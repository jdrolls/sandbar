# Sandbar browser bridge

`bridge.mjs` is a persistent JSON-lines stdio process for the trusted host
control daemon. It is not an HTTP server and accepts no connection URL, shell
command, evaluator, browser launch request, or filesystem path from a caller.

The image invokes it only as:

```text
/usr/local/bin/sandbar-node /opt/sandbar-browser/dist/bridge.mjs
```

It attaches through fixed container-loopback CDP to the headed Chromium started
by `sandbar-browser`. `attach` requires both `SANDBAR_SHARED_BROWSER=1` and
`SANDBAR_BROWSER_SANDBOX=namespace`, attaches to the existing default context,
and disconnects without closing Chromium. `detach` removes the HTTP route and
event observers, clears in-memory diagnostics/downloads, then disconnects the
CDP client. Playwright 1.63 has `routeWebSocket` but no `unrouteWebSocket`; the
client disconnect is its supported WebSocket-route cleanup lifecycle. Attach
rejects a context that already has service workers, and immediately disconnects
if one appears, because service-worker requests can bypass route interception.

Each input line is at most 1 MiB and has `{id,operation,args}`. Each output
line is exactly `{id,ok:true,result}` or `{id,ok:false,code}`. The bridge does
not persist tokens, DOM, URLs, screenshots, downloads, or diagnostics.

Install the pinned dependency and build from this directory:

```bash
bun install
bun run build
bun test
```

`playwright-core@1.63.0` is intentionally used without a browser download;
Chromium belongs to the desktop image. The build keeps `playwright-core`
external, so the deployed image must retain this pinned runtime dependency in
`node_modules`.

## Bounded native Mousepad lane

Native access is not general desktop control. `desktop-launch` accepts only
`{app:"mousepad"}` and requires both input and mutation consent. The bridge
starts Mousepad with fixed `execFile` argv without waiting for application exit,
then records its PID and visible X11 windows on fixed `DISPLAY=:1`. It retains
at most four windows and returns random opaque `windowId` values only—never X11
IDs, PIDs, titles, paths, or another application's windows.

`desktop-windows` (observation consent) lists only those opaque owned IDs;
`desktop-activate` (input consent) accepts only one of them. A native screenshot
requires observation consent and an owned `windowId`; it uses `scrot --window`
to capture that Mousepad window only and validates that the response is a bounded
PNG. Whole-screen `desktop-screenshot`, browser/basic desktop screenshots, and
screenshots of arbitrary applications remain unsupported.

`desktop-click`, `desktop-type`, `desktop-key`, and `desktop-scroll` require
input consent and first check that an owned Mousepad window is active. Clicks are
left-click only and must lie within its geometry; scroll moves to its center.
Typing is bounded text only. Keys are limited to `BackSpace`, `Delete`, arrow
keys, `Home`, `End`, `Return`, and `Tab`; modifier shortcuts (including terminal,
devtools, open/save, or execution shortcuts) are denied.

The bridge then runs the image-internal `native-input` helper with private,
fixed argv (owned XID, launched-child PID, operation, validated values). The
helper opens only `DISPLAY=:1`, grabs the X server, verifies `_NET_WM_PID` and
that the input-focus window is the owned top-level XID or its descendant, and
uses libxdo `CURRENTWINDOW` XTEST on that same Display. It calls `XSync` before
ungrabbing, preventing another X client from changing focus between guard and
input. The helper validates its own numeric IDs, operation arity, text bound,
and key allowlist; it has no standalone registration or caller-selected target.
Node launches it asynchronously with timeout/max-buffer bounds and aborts it on
bridge EOF. An X server grab is also released automatically if the helper dies.
No caller supplies a shell command, executable, file path, raw window ID, PID,
or cross-window input. `record`, `replay`, and `motion` remain
`unsupported-capability`.
