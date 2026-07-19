#!/usr/bin/env bash
# Spike service: serve the Hermes TUI over ttyd on :7681.
# The lsio base runs custom services under s6 as root; HOME points at /config
# (the persistent volume) so Hermes state survives container recreation.

export HOME=/config
export DISPLAY=:1

HERMES_BIN="$(command -v hermes || true)"
[ -z "$HERMES_BIN" ] && [ -x /opt/hermes/.venv/bin/hermes ] && HERMES_BIN=/opt/hermes/.venv/bin/hermes

if [ -z "$HERMES_BIN" ]; then
  echo "SPIKE-FINDING: hermes binary not found — record actual install path"
  exec ttyd -p 7681 -W bash
fi

exec ttyd -p 7681 -W "$HERMES_BIN"
