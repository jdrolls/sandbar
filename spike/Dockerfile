# Phase 0 spike — throwaway proving ground, NOT the shipping image.
#
# Questions this image must answer (see docs/ROADMAP.md · Phase 0):
#   a. Does Hermes install cleanly on the linuxserver.io Selkies Debian base?
#   b. Does Hermes computer-use (AT-SPI/XTest) drive the Selkies X server?
#   c. Does the Hermes TUI run under ttyd with an auto-greeting?
#   d. What are the exec-approval defaults inside an isolated container?
#   e. RAM/CPU envelope — idle and under agent load?
#
# Build:  docker build -t sandbar-spike spike/
# Run:    docker run -d --name sandbar-spike -p 3000:3000 -p 7681:7681 \
#           -e ANTHROPIC_API_KEY=sk-ant-... --shm-size=1g sandbar-spike
# Watch:  http://<host>:3000  (desktop)   http://<host>:7681  (agent TUI)

FROM lscr.io/linuxserver/webtop:debian-xfce

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git python3 python3-venv tmux jq xz-utils \
    && rm -rf /var/lib/apt/lists/*

# SPIKE-FINDING (a): ttyd is NOT packaged in Debian trixie — use the static
# release binary, arch-aware (BuildKit populates TARGETARCH).
ARG TARGETARCH
RUN TTYD_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64) && \
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" && \
    chmod +x /usr/local/bin/ttyd && /usr/local/bin/ttyd --version

# Hermes agent.
# TODO(phase1): pin to a release tag — spike runs the installer default to
# observe behavior; shipping images must never float.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash \
    || echo "SPIKE-FINDING: install.sh failed — capture output and adjust"

# ttyd → Hermes TUI as a linuxserver.io custom service (runs under s6)
COPY ttyd-hermes.sh /custom-services.d/ttyd-hermes
RUN chmod +x /custom-services.d/ttyd-hermes

EXPOSE 7681
