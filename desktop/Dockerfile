# Sandbar desktop image. Spike finding 1: Webtop supplies XFCE, Xvfb :1, and s6.
FROM lscr.io/linuxserver/webtop:debian-xfce

ARG TARGETARCH

LABEL org.opencontainers.image.source="https://github.com/jdrolls/sandbar" \
      org.opencontainers.image.description="Sandbar AI-agent Linux desktop container" \
      org.opencontainers.image.licenses="MIT"

# All build-time installers intentionally run as root; XFCE itself remains abc (spike finding 1).
USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Spike finding 4: these are the runtime and X11 automation dependencies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl git python3 python3-venv tmux jq xz-utils \
        at-spi2-core dbus-x11 xdotool wmctrl scrot \
    && rm -rf /var/lib/apt/lists/*

# Spike finding 2: ttyd is absent from trixie, so use its static arch-aware release.
RUN TTYD_ARCH="$( [ "$TARGETARCH" = "arm64" ] && echo aarch64 || echo x86_64 )" \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" \
        -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && ttyd --version

# Spike finding 3: install Hermes into the persistent /config home as root.
# TODO: pin Hermes to a release ref once the installer supports it.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | HOME=/config bash

# Spike finding 5: cua-driver currently injects input only in the background on Linux.
# Sandbar therefore documents xdotool/XTest as the reliable GUI-control path.
RUN HOME=/config hermes computer-use install || true; \
    ln -sfn /config/.cua-driver/packages/current/cua-driver /usr/local/bin/cua-driver

# Record the installed version and hand the root-installed persistent files to XFCE's abc user.
# Spike finding 6: the desktop session user must own /config.
RUN mkdir -p /etc/sandbar \
    && hermes --version | head -1 > /etc/sandbar/hermes-version \
    && chown -R abc:abc /config

EXPOSE 7681

# lsio convention: overlay custom services, init scripts, and Sandbar's agent skill.
COPY --chmod=755 root/ /
