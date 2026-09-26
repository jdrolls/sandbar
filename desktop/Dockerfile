# Pinned build-only runtimes. The final Webtop image receives neither Bun nor a
# package manager; sandbar-node is the only Node executable exposed at runtime.
FROM node:22.22.0-bookworm-slim AS sandbar-node

FROM oven/bun:1.3.14 AS sandbar-browser-build
WORKDIR /opt/sandbar-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY browser-control/package.json browser-control/bun.lock ./
# playwright-core is pinned in the frozen lockfile and does not install a browser.
RUN bun install --frozen-lockfile --production
COPY browser-control/bridge.ts ./
# Keep playwright-core external: it remains in node_modules and must not be
# bundled into the bridge or mistaken for a Chromium payload.
RUN bun build bridge.ts --target=node --external=playwright-core --outfile dist/bridge.mjs

# XTEST must share libxdo's Display with the ownership/focus guard, which the
# Node X11 bindings cannot provide atomically. Compile this small internal
# primitive only; the final image keeps xdotool's libxdo runtime dependency.
FROM debian:bookworm-slim AS sandbar-native-input-build
WORKDIR /opt/sandbar-browser
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev libxdo-dev libxtst-dev \
    && rm -rf /var/lib/apt/lists/*
COPY browser-control/native-input.c ./
RUN gcc -O2 -Wall -Wextra -Werror -std=c11 native-input.c -o native-input -lxdo -lX11 -lXtst

# Sandbar desktop image. Webtop supplies XFCE, Xvfb :1, and s6.
FROM lscr.io/linuxserver/webtop:debian-xfce

ARG TARGETARCH

LABEL org.opencontainers.image.source="https://github.com/jdrolls/sandbar" \
      org.opencontainers.image.description="Sandbar AI-agent Linux desktop container" \
      org.opencontainers.image.licenses="MIT" \
      io.sandbar.chromium-sandbox="namespace-v1" \
      io.sandbar.shared-browser="shared-seat-v1" \
      io.sandbar.shared-viewer="viewer-lock-v1"

# All build-time installers intentionally run as root; XFCE itself remains abc.
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl git python3 python3-venv tmux jq xz-utils \
        at-spi2-core dbus-x11 xdotool wmctrl scrot \
        ripgrep ffmpeg chromium \
    && rm -rf /var/lib/apt/lists/*

# ttyd is absent from trixie, so use its static arch-aware release.
RUN TTYD_ARCH="$( [ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64 )" \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" \
        -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && ttyd --version

# Hermes is installed into the persistent /config home as root, then handed to abc.
ARG HERMES_COMMIT=36f2a966c7f9f69987494b867c3dcf96b69a5766
RUN curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.sh" | HOME=/config bash -s -- --commit "${HERMES_COMMIT}"

RUN HOME=/config hermes computer-use install || true; \
    ln -sfn /config/.cua-driver/packages/current/cua-driver /usr/local/bin/cua-driver

# The bridge is a fixed stdio program. playwright-core is copied with no browser
# payload, and Chromium is supplied by apt above.
COPY --from=sandbar-node /usr/local/bin/node /usr/local/bin/sandbar-node
COPY --from=sandbar-browser-build /opt/sandbar-browser/dist /opt/sandbar-browser/dist
COPY --from=sandbar-browser-build /opt/sandbar-browser/node_modules /opt/sandbar-browser/node_modules
COPY --from=sandbar-native-input-build /opt/sandbar-browser/native-input /opt/sandbar-browser/native-input
RUN /usr/local/bin/sandbar-node --version \
    && chmod 0755 /opt/sandbar-browser/native-input \
    && mkdir -p /etc/sandbar \
    && hermes --version | head -1 > /etc/sandbar/hermes-version \
    && chown -R abc:abc /config

EXPOSE 7681 8080

# lsio convention: overlay custom services, init scripts, and Sandbar's agent skill.
COPY --chmod=755 root/ /
