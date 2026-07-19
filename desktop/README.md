# Sandbar Desktop

A friendly Linux desktop for your AI agent. Open the desktop to watch or take over while your agent works.

## Build

```bash
docker build -t sandbar-desktop desktop/
```

## Run

```bash
docker run -d --name sandbar \
  -p 3000:3000 -p 3001:3001 -p 7681:7681 -p 8080:8080 \
  -v sandbar-config:/config --shm-size=1g sandbar-desktop
```

Open `http://localhost:8080` for the Sandbar Window: the desktop and chat together on one page. The Window itself is unauthenticated but inert: its framed surfaces enforce any configured HTTP basic authentication (`CUSTOM_USER` and `PASSWORD`), and control endpoints still require `SANDBAR_TOKEN`.

Open `https://<host>:3001` for the standalone desktop. It uses a self-signed certificate, so accept the browser warning. Selkies requires a secure context; plain HTTP works only on localhost.

Open `http://<host>:7681` for standalone agent chat. On first run, Hermes walks you through connecting a provider. Passing a provider key such as `-e ANTHROPIC_API_KEY` or `-e OPENROUTER_API_KEY` skips onboarding.

For a reverse proxy or Tailscale setup, compose different surfaces with Window query parameters, for example `?desktop=https://desktop.example&chat=https://chat.example`. Remote plain HTTP cannot carry the desktop stream; use HTTPS.

## Agent adapters

- `SANDBAR_AGENT=hermes` (default) starts Hermes in the chat pane.
- `SANDBAR_AGENT=none` makes the chat pane a plain shell. Pair it with `SANDBAR_TOKEN` and the control API on port 8080 when an external agent or MCP drives the desktop.

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

## What can the agent do without asking?

Hermes' defaults are a sensible fit for an isolated container, so Sandbar ships them unchanged:

- **Shell commands:** an approval classifier gates dangerous commands; you approve or deny right in the chat pane. Routine commands run freely. (Headless/API-driven runs execute without interactive gates — that's what `SANDBAR_TOKEN` is protecting.)
- **Memory and skill writes:** free by default. To review what the agent teaches itself, set `skills.write_approval: true` / `memory.write_approval: true` in `/config/.hermes/config.yaml`, and `skills.guard_agent_created: true` to scan agent-written skills for dangerous patterns.
- **The blast radius is the container.** Everything the agent touches lives in this container and the `sandbar-config` volume. Delete both and it never happened.

For clean HTTPS over Tailscale:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```
