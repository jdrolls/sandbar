import { createHash, randomBytes } from "node:crypto";
import * as childProcess from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function execFile(file: string, args: string[], options: ExecFileOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    childProcess.execFile(file, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout));
    });
  });
}
const MAX_LINE_BYTES = 1024 * 1024;
// Upload payloads are the sole binary exception to the 1 MiB command-line limit.
const MAX_UPLOAD_LINE_BYTES = Math.ceil(5 * 1024 * 1024 * 4 / 3) + 4096;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_EVENTS = 200;
const MAX_SELECTOR = 1024;
const MAX_INPUT = 16 * 1024;
// The control daemon aborts a request after 30 s. Every browser wait finishes
// well inside that window so the bridge answers with a typed error first:
// Playwright action waits at 20 s (daemon timeout minus a 10 s margin) and a
// per-request deadline at 25 s for operations that carry no Playwright timeout.
const DAEMON_REQUEST_TIMEOUT_MS = 30_000;
const ACTION_WAIT_MS = DAEMON_REQUEST_TIMEOUT_MS - 10_000;
const REQUEST_DEADLINE_MS = DAEMON_REQUEST_TIMEOUT_MS - 5_000;
const DEADLINE_OPERATIONS: ReadonlySet<string> = new Set(["open", "tab-open", "tab-select", "snapshot", "click", "type", "select", "key", "scroll", "wait", "screenshot", "layout", "viewport", "upload", "committed-origin", "credential-type"]);
const MAX_DRAIN_MS = 5_000;
// A qa-layout click keeps its navigation fence armed this long after the click
// resolves: an off-origin navigation or popup may start just after the event.
const CLICK_SETTLE_MS = 500;
// `qa-layout` narrows page input to a plain selector click, scroll and viewport.
export type InputScope = "full" | "qa-layout";
// Off-lease requests a qa-layout attach may let through to a listed subresource
// origin: plain GET loads of these Playwright resource types, never navigation.
const SUBRESOURCE_TYPES: ReadonlySet<string> = new Set(["stylesheet", "font", "image"]);
const QA_LAYOUT_DENIED: ReadonlySet<string> = new Set(["type", "select", "key", "upload", "committed-origin", "credential-type", "desktop-screenshot", "desktop-click", "desktop-type", "desktop-key", "desktop-scroll", "desktop-launch", "desktop-windows", "desktop-activate"]);
// credential-type types a broker-held secret into one main-frame <input>. The
// value never leaves the bridge: the only result is {} or a safe error code.
export type CredentialField = "username" | "password" | "totp";
// Compared with the browser-normalized HTMLInputElement.type, so a missing,
// empty or unknown type attribute is "text", exactly as the page renders it.
const CREDENTIAL_INPUT_TYPES: Readonly<Record<CredentialField, ReadonlySet<string>>> = {
  password: new Set(["password"]),
  username: new Set(["text", "email", "tel"]),
  totp: new Set(["text", "tel", "number"]),
};
const MAX_CREDENTIAL_VALUE = 1024;
// Lowercased substrings that chain selector parts or enter a frame. Without
// `>>` and `internal:` a Playwright selector is one part, which cannot leave
// the main frame's document (frame entry is `internal:control=enter-frame`).
const CREDENTIAL_SELECTOR_DENIED: readonly string[] = [">>", "internal:", "control=", "enter-frame", "any-frame"];
// The element is proven visible, enabled and editable just before the fill, so
// the fill needs no actionability wait. A short cap keeps the window in which
// Playwright re-resolves the selector (and a navigation could land) small.
const CREDENTIAL_FILL_WAIT_MS = 2_000;
// A fill starts only while the fill and the bounded selection clear after it
// still fit in the request deadline, so an abandoned request can never type
// after its timeout was answered, and a successful one answers {} in time.
// A page that may hold an unsubmitted credential carries this main-world window
// property. It lives in the document, so it survives the bridge process dying
// and a cross-document main-frame navigation (a real submit) removes it. Each
// read is bounded so one wedged page cannot stall attach, detach or shutdown.
const CREDENTIAL_MARKER = "__sandbarCredentialFill";
const CREDENTIAL_MARKER_WAIT_MS = 2_000;
// Serialized into the page by page.evaluate; both close over nothing. The marker
// is non-configurable, so page script cannot delete or redefine it afterwards.
export function writeCredentialMarker(key: string): boolean {
  Object.defineProperty(globalThis, key, { value: true, enumerable: false, configurable: false, writable: false });
  return Object.getOwnPropertyDescriptor(globalThis, key)?.value === true;
}
// Any own property under the key counts as marked: a page can only fail closed.
export function readCredentialMarker(key: string): boolean { return Object.getOwnPropertyDescriptor(globalThis, key) !== undefined; }
// formMethod is "none" (no form owner), the form's effective method, or "get"
// when any associated submitter overrides it with formmethod=get. It reads
// through the window's own prototypes, so a control named "method" or
// "elements" cannot clobber the answer; anything unreadable is "unknown".
export interface CredentialFieldFacts { input: boolean; type: string; topDocument: boolean; connected: boolean; disabled: boolean; readOnly: boolean; formMethod: string }
// Only these form methods may receive a credential: a GET submission puts the
// field's value in the URL, so the next document (and history) echoes it.
const CREDENTIAL_FORM_METHODS: ReadonlySet<string> = new Set(["none", "post", "dialog"]);
// Serialized into the page by locator.evaluate, so it closes over nothing and
// reads only the element and its own document and window.
export function probeCredentialField(element: any): CredentialFieldFacts {
  const doc = element?.ownerDocument;
  const view = doc?.defaultView;
  let formMethod = "unknown";
  try {
    const form = element?.form;
    if (form === null) formMethod = "none";
    else if (form) {
      const methodOf = Object.getOwnPropertyDescriptor(view.HTMLFormElement.prototype, "method")?.get;
      formMethod = String(methodOf.call(form)).toLowerCase();
      // Every submitter of this form, inside it or linked by a form= attribute.
      const submitters: any[] = Array.from(view.Document.prototype.querySelectorAll.call(doc, "[formmethod]"));
      for (const submitter of submitters) {
        if (submitter.form === form && String(submitter.formMethod).toLowerCase() !== "post" && String(submitter.formMethod).toLowerCase() !== "dialog") formMethod = "get";
      }
    }
  } catch { formMethod = "unknown"; }
  return {
    formMethod,
    input: element?.namespaceURI === "http://www.w3.org/1999/xhtml" && element?.localName === "input",
    type: String(element?.type ?? "").toLowerCase(),
    topDocument: Boolean(view) && view.top === view && view.document === doc,
    connected: element?.isConnected === true,
    // Fail closed when the element cannot answer: unknown counts as disabled.
    disabled: typeof element?.matches === "function" ? Boolean(element.matches(":disabled")) : true,
    readOnly: element?.readOnly === true || (typeof element?.hasAttribute === "function" && Boolean(element.hasAttribute("readonly"))),
  };
}
const LAYOUT_KEYS = ["scrollWidth", "scrollHeight", "clientWidth", "clientHeight", "innerWidth", "innerHeight"] as const;
const MAX_VIEWPORT = { width: 7680, height: 7680 };
const MAX_NATIVE_WINDOWS = 4;
const MAX_NATIVE_TEXT = 4096;
const NATIVE_WINDOW_WAIT_MS = 5_000;
const NATIVE_POLL_MS = 100;
// X selections on the seat display. A cut or a plain selection of a filled
// field lands the value in CLIPBOARD or PRIMARY, which outlive the tab. The
// image's xsel (1.2.1) clears each by setting its owner to None, which makes
// the owning client (Chromium) drop its copy, then reads it back to confirm.
const SEAT_DISPLAY = ":1";
const SEAT_XSEL = "/usr/bin/xsel";
const SELECTION_COMMAND_TIMEOUT_MS = 1_000;
const SELECTION_READBACK_TIMEOUT_MS = 500;
const MAX_SELECTION_READBACK = 64 * 1024;
const CDP_METADATA_URL ="http://127.0.0.1:9222/json/version";
const MAX_CDP_METADATA_BYTES = 16 * 1024;
const CDP_METADATA_TIMEOUT_MS = 5_000;
const opaqueId = (): string => createHash("sha256").update(randomBytes(32)).digest("hex");
const stableHash = (value: string): string => createHash("sha256").update(value).digest("hex");
const hash = (value: string): string => stableHash(value).slice(0, 24);

export type ErrorCode = "provider-unavailable" | "needs-human-auth" | "human-control" | "busy" | "permission-denied" | "stale-owner" | "session-lost" | "unsupported-capability" | "verification-failed" | "invalid-request" | "timeout";
export interface BridgeResponse { id: string; ok: boolean; result?: Record<string, unknown>; code?: ErrorCode }
// This is intentionally an already-opaque identity. Adapters must never pass
// a debugger URL or endpoint UUID through the bridge response surface.
export interface BrowserAdapterIdentity { browserId: string }
export interface LaunchedMousepad {
  // This process capability is private to the bridge. It is never returned to
  // protocol callers, which receive only opaque X11 window identifiers.
  pid: number;
  terminate(): Promise<void>;
  // NodeAdapter binds this to its ChildProcess lifecycle. Optional preserves
  // the narrow test-adapter seam, while production never accepts a dead child.
  isAlive?(): boolean;
}
type NativeInputOperation = "type" | "key" | "click" | "scroll";
export interface BridgeAdapter {
  connect(): Promise<any>;
  browserIdentity(): Promise<BrowserAdapterIdentity>;
  display(): Promise<{ width: number; height: number }>;
  desktop(command: string, args: string[], maxBytes?: number): Promise<Buffer>;
  nativeInput(expectedXWindowId: string, expectedPid: number, operation: NativeInputOperation, values: string[]): Promise<void>;
  // EOF invokes this when available so a still-running helper cannot retain a
  // server grab until its normal timeout.
  cancelNativeInputs?(): void;
  launchMousepad(): Promise<LaunchedMousepad>;
  // Empties the seat display's CLIPBOARD and PRIMARY selections and confirms
  // both read back empty; rejects otherwise. Never returns selection contents.
  clearSelections(): Promise<void>;
  // True only when the seat Chromium's managed policy (CREDENTIAL_POLICY)
  // is installed as required; it never returns policy contents.
  credentialPolicy(): Promise<boolean>;
}

