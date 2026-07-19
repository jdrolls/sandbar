# Phase 0 Spike

> **Phase 0 is complete** — findings below are baked into the real image at [`desktop/`](../desktop/). This directory stays as the historical record.

A throwaway image that answers the risky questions before we build the real `sandbar-desktop`. Nothing here is final; everything here is allowed to be ugly.

## What we're proving

| # | Question | Status |
|---|---|---|
| a | Hermes installs on the lsio Selkies Debian base | ✅ |
| b | Hermes computer-use drives the Selkies X server (clicks real XFCE apps) | ✅ with caveats — see findings |
| c | Hermes TUI under ttyd | ✅ (auto-greeting not wired yet) |
| d | Exec-approval defaults understood + configured for isolation | 🟡 partial — headless `-z` runs executed shell commands without prompts; deliberate approval-model review is Phase 1 work |
| e | RAM/CPU envelope measured | ✅ idle: ~720MiB RAM, ~3% CPU (desktop streaming, agent quiet). Image: 7.0GB (trim later) |
| f | Same image builds and runs on arm64 | ⏳ needs an arm64 builder |

## Findings (2026-07-19, amd64, Debian 13 base `lscr.io/linuxserver/webtop:debian-xfce`)

**End-to-end proof:** Hermes (headless `-z` mode, via OpenRouter) launched `xfce4-terminal` and typed `echo hello-sandbar` into it with xdotool — verified by screenshot of the live Selkies desktop. The core loop works.

1. **`ttyd` is not in Debian trixie repos.** Use the static release binary, arch-aware (`ttyd.x86_64` / `ttyd.aarch64`).
2. **Hermes installer needs `xz-utils`** (extracts its Node 22 tarball). Otherwise fully self-sufficient: brings its own uv-managed Python 3.11, Node 22, Playwright browser engine. Root install uses FHS layout (`/usr/local/lib/hermes-agent`, launcher at `/usr/local/bin/hermes`).
3. **The base image runs X11 (Xvfb :1) + Selkies** — exactly what computer-use wants. No Wayland surprises on this tag.
4. **The agent must live in the desktop session.** Running Hermes as root with its own D-Bus while the desktop session belongs to user `abc` breaks AT-SPI and app launching. Run the agent as the session user, importing the session's `DBUS_SESSION_BUS_ADDRESS`. Bake this into the image's service definition.
5. **AT-SPI needs `at-spi2-core` + `dbus-x11`** installed and a session bus; then `hermes computer-use doctor` goes fully green (inspection + input).
6. **cua-driver 0.8.3 Linux limitation:** input is delivered in "background" mode (XSendEvent-style), which XFCE panels/menus ignore. Screenshots, AT-SPI trees, and basic clicks work; menu-driven GUI flows don't. **Workaround that fully works:** the agent drives the desktop through its shell with `xdotool` (XTest = real input) — launch apps via shell, click/type via xdotool. Pre-seed this as a skill; track upstream for a foreground-input mode.
7. **`cua-driver` installs to `~/.local/bin` (not on PATH)** — symlink into `/usr/local/bin` in the image.
8. **Image additions needed:** `xz-utils at-spi2-core dbus-x11 xdotool wmctrl scrot` + ttyd binary + cua-driver + PATH fixes + `/config` volume for persistence.
9. **Model plumbing:** `ANTHROPIC_API_KEY` env is picked up natively; OpenRouter works with `--provider openrouter -m <slug>` (slug without the extra `openrouter/` prefix).
10. **Installer's own config template trips a warning** in the installed Hermes version (`Unknown top-level config key 'group_sessions_per_user'`). Cosmetic — TUI continues. Candidate fix: run `hermes migrate` during image build.

## Try it

```bash
docker build -t sandbar-spike spike/
docker run -d --name sandbar-spike \
  -p 3000:3000 -p 7681:7681 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  --shm-size=1g \
  sandbar-spike
```

- Desktop: `http://<host>:3000`
- Agent TUI: `http://<host>:7681`

Findings get recorded right here as they land.
