#!/usr/bin/env bash
# Per-browser-terminal launcher. ttyd invokes this as abc (spike finding 7).
set -u

export HOME=/config
export USER=abc
export DISPLAY=:1
export PATH=/config/.local/bin:$PATH

# Hermes must share XFCE's session D-Bus, not a root or newly-created bus.
xfce_pid="$(pgrep -u abc -o xfce4-session || true)"
if [ -z "$xfce_pid" ] || [ ! -r "/proc/$xfce_pid/environ" ]; then
  echo "Sandbar desktop session is not ready; reconnect in a moment."
  exec bash
fi

DBUS_SESSION_BUS_ADDRESS="$(tr '\0' '\n' < "/proc/$xfce_pid/environ" \
  | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -n 1)"
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
  echo "Sandbar could not find the XFCE session bus; reconnect in a moment."
  exec bash
fi
export DBUS_SESSION_BUS_ADDRESS

provider_is_configured() {
  # A template config.yaml is not evidence of setup (spike finding 8).
  [ -s /config/.hermes/auth.json ] && return 0
  [ -f /config/.hermes/.env ] \
    && grep -Eq '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*_API_KEY=..*' /config/.hermes/.env \
    && return 0
  # Passing a provider key at container runtime also intentionally skips onboarding.
  printenv | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*_API_KEY=.' && return 0
  return 1
}

if ! provider_is_configured; then
  cat <<'EOF'
Welcome to Sandbar — let's connect your agent.
Hermes will guide you through choosing a provider.
Your setup is saved in this container's persistent config.
EOF
  if ! hermes setup; then
    echo "Hermes setup did not complete. Fix it here, then run: hermes setup"
    exec bash
  fi
fi

# Keep this wrapper alive long enough to leave a useful shell if Hermes cannot start.
if hermes; then
  exit 0
fi

echo "Hermes exited with an error. You can retry with: hermes"
exec bash
