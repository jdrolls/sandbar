#!/usr/bin/env bash
# Install or refresh Sandbar's small platform control plane. The desktop image is
# intentionally pulled separately so the roughly 7GB one-time download is visible.
set -euo pipefail

REPO_URL="https://github.com/jdrolls/sandbar.git"
RAW_MAIN="https://github.com/jdrolls/sandbar/archive/refs/heads/main.tar.gz"
INSTALL_ROOT="${HOME}/.sandbar"
SOURCE_DIR="${INSTALL_ROOT}/src"

say() { printf '\n%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Keep installer detection aligned with Platform's startup parser. Do not accept
# wildcard, LAN, public, ambiguous, or CIDR-edge addresses as Docker bind IPs.
is_allowed_bind_ip() {
  local ip="$1" octet
  local -a octets
  IFS='.' read -r -a octets <<< "$ip"
  [[ "${#octets[@]}" -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
  [[ "$ip" == "127.0.0.1" ]] && return 0
  (( 10#${octets[0]} == 100 && 10#${octets[1]} >= 64 && 10#${octets[1]} <= 127 )) || return 1
  [[ "$ip" != "100.64.0.0" && "$ip" != "100.127.255.255" ]]
}

# Sandbar publishes desktop images for these two Docker architectures only.
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $(uname -m). Sandbar supports amd64 and arm64." ;;
esac

OS="$(uname -s)"
case "$OS" in
  Linux) ;;
  Darwin) ;;
  *) die "Sandbar requires Linux, or macOS with Docker Desktop installed." ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required to install Sandbar."

have_compose() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

if ! have_compose; then
  if [[ "$OS" == "Linux" ]] && ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is not installed. Install Docker Engine using get.docker.com? [y/N] '
    # Read from the terminal, not stdin — under `curl | bash` stdin is the script itself.
    read -r answer < /dev/tty
    if [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
      # This is intentionally opt-in: it executes Docker's upstream installer as root.
      curl -fsSL https://get.docker.com | sh
    else
      die "Docker is required. Install Docker, then rerun this script."
    fi
  else
    die "Docker with the Docker Compose plugin is required. Install it, then rerun this script."
  fi
fi
have_compose || die "Docker Compose is unavailable after Docker installation."

# Only show the bootstrap token when this invocation creates the local source.
# Refreshes retain the platform token and must not expose it again.
INITIAL_INSTALL=false
if [[ ! -e "$SOURCE_DIR" ]]; then
  INITIAL_INSTALL=true
fi

mkdir -p "$INSTALL_ROOT"

# Git is preferred because repeated runs are quick and preserve a normal checkout.
# The archive fallback deliberately extracts only the files needed by the platform.
fetch_with_archive() {
  local temporary
  temporary="$(mktemp -d)"
  trap 'rm -rf "$temporary"' RETURN
  curl -fsSL "$RAW_MAIN" | tar -xz -C "$temporary"
  [[ -f "$temporary/sandbar-main/compose.yml" && -d "$temporary/sandbar-main/platform" ]] || die "GitHub archive did not contain platform files."
  rm -rf "$SOURCE_DIR"
  mkdir -p "$SOURCE_DIR"
  cp "$temporary/sandbar-main/compose.yml" "$SOURCE_DIR/compose.yml"
  cp -R "$temporary/sandbar-main/platform" "$SOURCE_DIR/platform"
  trap - RETURN
  rm -rf "$temporary"
}

if command -v git >/dev/null 2>&1; then
  if [[ -d "$SOURCE_DIR/.git" ]]; then
    say "Refreshing Sandbar source…"
    if ! git -C "$SOURCE_DIR" pull --ff-only; then
      say "Git refresh failed; downloading the platform files from GitHub instead…"
      fetch_with_archive
    fi
  elif [[ ! -e "$SOURCE_DIR" ]]; then
    say "Downloading Sandbar source…"
    if ! git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"; then
      say "Git clone failed; downloading the platform files from GitHub instead…"
      fetch_with_archive
    fi
  else
    say "Existing non-git source found; refreshing platform files from GitHub…"
    fetch_with_archive
  fi
else
  say "git is unavailable; downloading the platform files from GitHub…"
  fetch_with_archive
fi

[[ -f "$SOURCE_DIR/compose.yml" ]] || die "compose.yml was not downloaded."

# An operator's explicit safe bind wins. Otherwise, use a currently assigned
# Tailscale IPv4 address for this run only; do not save a potentially stale IP.
if [[ -n "${SANDBAR_BIND_IP:-}" ]]; then
  is_allowed_bind_ip "$SANDBAR_BIND_IP" || die "SANDBAR_BIND_IP must be 127.0.0.1 or a usable Tailscale CGNAT IPv4 address."
  BIND_IP="$SANDBAR_BIND_IP"
  BIND_SOURCE="explicit"
else
  BIND_IP="127.0.0.1"
  BIND_SOURCE="default"
  if command -v tailscale >/dev/null 2>&1; then
    detected_tailscale_ip="$(tailscale ip -4 2>/dev/null || true)"
    if is_allowed_bind_ip "$detected_tailscale_ip" && [[ "$detected_tailscale_ip" != "127.0.0.1" ]]; then
      BIND_IP="$detected_tailscale_ip"
      BIND_SOURCE="auto-detected"
    fi
  fi
fi
export SANDBAR_BIND_IP="$BIND_IP"

say "Starting Sandbar platform for ${ARCH}…"
docker compose -f "$SOURCE_DIR/compose.yml" up -d --build

# Do not claim success until Bun has opened the platform health endpoint.
say "Waiting for platform health check…"
ready=false
for _ in $(seq 1 60); do
  if curl -fs --max-time 3 "http://${BIND_IP}:9000/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == "true" ]] || die "Platform did not become healthy within 60 seconds. Run: docker compose -f $SOURCE_DIR/compose.yml logs platform"

say "Pre-pulling ghcr.io/jdrolls/sandbar-desktop:latest (~7GB one-time download)…"
docker pull ghcr.io/jdrolls/sandbar-desktop:latest

if [[ "$INITIAL_INSTALL" == "true" ]]; then
  # /data/token is created with mode 0600 by the platform. Logs are only a fallback
  # for older platform images that printed the first-run token but did not persist it.
  # </dev/null is load-bearing: under `curl | bash`, exec -T would otherwise consume
  # the remainder of this script as the container's stdin and silently end the install.
  TOKEN="$(docker compose -f "$SOURCE_DIR/compose.yml" exec -T platform cat /data/token </dev/null 2>/dev/null || true)"
  TOKEN="${TOKEN//$'\n'/}"
  if [[ ! "$TOKEN" =~ ^[a-f0-9]{32}$ ]]; then
    TOKEN="$(docker compose -f "$SOURCE_DIR/compose.yml" logs platform 2>/dev/null | grep -Eo '[a-f0-9]{32}' | tail -n 1 || true)"
  fi
  [[ "$TOKEN" =~ ^[a-f0-9]{32}$ ]] || die "Could not read the platform token. Run: docker compose -f $SOURCE_DIR/compose.yml logs platform"
fi

cat <<'EOF'

╔════════════════════════════════════════════════════════════════╗
║ Sandbar is ready                                                ║
╠════════════════════════════════════════════════════════════════╣
EOF

if [[ "$BIND_IP" == "127.0.0.1" ]]; then
  printf '║ Local-only dashboard: http://localhost:9000                    ║\n'
else
  printf '║ %-62s ║\n' "Direct tailnet dashboard: http://${BIND_IP}:9000"
  printf '║ Dashboard links use direct per-seat tailnet ports.              ║\n'
fi

if [[ "$INITIAL_INSTALL" == "true" ]]; then
  printf '║ %-62s ║\n' "Token:     ${TOKEN}"
fi

if [[ "$BIND_IP" == "127.0.0.1" ]]; then
  cat <<'EOF'
║ Tailscale Serve is optional for this dashboard only; it does    ║
║ not route the dynamic per-seat port pool.                        ║
EOF
else
  printf '║ Bind source: %s SANDBAR_BIND_IP.                              ║\n' "$BIND_SOURCE"
fi

cat <<'EOF'
║ Create your first computer from the dashboard.                  ║
╚════════════════════════════════════════════════════════════════╝
EOF