// The directory Debian's Chromium (the seat's browser) reads mandatory
// machine policy from; verified against Chromium 156 via chrome://policy.
export const CHROMIUM_MANAGED_POLICY_DIR = "/etc/chromium/policies/managed";
// The image ships these in desktop/root/etc/chromium/policies/managed/sandbar.json.
// No password manager, leak check upload, address/card autofill, or (via
// AutofillSettings "all", the M156 replacement for the two deprecated
// booleans) any other Autofill saving, so a typed credential stays out of the
// profile.
export const CREDENTIAL_POLICY: Readonly<Record<string, unknown>> = {
  PasswordManagerEnabled: false,
  PasswordLeakDetectionEnabled: false,
  AutofillAddressEnabled: false,
  AutofillCreditCardEnabled: false,
  AutofillSettings: [{ url_pattern: "*", blocked_types: ["all"] }],
  // Session restore stores typed usernames and TOTP codes; a restarted seat must open a new tab page, never reopen a filled form.
  RestoreOnStartup: 5,
};
const MAX_POLICY_FILES = 32;
const MAX_POLICY_FILE_BYTES = 64 * 1024;
// Chromium merges every file in the directory, so the policy holds only when
// each required key is set to its value somewhere and no file sets it to
// anything else. Any unreadable or non-object document fails closed.
export function credentialPolicyHolds(documents: readonly unknown[]): boolean {
  const records: Record<string, unknown>[] = [];
  for (const document of documents) {
    if (!document || typeof document !== "object" || Array.isArray(document)) return false;
    records.push(document as Record<string, unknown>);
  }
  return Object.entries(CREDENTIAL_POLICY).every(([key, required]) => {
    const values = records.filter((record) => Object.hasOwn(record, key)).map((record) => JSON.stringify(record[key]));
    return values.length > 0 && values.every((value) => value === JSON.stringify(required));
  });
}
export async function readCredentialPolicy(directory = CHROMIUM_MANAGED_POLICY_DIR): Promise<boolean> {
  try {
    const entries = await fs.readdir(directory);
    if (entries.length > MAX_POLICY_FILES) return false;
    const documents: unknown[] = [];
    for (const entry of entries) {
      // stat follows a symlinked policy file, as Chromium does.
      const path = join(directory, entry);
      const info = await fs.stat(path);
      if (!info.isFile()) continue;
      if (info.size > MAX_POLICY_FILE_BYTES) return false;
      documents.push(JSON.parse(await fs.readFile(path, "utf8")));
    }
    return credentialPolicyHolds(documents);
  } catch { return false; }
}

// Clears CLIPBOARD and PRIMARY with fixed xsel argv, then reads each back and
// requires it empty. The read-back bytes are only measured, then dropped.
export async function clearSeatSelections(xsel = SEAT_XSEL, display = SEAT_DISPLAY): Promise<void> {
  const options: ExecFileOptions = { encoding: "buffer", timeout: SELECTION_COMMAND_TIMEOUT_MS, maxBuffer: MAX_SELECTION_READBACK, env: { PATH: "/usr/bin:/bin", DISPLAY: display, HOME: "/config" } };
  for (const selection of ["--clipboard", "--primary"]) {
    await execFile(xsel, [selection, "--clear"], options);
    const remaining = await execFile(xsel, [selection, "--output", "--selectionTimeout", String(SELECTION_READBACK_TIMEOUT_MS)], options);
    if (remaining.length > 0) throw new Error("selection not empty after clear");
  }
}

class BridgeFailure extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

function fail(code: ErrorCode): never { throw new BridgeFailure(code); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-request"); return value as Record<string, unknown>; }
function string(value: unknown, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) fail("invalid-request"); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") fail("invalid-request"); return value; }
function number(value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail("invalid-request"); return value; }
function only(args: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(args).some((key) => !keys.includes(key))) fail("invalid-request"); }
// Aria snapshots print a field's current value after its name ("- textbox \"Email\": a@b.test") and each
// link's href as a "- /url:" child; text snapshots carry neither, so field values are replaced and
// hrefs (which can hold tokens) are dropped (sandbar i12).
const ARIA_VALUE_ROLE = "(?:textbox|searchbox|combobox|spinbutton|slider)";
// A key is either bare (`textbox "Name" [state]`) or, when the name holds YAML-significant text such as
// ": " or " #", single-quoted as a whole with '' escapes (`'textbox "Email: work"'`).
const ARIA_VALUE_ROLES = new RegExp(`^(\\s*- (?:${ARIA_VALUE_ROLE}(?: "(?:[^"\\\\]|\\\\.)*")?(?: \\[[^\\]\\n]*\\])*|'${ARIA_VALUE_ROLE}(?:[^'\\n]|'')*')):[ \\t]*\\S.*$`, "gm");
const ARIA_URL_PROPERTY = /^\s*- \/url:.*(?:\n|$)/gm;
export function redactAriaValues(tree: string): string { return tree.replace(ARIA_URL_PROPERTY, "").replace(ARIA_VALUE_ROLES, (_line, head: string) => `${head}: [redacted]`); }
function truncate(value: string, max = MAX_TEXT): string { return value.length > max ? value.slice(0, max) : value; }
function opaque(value: unknown): string { const id = string(value, 128); if (!/^[A-Za-z0-9_-]+$/.test(id)) fail("invalid-request"); return id; }
function safeError(error: unknown): ErrorCode {
  if (error instanceof BridgeFailure) return error.code;
  // Playwright's TimeoutError (a locator that never resolves, a navigation that
  // never commits) is a typed, retryable outcome rather than a dead provider.
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  // A selector that matches several elements (strict mode) or does not parse is
  // the caller's mistake, not a dead seat. Checked first because a strict-mode
  // message lists the matched elements, whose markup may say "closed".
  if (message.includes("strict mode violation") || /while parsing (css )?selector|is not a valid selector/.test(message)) return "invalid-request";
  if (message.includes("target page") || message.includes("closed") || message.includes("detached")) return "session-lost";
  return "provider-unavailable";
}
function b64(buffer: Buffer): string { if (buffer.byteLength > MAX_BINARY_BYTES) fail("verification-failed"); return buffer.toString("base64"); }

interface NativeWindow {
  opaqueId: string;
  xWindowId: string;
  pid: number;
}

interface NativeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Attachment {
  browser: any;
  context: any;
  origins: Set<string>;
  // qa-layout only: off-lease origins that may serve GET stylesheet/font/image loads.
  subresourceOrigins: Set<string>;
  allowInput: boolean;
  allowMutations: boolean;
  allowObservation: boolean;
  inputScope: InputScope;
  // Holds the fence of the qa-layout click in progress, if any; see clickFenced().
  clickFence: { current?: ClickFence };
  routeHandler: (route: any) => Promise<void>;
  webSocketHandler: (route: any) => Promise<void>;
  requestHandler?: (request: any) => void;
  responseHandler?: (response: any) => void;
  serviceWorkerHandler?: (worker: any) => void;
  pageHandler?: (page: any) => void;
  // Pages present before the lease are human-owned. Keep out-of-scope ones
  // intact and unobserved; only pages created while leased can be popup-fenced.
  preexistingPages: Set<any>;
  pageHandlers: Map<any, { consoleHandler?: (message: any) => void; downloadHandler?: (download: any) => void; frameHandler?: (frame: any) => void }>;
}

interface ClickFence { violated: boolean; pages: Set<any> }

export class BrowserBridge {
  private attachment?: Attachment;
  private readonly pageIds = new WeakMap<object, string>();
  private readonly pages = new Map<string, any>();
  private readonly consoleEvents: Record<string, unknown>[] = [];
  private readonly networkEvents: Record<string, unknown>[] = [];
  // `bytes` is internal accounting only; responses expose only the opaque tab
  // id, sanitized metadata, and complete base64 payload.
  private readonly downloads: Array<{ tabId: string; name: string; mimeType: string; data: string; bytes: number }> = [];
  private readonly browserIds = new WeakMap<object, string>();
  private readonly contextIds = new WeakMap<object, string>();
  // Native state is deliberately separate from CDP state. It only ever holds
  // Mousepad windows started by this bridge on the fixed :1 display.
  private readonly nativeWindows = new Map<string, NativeWindow>();
  // Keep a capability for every process the bridge itself started. Native
  // window discovery is asynchronous, so ownership begins before an X11
  // window exists and ends only after explicit cleanup.
  private readonly launchedMousepads = new Map<number, LaunchedMousepad>();
  // Every tab this process filled, closed at detach, shutdown and the next
  // attach whether or not it navigated since. Page wrappers are per CDP
  // connection, so each is kept with its browser target id, and the target ids
  // outlive a reattach. The document marker covers a process that died.
  private readonly filledPages = new Map<object, string>();
  private readonly filledTargets = new Set<string>();
  private selectedTabId?: string;
  private dispatch: Promise<void> = Promise.resolve();
  private ending = false;

  constructor(private readonly adapter: BridgeAdapter, private readonly requestDeadlineMs = REQUEST_DEADLINE_MS, private readonly clickSettleMs = CLICK_SETTLE_MS, private readonly selectionClearMs = MAX_DRAIN_MS) {}

  handle(request: unknown): Promise<BridgeResponse> {
    if (this.ending) return Promise.resolve({ id: "invalid", ok: false, code: "session-lost" });
    // The stdio reader can receive lines faster than Playwright settles them.
    // Serializing here makes detach a fence for every operation, not merely a
    // best-effort race with an already-dispatched command.
    const response = this.dispatch.then(() => this.handleOne(request));
    this.dispatch = response.then(() => undefined, () => undefined);
    return response;
  }

  private async handleOne(request: unknown): Promise<BridgeResponse> {
    let id = "invalid";
    try {
      const input = record(request);
      only(input, ["id", "operation", "args"]);
      id = opaque(input.id);
      const operation = string(input.operation, 64);
      const args = record(input.args);
      const result = await this.withDeadline(operation, () => this.operation(operation, args));
      return { id, ok: true, result };
    } catch (error) {
      return { id, ok: false, code: safeError(error) };
    }
  }

