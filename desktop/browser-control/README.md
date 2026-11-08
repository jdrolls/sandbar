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
client disconnect is its supported WebSocket-route cleanup lifecycle. No
service worker may run while the bridge is attached, because service-worker
requests can bypass route interception: attach blocks registration and clears
the workers earlier sessions left, refuses a worker it cannot clear, and
disconnects if one appears mid-lease (see [Service workers](#service-workers)).

`attach` also accepts an optional `inputScope`, `"full"` (the default when
absent) or `"qa-layout"`. Any other value, or `"qa-layout"` with
`allowMutations: true`, returns `invalid-request`. Under `qa-layout` the only
page input is `click`, `scroll` and `viewport`: `type`, `select`, `key`,
`upload` and every `desktop-*` operation return `permission-denied`, even with
`allowInput: true`. A `qa-layout` click also fences its outcome. While the click
runs, and for 500 ms after it resolves, the bridge records any top-level
navigation the origin route aborts and any page the click opens. A new page left
on an unapproved origin is closed. If either happened, or the clicked page itself
ends off the approved origins, the click returns
`permission-denied` instead of succeeding silently. A controller that sends
`inputScope` to an older bridge gets `invalid-request` (unknown key), so it
fails closed against a stale image.

A `qa-layout` attach may also pass `subresourceOrigins`: 1 to 32 exact
canonical HTTP(S) origins outside the lease, for example a webfont or image
CDN. The origin route then continues a request to a listed origin only when it
is a `GET`, its Playwright `resourceType()` is `stylesheet`, `font` or `image`,
and it is not a navigation request in any frame. Every other request to a
listed origin (navigation, popup, subframe, script, `xhr`, `fetch`, beacon,
`HEAD` or any non-`GET`) is aborted as before, and a click whose top-level
navigation targets a listed origin still returns `permission-denied`. Network
and console diagnostics stay limited to the lease origins. `subresourceOrigins`
with any other `inputScope`, or a malformed list, returns `invalid-request`; an
older bridge rejects the unknown key, so a controller fails closed. Like any
approved origin, a listed origin is trusted with its own redirects, so list only
hosts you would let serve the page directly.

Each input line is at most 1 MiB and has `{id,operation,args}`. Each output
line is exactly `{id,ok:true,result}` or `{id,ok:false,code}`. The bridge does
not persist tokens, DOM, URLs, screenshots, downloads, or diagnostics.

`layout {tabId?}` needs `allowObservation` (it is allowed under `qa-layout`)
and returns exactly `{scrollWidth, scrollHeight, clientWidth, clientHeight,
innerWidth, innerHeight}` as non-negative integers. The values come from a fixed
in-bridge read of `document.documentElement` and `window`; the caller supplies no
selector or script, so this is not an evaluator. Any argument but `tabId` is
`invalid-request`, and a missing or non-integer page value is
`verification-failed`. It answers questions such as horizontal overflow
(`scrollWidth - innerWidth`). An older bridge answers `invalid-request`.

`snapshot {tabId}` (or `format:"text"`) returns approved-origin body text.
`snapshot {tabId, format:"aria"}` returns `{tabId, format:"aria", text}` with the
Playwright aria snapshot of each approved-origin frame (roles, accessible names,
states), under the same 64 KiB cap. Field values are replaced with `[redacted]`
for textbox, searchbox, combobox, spinbutton, and slider lines, bare or
YAML single-quoted (Playwright prints password values in clear), and link `/url:` lines are dropped, so the tree holds
no more page data than the text snapshot. A `<select>`'s `[selected]` option
stays, as it does on screen.

The control daemon aborts a request after 30 s, so every browser wait finishes
inside it. Playwright action waits (`goto`, `snapshot`, `click`, `type`,
`select`, `wait`, `screenshot`, `upload`) are capped at 20 s, and `wait`
`milliseconds` accepts at most 20000. Browser page operations also have a 25 s
per-request deadline. A Playwright `TimeoutError` or an expired deadline returns
`{id,ok:false,code:"timeout"}`; the request queue is released, so later
requests (including `doctor` and `detach`) are still served on the same bridge.
An abandoned call is left to settle on its own and its late result is dropped;
a late `open` cannot repopulate state after `detach`. Input calls without a
Playwright timeout option (`key`, `scroll`, `viewport`, `tab-select`) are only
bounded by the request deadline, so a wedged one could still act late.
`attach`'s CDP connect uses the same 20 s cap.

A selector that matches several elements (Playwright strict mode) or does not
parse returns `invalid-request`, not `provider-unavailable`; narrow it, e.g.
`".gallery-item >> nth=0"`. `provider-unavailable` stays reserved for transport
and browser failures.

## Service workers

The origin route is the lease's fence, and service workers sit outside it:
Playwright's context routes do not reliably intercept a worker's own
requests, so a worker could send requests the route would abort. Earlier
bridges therefore refused any context with a running service worker. Many
sites register one on page load, so such a site could never be driven, and
while any tab kept a worker alive every lease on the seat failed.

Now no worker runs on the seat while it is leased:

1. **Registration is blocked first.** Attach installs a context init script
   that replaces `ServiceWorkerContainer.prototype.register` with a function
   that rejects with a `SecurityError`, which is how Chromium itself answers when
   site storage is blocked. The property is non-writable and non-configurable,
   so page script cannot put the original back. Playwright runs the script in
   every new document before page script, in child frames, popups and
   `about:blank` iframes too. Attach also evaluates it into every frame
   already open. A page that registers on load gets a rejected promise and carries on
   without a worker. Dedicated workers and insecure contexts have no
   `navigator.serviceWorker`, so they cannot register.
2. **Earlier workers are cleared next.** Through one tab's CDP session, attach
   reads every registration in the profile (`ServiceWorker.enable`). It deletes
   each `http`/`https` one with `Storage.clearDataForOrigin` (storage type
   `service_workers` only, so cookies, caches and other site data stay), then
   stops each web worker still running (`ServiceWorker.stopWorker`). Unlike
   `ServiceWorker.unregister`, the delete also releases tabs the worker
   controlled, so their requests go to the network and through the route. The
   whole exchange is bounded (5 s per tab, at most 3 tabs tried). A tab that
   cannot answer, a malformed report, or a failed delete returns
   `verification-failed`, and no route is installed.
3. **The old refusal is the safety net.** Stopped workers must leave
   Playwright's worker list within 2 s. Any worker still listed keeps the
   original answers: `permission-denied` if any is off the lease origins,
   otherwise `verification-failed`. Attach checks the list again after the
   `serviceworker` listener is installed, so a worker that starts in between is
   refused too. A worker that appears mid-lease still drops the lease
   (`session-lost`). Browser-internal workers (`chrome-extension:`) are never
   stopped or deleted. Stopping one leaves Playwright a session that never
   answers, which stalls route setup. A running one still refuses attach, as
   before.

Why the bridge does it this way: Chromium has no switch for this. Its managed
policies (`policies.yaml` in Chromium's policy templates, checked for this
change) have no setting that turns service workers off. The only
service-worker policies are `ServiceWorkerToControlSrcdocIframeEnabled`,
`PrefetchWithServiceWorkerEnabled`, `ServiceWorkerAutoPreloadEnabled` and
`RestrictBackgroundFetchFromServiceWorkerEnabled`. There is no
`Default…Setting` for service workers either. Blocking site storage
(`DefaultCookiesSetting`) would stop them, but it would also break every
login. Chromium's content and browser switch lists and its content feature
list have no service-worker kill switch either, so no launch flag in
`sandbar-browser` can do it. CDP is the only mechanism the bridge can reach. Block-before-clear
leaves no window in which a cleared site can register again, and the final list
check covers the gap before the listener exists.

What this costs and what is left:

- Clearing deletes every site's service-worker registration on the seat
  profile at every attach, including any push subscription tied to it. Sites
  re-register when visited outside a lease. The block lives on the bridge's CDP
  connection, so it stops at detach for new documents. A document that was
  already open at attach stays blocked until it reloads.
- The block is page JavaScript, not a browser setting. A document already open
  at attach that saved its own reference to `register` before the bridge
  arrived can still call it. A registration keyed to a third-party top-level
  site (a worker registered inside a cross-site iframe) is not deleted by
  `Storage.clearDataForOrigin`. Either way, the worker only runs if Chromium
  starts it, and then the safety net refuses the attach or ends the lease. None
  of these cases lets traffic past the route unseen. In each one, the lease
  fails closed.
- Tested against Chrome for Testing 156 with this bridge's bundle over CDP.
  Two workers left by an earlier client were cleared, one of them controlling
  an open tab. That tab was released, and its next request went to the
  network. A leased tab whose page registers on load got the `SecurityError`
  and stayed leased, and no worker script was fetched. That run used no
  extension workers (Chrome for Testing ships two, which refuse attach as
  described above). The image's Debian Chromium and a live seat were not
  part of it.

## Credential broker operations

Two operations let a credential broker (a separate host user holding the
vault) type a username, password or TOTP into a page without the agent ever
seeing the value. The host control daemon forwards them to the bridge only
from the broker's socket and only while a scoped lease on that origin is
active, so neither needs `allowInput` or `allowObservation`. Both need an
attachment: `committed-origin` answers `session-lost` without one, and
`credential-type` answers `permission-denied`, as it does for every failure
before its fill. Both are `permission-denied` under
`inputScope: "qa-layout"`, and both carry the 25 s request deadline. An older
bridge answers `invalid-request`.

`committed-origin {tabId}` (`tabId` required) returns exactly `{origin}`, the
origin of that tab's main-frame URL. A tab whose origin is not one of the
attachment's `origins` is `permission-denied`.

`credential-type {tabId, field, selector, value, expectOrigin, submit?}`
requires every argument except `submit`, and returns exactly `{}` on
success, with or without `submit`. `field` is `username`, `password` or
`totp`; `value` is a 1 to 1024 character string with no NUL; `expectOrigin`
is a canonical `https` origin (no path, trailing slash, userinfo or default
port). `submit` names the control the daemon will press after the fill. The
agent chose it, so it is not secret, and it is held to the same selector rules
as `selector`. Any other shape is `invalid-request`. The bridge then refuses,
typing nothing:

- `permission-denied` unless the tab's main-frame origin equals `expectOrigin`
  and is in the attachment's `origins`.
- `invalid-request` for a selector containing `>>`, `internal:`, `control=`,
  `enter-frame` or `any-frame` (compared case-insensitively). A single-part
  Playwright selector cannot leave the main frame's document; it does pierce
  open shadow roots, which belong to that document.
- `invalid-request` unless `page.locator(selector)` matches exactly one element.
- `permission-denied` unless that element is an HTML `<input>` in the top
  document that is connected, visible, enabled (including a disabled
  `<fieldset>`) and not `readonly`, and its browser-normalized `type` fits the
  field: `password` needs `password`; `username` needs `text`, `email` or `tel`
  (a missing, empty or unknown `type` is `text`); `totp` needs `text`, `tel` or
  `number`. The type check uses the property, not the attribute, so
  `type=" password "` (rendered as text) is refused for a password.
- `permission-denied` unless the field looks like where that credential
  belongs. The agent picks the selector, so a field that merely fits the type
  is not enough: a search box whose script navigates on Enter, or a POST
  "project name" field that stores what it gets, must never receive a secret.
  - **`password`:** an `<input type=password>`.
  - **`username`:** its form owner also has a password input, or it carries
    `autocomplete` `username` or `email`. A form-less input without that
    `autocomplete` is refused.
  - **`totp`:** `autocomplete=one-time-code`; or, with a form owner,
    `inputmode=numeric` with a `maxlength` of 1 to 10, or no other text-like
    control in the form. A form-less code field needs
    `autocomplete=one-time-code`.
- `permission-denied` for every field when the input's form would submit by
  GET, which would put the value in the next URL. That covers a form whose
  method is `get`, missing or invalid (all of these are the GET state), and a
  `post` form with any associated control whose `formmethod` is not `post` or
  `dialog`. That includes an `<input type=image>` submitter, which
  `form.elements` leaves out: the bridge also walks the inputs of the form's
  own tree (its document or shadow root) for image inputs whose form owner is
  that form. Inputs outside any form, and `post` or `dialog` forms, are
  allowed. A single-page login form that omits `method` and submits by script
  is refused too; give it `method="post"`.
- with `submit`, `permission-denied` unless `page.locator(submit)` matches
  exactly one element, and it is a submit button (a `<button>` whose type is
  `submit`, including a missing or invalid type, or an
  `<input type=submit|image>`) in the same document whose form owner is the
  filled input's form owner. A form-less input therefore cannot take a
  `submit`. Type and form owner are read through the
  `HTMLButtonElement`/`HTMLInputElement` prototype getters.
- The probe reads every fact through the window's native prototypes:
  attributes via `Element.prototype.getAttribute`, type and form owner via
  `HTMLInputElement.prototype`, and the form's controls via
  `HTMLFormElement.prototype.elements`. So a control named `method` or
  `elements`, or an own property on the element, cannot change the answer, and
  a form inside a shadow root is scanned in its own tree. A probe that fails
  part-way refuses.
- `permission-denied` unless the seat Chromium's credential policy is in effect
  (see below).

Immediately before `locator.fill(value)` the bridge re-reads the page origin
and checks that no main-frame navigation happened since the first check, even
one that came back to the same origin; either is `permission-denied` with
nothing typed. The fill waits at most 2 s (the element was already proven
fillable), and it starts only while at least that much of the request deadline
remains, so a request already answered with `timeout` never types later. If
the main frame navigates during the fill itself, the result is
`verification-failed`, never `{}`: the broker should treat that value as
possibly delivered elsewhere and rotate it.

Only the fill and the origin check after it may answer anything else, so a
broker never reads a pre-fill failure as "rotate it". Every failure before the
fill is `permission-denied`: no attachment, a detach racing the fill, a closed
page, a timeout, a dead provider, or any refused check. The only exception is
`invalid-request` for an unknown tab or a selector that does not parse or
match exactly one element. The work before the fill has its own budget: the
request deadline less the fill and the selection clear. At the budget it is
abandoned with `permission-denied`, stops at its next step, and never types.

A filled tab never outlives its lease. Before the value moves, the bridge
records the tab in three places:
- **In memory:** the Playwright Page together with the browser's target id.
  The target id stays the same across CDP connections, unlike the Page
  wrapper, so the tab is recognized after a reattach.
- **On tmpfs:** the target id in `/dev/shm/sandbar-bridge/filled-targets`, so
  a bridge process started after a crash knows it too. In the seat image
  `/run` is the overlay, not tmpfs, so the store uses `/dev/shm`. The store is
  a JSON list in a `0600` file inside a `0700` directory, both owned by the
  bridge's user. It is written atomically on every fill and every removal and
  loaded when the process first needs it. A store that exists but is not
  exactly that (another owner, wider modes, a symlink, malformed content)
  refuses `attach` with `verification-failed` and refuses fills.
- **In the document:** a non-enumerable, non-configurable main-world window
  property (`__sandbarCredentialFill`).

If any of these cannot be recorded, the fill is refused with
`permission-denied` and nothing is typed.

On `detach`, on EOF `shutdown`, and on every `attach` (before the new
attachment can list, select or observe anything), the bridge closes:
- every tab whose target id is recorded, whether or not it navigated since. A
  real login submit's tab is closed at release too; the session lives on in
  its cookies.
- every page whose document still carries the marker.
- while any filled tab is recorded, every page that can neither name its
  target nor answer the marker read, because it may be a recorded tab.
- at `attach`, any page on one of the new lease's origins that cannot answer
  the marker read.

A page is kept only when it is provably not a filled tab. Target ids also
change when Chromium discards and reloads a tab; the document marker and the
unanswerable-page rule are what cover that case. If a page that must close
cannot be closed, `attach` returns `verification-failed`. Before closing the
seat's last tab, the bridge opens a blank one, because headed Chromium quits
with its last window. Within the attachment that did the fill, the bridge
does not fence the tab; the daemon's lease fence covers that window.

The seat Chromium must not keep a typed value in its profile. The image ships
`/etc/chromium/policies/managed/sandbar.json`, the mandatory machine policy
directory of the image's Debian Chromium (verified on 156 in
`chrome://policy`):

| Policy | Value | Why |
|---|---|---|
| `PasswordManagerEnabled` | `false` | No offer to save the password |
| `PasswordLeakDetectionEnabled` | `false` | No leak-check upload of credentials |
| `AutofillAddressEnabled` | `false` | Deprecated in M156 but still applied |
| `AutofillCreditCardEnabled` | `false` | Deprecated in M156 but still applied |
| `AutofillSettings` | `[{"url_pattern": "*", "blocked_types": ["all"]}]` | The M156 replacement for the two above; blocks all Autofill saving |
| `RestoreOnStartup` | `5` | A started browser opens a new tab page, never the last session |

Without this policy, Chromium 156 stores a submitted username in the profile's
`Web Data` `autofill` table; with it, nothing is stored. `doctor` returns
`credentialPolicy: true` only when every file in that directory parses, each
key above is set to exactly that value, and no file contradicts it. It
reports nothing else about the policy. `credential-type` checks the same
before every fill.

Session restore is a separate store. Chromium writes each tab's form state,
never password fields, to `Default/Sessions/` and `Default/Sessions_Encrypted/`.
A filled login entry lands there once the tab moves on from it, for example
after a submit. The seat's `sandbar-browser` service therefore deletes both
directories (and the older `Current Session`, `Current Tabs`, `Last Session`
and `Last Tabs` files, which Chromium 156 no longer writes) before every
launch. It deletes them as `abc`, so a path planted in the profile cannot
steer a root removal. It then launches with `--hide-crash-restore-bubble`, so
an unclean exit is never followed by an offer to restore.

Sites that offer a passkey first (Google) open a native WebAuthn prompt that
nobody watching the seat can see or dismiss. Set `SANDBAR_BROWSER_WEBAUTHN=off`
on the seat container and the service adds `--disable-blink-features=WebAuth`,
which removes `PublicKeyCredential` from every page, so the site falls back to
a password. The default is `on`; any other value stops the service.

No value is left in a selection buffer either. On X11, selecting a filled
field publishes it as PRIMARY, and a cut (Shift+Delete) puts it in CLIPBOARD;
both outlive the tab. The bridge clears both selections on the seat display
`:1` after every dispatched fill (whatever its outcome), on `detach`, on EOF
`shutdown` (attached or not), and on `attach` before any page observer exists
or a page is listed. It runs fixed `/usr/bin/xsel --clipboard|--primary
--clear` argv, which sets each owner to None so Chromium drops its own copy,
then reads each selection back and requires it empty. The read-back bytes are
only measured, never returned or logged. Each clear is bounded (1 s per xsel
call, 5 s in total). At `attach`, a clear that fails or times out returns
`verification-failed`. After a fill, at `detach` and at `shutdown` it is best
effort, and the next `attach` clears again. CDP has no clipboard command short
of granting page script clipboard permissions, so the clear works at the X
level. In headed X11 Chromium that empties the browser's clipboard too. The
bridge cannot reach a copy the stream server (Selkies) has already synced to a
connected viewer, nor one a viewer later pushes back into the seat.

The value never appears in a result, error code or log line: failures map to
the existing codes only, and the bridge writes nothing but protocol responses.
The bridge cannot stop the page itself from revealing a value after the fill
(a "show password" toggle a later `click` flips, a page that logs or submits
it), so the daemon should keep agent input and observation off the tab while a
credential lease is active.

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
