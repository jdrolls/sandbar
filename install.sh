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
    read -r answer
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

say "Starting Sandbar platform for ${ARCH}…"
docker compose -f "$SOURCE_DIR/compose.yml" up -d --build

# Do not claim success until Bun has opened the platform health endpoint.
say "Waiting for platform health check…"
ready=false
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:9000/api/health" | grep -q '"status":"ok"'; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == "true" ]] || die "Platform did not become healthy within 60 seconds. Run: docker compose -f $SOURCE_DIR/compose.yml logs platform"

say "Pre-pulling ghcr.io/jdrolls/sandbar-desktop:latest (~7GB one-time download)…"
docker pull ghcr.io/jdrolls/sandbar-desktop:latest

# /data/token is created with mode 0600 by the platform. Logs are only a fallback
# for older platform images that printed the first-run token but did not persist it.
TOKEN="$(docker compose -f "$SOURCE_DIR/compose.yml" exec -T platform cat /data/token 2>/dev/null || true)"
TOKEN="${TOKEN//$'\n'/}"
if [[ ! "$TOKEN" =~ ^[a-f0-9]{32}$ ]]; then
  TOKEN="$(docker compose -f "$SOURCE_DIR/compose.yml" logs platform 2>/dev/null | grep -Eo '[a-f0-9]{32}' | tail -n 1 || true)"
fi
[[ "$TOKEN" =~ ^[a-f0-9]{32}$ ]] || die "Could not read the platform token. Run: docker compose -f $SOURCE_DIR/compose.yml logs platform"

first_non_loopback_ip() {
  local candidate
  if hostname -I >/dev/null 2>&1; then
    candidate="$(hostname -I | awk '{print $1}')"
    [[ -n "$candidate" ]] && { printf '%s\n' "$candidate"; return; }
  fi
  if command -v ip >/dev/null 2>&1; then
    candidate="$(ip -4 -o addr show scope global | awk 'NR==1 {split($4, a, "/"); print a[1]}')"
    [[ -n "$candidate" ]] && { printf '%s\n' "$candidate"; return; }
  fi
  if command -v ifconfig >/dev/null 2>&1; then
    candidate="$(ifconfig | awk '$1 == "inet" && $2 != "127.0.0.1" {print $2; exit}')"
    [[ -n "$candidate" ]] && { printf '%s\n' "$candidate"; return; }
  fi
  printf 'localhost\n'
}
HOST_IP="$(first_non_loopback_ip)"

cat <<EOF

╔════════════════════════════════════════════════════════════════╗n║ Sandbar is ready                                                ║
╠════════════════════════════════════════════════════════════════╣
║ Dashboard: http://${HOST_IP}:9000
║ Token:     ${TOKEN}
╠════════════════════════════════════════════════════════════════╣
║ For private remote access, install Tailscale on this host.      ║
║ Create your first computer from the dashboard.                  ║
╚════════════════════════════════════════════════════════════════╝
EOF