  // Requests are serialized, so one wedged page call would stall every later
  // request (including doctor and detach) behind it. Answer with a typed timeout
  // before the daemon's own deadline and let the abandoned call settle alone.
  private async withDeadline<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (!DEADLINE_OPERATIONS.has(operation)) return work();
    const running = work();
    running.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([running, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new BridgeFailure("timeout")), this.requestDeadlineMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async operation(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // qa-layout is a scope, not a grant: allowInput cannot widen it.
    if (this.attachment?.inputScope === "qa-layout" && QA_LAYOUT_DENIED.has(operation)) fail("permission-denied");
    switch (operation) {
      case "attach": return this.attach(args);
      case "detach": return this.detach(args);
      case "doctor": return this.doctor(args);
      case "open": return this.open(args, false);
      case "tab-open": return this.open(args, true);
      case "tabs": return this.tabs(args);
      case "tab-select": return this.tabSelect(args);
      case "snapshot": return this.snapshot(args);
      case "click": return this.click(args);
      case "type": return this.type(args);
      case "select": return this.select(args);
      case "key": return this.key(args);
      case "scroll": return this.scroll(args);
      case "wait": return this.wait(args);
      case "screenshot": return this.screenshot(args);
      case "layout": return this.layout(args);
      case "console": return this.events(args, "console");
      case "network": return this.events(args, "network");
      case "viewport": return this.viewport(args);
      case "upload": return this.upload(args);
      case "committed-origin": return this.committedOrigin(args);
      case "credential-type": return this.credentialType(args);
      case "downloads": return this.downloadList(args);
      case "desktop-screenshot": return this.desktopScreenshot(args);
      case "desktop-click": return this.desktopClick(args);
      case "desktop-type": return this.desktopType(args);
      case "desktop-key": return this.desktopKey(args);
      case "desktop-scroll": return this.desktopScroll(args);
      case "desktop-launch": return this.desktopLaunch(args);
      case "desktop-windows": return this.desktopWindows(args);
      case "desktop-activate": return this.desktopActivate(args);
      case "record": case "replay": case "motion": only(args, []); fail("unsupported-capability");
      default: fail("invalid-request");
    }
  }

  private requireAttachment(): Attachment { if (!this.attachment) fail("session-lost"); return this.attachment; }
  private requireObservation(): Attachment { const attached = this.requireAttachment(); if (!attached.allowObservation) fail("permission-denied"); return attached; }
  private requireInput(): Attachment { const attached = this.requireAttachment(); if (!attached.allowInput) fail("permission-denied"); return attached; }
  private pageId(page: any): string {
    let id = this.pageIds.get(page);
    if (!id) { id = opaqueId(); this.pageIds.set(page, id); }
    // clearBuffers deliberately clears the strong lookup map. Re-registering
    // the stable weak-map id prevents a surviving Page from becoming unknown.
    this.pages.set(id, page);
    return id;
  }
  private pageOrigin(page: any): string | undefined {
    try { return new URL(String(page.url())).origin; } catch { return undefined; }
  }
  private pageIsApproved(page: any, attached: Attachment): boolean { return attached.origins.has(this.pageOrigin(page) ?? ""); }
  private pageIsPristineAboutBlank(page: any): boolean {
    try { return String(page.url()) === "about:blank"; } catch { return false; }
  }
  private approvedPage(tabId: unknown): any {
    const attached = this.requireAttachment();
    const id = tabId === undefined ? this.selectedTabId : opaque(tabId);
    if (!id) fail("invalid-request");
    const page = this.pages.get(id);
    if (!page) fail("invalid-request");
    if (!this.pageIsApproved(page, attached)) fail("permission-denied");
    return page;
  }
  private adapterBrowserId(identity: BrowserAdapterIdentity): string {
    if (!identity || typeof identity !== "object" || Array.isArray(identity) || Object.keys(identity).length !== 1) fail("provider-unavailable");
    const browserId = (identity as { browserId?: unknown }).browserId;
    // The adapter contract requires a SHA-256 digest, not a raw CDP endpoint.
    if (typeof browserId !== "string" || !/^[a-f0-9]{64}$/.test(browserId)) fail("provider-unavailable");
    return browserId;
  }
  private contextId(browserId: string): string {
    // A single context is verified immediately before this value is returned.
    // It therefore names the default context of this browser, rather than the
    // transient Playwright wrapper created for an individual CDP connection.
    return stableHash(`default-context:${browserId}`);
  }
  private async closeConnection(browser: any): Promise<void> {
    // Playwright Browser has close(); for a browser returned by
    // connectOverCDP it closes only the client connection, not Chromium.
    if (typeof browser.close !== "function") fail("unsupported-capability");
    await browser.close();
  }
  private async bounded<T>(work: Promise<T>, code: ErrorCode, limitMs = MAX_DRAIN_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new BridgeFailure(code)), limitMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private assertUrl(value: unknown, origins: Set<string>): string {
    const raw = string(value, 2048);
    let url: URL;
    try { url = new URL(raw); } catch { fail("invalid-request"); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !origins.has(url.origin)) fail("permission-denied");
    return url.href;
  }
  private validateOrigins(value: unknown): Set<string> {
    if (!Array.isArray(value) || value.length === 0 || value.length > 32) fail("invalid-request");
    const origins = new Set<string>();
    for (const candidate of value) {
      const raw = string(candidate, 256);
      let url: URL;
      try { url = new URL(raw); } catch { fail("invalid-request"); }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== raw || url.username || url.password || url.search || url.hash) fail("invalid-request");
      origins.add(url.origin);
    }
    return origins;
  }

