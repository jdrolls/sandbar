# Phase 0 Spike

A throwaway image that answers the risky questions before we build the real `sandbar-desktop`. Nothing here is final; everything here is allowed to be ugly.

## What we're proving

| # | Question | Status |
|---|---|---|
| a | Hermes installs on the lsio Selkies Debian base | ⏳ |
| b | Hermes computer-use drives the Selkies X server (clicks real XFCE apps) | ⏳ |
| c | Hermes TUI under ttyd, auto-greeting | ⏳ |
| d | Exec-approval defaults understood + configured for isolation | ⏳ |
| e | RAM/CPU envelope measured (idle / agent browsing) | ⏳ |
| f | Same image builds and runs on arm64 | ⏳ |

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
