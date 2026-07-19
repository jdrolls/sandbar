# Roadmap

> Building in public. Checkboxes update as things land — if it's checked, it's real and verified, not aspirational.

```mermaid
flowchart LR
    P0["Phase 0\n🧪 Spike"] --> P1["Phase 1\n📦 sandbar-desktop"] --> P2["Phase 2\n🎛️ Platform"] --> P3["Phase 3\n🌍 Community"] --> P4["Phase 4\n🛡️ Hardening"]
```

## Phase 0 — Spike ✅ (2026-07-19, amd64)

Prove every risky assumption in one throwaway image before building anything real.

- [x] Hermes installs and runs on a Debian 13 Selkies base image
- [x] Hermes computer-use works against the Selkies X server — screenshots + AT-SPI green; GUI input via xdotool/XTest (cua-driver's Linux background-input limitation documented in [`spike/README.md`](../spike/README.md))
- [x] Hermes TUI runs under ttyd
- [x] Exec-approval behavior: headless runs execute without prompts; deliberate review still open (Phase 1)
- [x] RAM/CPU envelope measured (~720MiB / ~3% CPU idle)
- [ ] Same image builds and runs on arm64 → moved to Phase 1 CI

## Phase 1 — `sandbar-desktop` (Tier 0) — in progress

The one-command agent computer.

- [x] Multi-arch image (amd64 + arm64) published to GHCR, built on native runners — `docker run ghcr.io/jdrolls/sandbar-desktop:latest` verified boots to onboarding (amd64; arm64 runtime test pending hardware)
- [x] Desktop browser works out of the box (Chromium, flags preconfigured; container is the isolation boundary — Docker's default seccomp blocks the browser sandbox, custom seccomp re-enables it)
- [x] Hermes pinned to the v0.18.2 release commit (installer `--commit` flag); bumps are deliberate ARG updates, rebuilt and retested
- [x] First-run onboarding: no baked keys — native Hermes wizard in the chat pane; env keys skip it
- [x] Agent runs inside the desktop session (session user + session D-Bus), verified end-to-end: agent opened a terminal and typed into it
- [x] `sandbar-desktop` skill seeded (GUI control via shell + xdotool)
- [x] Agent adapter contract: `hermes` (default) and `none` (BYO agent via control API/MCP) via `SANDBAR_AGENT`
- [x] Non-root agent user (desktop session user, not root)
- [x] Control API (screenshot / click / type / key / scroll / bash / health / info) — token-gated, off by default; basic auth (`CUSTOM_USER`/`PASSWORD`) covers desktop + chat
- [x] The Window: desktop + chat in one page at `:8080/` (draggable split, per-surface links, secure-context hint)
- [x] Raspberry Pi guide ([docs/raspberry-pi.md](raspberry-pi.md))
- [x] Exec-approval model reviewed and documented (Hermes defaults kept: interactive classifier gates dangerous commands in the chat pane; hardening knobs documented)

## Phase 2 — Platform (Tier 1)

Provision many computers; keep it optional.

- [ ] Bun/TS control plane: provisioning CRUD + embedded reverse proxy (no Docker socket in anything internet-facing)
- [ ] Single-user token auth by default; signed short-lived route tokens on every surface
- [ ] `install.sh` — arch detect, Docker bootstrap, secrets, guided first run
- [ ] Tailscale-default access; Cloudflare Tunnel + Caddy/LE documented
- [ ] MCP server — Sandbar computers as native tools in Claude Code and any MCP client
- [ ] Multi-user opt-in mode (accounts, per-user keys, admin)

## Phase 3 — Community

- [ ] `openclaw` containment adapter + migration guide
- [ ] Takeover-mode polish (explicit human/agent control handoff in the UI)
- [ ] Docs site
- [ ] Launch write-ups: self-hosted agent computers, OpenClaw containment, agents on a Pi

## Phase 4 — Hardening & fleet

- [ ] sysbox opt-in runtime (Docker-in-desktop, real systemd)
- [ ] gVisor "untrusted agent" tier
- [ ] Computer templates & persistence/snapshot story