  private async attach(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["origins", "allowInput", "allowMutations", "allowObservation", "inputScope", "subresourceOrigins"]);
    if (this.attachment) fail("busy");
    if (process.env.SANDBAR_SHARED_BROWSER !== "1" || process.env.SANDBAR_BROWSER_SANDBOX !== "namespace") fail("verification-failed");
    const origins = this.validateOrigins(args.origins);
    const allowInput = bool(args.allowInput); const allowMutations = bool(args.allowMutations); const allowObservation = bool(args.allowObservation);
    const inputScope = this.inputScope(args.inputScope);
    if (inputScope === "qa-layout" && allowMutations) fail("invalid-request");
    // Subresource origins widen only what a qa-layout page may load, so they
    // are meaningless (and refused) for any other scope.
    if (args.subresourceOrigins !== undefined && inputScope !== "qa-layout") fail("invalid-request");
    const subresourceOrigins = args.subresourceOrigins === undefined ? new Set<string>() : this.validateOrigins(args.subresourceOrigins);
    const clickFence: { current?: ClickFence } = {};
    const display = await this.adapter.display();
    if (display.width < 1 || display.height < 1) fail("verification-failed");
    const browser = await this.adapter.connect();
    const contexts = browser.contexts();
    if (!Array.isArray(contexts) || contexts.length !== 1) { await this.closeConnection(browser).catch(() => undefined); fail("provider-unavailable"); }
    const context = contexts[0];
    // Playwright 1.63 exposes route/unroute for HTTP and routeWebSocket for
    // WebSockets, but intentionally has no unrouteWebSocket. Closing a Browser
    // returned by connectOverCDP is the supported client-disconnect lifecycle;
    // it tears down both route registrations without closing Chromium.
    if (typeof context.route !== "function" || typeof context.unroute !== "function" || typeof context.routeWebSocket !== "function" || typeof context.serviceWorkers !== "function") {
      await this.closeConnection(browser).catch(() => undefined); fail("unsupported-capability");
    }
    let workers: any[];
    try { workers = context.serviceWorkers(); } catch { await this.closeConnection(browser).catch(() => undefined); fail("provider-unavailable"); }
    if (!Array.isArray(workers)) { await this.closeConnection(browser).catch(() => undefined); fail("provider-unavailable"); }
    // BrowserContext routes do not reliably intercept service-worker traffic.
    // Existing workers are therefore incompatible with this restricted client.
    // Check worker origins before rejecting so a foreign worker cannot be
    // mistaken for an approved context state.
    for (const worker of workers) {
      if (!origins.has(this.workerOrigin(worker))) { await this.closeConnection(browser).catch(() => undefined); fail("permission-denied"); }
    }
    if (workers.length > 0) { await this.closeConnection(browser).catch(() => undefined); fail("verification-failed"); }
    // A tab that received a credential (from an earlier lease of this process,
    // navigated or not, or marked by a bridge process that died) is closed
    // before this attachment can list, select or observe it. A leased-origin
    // page that cannot answer is treated as marked; one that cannot be closed
    // refuses the attach.
    try { await this.closeCredentialPages(context, (page) => origins.has(this.pageOrigin(page) ?? "")); }
    catch { await this.closeConnection(browser).catch(() => undefined); fail("verification-failed"); }
    // An earlier lease may have cut or selected a value into the seat's X
    // selections. They must be empty before this attachment can paste;
    // a selection that cannot be cleared refuses the attach.
    try { await this.clearSelections(); }
    catch { await this.closeConnection(browser).catch(() => undefined); fail("verification-failed"); }
    const routeHandler = async (route: any): Promise<void> => {
      const request = route.request();
      let url: URL;
      try { url = new URL(request.url()); } catch { await route.abort(); return; }
      const allowed = origins.has(url.origin) ? allowMutations || ["GET", "HEAD"].includes(String(request.method()).toUpperCase()) : this.isListedSubresource(request, url, subresourceOrigins);
      if (!allowed) {
        if (clickFence.current && this.isTopLevelNavigation(request)) clickFence.current.violated = true;
        await route.abort(); return;
      }
      await route.continue();
    };
    // WebSocketRoute has close(), not Route.abort(). Closing before a server
    // connection is made is the supported Playwright websocket denial path.
    const webSocketHandler = async (route: any): Promise<void> => {
      if (typeof route.close !== "function") fail("unsupported-capability");
      await route.close();
    };
    try {
      await context.route("**/*", routeHandler);
      await context.routeWebSocket("**/*", webSocketHandler);
    } catch {
      await context.unroute("**/*", routeHandler).catch(() => undefined);
      await this.closeConnection(browser).catch(() => undefined);
      fail("provider-unavailable");
    }
    const attachment: Attachment = { browser, context, origins, subresourceOrigins, allowInput, allowMutations, allowObservation, inputScope, clickFence, routeHandler, webSocketHandler, preexistingPages: new Set(context.pages()), pageHandlers: new Map() };
    this.attachment = attachment;
    this.clearBuffers();
    for (const page of context.pages()) this.pageId(page);
    this.installObservers(attachment);
    return { attached: true, pageCount: context.pages().filter((page: any) => this.pageIsApproved(page, attachment)).length };
  }

  private inputScope(value: unknown): InputScope {
    if (value === undefined || value === "full") return "full";
    if (value === "qa-layout") return "qa-layout";
    fail("invalid-request");
  }
  // Fail closed: any request detail that cannot be read keeps the abort.
  private isListedSubresource(request: any, url: URL, subresourceOrigins: Set<string>): boolean {
    if (!subresourceOrigins.has(url.origin)) return false;
    try { return String(request.method()).toUpperCase() === "GET" && SUBRESOURCE_TYPES.has(String(request.resourceType())) && request.isNavigationRequest() === false; } catch { return false; }
  }
  private isTopLevelNavigation(request: any): boolean {
    // Fail toward a violation: a navigation whose frame cannot be inspected is
    // treated as top-level.
    try { return Boolean(request.isNavigationRequest?.()) && !request.frame?.()?.parentFrame?.(); } catch { return true; }
  }
  private installObservers(attached: Attachment): void {
    attached.requestHandler = (request: any): void => {
      if (this.attachment !== attached || !attached.allowObservation || !attached.origins.has(this.requestOrigin(request))) return;
      this.push(this.networkEvents, { tabId: this.eventTabId(request), phase: "request", method: truncate(String(request.method?.() ?? "GET").toUpperCase(), 12), urlHash: hash(String(request.url?.() ?? "")) });
    };
    attached.responseHandler = (response: any): void => {
      const request = response.request?.();
      if (this.attachment !== attached || !attached.allowObservation || !attached.origins.has(this.requestOrigin(response))) return;
      this.push(this.networkEvents, { tabId: this.eventTabId(request), phase: "response", status: Number(response.status?.() ?? 0), method: truncate(String(request?.method?.() ?? "GET").toUpperCase(), 12), urlHash: hash(String(response.url?.() ?? "")) });
    };
    attached.serviceWorkerHandler = (worker: any): void => {
      if (this.attachment !== attached) return;
      // BrowserContext routes do not cover service workers. Validate the worker
      // origin and fence the connection even for an approved worker: either can
      // issue requests outside the HTTP route policy.
      const origin = this.workerOrigin(worker);
      if (!attached.origins.has(origin)) {
        this.attachment = undefined;
        this.nativeWindows.clear();
        this.clearBuffers();
        void this.closeConnection(attached.browser).catch(() => undefined);
        return;
      }
      this.attachment = undefined;
      this.nativeWindows.clear();
      this.clearBuffers();
      void this.closeConnection(attached.browser).catch(() => undefined);
    };
    attached.pageHandler = (page: any): void => {
      attached.clickFence.current?.pages.add(page);
      this.installPageBoundary(attached, page, !attached.preexistingPages.has(page));
    };
    attached.context.on("serviceworker", attached.serviceWorkerHandler);
    attached.context.on("page", attached.pageHandler);
    attached.context.on("request", attached.requestHandler);
    attached.context.on("response", attached.responseHandler);
    for (const page of attached.context.pages()) this.installPageBoundary(attached, page, !attached.preexistingPages.has(page));
  }
  private requestOrigin(request: any): string {
    try { return new URL(String(request.url?.() ?? "")).origin; } catch { return ""; }
  }
  private workerOrigin(worker: any): string {
    try { return new URL(String(worker.url?.() ?? "")).origin; } catch { return ""; }
  }
  private eventTabId(request: any): string | undefined {
    try { const page = request?.frame?.()?.page?.(); return page ? this.pageId(page) : undefined; } catch { return undefined; }
  }
  private installPageBoundary(attached: Attachment, page: any, closeUnapproved: boolean): void {
    this.pageId(page);
    if (attached.pageHandlers.has(page)) return;
    const handlers: { consoleHandler?: (message: any) => void; downloadHandler?: (download: any) => void; frameHandler?: (frame: any) => void } = {};
    handlers.frameHandler = (frame: any): void => {
      if (this.attachment !== attached || frame !== page.mainFrame?.()) return;
      if (!this.pageIsApproved(page, attached)) {
        if (closeUnapproved) void page.close?.({ runBeforeUnload: false }).catch(() => undefined);
      } else this.installApprovedPageObservers(attached, page, handlers);
    };
    page.on?.("framenavigated", handlers.frameHandler);
    attached.pageHandlers.set(page, handlers);
    if (this.pageIsApproved(page, attached)) this.installApprovedPageObservers(attached, page, handlers);
    // A popup cannot escape the origin policy: the network route aborts it,
    // then this navigation fence closes the unapproved page if it still exists.
    // The browser's initial pristine about:blank page is retained solely as a
    // safe destination for the first approved navigation.
    if (closeUnapproved && !this.pageIsApproved(page, attached) && !this.pageIsPristineAboutBlank(page) && this.pageOrigin(page)) void page.close?.({ runBeforeUnload: false }).catch(() => undefined);
  }
  private installApprovedPageObservers(attached: Attachment, page: any, handlers: { consoleHandler?: (message: any) => void; downloadHandler?: (download: any) => void }): void {
    if (!attached.allowObservation || handlers.consoleHandler) return;
    handlers.consoleHandler = (message: any): void => {
      if (this.attachment === attached && this.pageIsApproved(page, attached)) this.push(this.consoleEvents, { tabId: this.pageId(page), type: truncate(String(message.type?.() ?? "log"), 32), hash: hash(truncate(String(message.text?.() ?? ""), MAX_TEXT)) });
    };
    handlers.downloadHandler = (download: any): void => { void this.captureDownload(attached, page, download); };
    page.on?.("console", handlers.consoleHandler);
    page.on?.("download", handlers.downloadHandler);
  }
  private async captureDownload(attached: Attachment, page: any, download: any): Promise<void> {
    try {
      if (this.attachment !== attached || !this.pageIsApproved(page, attached)) return;
      const stream = await download.createReadStream(); if (!stream) return;
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) {
        const part = Buffer.from(chunk);
        size += part.length;
        if (size > MAX_BINARY_BYTES) {
          // Do not leave an over-limit artifact downloading after refusing it.
          // Download.cancel is a public Playwright API and never exposes its
          // browser-side path.
          if (typeof download.cancel === "function") await download.cancel();
          return;
        }
        chunks.push(part);
      }
      // A detach or cross-origin navigation while reading must discard bytes.
      if (this.attachment !== attached || !this.pageIsApproved(page, attached)) return;
      const name = String(download.suggestedFilename?.() ?? "download").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "download";
      this.downloads.push({ tabId: this.pageId(page), name, mimeType: "application/octet-stream", data: b64(Buffer.concat(chunks)), bytes: size });
      if (this.downloads.length > 10) this.downloads.shift();
    } catch { /* A failed download is intentionally absent rather than exposing a filesystem path. */ }
  }
  private push(target: Record<string, unknown>[], event: Record<string, unknown>): void { target.push(event); if (target.length > MAX_EVENTS) target.shift(); }
  private clearBuffers(): void { this.consoleEvents.length = 0; this.networkEvents.length = 0; this.downloads.length = 0; this.pages.clear(); this.selectedTabId = undefined; }

  private async releaseAttachment(attached: Attachment, closeFirst: boolean): Promise<void> {
    // EOF must terminate the CDP client before waiting on listener cleanup so
    // an in-flight Playwright call cannot keep controlling the shared browser.
    // BrowserContext has no unrouteWebSocket API in Playwright 1.63: closing
    // this connectOverCDP client is the supported routeWebSocket cleanup and
    // does not terminate the independently owned Chromium process.
    if (closeFirst) {
      await this.closeConnection(attached.browser);
      return;
    }
    if (typeof attached.context.off === "function") {
      for (const [page, handlers] of attached.pageHandlers) {
        if (handlers.consoleHandler) page.off?.("console", handlers.consoleHandler);
        if (handlers.downloadHandler) page.off?.("download", handlers.downloadHandler);
        if (handlers.frameHandler) page.off?.("framenavigated", handlers.frameHandler);
      }
      if (attached.pageHandler) attached.context.off("page", attached.pageHandler);
      if (attached.serviceWorkerHandler) attached.context.off("serviceworker", attached.serviceWorkerHandler);
      if (attached.requestHandler) attached.context.off("request", attached.requestHandler);
      if (attached.responseHandler) attached.context.off("response", attached.responseHandler);
    }
    await attached.context.unroute("**/*", attached.routeHandler);
    await this.closeConnection(attached.browser);
  }
  private async detach(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, []);
    const attached = this.attachment;
    if (!attached) return { attached: false };
    this.attachment = undefined; // fence new work before observers/routes are drained
    // Forget native capabilities on consent teardown; do not kill Mousepad (or
    // the independently owned browser) as part of bridge cleanup.
    this.nativeWindows.clear();
    // Best effort: a page that cannot be closed now keeps its document marker,
    // and the next attach closes it before anything can list it.
    await this.bounded(this.closeCredentialPages(attached.context, () => false), "session-lost").catch(() => undefined);
    // Best effort and bounded, like the page sweep; the next attach clears
    // again and refuses if it cannot.
    await this.clearSelections().catch(() => undefined);
    try { await this.bounded(this.releaseAttachment(attached, false), "session-lost"); }
    catch { await this.closeConnection(attached.browser).catch(() => undefined); this.clearBuffers(); fail("session-lost"); }
    this.clearBuffers();
    return { attached: false };
  }
  // Called by the stdio transport on EOF. It is intentionally not serialized:
  // it must fence and close CDP even when the command queue is stuck.
  async shutdown(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    // native-input is an internal, bounded child process. Abort it before
    // teardown so EOF does not leave a server grab alive behind this bridge.
    this.adapter.cancelNativeInputs?.();
    const attached = this.attachment;
    this.attachment = undefined;
    this.nativeWindows.clear();
    this.clearBuffers();
    // Only launch capabilities held by this bridge are terminated. This never
    // searches for or signals a desktop process by a caller-provided PID.
    await this.stopLaunchedMousepads().catch(() => undefined);
    // Bounded, then CDP closes regardless; a page left open keeps its marker.
    if (attached) await this.bounded(this.closeCredentialPages(attached.context, () => false), "session-lost").catch(() => undefined);
    // Cleared even with no attachment: a failed clear at an earlier detach
    // must not leave a value for whatever this seat runs next.
    await this.clearSelections().catch(() => undefined);
    if (!attached) return;
    await this.bounded(this.releaseAttachment(attached, true), "session-lost").catch(() => undefined);
  }
  // Bounded so a wedged X server can never hold a detach, shutdown or fill open.
  private async clearSelections(): Promise<void> {
    await this.bounded(Promise.resolve().then(() => this.adapter.clearSelections()), "provider-unavailable", this.selectionClearMs);
  }
  // true: the page's document holds the marker; false: it provably does not;
  // undefined: the page could not answer in time (closed, crashed, wedged).
  private async credentialMarker(page: any): Promise<boolean | undefined> {
    const answer: unknown = await this.settleWithin(() => page.evaluate(readCredentialMarker, CREDENTIAL_MARKER), CREDENTIAL_MARKER_WAIT_MS);
    return typeof answer === "boolean" ? answer : undefined;
  }
  // Closes every page that may still hold a credential this seat typed:
  // - any tab this process filled, matched by Page wrapper or (after a
  //   reattach, when wrappers are new) by browser target id, whether or not it
  //   navigated since: a GET submit or a results page can echo the value;
  // - any page whose document carries the marker (a fill by a process that died);
  // - a page that cannot answer the marker read when `closeUnanswerable` says so.
  // Throws if any page that must close could not be closed.
  private async closeCredentialPages(context: any, closeUnanswerable: (page: any) => boolean): Promise<void> {
    const pages: any[] = context.pages();
    // A Page wrapper absent from the context is closed, or belongs to an
    // earlier CDP connection; its tab stays tracked by target id.
    for (const page of [...this.filledPages.keys()]) if (!pages.includes(page)) this.filledPages.delete(page);
    const matchTargets = this.filledTargets.size > 0;
    const verdicts = await Promise.all(pages.map(async (page): Promise<{ page: any; close: boolean; targetId: string | undefined }> => {
      const targetId = this.filledPages.get(page) ?? (matchTargets ? await this.targetId(context, page) : undefined);
      const filled = this.filledPages.has(page) || (targetId !== undefined && this.filledTargets.has(targetId));
      if (filled) return { page, close: true, targetId };
      const marker = await this.credentialMarker(page);
      return { page, close: marker === true || (marker === undefined && closeUnanswerable(page)), targetId };
    }));
    const closing = verdicts.filter((verdict) => verdict.close);
    // A headed Chromium quits when its last window closes, which would take the
    // shared seat down. Keep one blank tab open first; if that fails, the
    // credential tabs still close.
    if (closing.length > 0 && closing.length === pages.length) await this.settleWithin(() => context.newPage(), CREDENTIAL_MARKER_WAIT_MS);
    const outcomes = await Promise.allSettled(closing.map(async ({ page, targetId }) => {
      await page.close({ runBeforeUnload: false });
      this.filledPages.delete(page);
      if (targetId !== undefined) this.filledTargets.delete(targetId);
    }));
    if (outcomes.some((outcome) => outcome.status === "rejected")) fail("verification-failed");
    // Once every page left open has named its target, a tracked target that is
    // not among them was closed elsewhere and can be forgotten.
    const kept = verdicts.filter((verdict) => !verdict.close);
    if (matchTargets && kept.every((verdict) => verdict.targetId !== undefined)) {
      const live = new Set(kept.map((verdict) => verdict.targetId));
      for (const targetId of [...this.filledTargets]) if (!live.has(targetId)) this.filledTargets.delete(targetId);
    }
  }

  private async doctor(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, []);
    if (process.env.SANDBAR_SHARED_BROWSER !== "1" || process.env.SANDBAR_BROWSER_SANDBOX !== "namespace") fail("verification-failed");
    const display = await this.adapter.display();
    const attached = this.attachment;
    const browser = attached?.browser ?? await this.adapter.connect();
    try {
      const contexts = browser.contexts();
      if (!Array.isArray(contexts) || contexts.length !== 1) fail("provider-unavailable");
      const context = contexts[0];
      const browserId = this.adapterBrowserId(await this.adapter.browserIdentity());
      const version = truncate(String(await browser.version()), 128);
      return { browserVersion: version.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted]"), browserId, contextId: this.contextId(browserId), display: { width: number(display.width, 1, MAX_VIEWPORT.width), height: number(display.height, 1, MAX_VIEWPORT.height) }, attached: Boolean(attached), pageCount: context.pages().length, credentialPolicy: await this.credentialPolicyInEffect() };
    } finally { if (!attached) await this.closeConnection(browser); }
  }

  private async initialNavigationPage(attached: Attachment): Promise<{ page: any; created: boolean }> {
    const pages = attached.context.pages();
    const selected = this.selectedTabId ? this.pages.get(this.selectedTabId) : undefined;
    if (selected && this.pageIsApproved(selected, attached)) return { page: selected, created: false };
    const approved = pages.find((page: any) => this.pageIsApproved(page, attached));
    if (approved) return { page: approved, created: false };
    const blank = pages.find((page: any) => this.pageIsPristineAboutBlank(page));
    return blank ? { page: blank, created: false } : { page: await attached.context.newPage(), created: true };
  }
  private async open(args: Record<string, unknown>, newTab: boolean): Promise<Record<string, unknown>> {
    only(args, newTab ? ["url"] : ["url", "tabId"]); const attached = this.requireObservation(); const url = this.assertUrl(args.url, attached.origins);
    // An explicit tab id is never allowed to fall back to a different page.
    // Playwright's BrowserContext.newPage() takes no timeout, so a hung acquisition is bounded only by the request deadline.
    const { page, created } = newTab ? { page: await attached.context.newPage(), created: true } : args.tabId === undefined ? await this.initialNavigationPage(attached) : { page: this.approvedPage(args.tabId), created: false };
    // A call abandoned at the request deadline can settle after detach; it must not re-register the page, and a page it created is orphaned.
    if (this.attachment !== attached) {
      if (created) void Promise.resolve(page.close?.({ runBeforeUnload: false })).catch(() => undefined);
      fail("session-lost");
    }
    this.pageId(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: ACTION_WAIT_MS });
    // A call abandoned at the request deadline can settle after detach/re-attach; it must not repopulate cleared state.
    if (this.attachment !== attached) fail("session-lost");
    const tabId = this.pageId(page); this.selectedTabId = tabId; return { tabId };
  }
  private async tabs(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, []); const attached = this.requireObservation(); return { tabs: attached.context.pages().filter((page: any) => this.pageIsApproved(page, attached)).map((page: any) => ({ tabId: this.pageId(page), selected: this.pageId(page) === this.selectedTabId })) }; }
  private async tabSelect(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId"]); this.requireObservation(); const page = this.approvedPage(args.tabId); await page.bringToFront(); const tabId = this.pageId(page); this.selectedTabId = tabId; return { tabId }; }
  private async snapshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["tabId", "format"]); if (args.format !== undefined && args.format !== "text" && args.format !== "aria") fail("invalid-request");
    const aria = args.format === "aria"; const attached = this.requireObservation(); const page = this.approvedPage(args.tabId); const parts: string[] = [];
    for (const frame of page.frames()) { if (!attached.origins.has(this.frameOrigin(frame))) continue; try { const body = frame.locator("body"); parts.push(truncate(aria ? redactAriaValues(String(await body.ariaSnapshot({ timeout: ACTION_WAIT_MS }))) : await body.innerText({ timeout: ACTION_WAIT_MS }))); } catch { /* unready approved frames are omitted */ } }
    return aria ? { tabId: this.pageId(page), format: "aria", text: truncate(parts.join("\n")) } : { tabId: this.pageId(page), text: truncate(parts.join("\n")) };
  }
  private frameOrigin(frame: any): string { try { return new URL(String(frame.url())).origin; } catch { return ""; } }
  private locator(args: Record<string, unknown>, valueKey: "text" | "value" | undefined = undefined): { page: any; selector: string; value?: string } { const allowed = valueKey ? ["tabId", "selector", valueKey] : ["tabId", "selector"]; only(args, allowed); const selector = string(args.selector, MAX_SELECTOR); const value = valueKey ? string(args[valueKey], MAX_INPUT) : undefined; return { page: this.approvedPage(args.tabId), selector, value }; }
  private async click(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const attached = this.requireInput(); const { page, selector } = this.locator(args);
    const click = () => page.locator(selector).click({ timeout: ACTION_WAIT_MS });
    if (attached.inputScope === "qa-layout") await this.clickFenced(attached, page, click); else await click();
    return { tabId: this.pageId(page) };
  }
  // The route and page boundary already block an off-origin navigation or
  // popup. Under qa-layout the click must also report that block, so a caller
  // never reads a silently suppressed result as a successful interaction.
  private async clickFenced(attached: Attachment, page: any, click: () => Promise<unknown>): Promise<void> {
    // A fresh fence per click: a click abandoned at the request deadline that
    // settles later can only clear its own fence, never a newer click's.
    const fence: ClickFence = { violated: false, pages: new Set() };
    attached.clickFence.current = fence;
    try {
      await click();
      await new Promise<void>((resolve) => setTimeout(resolve, this.clickSettleMs));
      if (this.attachment !== attached) fail("session-lost");
      // A script-driven navigation (blob:, data:, about:blank) never reaches the route.
      if (!this.pageIsApproved(page, attached)) fence.violated = true;
      for (const popup of fence.pages) {
        if (this.pageIsApproved(popup, attached)) continue;
        fence.violated = true;
        void Promise.resolve(popup.close?.({ runBeforeUnload: false })).catch(() => undefined);
      }
      if (fence.violated) fail("permission-denied");
    } finally { if (attached.clickFence.current === fence) attached.clickFence.current = undefined; }
  }
  private async type(args: Record<string, unknown>): Promise<Record<string, unknown>> { this.requireInput(); const { page, selector, value } = this.locator(args, "text"); await page.locator(selector).pressSequentially(value!, { timeout: ACTION_WAIT_MS }); return { tabId: this.pageId(page) }; }
  private async select(args: Record<string, unknown>): Promise<Record<string, unknown>> { this.requireInput(); const { page, selector, value } = this.locator(args, "value"); await page.locator(selector).selectOption(value!, { timeout: ACTION_WAIT_MS }); return { tabId: this.pageId(page) }; }
  private async key(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId", "key"]); this.requireInput(); const page = this.approvedPage(args.tabId); const key = string(args.key, 64); if (!/^[A-Za-z0-9_+\-]+$/.test(key)) fail("invalid-request"); await page.keyboard.press(key); return { tabId: this.pageId(page) }; }
  private async scroll(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId", "x", "y"]); this.requireInput(); const page = this.approvedPage(args.tabId); await page.mouse.wheel(number(args.x, -10_000, 10_000), number(args.y, -10_000, 10_000)); return { tabId: this.pageId(page) }; }
  private async wait(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId", "selector", "milliseconds"]); if (args.selector !== undefined) this.requireObservation(); const page = this.approvedPage(args.tabId); if (args.selector !== undefined) await page.locator(string(args.selector, MAX_SELECTOR)).waitFor({ timeout: args.milliseconds === undefined ? ACTION_WAIT_MS : number(args.milliseconds, 0, ACTION_WAIT_MS) }); else await page.waitForTimeout(number(args.milliseconds, 0, ACTION_WAIT_MS)); return { tabId: this.pageId(page) }; }
  private async screenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId"]); this.requireObservation(); const page = this.approvedPage(args.tabId); const bytes = Buffer.from(await page.screenshot({ type: "png", timeout: ACTION_WAIT_MS })); const size = await page.viewportSize?.(); return { mimeType: "image/png", data: b64(bytes), tabId: this.pageId(page), width: number(size?.width ?? 1, 1, MAX_VIEWPORT.width), height: number(size?.height ?? 1, 1, MAX_VIEWPORT.height) }; }
  // A fixed read of document geometry; the caller supplies no selector or script.
  private async layout(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["tabId"]); this.requireObservation(); const page = this.approvedPage(args.tabId);
    const metrics: unknown = await page.evaluate(() => {
      const scope = globalThis as any; const root = scope.document.documentElement;
      return { scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight, innerWidth: scope.innerWidth, innerHeight: scope.innerHeight };
    });
    const values = metrics && typeof metrics === "object" ? metrics as Record<string, unknown> : {};
    const result: Record<string, unknown> = {};
    for (const key of LAYOUT_KEYS) {
      const value = values[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("verification-failed");
      result[key] = value;
    }
    return result;
  }
  private async events(args: Record<string, unknown>, type: "console" | "network"): Promise<Record<string, unknown>> { only(args, ["tabId"]); this.requireObservation(); const tabId = args.tabId === undefined ? undefined : this.pageId(this.approvedPage(args.tabId)); const source = type === "console" ? this.consoleEvents : this.networkEvents; return { events: source.filter((event) => tabId === undefined || event.tabId === tabId) }; }
  private async viewport(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId", "width", "height"]); this.requireInput(); const page = this.approvedPage(args.tabId); const width = number(args.width, 320, MAX_VIEWPORT.width); const height = number(args.height, 240, MAX_VIEWPORT.height); await page.setViewportSize({ width, height }); return { tabId: this.pageId(page), width, height }; }
  private async upload(args: Record<string, unknown>): Promise<Record<string, unknown>> { only(args, ["tabId", "selector", "name", "mimeType", "data"]); this.requireInput(); const page = this.approvedPage(args.tabId); const selector = string(args.selector, MAX_SELECTOR); const name = string(args.name, 128); const mimeType = string(args.mimeType, 128); const data = string(args.data, Math.ceil(MAX_BINARY_BYTES * 4 / 3) + 4); if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) fail("invalid-request"); let bytes: Buffer; try { bytes = Buffer.from(data, "base64"); } catch { fail("invalid-request"); } if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || bytes.length > MAX_BINARY_BYTES) fail("invalid-request"); await page.locator(selector).setInputFiles({ name, mimeType, buffer: bytes }, { timeout: ACTION_WAIT_MS }); return { tabId: this.pageId(page) }; }
  // The broker's pre-flight read: which approved origin a tab has committed.
  // It needs no observation or input grant and reveals only a lease origin.
  private async committedOrigin(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["tabId"]);
    if (args.tabId === undefined) fail("invalid-request");
    const attached = this.requireAttachment();
    const page = this.approvedPage(args.tabId);
    const origin = this.pageOrigin(page);
    if (origin === undefined || !attached.origins.has(origin)) fail("permission-denied");
    return { origin };
  }
  private credentialField(value: unknown): CredentialField {
    if (value !== "username" && value !== "password" && value !== "totp") fail("invalid-request");
    return value;
  }
  private credentialSelector(value: unknown): string {
    const selector = string(value, MAX_SELECTOR);
    const lowered = selector.toLowerCase();
    if (CREDENTIAL_SELECTOR_DENIED.some((token) => lowered.includes(token))) fail("invalid-request");
    return selector;
  }
  private httpsOrigin(value: unknown): string {
    const raw = string(value, 256);
    let url: URL;
    try { url = new URL(raw); } catch { fail("invalid-request"); }
    // Canonical origins only: no path, userinfo, default port or trailing slash.
    if (url.protocol !== "https:" || url.origin !== raw) fail("invalid-request");
    return raw;
  }
  // A probe answer that is not exactly this shape is a refusal: nothing has been
  // typed yet, so it is permission-denied, never verification-failed.
  private credentialFacts(value: unknown): CredentialFieldFacts {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("permission-denied");
    const facts = value as Record<string, unknown>;
    for (const key of ["input", "topDocument", "connected", "disabled", "readOnly"] as const) if (typeof facts[key] !== "boolean") fail("permission-denied");
    if (typeof facts.type !== "string" || typeof facts.formMethod !== "string") fail("permission-denied");
    return { input: facts.input as boolean, type: facts.type, topDocument: facts.topDocument as boolean, connected: facts.connected as boolean, disabled: facts.disabled as boolean, readOnly: facts.readOnly as boolean, formMethod: facts.formMethod };
  }
  // Resolves to undefined, never throws, when the work fails or outlasts `ms`.
  private async settleWithin<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
      ]);
    } catch { return undefined; } finally { if (timer) clearTimeout(timer); }
  }
  // The browser's own id for a tab. Unlike a Playwright Page wrapper, it is the
  // same across CDP connections, so a filled tab is recognized after a reattach.
  private async targetId(context: any, page: any): Promise<string | undefined> {
    return this.settleWithin(async () => {
      const session = await context.newCDPSession(page);
      try {
        const info: unknown = await session.send("Target.getTargetInfo");
        const id = (info as { targetInfo?: { targetId?: unknown } } | undefined)?.targetInfo?.targetId;
        return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
      } finally { void Promise.resolve(session.detach?.()).catch(() => undefined); }
    }, CREDENTIAL_MARKER_WAIT_MS);
  }
  // The managed Chromium policy that keeps typed credentials out of the
  // profile; false on any failure to read it.
  private async credentialPolicyInEffect(): Promise<boolean> {
    return (await this.settleWithin(() => this.adapter.credentialPolicy(), CREDENTIAL_MARKER_WAIT_MS)) === true;
  }
  // The host daemon forwards this only from the credential broker's socket under
  // an active lease on the origin, so it needs no allowInput grant. The bridge is
  // the last line: the value reaches only one visible, editable main-frame
  // <input> of a fitting type on the expected, leased origin, and no result or
  // error code ever carries it.
  private async credentialType(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.requestDeadlineMs;
    only(args, ["tabId", "field", "selector", "value", "expectOrigin"]);
    if (args.tabId === undefined) fail("invalid-request");
    const field = this.credentialField(args.field);
    const selector = this.credentialSelector(args.selector);
    const value = string(args.value, MAX_CREDENTIAL_VALUE);
    const expectOrigin = this.httpsOrigin(args.expectOrigin);
    const attached = this.requireAttachment();
    const page = this.approvedPage(args.tabId);
    const onExpectedOrigin = (): boolean => this.attachment === attached && attached.origins.has(expectOrigin) && this.pageOrigin(page) === expectOrigin;
    if (!onExpectedOrigin()) fail("permission-denied");
    // A browser that would save the typed value (password manager, form history)
    // never receives one.
    if (!(await this.credentialPolicyInEffect())) fail("permission-denied");
    // Any main-frame navigation from here on voids the origin check, even one
    // that lands back on the same origin: the checked document is gone.
    let navigated = false;
    const mainFrame = page.mainFrame();
    const onNavigated = (frame: unknown): void => { if (frame === mainFrame) navigated = true; };
    page.on("framenavigated", onNavigated);
    try {
      const locator = page.locator(selector);
      if (await locator.count() !== 1) fail("invalid-request");
      const facts = this.credentialFacts(await locator.evaluate(probeCredentialField));
      if (!facts.input || !facts.topDocument || !facts.connected || facts.disabled || facts.readOnly || !CREDENTIAL_INPUT_TYPES[field].has(facts.type)) fail("permission-denied");
      // No real login form submits by GET, and a GET submit (a search box, say)
      // carries the value into the next URL. Refused for every field.
      if (!CREDENTIAL_FORM_METHODS.has(facts.formMethod)) fail("permission-denied");
      if (await locator.isVisible() !== true) fail("permission-denied");
      // Record the tab before the value moves: detach, shutdown and every later
      // attach in this process close it, whether or not it navigated since. The
      // document marker is the fallback for a process that dies. Every refusal
      // up to the fill below is permission-denied: nothing has been typed.
      const targetId = await this.targetId(attached.context, page);
      if (targetId === undefined) fail("permission-denied");
      const filledBefore = this.filledTargets.has(targetId);
      this.filledPages.set(page, targetId);
      this.filledTargets.add(targetId);
      let marked: unknown;
      try { marked = await page.evaluate(writeCredentialMarker, CREDENTIAL_MARKER); } catch { marked = false; }
      if (marked !== true) {
        // Nothing was typed by this attempt; keep only an earlier fill's record.
        if (!filledBefore) { this.filledPages.delete(page); this.filledTargets.delete(targetId); }
        fail("permission-denied");
      }
      if (this.attachment !== attached) fail("session-lost");
      if (deadline - Date.now() < CREDENTIAL_FILL_WAIT_MS + this.selectionClearMs) fail("timeout");
      // The last check before the value moves; nothing awaits between it and the fill.
      if (navigated || !onExpectedOrigin()) fail("permission-denied");
      // Once the fill is dispatched, the selections are cleared whatever its
      // outcome: fill selects the field, and X11 publishes a selection as PRIMARY.
      try { await locator.fill(value, { timeout: CREDENTIAL_FILL_WAIT_MS }); }
      finally { await this.clearSelections().catch(() => undefined); }
      // A navigation during the fill means the value may have reached the new
      // document. verification-failed (never {}) tells the broker so.
      if (navigated || !onExpectedOrigin()) fail("verification-failed");
      return {};
    } finally { page.off("framenavigated", onNavigated); }
  }
  private async downloadList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["tabId"]); this.requireObservation();
    const tabId = args.tabId === undefined ? undefined : this.pageId(this.approvedPage(args.tabId));
    const matching = this.downloads.filter((download) => tabId === undefined || download.tabId === tabId);
    // A response never fragments a file: select complete, newest downloads
    // within one 5 MiB binary batch and explicitly report whole artifacts that
    // did not fit. This prevents a 10-download buffer from bypassing the
    // transport's binary limit without exposing browser filesystem paths.
    const selected: Array<{ tabId: string; name: string; mimeType: string; data: string }> = [];
    let bytes = 0; let omittedCount = 0;
    for (let index = matching.length - 1; index >= 0; index--) {
      const download = matching[index];
      if (bytes + download.bytes > MAX_BINARY_BYTES) { omittedCount++; continue; }
      bytes += download.bytes;
      selected.unshift({ tabId: download.tabId, name: download.name, mimeType: download.mimeType, data: download.data });
    }
    return { downloads: selected, omittedCount };
  }

  // This is a one-app native lane: raw X11 ids remain private and only
  // bridge-launched Mousepad windows on the fixed :1 display are remembered.
  private nativeId(value: unknown): string { return opaque(value); }
  private async nativeOutput(args: string[], maxBytes = MAX_TEXT): Promise<string> { return (await this.bounded(this.adapter.desktop("xdotool", args, maxBytes), "provider-unavailable")).toString("utf8"); }
  private parseNativeNumber(value: string, min: number, max: number): number { if (!/^\d+$/.test(value)) fail("verification-failed"); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail("verification-failed"); return parsed; }
  private isBadWindow(error: unknown): boolean {
    // X11 reports a destroyed XID as BadWindow. Do not treat a generic xdotool
    // failure as a replacement signal: only this narrow, expected transition
    // may cause the bridge to look for the child process's new window.
    if (!error || typeof error !== "object") return false;
    const failure = error as { message?: unknown; stderr?: unknown };
    const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : typeof failure.stderr === "string" ? failure.stderr : "";
    return `${typeof failure.message === "string" ? failure.message : ""}\n${stderr}`.toLowerCase().includes("badwindow");
  }
  private async ownedNativeWindow(value: unknown): Promise<NativeWindow> {
    const id = this.nativeId(value); const window = this.nativeWindows.get(id); if (!window) fail("permission-denied");
    // Never adopt an XID merely because a terminated child's numeric PID has
    // been recycled. Production launch capabilities expose their ChildProcess
    // lifecycle; a dead capability invalidates all of its remembered windows.
    const launched = this.launchedMousepads.get(window.pid);
    if (!launched || (launched.isAlive !== undefined && !launched.isAlive())) {
      this.nativeWindows.delete(id);
      this.launchedMousepads.delete(window.pid);
      fail("stale-owner");
    }
    let pid: number;
    try { pid = this.parseNativeNumber((await this.nativeOutput(["getwindowpid", window.xWindowId])).trim(), 1, 2 ** 31 - 1); }
    catch (error) {
      if (this.isBadWindow(error)) return this.resolveMousepadReplacement(window);
      if (error instanceof BridgeFailure && error.code === "verification-failed") { this.nativeWindows.delete(id); fail("stale-owner"); }
      throw error;
    }
    if (pid !== window.pid) { this.nativeWindows.delete(id); fail("stale-owner"); }
    return window;
  }
  private async activeNativeWindowId(): Promise<string> {
    const active = (await this.nativeOutput(["getactivewindow"])).trim();
    if (!/^\d+$/.test(active)) fail("verification-failed");
    return active;
  }
  private async activeOwnedWindow(): Promise<NativeWindow> {
    let active = await this.activeNativeWindowId();
    for (const window of [...this.nativeWindows.values()]) {
      const previousXWindowId = window.xWindowId;
      const resolved = await this.ownedNativeWindow(window.opaqueId);
      // Replacing an XID can happen while focus changes. Re-read focus after
      // every replacement before accepting it; otherwise a stale active-XID
      // fast path could turn a foreign focused window into an input target.
      if (resolved.xWindowId !== previousXWindowId) active = await this.activeNativeWindowId();
      if (resolved.xWindowId === active) return resolved;
    }
    fail("permission-denied");
  }
  private async nativeGeometry(window: NativeWindow): Promise<NativeGeometry> {
    const fields = new Map<string, string>();
    for (const line of (await this.nativeOutput(["getwindowgeometry", "--shell", window.xWindowId])).split("\n")) { const match = /^([A-Z]+)=(-?\d+)$/.exec(line.trim()); if (match) fields.set(match[1], match[2]); }
    const parse = (key: string, min: number, max: number): number => { const value = fields.get(key) ?? ""; if (!/^-?\d+$/.test(value)) fail("verification-failed"); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail("verification-failed"); return parsed; };
    return { x: parse("X", -MAX_VIEWPORT.width, MAX_VIEWPORT.width), y: parse("Y", -MAX_VIEWPORT.height, MAX_VIEWPORT.height), width: parse("WIDTH", 1, MAX_VIEWPORT.width), height: parse("HEIGHT", 1, MAX_VIEWPORT.height) };
  }
  private async inputTarget(): Promise<{ window: NativeWindow; geometry: NativeGeometry }> { const window = await this.activeOwnedWindow(); return { window, geometry: await this.nativeGeometry(window) }; }
  private async validateDesktopPoint(xValue: unknown, yValue: unknown, geometry: NativeGeometry): Promise<{ x: number; y: number }> {
    const display = await this.adapter.display(); const x = number(xValue, 0, number(display.width, 1, MAX_VIEWPORT.width) - 1); const y = number(yValue, 0, number(display.height, 1, MAX_VIEWPORT.height) - 1);
    if (x < geometry.x || y < geometry.y || x >= geometry.x + geometry.width || y >= geometry.y + geometry.height) fail("permission-denied"); return { x, y };
  }
  private async desktopScreenshot(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["windowId"]); if (args.windowId === undefined) fail("unsupported-capability"); this.requireObservation(); const window = await this.ownedNativeWindow(args.windowId);
    let bytes: Buffer;
    try {
      bytes = await this.bounded(this.adapter.desktop("scrot", ["--window", window.xWindowId, "-"], MAX_BINARY_BYTES), "provider-unavailable");
    } catch (error) {
      // The XID can disappear between ownership validation and scrot. Resolve
      // only a verified replacement for this same launched child, then make
      // exactly one new capture attempt; all other capture failures surface.
      if (!this.isBadWindow(error)) throw error;
      await this.resolveMousepadReplacement(window);
      bytes = await this.bounded(this.adapter.desktop("scrot", ["--window", window.xWindowId, "-"], MAX_BINARY_BYTES), "provider-unavailable");
    }
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") fail("verification-failed");
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20); if (width < 1 || width > MAX_VIEWPORT.width || height < 1 || height > MAX_VIEWPORT.height) fail("verification-failed");
    return { windowId: window.opaqueId, mimeType: "image/png", data: b64(bytes), width, height };
  }
  private async nativeInput(window: NativeWindow, operation: NativeInputOperation, values: string[]): Promise<void> {
    // The helper receives only private ownership state. Its PID/focus guard and
    // XTEST injection share one grabbed X11 connection.
    await this.bounded(this.adapter.nativeInput(window.xWindowId, window.pid, operation, values), "provider-unavailable");
  }
  private async desktopClick(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["x", "y", "button"]); this.requireInput(); if (args.button !== undefined && string(args.button, 5) !== "left") fail("invalid-request");
    const { window, geometry } = await this.inputTarget(); const { x, y } = await this.validateDesktopPoint(args.x, args.y, geometry);
    await this.nativeInput(window, "click", [String(x), String(y)]); return { windowId: window.opaqueId };
  }
  private async desktopType(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["text"]); this.requireInput(); const text = string(args.text, MAX_NATIVE_TEXT); if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) fail("invalid-request");
    const { window } = await this.inputTarget(); await this.nativeInput(window, "type", [text]); return { windowId: window.opaqueId };
  }
  private async desktopKey(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["key"]); this.requireInput(); const key = string(args.key, 16);
    if (!new Set(["BackSpace", "Delete", "Left", "Right", "Up", "Down", "Home", "End", "Return", "Tab"]).has(key)) fail("permission-denied");
    const { window } = await this.inputTarget(); await this.nativeInput(window, "key", [key]); return { windowId: window.opaqueId };
  }
  private async desktopScroll(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["x", "y"]); this.requireInput(); const x = number(args.x, -100, 100); const y = number(args.y, -100, 100); const { window, geometry } = await this.inputTarget();
    const centerX = geometry.x + Math.floor(geometry.width / 2); const centerY = geometry.y + Math.floor(geometry.height / 2); await this.validateDesktopPoint(centerX, centerY, geometry);
    await this.nativeInput(window, "scroll", [String(centerX), String(centerY), String(x), String(y)]);
    return { windowId: window.opaqueId };
  }
  private async pruneNativeWindows(): Promise<void> {
    for (const [id] of [...this.nativeWindows]) {
      try { await this.ownedNativeWindow(id); }
      catch (error) { if (!(error instanceof BridgeFailure) || error.code !== "stale-owner") throw error; }
    }
  }
  private rememberNativeWindow(pid: number, xWindowId: string): NativeWindow {
    if (!/^\d+$/.test(xWindowId)) fail("verification-failed");
    const existing = [...this.nativeWindows.values()].find((window) => window.xWindowId === xWindowId);
    if (existing) return existing;
    if (this.nativeWindows.size >= MAX_NATIVE_WINDOWS) fail("verification-failed");
    const window = { opaqueId: opaqueId(), xWindowId, pid }; this.nativeWindows.set(window.opaqueId, window); return window;
  }
  private isExpectedXdotoolSearchMiss(error: unknown): boolean {
    // xdotool documents exit status 1 for a search with no matching windows.
    // This check sits immediately around the fixed search invocation below;
    // every other desktop command failure remains provider-unavailable.
    return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 1);
  }
  private async visibleMousepadWindowIds(pid: number): Promise<string[]> {
    let output: string;
    try {
      output = await this.nativeOutput(["search", "--onlyvisible", "--pid", String(pid)]);
    } catch (error) {
      if (this.isExpectedXdotoolSearchMiss(error)) return [];
      throw error;
    }
    const ids = [...new Set(output.split(/\s+/).filter(Boolean))];
    if (ids.length > MAX_NATIVE_WINDOWS || ids.some((id) => !/^\d+$/.test(id))) fail("verification-failed");
    for (const xWindowId of ids) {
      const actualPid = this.parseNativeNumber((await this.nativeOutput(["getwindowpid", xWindowId])).trim(), 1, 2 ** 31 - 1);
      if (actualPid !== pid) fail("stale-owner");
    }
    return ids;
  }
  private async findMousepadWindow(pid: number): Promise<NativeWindow[]> {
    return (await this.visibleMousepadWindowIds(pid)).map((xWindowId) => this.rememberNativeWindow(pid, xWindowId));
  }
  private async resolveMousepadReplacement(window: NativeWindow): Promise<NativeWindow> {
    // An XID replacement is accepted only for the still-held child capability,
    // and only when its visible search result is unambiguous. The opaque ID is
    // deliberately retained while its private XID is updated.
    const launched = this.launchedMousepads.get(window.pid);
    if (!launched || (launched.isAlive !== undefined && !launched.isAlive())) { this.nativeWindows.delete(window.opaqueId); this.launchedMousepads.delete(window.pid); fail("stale-owner"); }
    const deadline = Date.now() + NATIVE_WINDOW_WAIT_MS;
    while (true) {
      const candidates = await this.visibleMousepadWindowIds(window.pid);
      if (candidates.length === 1) { window.xWindowId = candidates[0]; return window; }
      if (candidates.length > 1) { this.nativeWindows.delete(window.opaqueId); fail("stale-owner"); }
      if (Date.now() >= deadline) { this.nativeWindows.delete(window.opaqueId); fail("stale-owner"); }
      await new Promise<void>((resolve) => setTimeout(resolve, NATIVE_POLL_MS));
    }
  }
  private async stopLaunchedMousepad(launched: LaunchedMousepad): Promise<void> {
    this.launchedMousepads.delete(launched.pid);
    await this.bounded(launched.terminate(), "provider-unavailable");
  }
  private async stopLaunchedMousepads(): Promise<void> {
    const launched = [...this.launchedMousepads.values()];
    this.launchedMousepads.clear();
    await this.bounded(Promise.all(launched.map((child) => child.terminate())).then(() => undefined), "provider-unavailable");
  }
  private async desktopLaunch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["app"]); this.requireInput();
    if (!this.requireAttachment().allowMutations) fail("permission-denied");
    if (string(args.app, 16) !== "mousepad") fail("unsupported-capability");
    await this.pruneNativeWindows(); if (this.nativeWindows.size > 0) fail("busy");
    const launched = await this.adapter.launchMousepad();
    if (!launched || typeof launched !== "object" || !Number.isSafeInteger(launched.pid) || launched.pid < 1 || launched.pid > 2 ** 31 - 1 || typeof launched.terminate !== "function") fail("provider-unavailable");
    this.launchedMousepads.set(launched.pid, launched);
    try {
      const deadline = Date.now() + NATIVE_WINDOW_WAIT_MS;
      while (Date.now() < deadline) {
        if (this.ending) fail("session-lost");
        const windows = await this.findMousepadWindow(launched.pid);
        if (this.ending) fail("session-lost");
        if (windows.length > 0) return { windowId: windows[0].opaqueId };
        await new Promise<void>((resolve) => setTimeout(resolve, NATIVE_POLL_MS));
      }
      fail("provider-unavailable");
    } catch (error) {
      await this.stopLaunchedMousepad(launched).catch(() => undefined);
      throw error;
    }
  }
  private async desktopWindows(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, []); this.requireObservation(); await this.pruneNativeWindows();
    const active = (await this.nativeOutput(["getactivewindow"])).trim();
    return { windows: [...this.nativeWindows.values()].map((window) => ({ windowId: window.opaqueId, active: window.xWindowId === active })) };
  }
  private async desktopActivate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    only(args, ["windowId"]); this.requireInput(); const window = await this.ownedNativeWindow(args.windowId);
    await this.nativeOutput(["windowactivate", "--sync", window.xWindowId]); return { windowId: window.opaqueId };
  }
}

