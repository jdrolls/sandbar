# Sandbar Desktop

A friendly Linux desktop for your AI agent. Open the desktop to watch or take over while your agent works.

## Build

```bash
docker build -t sandbar-desktop desktop/
```

## Run

```bash
docker run -d --name sandbar \
  -p 3000:3000 -p 3001:3001 -p 7681:7681 \
  -v sandbar-config:/config --shm-size=1g sandbar-desktop
```

Open `https://<host>:3001` for the desktop. It uses a self-signed certificate, so accept the browser warning. Selkies requires a secure context; plain HTTP works only on localhost.

Open `http://<host>:7681` for agent chat. On first run, Hermes walks you through connecting a provider. Passing a provider key such as `-e ANTHROPIC_API_KEY` or `-e OPENROUTER_API_KEY` skips onboarding.

For clean HTTPS over Tailscale:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```
