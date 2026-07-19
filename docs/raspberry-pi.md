# Sandbar on a Raspberry Pi

Yes, really: an AI agent with its own desktop, on a $80 board on your shelf. The image is published multi-arch, so the same command works on a Pi as on a cloud VM.

## What you need

- **Raspberry Pi 5 (8GB)** recommended. A Pi 4 (4GB+) boots it, but the desktop stream will feel sluggish under load.
- **Boot from SSD/NVMe, not a microSD card.** Docker image layers plus Chromium on an SD card is misery (and wears the card out).
- 64-bit Raspberry Pi OS (or any arm64 Debian/Ubuntu) with Docker installed.

## Run it

Same one-liner as everywhere else — Docker picks the arm64 image automatically:

```bash
docker run -d --name sandbar \
  -p 3000:3000 -p 3001:3001 -p 7681:7681 -p 8080:8080 \
  -v sandbar-config:/config \
  --shm-size=1g \
  ghcr.io/jdrolls/sandbar-desktop:latest
```

`--shm-size=1g` is not optional — Chromium crashes without it.

## Pi-specific notes

- **Browser:** the desktop ships Chromium (Google Chrome still has no arm64 Linux build; when Google ships one, it'll join the amd64 image first).
- **Encoding is CPU-bound.** The Pi 5 dropped hardware H.264 encoding, so the desktop stream is software-encoded on the Cortex-A76 cores. Selkies is built for exactly this and stays smooth at desktop work; don't expect 60fps video playback.
- **One computer per Pi.** Agent + Chromium + stream encoding uses 2–3 of the 4 cores when active. Provisioning a fleet needs bigger hardware.
- **Headroom tip:** if it feels tight, lower the desktop resolution from inside the session (`xrandr -s 1280x800`) — encoding cost scales with pixels.

## Reaching it from your other machines

The desktop stream needs HTTPS off-localhost (browser secure-context rules). The clean way on a home network is [Tailscale](https://tailscale.com) on the Pi:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000   # desktop
tailscale serve --bg --https=8444 http://127.0.0.1:7681   # agent chat
```

Then open `https://<pi-name>.<tailnet>.ts.net:8443` from anywhere on your tailnet — valid certificate, zero open ports on your router.

## Status

The arm64 image is built and published from native ARM runners on every release. If you hit something Pi-specific, [open an issue](https://github.com/jdrolls/sandbar/issues) — this deployment target is a first-class citizen, not a novelty.