export class NodeAdapter implements BridgeAdapter {
  private readonly nativeInputAbortControllers = new Set<AbortController>();

  async connect(): Promise<any> {
    const playwright = await import("playwright-core");
    // connectOverCDP's default-context overrides are what enable accepted
    // downloads. Keep them explicit: noDefaults leaves the browser's existing
    // (often deny) setting intact. isLocal must remain false because Chromium
    // and this bridge are independently owned processes; Playwright then
    // serves Download.createReadStream() over its protocol instead of trusting
    // a browser-side artifact path that must never cross this boundary.
    return playwright.chromium.connectOverCDP("http://127.0.0.1:9222", { noDefaults: false, isLocal: false, timeout: ACTION_WAIT_MS });
  }
  async browserIdentity(): Promise<BrowserAdapterIdentity> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CDP_METADATA_TIMEOUT_MS);
    try {
      const response = await fetch(CDP_METADATA_URL, { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error("CDP metadata request failed");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CDP_METADATA_BYTES)) throw new Error("CDP metadata exceeds limit");
      if (!response.body) throw new Error("CDP metadata has no body");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_CDP_METADATA_BYTES) { await reader.cancel(); throw new Error("CDP metadata exceeds limit"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let metadata: unknown;
      try { metadata = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { throw new Error("invalid CDP metadata"); }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid CDP metadata");
      const webSocketDebuggerUrl = (metadata as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
      if (typeof webSocketDebuggerUrl !== "string" || webSocketDebuggerUrl.length > 512) throw new Error("invalid CDP metadata");
      let endpoint: URL;
      try { endpoint = new URL(webSocketDebuggerUrl); } catch { throw new Error("invalid CDP metadata"); }
      const match = /^\/devtools\/browser\/([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(endpoint.pathname);
      if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== "9222" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !match) throw new Error("invalid CDP metadata");
      // Hash only the process-scoped debugger UUID. The raw endpoint is never
      // returned, logged, or used as a caller-selected CDP connection target.
      return { browserId: stableHash(match[1].toLowerCase()) };
    } finally { clearTimeout(timeout); }
  }
  async display(): Promise<{ width: number; height: number }> { const output = await this.desktop("xdotool", ["getdisplaygeometry"]); const match = /^(\d+)\s+(\d+)\s*$/.exec(output.toString("utf8")); if (!match) fail("verification-failed"); return { width: Number(match[1]), height: Number(match[2]) }; }
  async nativeInput(expectedXWindowId: string, expectedPid: number, operation: NativeInputOperation, values: string[]): Promise<void> {
    // This fixed internal argv is the only native-input launch path. Raw XIDs
    // and PIDs originate from bridge ownership state, never MCP arguments.
    if (!/^\d+$/.test(expectedXWindowId) || !Number.isSafeInteger(expectedPid) || expectedPid < 1 || expectedPid > 2 ** 31 - 1 ||
        !["type", "key", "click", "scroll"].includes(operation) || values.some((value) => typeof value !== "string" || value.includes("\0"))) fail("invalid-request");
    const controller = new AbortController();
    this.nativeInputAbortControllers.add(controller);
    try {
      await execFile("/opt/sandbar-browser/native-input", [expectedXWindowId, String(expectedPid), operation, ...values], {
        encoding: "buffer", maxBuffer: 1024, timeout: MAX_DRAIN_MS,
        env: { PATH: "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config" }, signal: controller.signal,
      });
    } finally { this.nativeInputAbortControllers.delete(controller); }
  }
  cancelNativeInputs(): void {
    for (const controller of this.nativeInputAbortControllers) controller.abort();
  }
  private async scrot(args: string[]): Promise<Buffer> {
    // Node's child-process stdout is a Unix socket. scrot reopens /dev/stdout,
    // which fails on that socket, so use this fixed shell-owned OS pipe instead.
    // The only variable is a validated numeric X11 id passed as "$1", never
    // shell source. execFile keeps the capture asynchronous so EOF shutdown
    // can fence the bridge while a bounded screenshot is still in flight.
    if (args.length !== 3 || args[0] !== "--window" || !/^\d+$/.test(args[1]) || args[2] !== "-") fail("invalid-request");
    return execFile("/bin/bash", ["-o", "pipefail", "-c", "scrot --window \"$1\" - | /bin/cat", "sandbar-screenshot", args[1]], {
      encoding: "buffer", env: { PATH: "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config" }, timeout: 3_000, maxBuffer: MAX_BINARY_BYTES,
    });
  }
  async desktop(command: string, args: string[], maxBytes = MAX_BINARY_BYTES): Promise<Buffer> {
    if (command !== "xdotool" && command !== "scrot" || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) fail("invalid-request");
    if (command === "scrot") return this.scrot(args);
    return execFile(command, args, { encoding: "buffer", maxBuffer: maxBytes, timeout: MAX_DRAIN_MS, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config" } });
  }
  clearSelections(): Promise<void> { return clearSeatSelections(); }
  credentialPolicy(): Promise<boolean> { return readCredentialPolicy(); }
  async launchMousepad(): Promise<LaunchedMousepad> {
    // Mousepad restores its previous session from XDG state. Give this child a
    // private, bridge-created profile instead of allowing it to read or mutate
    // the shared /config profile used by the native desktop.
    const profileRoot = await fs.mkdtemp(join(tmpdir(), "sandbar-mousepad-"));
    const profileDirs = ["config", "cache", "data"].map((name) => join(profileRoot, name));
    try {
      await fs.chmod(profileRoot, 0o700);
      await Promise.all(profileDirs.map(async (directory) => {
        await fs.mkdir(directory, { mode: 0o700 });
        await fs.chmod(directory, 0o700);
      }));
    } catch (error) {
      try { await fs.rm(profileRoot, { recursive: true, force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "could not prepare private Mousepad profile"); }
      throw error;
    }

    // This closure is the sole holder of the root created above. It never
    // receives a caller path, so cleanup cannot reach any shared profile or an
    // unrelated temporary directory.
    let cleanupPromise: Promise<void> | undefined;
    const cleanupProfile = (): Promise<void> => cleanupPromise ??= fs.rm(profileRoot, { recursive: true, force: true });
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config",
      XDG_CONFIG_HOME: profileDirs[0], XDG_CACHE_HOME: profileDirs[1], XDG_DATA_HOME: profileDirs[2],
      GSETTINGS_BACKEND: "memory",
    };

    // Fixed argv, no shell, and no await on the application's eventual exit.
    // --disable-server prevents Mousepad from forwarding this request to an
    // existing user-owned instance, so the child capability is bridge-owned.
    return new Promise<LaunchedMousepad>((resolve, reject) => {
      let launched = false;
      let closed = false;
      let launchFailed = false;
      let naturalExitCleanupFailure: unknown;
      let resolveClosed!: () => void;
      const closedPromise = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });
      const close = (): void => {
        if (closed) return;
        closed = true;
        resolveClosed();
        // Keep cleanup errors attached to cleanupPromise. terminate() observes
        // them rather than silently treating an owned profile as removed.
        if (launched) void cleanupProfile().then(undefined, (error) => { naturalExitCleanupFailure = error; });
      };
      const rejectAfterCleanup = (error: unknown): void => {
        launchFailed = true;
        void cleanupProfile().then(
          () => reject(error instanceof Error ? error : new Error("mousepad did not start")),
          (cleanupError) => reject(new AggregateError([error, cleanupError], "Mousepad launch failed and private profile cleanup failed")),
        );
      };

      let child: childProcess.ChildProcess;
      try {
        child = childProcess.execFile("mousepad", ["--disable-server"], { stdio: "ignore", env }, (error) => {
          // execFile invokes its callback only after the child has closed. A
          // failed spawn therefore has no live child whose profile could be
          // removed prematurely.
          if (!launched) rejectAfterCleanup(error ?? new Error("mousepad did not start"));
        });
      } catch (error) {
        rejectAfterCleanup(error);
        return;
      }
      child.once("close", close);
      if (child.exitCode !== null) close();
      if (!launchFailed && !closed && Number.isSafeInteger(child.pid) && child.pid! > 0) {
        launched = true;
        child.unref();
        resolve({
          pid: child.pid!,
          isAlive: (): boolean => !closed && child.exitCode === null,
          async terminate(): Promise<void> {
            if (!closed && child.exitCode === null) {
              try {
                if (!child.kill("SIGTERM")) throw new Error("Mousepad process was not running");
              } catch (error) { throw error instanceof Error ? error : new Error("could not terminate Mousepad"); }
              await closedPromise;
            }
            // A child that has already closed cannot write its private profile,
            // so it is safe to remove the root now (or await close's cleanup).
            if (naturalExitCleanupFailure) throw naturalExitCleanupFailure;
            await cleanupProfile();
          },
        });
      } else if (!launchFailed && closed) {
        rejectAfterCleanup(new Error("mousepad did not start"));
      }
    });
  }
}

function oversizedUploadRequest(line: string): unknown {
  if (Buffer.byteLength(line) > MAX_UPLOAD_LINE_BYTES) return null;
  try {
    const request = record(JSON.parse(line));
    return request.operation === "upload" ? request : null;
  } catch { return null; }
}
export async function runProtocol(adapter: BridgeAdapter = new NodeAdapter()): Promise<void> {
  const bridge = new BrowserBridge(adapter); let pending = ""; let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void bridge.shutdown().finally(() => process.exit(0));
  };
  process.stdin.setEncoding("utf8");
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  process.stdin.on("data", (chunk: string) => { if (closing) return; pending += chunk; while (true) { const index = pending.indexOf("\n"); if (index < 0) { if (Buffer.byteLength(pending) > MAX_UPLOAD_LINE_BYTES) { pending = ""; void respond(bridge, null); } break; } const line = pending.slice(0, index); pending = pending.slice(index + 1); const bytes = Buffer.byteLength(line); if (bytes > MAX_LINE_BYTES) { void respond(bridge, oversizedUploadRequest(line)); continue; } let request: unknown = null; try { request = JSON.parse(line); } catch { /* returns invalid-request */ } void respond(bridge, request); } });
}
async function respond(bridge: BrowserBridge, request: unknown): Promise<void> { process.stdout.write(`${JSON.stringify(await bridge.handle(request))}\n`); }
// import.meta.main is Bun-only. This ESM entry check also starts under Node 22.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void runProtocol();
