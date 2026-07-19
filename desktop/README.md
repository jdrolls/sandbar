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

## Authentication

`-e CUSTOM_USER=me -e PASSWORD=...` protects both the desktop and chat pane with HTTP basic authentication.

`-e SANDBAR_TOKEN=...` enables the control API on port 8080. Publish it with `-p 8080:8080`, then send the token as a bearer token:

```bash
curl -sS -H "Authorization: Bearer $SANDBAR_TOKEN" http://localhost:8080/screenshot \
  | jq -r '.image' | base64 --decode > screenshot.png

curl -sS -X POST -H "Authorization: Bearer $SANDBAR_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"command":"echo hello from Sandbar","timeout":10}' \
  http://localhost:8080/bash
```

With none of these set, anyone who can reach the ports controls the computer. That is fine on localhost or a tailnet, but not on exposed hosts.

For clean HTTPS over Tailscale:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```
