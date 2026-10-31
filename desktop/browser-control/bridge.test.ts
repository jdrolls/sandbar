import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { BrowserBridge, CHROMIUM_MANAGED_POLICY_DIR, CREDENTIAL_POLICY, NodeAdapter, credentialPolicyHolds, probeCredentialField, readCredentialMarker, readCredentialPolicy, redactAriaValues, writeCredentialMarker, type BridgeAdapter, type BridgeResponse, type LaunchedMousepad } from "./bridge";

class FakePage {
  events = new Map<string, Function[]>();
  gotoUrls: string[] = [];
  closed = 0;
  urlValue: string;
  keyboard = { press: async (_key: string) => {} };
  mouse = { wheel: async (_x: number, _y: number) => {} };
  constructor(url = "https://example.test/") { this.urlValue = url; }
  on(name: string, callback: Function): void { this.events.set(name, [...(this.events.get(name) ?? []), callback]); }
  off(name: string, callback: Function): void { this.events.set(name, (this.events.get(name) ?? []).filter((entry) => entry !== callback)); }
  emit(name: string, value: unknown): void { for (const callback of this.events.get(name) ?? []) callback(value); }
  url(): string { return this.urlValue; }
  mainFrame(): FakePage { return this; }
  // The main world's credential marker, as writeCredentialMarker/readCredentialMarker see it.
  credentialMarker = false;
  markerReadError?: Error;
  markerWriteResult: unknown = true;
  closeFailures = 0;
  // The browser's target id: stable for the tab, unlike this wrapper object.
  targetId = `TARGET${Math.random().toString(16).slice(2, 14).toUpperCase()}`;
  targetIdError?: Error;
  async close(): Promise<void> { if (this.closeFailures > 0) { this.closeFailures--; throw new Error("page.close: Protocol error"); } this.closed++; }
  // A cross-document navigation replaces the document, and with it the marker.
  async goto(url: string): Promise<void> { this.gotoUrls.push(url); this.urlValue = url; this.credentialMarker = false; }
  navigate(url: string): void { this.urlValue = url; this.credentialMarker = false; this.emit("framenavigated", this); }
  async bringToFront(): Promise<void> {}
  frames(): FakePage[] { return [this]; }
  ariaTree = '- heading "Welcome" [level=1]\n- link "Pricing":\n  - /url: https://example.test/pricing?token=abc\n- button "Sign in"';
  onClick: () => Promise<void> = async () => {};
  locator(_selector: string): any { return { innerText: async () => "semantic page text", ariaSnapshot: async () => this.ariaTree, click: async () => this.onClick(), pressSequentially: async () => {}, selectOption: async () => {}, waitFor: async () => {}, setInputFiles: async () => {} }; }
  async screenshot(): Promise<Buffer> { return Buffer.from("png"); }
  async setViewportSize(_size: unknown): Promise<void> {}
  async viewportSize(): Promise<{ width: number; height: number }> { return { width: 800, height: 600 }; }
  async waitForTimeout(_milliseconds: number): Promise<void> {}
  layoutMetrics: unknown = { scrollWidth: 1440, scrollHeight: 5200, clientWidth: 1440, clientHeight: 900, innerWidth: 1440, innerHeight: 900 };
  evaluated: Function[] = [];
  async evaluate(fn: Function, arg?: unknown): Promise<unknown> {
    if (fn === writeCredentialMarker) { expect(arg).toBe("__sandbarCredentialFill"); if (this.markerWriteResult === true) this.credentialMarker = true; return this.markerWriteResult; }
    if (fn === readCredentialMarker) { expect(arg).toBe("__sandbarCredentialFill"); if (this.markerReadError) throw this.markerReadError; return this.credentialMarker; }
    this.evaluated.push(fn); return this.layoutMetrics;
  }
}
class FakeWorker {
  constructor(private readonly urlValue: string) {}
  url(): string { return this.urlValue; }
}
class FakeContext {
  page = new FakePage();
  routes: Array<{ pattern: string; handler: Function }> = [];
  websocketRoutes: Function[] = [];
  workers: FakeWorker[] = [];
  events = new Map<string, Function[]>();
  allPages: FakePage[] = [this.page];
  // As Playwright: a closed page leaves the context's page list.
  pages(): FakePage[] { return this.allPages.filter((page) => page.closed === 0); }
  serviceWorkers(): FakeWorker[] { return this.workers; }
  cdpSessions = 0; detachedSessions = 0;
  async newCDPSession(page: FakePage): Promise<{ send: (method: string) => Promise<unknown>; detach: () => Promise<void> }> {
    this.cdpSessions++;
    return {
      send: async (method: string) => { expect(method).toBe("Target.getTargetInfo"); if (page.targetIdError) throw page.targetIdError; return { targetInfo: { targetId: page.targetId, type: "page" } }; },
      detach: async () => { this.detachedSessions++; },
    };
  }
  async newPage(): Promise<FakePage> { const page = new FakePage("about:blank"); this.allPages.push(page); for (const listener of this.events.get("page") ?? []) listener(page); return page; }
  async route(pattern: string, handler: Function): Promise<void> { this.routes.push({ pattern, handler }); }
  async routeWebSocket(_pattern: string, handler: Function): Promise<void> { this.websocketRoutes.push(handler); }
  async unroute(_pattern: string, handler: Function): Promise<void> { this.routes = this.routes.filter((route) => route.handler !== handler); }
  on(name: string, callback: Function): void { this.events.set(name, [...(this.events.get(name) ?? []), callback]); }
  off(name: string, callback: Function): void { this.events.set(name, (this.events.get(name) ?? []).filter((entry) => entry !== callback)); }
}
class FakeBrowser {
  context = new FakeContext();
  closedConnections = 0;
  contexts(): FakeContext[] { return [this.context]; }
  // Mirrors Browser.close() after connectOverCDP: this is transport-only and
  // clears client-owned websocket routing without terminating Chromium.
  async close(): Promise<void> { this.closedConnections++; this.context.websocketRoutes = []; }
  async version(): Promise<string> { return "Chromium 123"; }
}
class FakeAdapter implements BridgeAdapter {
  browser = new FakeBrowser();
  browserIdentityValue = "1".repeat(64);
  reconnectWithFreshWrappers = false;
  activeWindow = "100";
  activeWindowOutcomes: string[] = [];
  pendingScrot?: Promise<Buffer>;
  mousepadPid = 4242;
  unrelatedMousepadPid = 1860;
  launched = 0;
  terminatedPids: number[] = [];
  searchOutcomes: Array<Buffer | Error> = [];
  scrotOutcomes: Array<Buffer | Error> = [];
  windowPids: Record<string, number | Error> = {};
  desktopCalls: Array<{ command: string; args: string[] }> = [];
  nativeInputCalls: Array<{ xWindowId: string; pid: number; operation: string; values: string[] }> = [];
  nativeInputFailure?: Error;
  // Each clearSelections call records whether the context's page observers were installed yet.
  selectionClears: Array<{ observersInstalled: boolean }> = [];
  clearFailure?: Error;
  pendingClear?: Promise<void>;
  onClear?: () => void;
  credentialPolicyValue: boolean | Error = true;
  async credentialPolicy(): Promise<boolean> { if (this.credentialPolicyValue instanceof Error) throw this.credentialPolicyValue; return this.credentialPolicyValue; }
  async clearSelections(): Promise<void> {
    this.selectionClears.push({ observersInstalled: (this.browser.context.events.get("page") ?? []).length > 0 });
    this.onClear?.();
    if (this.pendingClear) return this.pendingClear;
    if (this.clearFailure) throw this.clearFailure;
  }
  private readonly png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000003080600000000000000", "hex");
  async connect(): Promise<FakeBrowser> {
    if (!this.reconnectWithFreshWrappers) return this.browser;
    const browser = this.browser;
    // connectOverCDP creates a new Playwright Browser wrapper per client.
    return { contexts: () => browser.contexts(), close: async () => { browser.closedConnections++; }, version: async () => browser.version() } as FakeBrowser;
  }
  async browserIdentity(): Promise<{ browserId: string }> { return { browserId: this.browserIdentityValue }; }
  async display(): Promise<{ width: number; height: number }> { return { width: 1024, height: 768 }; }
  async launchMousepad(): Promise<LaunchedMousepad> {
    this.launched++;
    return { pid: this.mousepadPid, terminate: async () => { this.terminatedPids.push(this.mousepadPid); }, isAlive: () => true };
  }
  async nativeInput(xWindowId: string, pid: number, operation: "type" | "key" | "click" | "scroll", values: string[]): Promise<void> {
    this.nativeInputCalls.push({ xWindowId, pid, operation, values });
    if (this.nativeInputFailure) throw this.nativeInputFailure;
  }
  async desktop(command: string, args: string[]): Promise<Buffer> {
    this.desktopCalls.push({ command, args });
    if (command === "scrot") {
      if (this.pendingScrot) return this.pendingScrot;
      const outcome = this.scrotOutcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome ?? this.png;
    }
    if (args[0] === "search") {
      const outcome = this.searchOutcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome ?? Buffer.from(args[3] === String(this.mousepadPid) ? "100\n" : "");
    }
    if (args[0] === "getwindowpid") {
      const configured = this.windowPids[args[1]];
      if (configured instanceof Error) throw configured;
      return Buffer.from(`${configured ?? (args[1] === "100" ? this.mousepadPid : 999)}\n`);
    }
    if (args[0] === "getactivewindow") return Buffer.from(`${this.activeWindowOutcomes.shift() ?? this.activeWindow}\n`);
    if (args[0] === "getwindowgeometry") return Buffer.from("WINDOW=100\nX=10\nY=20\nWIDTH=500\nHEIGHT=300\nSCREEN=0\n");
    return Buffer.alloc(0);
  }
}
const before = { shared: process.env.SANDBAR_SHARED_BROWSER, sandbox: process.env.SANDBAR_BROWSER_SANDBOX };
afterEach(() => { if (before.shared === undefined) delete process.env.SANDBAR_SHARED_BROWSER; else process.env.SANDBAR_SHARED_BROWSER = before.shared; if (before.sandbox === undefined) delete process.env.SANDBAR_BROWSER_SANDBOX; else process.env.SANDBAR_BROWSER_SANDBOX = before.sandbox; });
function request(id: string, operation: string, args: Record<string, unknown>) { return { id, operation, args }; }
function configured(): void { process.env.SANDBAR_SHARED_BROWSER = "1"; process.env.SANDBAR_BROWSER_SANDBOX = "namespace"; }
function xdotoolSearchMiss(): Error { return Object.assign(new Error("xdotool found no windows"), { code: 1 }); }
function badWindow(): Error { return new Error("X Error of failed request:  BadWindow (invalid Window parameter)"); }
function attach(bridge: BrowserBridge, allowInput = true, allowObservation = true, allowMutations = false) { return bridge.handle(request("attach", "attach", { origins: ["https://example.test"], allowInput, allowMutations, allowObservation })); }
async function launchMousepad(bridge: BrowserBridge): Promise<string> { const response = await bridge.handle(request("launch", "desktop-launch", { app: "mousepad" })); expect(response).toMatchObject({ ok: true }); return (response.result as { windowId: string }).windowId; }
function qaAttach(bridge: BrowserBridge, inputScope: unknown = "qa-layout", allowMutations = false) { return bridge.handle(request("attach", "attach", { origins: ["https://example.test"], allowInput: true, allowMutations, allowObservation: true, inputScope })); }
async function firstTabId(bridge: BrowserBridge): Promise<string> { return ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId; }
// A route request as Playwright reports it for a navigation of `frameParent`'s child (null = top-level).
function navigationRoute(url: string, frameParent: unknown = null) { const route = { request: () => ({ url: () => url, method: () => "GET", isNavigationRequest: () => true, frame: () => ({ parentFrame: () => frameParent }) }), abort: async () => { route.aborted = true; }, continue: async () => { route.continued = true; }, aborted: false, continued: false }; return route; }
// A routed request with a Playwright resource type, as the origin route sees it.
function resourceRoute(url: string, resourceType: string, method = "GET", navigation = false) { const route = { request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType, isNavigationRequest: () => navigation, frame: () => ({ parentFrame: () => null }) }), abort: async () => { route.aborted = true; }, continue: async () => { route.continued = true; }, aborted: false, continued: false }; return route; }
const FONT_ORIGINS = ["https://fonts.example.test", "https://static.example.test"];
function subresourceAttach(bridge: BrowserBridge, subresourceOrigins: unknown = FONT_ORIGINS, inputScope: unknown = "qa-layout") { return bridge.handle(request("attach", "attach", { origins: ["https://example.test"], allowInput: true, allowMutations: false, allowObservation: true, ...(inputScope === "absent" ? {} : { inputScope }), subresourceOrigins })); }
async function eventually<T>(work: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const result = await work();
    if (result !== undefined) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not settle");
}

 describe("BrowserBridge", () => {
  test("refuses attach unless this is the namespace shared-seat lane", async () => {
    const bridge = new BrowserBridge(new FakeAdapter());
    expect(await attach(bridge)).toMatchObject({ ok: false, code: "verification-failed" });
  });

  test("uses close() for CDP transport teardown and the supported websocket close route", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
    expect(await attach(bridge)).toMatchObject({ ok: true, result: { attached: true, pageCount: 1 } });
    const route = { request: () => ({ url: () => "https://example.test/path", method: () => "POST" }), abort: async () => { route.aborted = true; }, continue: async () => { route.continued = true; }, aborted: false, continued: false };
    await adapter.browser.context.routes[0].handler(route);
    expect(route.aborted).toBe(true); expect(route.continued).toBe(false);
    const socket = { closed: false, close: async () => { socket.closed = true; } };
    await adapter.browser.context.websocketRoutes[0](socket);
    expect(socket.closed).toBe(true);
    expect(await bridge.handle(request("detach", "detach", {}))).toMatchObject({ ok: true, result: { attached: false } });
    expect(adapter.browser.closedConnections).toBe(1);
    expect(adapter.browser.context.routes).toEqual([]);
    expect(adapter.browser.context.websocketRoutes).toEqual([]);
  });

  test("captures accepted CDP downloads through streams without exposing paths and cancels oversized artifacts", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    adapter.browser.context.page.emit("download", {
      suggestedFilename: () => "synthetic-download.txt",
      createReadStream: async () => Readable.from([Buffer.from("synthetic download")]),
      cancel: async () => { throw new Error("a successful download must not be cancelled"); },
    });
    const captured = await eventually(async () => {
      const response = await bridge.handle(request("downloads", "downloads", { tabId }));
      const downloads = (response.result as { downloads: Array<{ name: string; data: string }> }).downloads;
      return downloads.length === 1 ? downloads[0] : undefined;
    });
    expect(captured).toMatchObject({ name: "synthetic-download.txt", data: Buffer.from("synthetic download").toString("base64") });
    expect(JSON.stringify(captured)).not.toContain("/tmp/");

    const completeDownload = (name: string, byte: number) => ({
      suggestedFilename: () => name,
      createReadStream: async () => Readable.from([Buffer.alloc(3 * 1024 * 1024, byte)]),
      cancel: async () => { throw new Error("an in-limit download must not be cancelled"); },
    });
    adapter.browser.context.page.emit("download", completeDownload("older.bin", 1));
    await eventually(async () => {
      const response = await bridge.handle(request("downloads-after-older", "downloads", { tabId }));
      return (response.result as { downloads: Array<{ name: string }> }).downloads.some((download) => download.name === "older.bin") ? true : undefined;
    });
    adapter.browser.context.page.emit("download", completeDownload("newer.bin", 2));
    const batch = await eventually(async () => {
      const response = await bridge.handle(request("downloads-batched", "downloads", { tabId }));
      return (response.result as { downloads: Array<{ name: string; data: string }>; omittedCount: number }).omittedCount === 1 ? response.result as { downloads: Array<{ name: string; data: string }>; omittedCount: number } : undefined;
    });
    expect(batch.downloads.map((download) => download.name)).toEqual(["synthetic-download.txt", "newer.bin"]);
    expect(batch.downloads.find((download) => download.name === "newer.bin")?.data).toHaveLength(4 * 1024 * 1024);

    let cancelled = false;
    adapter.browser.context.page.emit("download", {
      suggestedFilename: () => "too-large.bin",
      createReadStream: async () => Readable.from([Buffer.alloc(5 * 1024 * 1024 + 1)]),
      cancel: async () => { cancelled = true; },
    });
    await eventually(() => cancelled ? true : undefined);
    const afterOversize = await bridge.handle(request("downloads-after-oversize", "downloads", { tabId }));
    expect((afterOversize.result as { downloads: unknown[]; omittedCount: number }).downloads).toHaveLength(2);
    expect((afterOversize.result as { downloads: unknown[]; omittedCount: number }).omittedCount).toBe(1);
  });

  test("rejects existing service workers and disconnects if one is created", async () => {
    configured(); const foreignAdapter = new FakeAdapter(); foreignAdapter.browser.context.workers.push(new FakeWorker("https://private.test/sw.js"));
    expect(await attach(new BrowserBridge(foreignAdapter))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(foreignAdapter.browser.closedConnections).toBe(1);

    const adapter = new FakeAdapter(); adapter.browser.context.workers.push(new FakeWorker("https://example.test/sw.js"));
    const bridge = new BrowserBridge(adapter);
    expect(await attach(bridge)).toMatchObject({ ok: false, code: "verification-failed" });
    expect(adapter.browser.closedConnections).toBe(1);

    const cleanAdapter = new FakeAdapter(); const cleanBridge = new BrowserBridge(cleanAdapter);
    expect(await attach(cleanBridge)).toMatchObject({ ok: true });
    cleanAdapter.browser.context.events.get("serviceworker")?.[0](new FakeWorker("https://private.test/sw.js"));
    expect(await cleanBridge.handle(request("after-worker", "tabs", {}))).toMatchObject({ ok: false, code: "session-lost" });
    expect(cleanAdapter.browser.closedConnections).toBe(1);
  });

  test("does not enumerate, select, observe, or use an unapproved existing tab", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.browser.context.page.urlValue = "https://private.test/"; const bridge = new BrowserBridge(adapter);
    expect(await attach(bridge)).toMatchObject({ ok: true, result: { pageCount: 0 } });
    expect(await bridge.handle(request("tabs", "tabs", {}))).toMatchObject({ ok: true, result: { tabs: [] } });
    expect(await bridge.handle(request("snapshot", "snapshot", {}))).toMatchObject({ ok: false, code: "invalid-request" });
    const opened = await bridge.handle(request("new", "tab-open", { url: "https://example.test/path" }));
    expect(opened).toMatchObject({ ok: true });
    const tabId = (opened.result as { tabId: string }).tabId;
    expect(await bridge.handle(request("snapshot", "snapshot", { tabId }))).toMatchObject({ ok: true, result: { text: "semantic page text" } });
  });

  test("snapshot format aria returns roles and names, redacts values and hrefs (i12)", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    expect(await bridge.handle(request("text", "snapshot", { tabId, format: "text" }))).toEqual({ id: "text", ok: true, result: { tabId, text: "semantic page text" } });
    const aria = await bridge.handle(request("aria", "snapshot", { tabId, format: "aria" }));
    expect(aria).toEqual({ id: "aria", ok: true, result: { tabId, format: "aria", text: '- heading "Welcome" [level=1]\n- link "Pricing":\n- button "Sign in"' } });
    for (const format of ["html", "", "ARIA", 1, null]) expect(await bridge.handle(request("bad", "snapshot", { tabId, format }))).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await bridge.handle(request("extra", "snapshot", { tabId, format: "aria", depth: 2 }))).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("aria snapshot keeps the approved-origin frame filter and 64 KB cap (i12)", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const page = adapter.browser.context.page; const foreign = new FakePage("https://private.test/frame"); foreign.ariaTree = '- button "private"';
    page.frames = () => [page, foreign]; page.ariaTree = "- paragraph: " + "x".repeat(70 * 1024);
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    const text = ((await bridge.handle(request("aria", "snapshot", { tabId, format: "aria" }))).result as { text: string }).text;
    expect(text.length).toBe(64 * 1024); expect(text).not.toContain("private");
  });

  test("redactAriaValues hides field values and hrefs, keeps roles and names (i12)", () => {
    const tree = [
      '- textbox "Email": jonathan@example.test',
      '- textbox "Password" [disabled]: hunter2',
      '- textbox: unnamed value',
      '- textbox "Empty"',
      '- searchbox "Search": my query',
      '- combobox "Country": United States',
      '- combobox "Pick":',
      '  - option "A" [selected]',
      '- spinbutton "Qty": 3',
      '- textbox "Say \\"hi\\"": quoted',
      "- 'textbox \"Email: work\"': secret-a",
      "- 'textbox \"it''s: here\"': secret-d",
      "- 'combobox \"Combo: y\"': secret-cb",
      '- slider "Vol": "50"',
      "- 'text: \"x\"': kept text",
      '- link "Docs":',
      '  - /url: /docs?session=secret',
      '- paragraph: textbox "Email": not a field',
      '- button "Submit"',
    ].join("\n");
    expect(redactAriaValues(tree)).toBe([
      '- textbox "Email": [redacted]',
      '- textbox "Password" [disabled]: [redacted]',
      '- textbox: [redacted]',
      '- textbox "Empty"',
      '- searchbox "Search": [redacted]',
      '- combobox "Country": [redacted]',
      '- combobox "Pick":',
      '  - option "A" [selected]',
      '- spinbutton "Qty": [redacted]',
      '- textbox "Say \\"hi\\"": [redacted]',
      "- 'textbox \"Email: work\"': [redacted]",
      "- 'textbox \"it''s: here\"': [redacted]",
      "- 'combobox \"Combo: y\"': [redacted]",
      '- slider "Vol": [redacted]',
      "- 'text: \"x\"': kept text",
      '- link "Docs":',
      '- paragraph: textbox "Email": not a field',
      '- button "Submit"',
    ].join("\n"));
  });

  test("preserves preexisting out-of-scope tabs while fencing new unauthorized popups", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.browser.context.page.urlValue = "https://private.test/"; const bridge = new BrowserBridge(adapter);
    expect(await attach(bridge)).toMatchObject({ ok: true, result: { pageCount: 0 } });
    expect(adapter.browser.context.page.closed).toBe(0);
    expect(await bridge.handle(request("existing-tabs", "tabs", {}))).toMatchObject({ ok: true, result: { tabs: [] } });
    expect(await bridge.handle(request("existing-snapshot", "snapshot", {}))).toMatchObject({ ok: false, code: "invalid-request" });
    const popup = new FakePage("https://private.test/");
    adapter.browser.context.allPages.push(popup);
    adapter.browser.context.events.get("page")?.[0](popup);
    expect(popup.closed).toBe(1);
    expect(await bridge.handle(request("detach", "detach", {}))).toMatchObject({ ok: true, result: { attached: false } });
    expect(adapter.browser.context.page.closed).toBe(0);
  });

  test("requires observation before navigation or tab creation, while preserving observation-only approved navigation", async () => {
    configured();
    const zeroObservationAdapter = new FakeAdapter(); const zeroObservation = new BrowserBridge(zeroObservationAdapter);
    expect(await attach(zeroObservation, false, false, false)).toMatchObject({ ok: true });
    expect(await zeroObservation.handle(request("open-no-observation", "open", { url: "https://example.test/first" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(await zeroObservation.handle(request("tab-open-no-observation", "tab-open", { url: "https://example.test/second" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(zeroObservationAdapter.browser.context.page.gotoUrls).toEqual([]);
    expect(zeroObservationAdapter.browser.context.allPages).toHaveLength(1);

    const observationOnlyAdapter = new FakeAdapter(); const observationOnly = new BrowserBridge(observationOnlyAdapter);
    expect(await attach(observationOnly, false, true, false)).toMatchObject({ ok: true });
    expect(await observationOnly.handle(request("open-observation-only", "open", { url: "https://example.test/first" }))).toMatchObject({ ok: true });
    expect(await observationOnly.handle(request("tab-open-observation-only", "tab-open", { url: "https://example.test/second" }))).toMatchObject({ ok: true });
    expect(observationOnlyAdapter.browser.context.page.gotoUrls).toEqual(["https://example.test/first"]);
    expect(observationOnlyAdapter.browser.context.allPages).toHaveLength(2);
    expect(observationOnlyAdapter.browser.context.allPages[1].gotoUrls).toEqual(["https://example.test/second"]);

    expect(await observationOnly.handle(request("open-private-origin", "open", { url: "https://private.test/" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(await observationOnly.handle(request("tab-open-private-origin", "tab-open", { url: "https://private.test/" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(observationOnlyAdapter.browser.context.page.gotoUrls).toEqual(["https://example.test/first"]);
    expect(observationOnlyAdapter.browser.context.allPages).toHaveLength(2);
  });

  test("uses the initial pristine blank page for the first approved navigation", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.browser.context.page.urlValue = "about:blank"; const bridge = new BrowserBridge(adapter);
    expect(await attach(bridge)).toMatchObject({ ok: true, result: { pageCount: 0 } });
    const opened = await bridge.handle(request("initial-blank", "open", { url: "https://example.test/first" }));
    expect(opened).toMatchObject({ ok: true });
    expect(adapter.browser.context.allPages).toHaveLength(1);
    expect(adapter.browser.context.page.closed).toBe(0);
    expect(adapter.browser.context.page.gotoUrls).toEqual(["https://example.test/first"]);
    expect(await bridge.handle(request("credential-url", "open", { url: "https://user:secret@example.test/" }))).toMatchObject({ ok: false, code: "permission-denied" });
  });

  test("opens a new tab rather than overwriting an unrelated page", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.browser.context.page.urlValue = "https://private.test/"; const bridge = new BrowserBridge(adapter);
    await attach(bridge);
    const opened = await bridge.handle(request("unrelated", "open", { url: "https://example.test/first" }));
    expect(opened).toMatchObject({ ok: true });
    expect(adapter.browser.context.page.urlValue).toBe("https://private.test/");
    expect(adapter.browser.context.page.gotoUrls).toEqual([]);
    expect(adapter.browser.context.allPages).toHaveLength(2);
    expect(adapter.browser.context.allPages[1].gotoUrls).toEqual(["https://example.test/first"]);
  });

  test("rejects explicit unknown or no-longer-approved tab ids without fallback", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    expect(await bridge.handle(request("unknown-tab", "open", { url: "https://example.test/first", tabId: "a".repeat(64) }))).toMatchObject({ ok: false, code: "invalid-request" });
    expect(adapter.browser.context.page.gotoUrls).toEqual([]);
    adapter.browser.context.page.urlValue = "https://private.test/";
    expect(await bridge.handle(request("unapproved-tab", "open", { url: "https://example.test/first", tabId }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(adapter.browser.context.page.gotoUrls).toEqual([]);
  });

  test("filters cross-origin frames and diagnostics, requires known selected tabs, and accepts optional tab filters", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
    await attach(bridge);
    expect(await bridge.handle(request("no-tab", "click", { selector: "button" }))).toMatchObject({ ok: false, code: "invalid-request" });
    const tabs = await bridge.handle(request("tabs", "tabs", {})); const tabId = ((tabs.result as { tabs: Array<{ tabId: string }> }).tabs[0]).tabId;
    adapter.browser.context.page.events.get("console")?.[0]({ type: () => "log", text: () => "secret message" });
    const diagnostics = await bridge.handle(request("console", "console", { tabId }));
    expect(JSON.stringify(diagnostics)).not.toContain("secret message");
    expect(diagnostics).toMatchObject({ ok: true, result: { events: [{ tabId }] } });
    expect(await bridge.handle(request("viewport", "viewport", { tabId, width: 7680, height: 7680 }))).toMatchObject({ ok: true });
  });

  test("re-registers stable page ids after detach clears strong state", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
    await attach(bridge); const first = await bridge.handle(request("tabs", "tabs", {})); const firstId = ((first.result as { tabs: Array<{ tabId: string }> }).tabs[0]).tabId;
    await bridge.handle(request("detach", "detach", {})); await attach(bridge);
    const second = await bridge.handle(request("tabs", "tabs", {}));
    expect((second.result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId).toBe(firstId);
  });

  test("requires input and mutation consent before the only allowed native launch", async () => {
    configured(); const noInput = new BrowserBridge(new FakeAdapter()); await attach(noInput, false, true, true);
    expect(await noInput.handle(request("launch-no-input", "desktop-launch", { app: "mousepad" }))).toMatchObject({ ok: false, code: "permission-denied" });
    const noMutation = new BrowserBridge(new FakeAdapter()); await attach(noMutation, true, true, false);
    expect(await noMutation.handle(request("launch-no-mutation", "desktop-launch", { app: "mousepad" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(await noMutation.handle(request("other-app", "desktop-launch", { app: "terminal" }))).toMatchObject({ ok: false, code: "permission-denied" });
    const noObservation = new BrowserBridge(new FakeAdapter()); await attach(noObservation, true, false, true); const windowId = await launchMousepad(noObservation);
    expect(await noObservation.handle(request("shot-no-observation", "desktop-screenshot", { windowId }))).toMatchObject({ ok: false, code: "permission-denied" });
  });

  test("retries an expected xdotool search miss until its bridge-owned Mousepad window appears", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.searchOutcomes = [xdotoolSearchMiss(), Buffer.from("100\n")]; const bridge = new BrowserBridge(adapter);
    await attach(bridge, true, true, true);
    const windowId = await launchMousepad(bridge);
    expect(windowId).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.desktopCalls.filter((call) => call.args[0] === "search")).toEqual([
      { command: "xdotool", args: ["search", "--onlyvisible", "--pid", "4242"] },
      { command: "xdotool", args: ["search", "--onlyvisible", "--pid", "4242"] },
    ]);
    expect(adapter.terminatedPids).toEqual([]);
  });

  test("does not treat non-no-match xdotool failures as an empty search", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.searchOutcomes = [Object.assign(new Error("xdotool display failure"), { code: 2 })]; const bridge = new BrowserBridge(adapter);
    await attach(bridge, true, true, true);
    expect(await bridge.handle(request("launch-search-failure", "desktop-launch", { app: "mousepad" }))).toMatchObject({ ok: false, code: "provider-unavailable" });
    expect(adapter.terminatedPids).toEqual([adapter.mousepadPid]);
  });

  test("cleans up a timed-out bridge launch without adopting an unrelated Mousepad", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.searchOutcomes = [xdotoolSearchMiss()]; const bridge = new BrowserBridge(adapter);
    await attach(bridge, true, true, true);
    const originalNow = Date.now; let nowCalls = 0;
    Date.now = () => (++nowCalls === 1 ? 0 : nowCalls === 2 ? 1 : 5_001);
    try {
      expect(await bridge.handle(request("launch-timeout", "desktop-launch", { app: "mousepad" }))).toMatchObject({ ok: false, code: "provider-unavailable" });
    } finally { Date.now = originalNow; }
    expect(adapter.terminatedPids).toEqual([adapter.mousepadPid]);
    expect(adapter.terminatedPids).not.toContain(adapter.unrelatedMousepadPid);
    expect(adapter.desktopCalls.filter((call) => call.args[0] === "search")).toEqual([
      { command: "xdotool", args: ["search", "--onlyvisible", "--pid", "4242"] },
    ]);
    expect(await bridge.handle(request("windows-after-timeout", "desktop-windows", {}))).toMatchObject({ ok: true, result: { windows: [] } });
  });

  test("terminates bridge-owned Mousepad children during shutdown", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
    await attach(bridge, true, true, true);
    await launchMousepad(bridge);
    await bridge.shutdown();
    expect(adapter.terminatedPids).toEqual([adapter.mousepadPid]);
    expect(adapter.terminatedPids).not.toContain(adapter.unrelatedMousepadPid);
  });

  test("shutdown advances while an asynchronous native capture is pending", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    const windowId = await launchMousepad(bridge);
    let releaseCapture!: () => void;
    adapter.pendingScrot = new Promise<Buffer>((resolve) => { releaseCapture = () => resolve(Buffer.from("89504e470d0a1a0a0000000d494844520000000200000003080600000000000000", "hex")); });
    const capture = bridge.handle(request("pending-capture", "desktop-screenshot", { windowId }));
    await eventually(() => adapter.desktopCalls.some((call) => call.command === "scrot") ? true : undefined);
    await Promise.race([
      bridge.shutdown(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("shutdown waited for capture")), 100)),
    ]);
    expect(adapter.terminatedPids).toEqual([adapter.mousepadPid]);
    releaseCapture();
    await capture;
  });

  test("returns bounded opaque Mousepad ids and supports meaningful owned screenshots and typing", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    const windowId = await launchMousepad(bridge); expect(windowId).toMatch(/^[a-f0-9]{64}$/); expect(windowId).not.toBe("100");
    expect(await bridge.handle(request("not-mousepad", "desktop-launch", { app: "terminal" }))).toMatchObject({ ok: false, code: "unsupported-capability" });
    const windows = await bridge.handle(request("windows", "desktop-windows", {})); expect(windows).toEqual({ id: "windows", ok: true, result: { windows: [{ windowId, active: true }] } });
    expect(await bridge.handle(request("oversized-id", "desktop-screenshot", { windowId: "a".repeat(129) }))).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await bridge.handle(request("shot", "desktop-screenshot", { windowId }))).toMatchObject({ ok: true, result: { windowId, mimeType: "image/png", width: 2, height: 3 } });
    expect(await bridge.handle(request("type", "desktop-type", { text: "hello world" }))).toMatchObject({ ok: true, result: { windowId } });
    expect(adapter.nativeInputCalls).toContainEqual({ xWindowId: "100", pid: adapter.mousepadPid, operation: "type", values: ["hello world"] });
    expect(adapter.desktopCalls.some((call) => call.args[0] === "type")).toBe(false);
  });

  test("passes LF and TAB to the native type helper intact", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    await launchMousepad(bridge);
    const text = "first line\n\tsecond line";
    expect(await bridge.handle(request("type-controls", "desktop-type", { text }))).toMatchObject({ ok: true });
    expect(adapter.nativeInputCalls).toEqual([{ xWindowId: "100", pid: adapter.mousepadPid, operation: "type", values: [text] }]);
  });

  test("revalidates focus after an XID remap and sends no input to a foreign window", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    await launchMousepad(bridge);
    adapter.windowPids["100"] = badWindow(); adapter.searchOutcomes = [Buffer.from("101\n")]; adapter.windowPids["101"] = adapter.mousepadPid;
    // The initial active XID was owned, but focus changed while Mousepad
    // replaced it. The remapped capability must not authorize global input.
    adapter.activeWindowOutcomes = ["100", "999"];
    expect(await bridge.handle(request("remapped-foreign-focus", "desktop-type", { text: "must not arrive" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(adapter.nativeInputCalls).toEqual([]);
    expect(adapter.desktopCalls.filter((call) => ["type", "key", "click", "mousemove"].includes(call.args[0]))).toEqual([]);
  });

  test("binds native input to the owned XID so focus changes cannot redirect it", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    await launchMousepad(bridge);
    // The second value represents focus changing immediately after ownership
    // validation. The command remains bound to the owned XID, not focus.
    adapter.activeWindowOutcomes = ["100", "999"];
    expect(await bridge.handle(request("bound-type", "desktop-type", { text: "hello" }))).toMatchObject({ ok: true });
    expect(adapter.activeWindowOutcomes).toEqual(["999"]);
    adapter.activeWindowOutcomes = [];
    expect(await bridge.handle(request("bound-click", "desktop-click", { x: 20, y: 30 }))).toMatchObject({ ok: true });
    expect(await bridge.handle(request("bound-key", "desktop-key", { key: "Return" }))).toMatchObject({ ok: true });
    expect(await bridge.handle(request("bound-scroll", "desktop-scroll", { x: 1, y: -2 }))).toMatchObject({ ok: true });
    expect(adapter.nativeInputCalls).toEqual([
      { xWindowId: "100", pid: adapter.mousepadPid, operation: "type", values: ["hello"] },
      { xWindowId: "100", pid: adapter.mousepadPid, operation: "click", values: ["20", "30"] },
      { xWindowId: "100", pid: adapter.mousepadPid, operation: "key", values: ["Return"] },
      { xWindowId: "100", pid: adapter.mousepadPid, operation: "scroll", values: ["260", "170", "1", "-2"] },
    ]);
    expect(adapter.desktopCalls.filter((call) => ["type", "key", "click", "mousemove"].includes(call.args[0]))).toEqual([]);
  });

  test("surfaces a native helper focus or PID rejection without falling back to xdotool", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    await launchMousepad(bridge);
    // This seam represents native-input exiting after its in-grab _NET_WM_PID
    // or XGetInputFocus check. A failure must not retry via global XTEST.
    adapter.nativeInputFailure = new Error("native-input guard rejected target");
    expect(await bridge.handle(request("helper-guard", "desktop-type", { text: "must not arrive" }))).toMatchObject({ ok: false, code: "provider-unavailable" });
    expect(adapter.nativeInputCalls).toEqual([{ xWindowId: "100", pid: adapter.mousepadPid, operation: "type", values: ["must not arrive"] }]);
    expect(adapter.desktopCalls.filter((call) => ["type", "key", "click", "mousemove"].includes(call.args[0]))).toEqual([]);
  });

  test("preserves the opaque ID when the owned Mousepad process replaces its XID", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    const windowId = await launchMousepad(bridge);
    adapter.windowPids["100"] = badWindow();
    adapter.searchOutcomes = [Buffer.from("101\n")];
    adapter.windowPids["101"] = adapter.mousepadPid;
    expect(await bridge.handle(request("replacement", "desktop-screenshot", { windowId }))).toMatchObject({ ok: true, result: { windowId, mimeType: "image/png" } });
    expect(adapter.desktopCalls.filter((call) => call.command === "scrot")).toEqual([{ command: "scrot", args: ["--window", "101", "-"] }]);
    expect(JSON.stringify(await bridge.handle(request("replacement-windows", "desktop-windows", {})))).toContain(windowId);
  });

  test("rejects ambiguous or foreign-PID Mousepad XID replacements", async () => {
    configured();
    const foreign = new FakeAdapter(); const foreignBridge = new BrowserBridge(foreign); await attach(foreignBridge, true, true, true);
    const foreignId = await launchMousepad(foreignBridge); foreign.windowPids["100"] = badWindow(); foreign.searchOutcomes = [Buffer.from("101\n")];
    expect(await foreignBridge.handle(request("foreign-replacement", "desktop-screenshot", { windowId: foreignId }))).toMatchObject({ ok: false, code: "stale-owner" });
    expect(foreign.desktopCalls.filter((call) => call.command === "scrot")).toEqual([]);

    const multiple = new FakeAdapter(); const multipleBridge = new BrowserBridge(multiple); await attach(multipleBridge, true, true, true);
    const multipleId = await launchMousepad(multipleBridge); multiple.windowPids["100"] = badWindow(); multiple.searchOutcomes = [Buffer.from("101\n102\n")]; multiple.windowPids["101"] = multiple.mousepadPid; multiple.windowPids["102"] = multiple.mousepadPid;
    expect(await multipleBridge.handle(request("multiple-replacement", "desktop-screenshot", { windowId: multipleId }))).toMatchObject({ ok: false, code: "stale-owner" });
    expect(multiple.desktopCalls.filter((call) => call.command === "scrot")).toEqual([]);
  });

  test("re-resolves a BadWindow during capture and retries scrot exactly once", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true);
    const windowId = await launchMousepad(bridge); adapter.scrotOutcomes = [badWindow(), Buffer.from("89504e470d0a1a0a0000000d494844520000000200000003080600000000000000", "hex")]; adapter.searchOutcomes = [Buffer.from("101\n")]; adapter.windowPids["101"] = adapter.mousepadPid;
    expect(await bridge.handle(request("capture-replacement", "desktop-screenshot", { windowId }))).toMatchObject({ ok: true, result: { windowId } });
    expect(adapter.desktopCalls.filter((call) => call.command === "scrot")).toEqual([
      { command: "scrot", args: ["--window", "100", "-"] },
      { command: "scrot", args: ["--window", "101", "-"] },
    ]);

    const bounded = new FakeAdapter(); const boundedBridge = new BrowserBridge(bounded); await attach(boundedBridge, true, true, true);
    const boundedId = await launchMousepad(boundedBridge); bounded.scrotOutcomes = [badWindow(), badWindow()]; bounded.searchOutcomes = [Buffer.from("101\n")]; bounded.windowPids["101"] = bounded.mousepadPid;
    expect(await boundedBridge.handle(request("capture-retry-bounded", "desktop-screenshot", { windowId: boundedId }))).toMatchObject({ ok: false, code: "provider-unavailable" });
    expect(bounded.desktopCalls.filter((call) => call.command === "scrot")).toHaveLength(2);
    expect(bounded.desktopCalls.filter((call) => call.args[0] === "search")).toHaveLength(2);
  });

  test("denies cross-window native input and terminal or file-operation shortcuts", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, true, true, true); const windowId = await launchMousepad(bridge);
    adapter.activeWindow = "999";
    expect(await bridge.handle(request("wrong-active", "desktop-click", { x: 20, y: 30, button: "left" }))).toMatchObject({ ok: false, code: "permission-denied" });
    adapter.activeWindow = "100";
    expect(await bridge.handle(request("terminal-shortcut", "desktop-key", { key: "Ctrl+Alt+t" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(await bridge.handle(request("save-shortcut", "desktop-key", { key: "Ctrl+s" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(await bridge.handle(request("off-window", "desktop-click", { x: 700, y: 30, button: "left" }))).toMatchObject({ ok: false, code: "permission-denied" });
    expect(await bridge.handle(request("whole-screen-shot", "desktop-screenshot", {}))).toMatchObject({ ok: false, code: "unsupported-capability" });
    expect(await bridge.handle(request("record", "record", {}))).toMatchObject({ ok: false, code: "unsupported-capability" });
    expect(windowId).toBeDefined();
  });

  test("launches Mousepad with an isolated private profile and removes only owned profiles after child closure", async () => {
    const profiles: string[] = [];
    const unrelated = await fs.mkdtemp(join(tmpdir(), "sandbar-unrelated-"));
    await fs.writeFile(join(unrelated, "keep"), "unrelated");
    let invocation = 0;
    const exec = spyOn(childProcess, "execFile").mockImplementation((_file: any, _args: any, options: any, callback: any) => {
      expect(_file).toBe("mousepad");
      expect(_args).toEqual(["--disable-server"]);
      expect(typeof callback).toBe("function");
      const env = options.env as Record<string, string>;
      const root = dirname(env.XDG_CONFIG_HOME);
      profiles.push(root);
      expect(env).toMatchObject({ HOME: "/config", DISPLAY: ":1", GSETTINGS_BACKEND: "memory" });
      expect(env.XDG_CONFIG_HOME).toBe(join(root, "config"));
      expect(env.XDG_CACHE_HOME).toBe(join(root, "cache"));
      expect(env.XDG_DATA_HOME).toBe(join(root, "data"));
      const child = new EventEmitter() as any;
      child.exitCode = null;
      child.unref = () => {};
      if (invocation++ === 0) {
        child.pid = 7123;
        child.kill = () => { child.exitCode = 0; child.emit("close", 0, "SIGTERM"); return true; };
      } else {
        // execFile's callback is its failed-spawn completion seam: no child
        // exists, so the adapter may clean the profile immediately.
        child.pid = undefined;
        callback(new Error("mousepad spawn denied"), Buffer.alloc(0), Buffer.alloc(0));
      }
      return child;
    });
    try {
      const adapter = new NodeAdapter();
      const launched = await adapter.launchMousepad();
      expect(launched.pid).toBe(7123);
      for (const directory of [profiles[0], join(profiles[0], "config"), join(profiles[0], "cache"), join(profiles[0], "data")]) {
        expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      }
      // The child is live, so its profile remains present until close confirms
      // it can no longer write state.
      await expect(fs.access(profiles[0])).resolves.toBeNull();
      await launched.terminate();
      await expect(fs.access(profiles[0])).rejects.toThrow();

      await expect(adapter.launchMousepad()).rejects.toThrow("mousepad spawn denied");
      await expect(fs.access(profiles[1])).rejects.toThrow();
      await expect(fs.readFile(join(unrelated, "keep"), "utf8")).resolves.toBe("unrelated");
    } finally {
      exec.mockRestore();
      await fs.rm(unrelated, { recursive: true, force: true });
      await Promise.all(profiles.map((profile) => fs.rm(profile, { recursive: true, force: true })));
    }
  });

  test("uses an asynchronous fixed bash pipe for scrot rather than Node's stdout socket", async () => {
    const exec = spyOn(childProcess, "execFile").mockImplementation((_file: any, _args: any, _options: any, callback: any) => {
      callback(null, Buffer.from("png"), Buffer.alloc(0)); return {} as any;
    });
    try {
      await expect(new NodeAdapter().desktop("scrot", ["--window", "123", "-"])).resolves.toEqual(Buffer.from("png"));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith("/bin/bash", ["-o", "pipefail", "-c", "scrot --window \"$1\" - | /bin/cat", "sandbar-screenshot", "123"], {
        encoding: "buffer", env: { PATH: "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config" }, timeout: 3_000, maxBuffer: 5 * 1024 * 1024,
      }, expect.any(Function));
    } finally { exec.mockRestore(); }
  });

  test("runs native input through a fixed bounded helper argv", async () => {
    const exec = spyOn(childProcess, "execFile").mockImplementation((_file: any, _args: any, _options: any, callback: any) => {
      callback(null, Buffer.alloc(0), Buffer.alloc(0)); return {} as any;
    });
    try {
      await new NodeAdapter().nativeInput("123", 456, "type", ["actual typing seam"]);
      expect(exec).toHaveBeenCalledWith("/opt/sandbar-browser/native-input", ["123", "456", "type", "actual typing seam"], {
        encoding: "buffer", maxBuffer: 1024, timeout: 5_000,
        env: { PATH: "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config" }, signal: expect.any(AbortSignal),
      }, expect.any(Function));
    } finally { exec.mockRestore(); }
  });

  test("rejects malformed or injected scrot window ids before starting bash", async () => {
    const exec = spyOn(childProcess, "execFile");
    try {
      const adapter = new NodeAdapter();
      await expect(adapter.desktop("scrot", ["--window", "123; touch /tmp/pwned", "-"])).rejects.toThrow("invalid-request");
      await expect(adapter.desktop("scrot", ["--window", "123", "--format", "png", "-"])).rejects.toThrow("invalid-request");
      expect(exec).not.toHaveBeenCalled();
    } finally { exec.mockRestore(); }
  });

  test("propagates an asynchronous scrot pipeline command failure", async () => {
    const failure = Object.assign(new Error("scrot failed"), { status: 1 });
    const exec = spyOn(childProcess, "execFile").mockImplementation((_file: any, _args: any, _options: any, callback: any) => {
      callback(failure, Buffer.alloc(0), Buffer.from("scrot failed")); return {} as any;
    });
    try {
      await expect(new NodeAdapter().desktop("scrot", ["--window", "123", "-"])).rejects.toBe(failure);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally { exec.mockRestore(); }
  });

  test("hashes only the fixed loopback CDP browser UUID and rejects credentialed metadata", async () => {
    const originalFetch = globalThis.fetch;
    let endpoint = "ws://127.0.0.1:9222/devtools/browser/0123456789abcdef0123456789abcdef";
    globalThis.fetch = (async (input: unknown) => {
      expect(String(input)).toBe("http://127.0.0.1:9222/json/version");
      return new Response(JSON.stringify({ webSocketDebuggerUrl: endpoint }));
    }) as typeof fetch;
    try {
      const adapter = new NodeAdapter();
      const identity = await adapter.browserIdentity();
      expect(identity.browserId).toMatch(/^[a-f0-9]{64}$/);
      expect(identity.browserId).not.toContain("0123456789abcdef0123456789abcdef");
      endpoint = "ws://user:secret@127.0.0.1:9222/devtools/browser/0123456789abcdef0123456789abcdef";
      await expect(adapter.browserIdentity()).rejects.toThrow("invalid CDP metadata");
    } finally { globalThis.fetch = originalFetch; }
  });

  test("uses endpoint-derived identities across fresh CDP wrappers and changes them for a new browser", async () => {
    configured(); const adapter = new FakeAdapter(); adapter.reconnectWithFreshWrappers = true; const bridge = new BrowserBridge(adapter);
    const first = await bridge.handle(request("doctor-1", "doctor", {}));
    const second = await bridge.handle(request("doctor-2", "doctor", {}));
    expect(first).toMatchObject({ ok: true }); expect(second).toMatchObject({ ok: true });
    const firstIdentity = first.result as { browserId: string; contextId: string };
    const secondIdentity = second.result as { browserId: string; contextId: string };
    expect(secondIdentity).toEqual(firstIdentity);
    adapter.browserIdentityValue = "2".repeat(64);
    const restarted = await bridge.handle(request("doctor-3", "doctor", {}));
    expect(restarted).toMatchObject({ ok: true });
    const restartedIdentity = restarted.result as { browserId: string; contextId: string };
    expect(restartedIdentity.browserId).not.toBe(firstIdentity.browserId);
    expect(restartedIdentity.contextId).not.toBe(firstIdentity.contextId);
  });

  test("caps action waits at 20 s, below the daemon's 30 s request timeout", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const page = adapter.browser.context.page; const timeouts: Array<number | undefined> = [];
    const record = (options?: { timeout?: number }) => { timeouts.push(options?.timeout); };
    page.locator = () => ({ click: async (o: any) => record(o), pressSequentially: async (_v: string, o: any) => record(o), selectOption: async (_v: string, o: any) => record(o), waitFor: async (o: any) => record(o), innerText: async (o: any) => { record(o); return "text"; }, setInputFiles: async (_f: unknown, o: any) => record(o) });
    page.goto = async (_url: string, o: any) => { record(o); };
    page.screenshot = async (o: any) => { record(o); return Buffer.from("png"); };
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    for (const [operation, args] of [["open", { url: "https://example.test/" }], ["snapshot", {}], ["click", { selector: "button" }], ["type", { selector: "input", text: "x" }], ["select", { selector: "select", value: "a" }], ["wait", { selector: "button" }], ["screenshot", {}], ["upload", { selector: "input", name: "a.txt", mimeType: "text/plain", data: "eA==" }]] as const) {
      expect(await bridge.handle(request(operation, operation, { tabId, ...args }))).toMatchObject({ ok: true });
    }
    expect(timeouts).toEqual(Array(8).fill(20_000));
    expect(await bridge.handle(request("wait-max", "wait", { tabId, milliseconds: 20_001 }))).toMatchObject({ ok: false, code: "invalid-request" });
    expect(await bridge.handle(request("wait-ok", "wait", { tabId, milliseconds: 20_000 }))).toMatchObject({ ok: true });
  });

  test("maps a Playwright TimeoutError to a typed timeout and keeps serving requests", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const page = adapter.browser.context.page; const original = page.locator.bind(page);
    page.locator = () => ({ click: async () => { throw Object.assign(new Error("locator.click: Timeout 20000ms exceeded."), { name: "TimeoutError" }); } });
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    expect(await bridge.handle(request("click-miss", "click", { tabId, selector: "role=button[name=\"X\"s] >> nth=0" }))).toEqual({ id: "click-miss", ok: false, code: "timeout" });
    page.locator = original;
    expect(await bridge.handle(request("doctor", "doctor", {}))).toMatchObject({ ok: true, result: { attached: true } });
    expect(await bridge.handle(request("click-ok", "click", { tabId, selector: "button" }))).toMatchObject({ ok: true });
  });

  test("maps Playwright selector errors to invalid-request and keeps provider-unavailable for transport failures", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const page = adapter.browser.context.page; const original = page.locator.bind(page);
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    for (const message of [
      "locator.click: Error: strict mode violation: locator('.gallery-item') resolved to 3 elements:\n    1) <div class=\"gallery-item closed\">…</div>",
      "locator.click: Unexpected token \"]\" while parsing css selector \"a]\". Did you mean to CSS.escape it?",
      "locator.click: Unknown engine \"bogus\" while parsing selector bogus=x",
    ]) {
      page.locator = () => ({ click: async () => { throw new Error(message); } });
      expect(await bridge.handle(request("click-bad", "click", { tabId, selector: ".gallery-item" }))).toEqual({ id: "click-bad", ok: false, code: "invalid-request" });
    }
    page.locator = () => ({ click: async () => { throw new Error("browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222"); } });
    expect(await bridge.handle(request("click-dead", "click", { tabId, selector: "button" }))).toEqual({ id: "click-dead", ok: false, code: "provider-unavailable" });
    page.locator = original;
    expect(await bridge.handle(request("click-ok", "click", { tabId, selector: ".gallery-item >> nth=0" }))).toMatchObject({ ok: true });
  });

  test("a never-resolving page call times out before the cap and does not poison the next request", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, 50); await attach(bridge);
    const page = adapter.browser.context.page; const original = page.locator.bind(page);
    let release: () => void = () => {}; const hung = new Promise<void>((resolve) => { release = resolve; });
    page.locator = () => ({ click: () => hung.then(() => { throw new Error("late failure after abandonment"); }) });
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    const started = Date.now();
    expect(await bridge.handle(request("hung", "click", { tabId, selector: "button" }))).toEqual({ id: "hung", ok: false, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    page.locator = original;
    expect(await bridge.handle(request("doctor", "doctor", {}))).toMatchObject({ ok: true });
    expect(await bridge.handle(request("click-ok", "click", { tabId, selector: "button" }))).toMatchObject({ ok: true });
    release(); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(await bridge.handle(request("after-late", "tabs", {}))).toMatchObject({ ok: true });
  });

  test("reports a TimeoutError as timeout even when its call log mentions a closed or detached element", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
    const page = adapter.browser.context.page;
    page.locator = () => ({ click: async () => { throw Object.assign(new Error("Timeout 20000ms exceeded.\n  - element was detached from the DOM, retrying; dialog closed"), { name: "TimeoutError" }); } });
    const tabId = ((await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string }> }).tabs[0].tabId;
    expect(await bridge.handle(request("click", "click", { tabId, selector: "button" }))).toMatchObject({ ok: false, code: "timeout" });
  });

  test("an abandoned open that settles after detach does not repopulate bridge state", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, 20); await attach(bridge);
    const page = adapter.browser.context.page; let release: () => void = () => {};
    page.goto = () => new Promise<void>((resolve) => { release = resolve; });
    expect(await bridge.handle(request("open", "open", { url: "https://example.test/slow" }))).toMatchObject({ ok: false, code: "timeout" });
    expect(await bridge.handle(request("detach", "detach", {}))).toMatchObject({ ok: true });
    await attach(bridge);
    release(); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(await bridge.handle(request("tabs", "tabs", {}))).toMatchObject({ ok: true, result: { tabs: [{ selected: false }] } });
  });

  test("a new tab whose newPage settles after detach is closed and not re-registered", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, 20); await attach(bridge);
    const context = adapter.browser.context; let settle: () => void = () => {}; const created: FakePage[] = [];
    context.newPage = () => new Promise<FakePage>((resolve) => { settle = () => { const page = new FakePage("about:blank"); created.push(page); context.allPages.push(page); resolve(page); }; });
    expect(await bridge.handle(request("tab-open", "tab-open", { url: "https://example.test/new" }))).toMatchObject({ ok: false, code: "timeout" });
    expect(await bridge.handle(request("detach", "detach", {}))).toMatchObject({ ok: true });
    await attach(bridge);
    settle(); await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(created).toHaveLength(1);
    expect(created[0].closed).toBe(1);
    expect(created[0].gotoUrls).toEqual([]);
    const tabs = (await bridge.handle(request("tabs", "tabs", {}))).result as { tabs: Array<{ tabId: string; selected: boolean }> };
    expect(tabs.tabs.every((tab) => !tab.selected)).toBe(true);
    expect([...(bridge as any).pages.values()]).not.toContain(created[0]);
    expect((bridge as any).selectedTabId).toBeUndefined();
  });

  test("rejects malformed schemas and omits browser URLs from doctor", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
    expect(await bridge.handle({ id: "bad id", operation: "doctor", args: {} })).toMatchObject({ ok: false, code: "invalid-request" });
    const doctor = await bridge.handle(request("doctor", "doctor", {}));
    expect(doctor).toMatchObject({ ok: true, result: { pageCount: 1, attached: false, display: { width: 1024, height: 768 } } });
    expect(JSON.stringify(doctor)).not.toContain("http");
    expect(adapter.browser.closedConnections).toBe(1);
  });

  describe("qa-layout input scope", () => {
    test("attach rejects an unknown scope and qa-layout with mutations; absent scope keeps full input", async () => {
      configured();
      expect(await qaAttach(new BrowserBridge(new FakeAdapter()), "anything")).toMatchObject({ ok: false, code: "invalid-request" });
      expect(await qaAttach(new BrowserBridge(new FakeAdapter()), "qa-layout", true)).toMatchObject({ ok: false, code: "invalid-request" });
      const bridge = new BrowserBridge(new FakeAdapter()); expect(await qaAttach(bridge, "full")).toMatchObject({ ok: true });
      const full = new BrowserBridge(new FakeAdapter()); expect(await attach(full)).toMatchObject({ ok: true });
      const tabId = await firstTabId(full);
      expect(await full.handle(request("type", "type", { tabId, selector: "input", text: "x" }))).toMatchObject({ ok: true });
      expect(await full.handle(request("key", "key", { tabId, key: "Enter" }))).toMatchObject({ ok: true });
    });

    test("denies type, select, key, upload and every desktop operation even with allowInput", async () => {
      configured(); const bridge = new BrowserBridge(new FakeAdapter(), undefined, 0); expect(await qaAttach(bridge)).toMatchObject({ ok: true });
      const tabId = await firstTabId(bridge);
      const denied: Array<[string, Record<string, unknown>]> = [
        ["type", { tabId, selector: "input", text: "x" }], ["select", { tabId, selector: "select", value: "v" }], ["key", { tabId, key: "Enter" }],
        ["upload", { tabId, selector: "input", name: "x.txt", mimeType: "text/plain", data: "eA==" }],
        ["desktop-screenshot", { windowId: "w" }], ["desktop-click", { x: 1, y: 1 }], ["desktop-type", { text: "x" }], ["desktop-key", { key: "Return" }],
        ["desktop-scroll", { x: 0, y: 1 }], ["desktop-launch", { app: "mousepad" }], ["desktop-windows", {}], ["desktop-activate", { windowId: "w" }],
      ];
      for (const [operation, args] of denied) expect(await bridge.handle(request(operation, operation, args))).toMatchObject({ ok: false, code: "permission-denied" });
      expect(await bridge.handle(request("click", "click", { tabId, selector: "#tile" }))).toMatchObject({ ok: true, result: { tabId } });
      expect(await bridge.handle(request("scroll", "scroll", { tabId, x: 0, y: 400 }))).toMatchObject({ ok: true });
      expect(await bridge.handle(request("viewport", "viewport", { tabId, width: 390, height: 844 }))).toMatchObject({ ok: true });
    });

    test("fails a click whose top-level navigation the origin route aborted", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, 0); await qaAttach(bridge);
      const tabId = await firstTabId(bridge); const offOrigin = navigationRoute("https://outside.test/");
      adapter.browser.context.page.onClick = async () => { await adapter.browser.context.routes[0].handler(offOrigin); };
      expect(await bridge.handle(request("click", "click", { tabId, selector: "a" }))).toMatchObject({ ok: false, code: "permission-denied" });
      expect(offOrigin.aborted).toBe(true);
      // The fence is per click: a later click with no blocked navigation succeeds.
      adapter.browser.context.page.onClick = async () => {};
      expect(await bridge.handle(request("click-2", "click", { tabId, selector: "a" }))).toMatchObject({ ok: true });
    });

    test("fails a click that opened an off-origin popup and closes the popup", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, 0); await qaAttach(bridge);
      const tabId = await firstTabId(bridge); let popup: FakePage | undefined;
      // window.open("about:blank") then a script write keeps the popup off-origin without a routed request.
      adapter.browser.context.page.onClick = async () => { popup = await adapter.browser.context.newPage(); };
      expect(await bridge.handle(request("click", "click", { tabId, selector: "a" }))).toMatchObject({ ok: false, code: "permission-denied" });
      expect(popup!.closed).toBeGreaterThan(0);
    });

    test("fails a click that left the clicked page itself off the approved origins", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, 0); await qaAttach(bridge);
      const tabId = await firstTabId(bridge); const page = adapter.browser.context.page;
      page.onClick = async () => { page.urlValue = "about:blank"; };
      expect(await bridge.handle(request("click", "click", { tabId, selector: "a" }))).toMatchObject({ ok: false, code: "permission-denied" });
    });

    test("allows a click whose navigation or popup stays on approved origins, and ignores aborted subframe navigations", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, 0); await qaAttach(bridge);
      const tabId = await firstTabId(bridge); const subframe = navigationRoute("https://ads.outside.test/frame", {});
      adapter.browser.context.page.onClick = async () => {
        await adapter.browser.context.routes[0].handler(subframe);
        const sameOrigin = navigationRoute("https://example.test/next"); await adapter.browser.context.routes[0].handler(sameOrigin);
        const popup = await adapter.browser.context.newPage(); popup.urlValue = "https://example.test/lightbox";
      };
      expect(await bridge.handle(request("click", "click", { tabId, selector: "#tile" }))).toMatchObject({ ok: true, result: { tabId } });
      expect(subframe.aborted).toBe(true);
    });

    test("a full-scope click keeps today's behaviour when its navigation is aborted", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, 0); await attach(bridge);
      const tabId = await firstTabId(bridge); const offOrigin = navigationRoute("https://outside.test/");
      adapter.browser.context.page.onClick = async () => { await adapter.browser.context.routes[0].handler(offOrigin); };
      expect(await bridge.handle(request("click", "click", { tabId, selector: "a" }))).toMatchObject({ ok: true });
      expect(offOrigin.aborted).toBe(true);
    });
  });
  describe("layout metric", () => {
    test("returns exactly the six document geometry integers from a fixed in-bridge read", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge, false, true);
      const tabId = await firstTabId(bridge);
      const response = await bridge.handle(request("layout", "layout", { tabId }));
      expect(response).toEqual({ id: "layout", ok: true, result: { scrollWidth: 1440, scrollHeight: 5200, clientWidth: 1440, clientHeight: 900, innerWidth: 1440, innerHeight: 900 } });
      // The selected tab is the default, as for screenshot.
      await bridge.handle(request("select", "tab-select", { tabId }));
      expect(await bridge.handle(request("layout-default", "layout", {}))).toMatchObject({ ok: true });
      expect(adapter.browser.context.page.evaluated).toHaveLength(2);
    });

    test("requires observation and rejects any argument but tabId", async () => {
      configured(); const blind = new BrowserBridge(new FakeAdapter()); await attach(blind, true, false);
      expect(await blind.handle(request("layout", "layout", {}))).toMatchObject({ ok: false, code: "permission-denied" });
      const bridge = new BrowserBridge(new FakeAdapter()); await attach(bridge);
      const tabId = await firstTabId(bridge);
      for (const args of [{ tabId, selector: "body" }, { tabId, script: "1" }, { expression: "document.title" }]) {
        expect(await bridge.handle(request("layout", "layout", args))).toMatchObject({ ok: false, code: "invalid-request" });
      }
      expect(await new BrowserBridge(new FakeAdapter()).handle(request("layout", "layout", {}))).toMatchObject({ ok: false, code: "session-lost" });
    });

    test("is allowed under qa-layout", async () => {
      configured(); const bridge = new BrowserBridge(new FakeAdapter()); expect(await qaAttach(bridge)).toMatchObject({ ok: true });
      expect(await bridge.handle(request("layout", "layout", { tabId: await firstTabId(bridge) }))).toMatchObject({ ok: true, result: { scrollWidth: 1440 } });
    });

    test("fails verification on a missing, negative, fractional or non-numeric page value", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await attach(bridge);
      const tabId = await firstTabId(bridge); const page = adapter.browser.context.page;
      const good = { scrollWidth: 390, scrollHeight: 800, clientWidth: 390, clientHeight: 844, innerWidth: 390, innerHeight: 844 };
      for (const bad of [null, "390", { ...good, innerHeight: undefined }, { ...good, scrollWidth: -1 }, { ...good, clientWidth: 389.5 }, { ...good, innerWidth: "390" }]) {
        page.layoutMetrics = bad;
        expect(await bridge.handle(request("layout", "layout", { tabId }))).toMatchObject({ ok: false, code: "verification-failed" });
      }
      // Extra page keys never reach the caller.
      page.layoutMetrics = { ...good, title: "secret" };
      expect(await bridge.handle(request("layout", "layout", { tabId }))).toEqual({ id: "layout", ok: true, result: good });
    });
  });

  describe("qa-layout subresource origins", () => {
    test("attach rejects subresourceOrigins outside qa-layout and when malformed", async () => {
      configured();
      expect(await subresourceAttach(new BrowserBridge(new FakeAdapter()), FONT_ORIGINS, "absent")).toMatchObject({ ok: false, code: "invalid-request" });
      expect(await subresourceAttach(new BrowserBridge(new FakeAdapter()), FONT_ORIGINS, "full")).toMatchObject({ ok: false, code: "invalid-request" });
      for (const bad of [[], "https://fonts.example.test", ["https://fonts.example.test/css"], ["ftp://fonts.example.test"], ["https://user:pw@fonts.example.test"], [42], Array.from({ length: 33 }, (_v, i) => `https://f${i}.example.test`)]) {
        expect(await subresourceAttach(new BrowserBridge(new FakeAdapter()), bad)).toMatchObject({ ok: false, code: "invalid-request" });
      }
      expect(await subresourceAttach(new BrowserBridge(new FakeAdapter()))).toMatchObject({ ok: true });
    });

    test("continues a GET stylesheet, font or image to a listed origin", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await subresourceAttach(bridge);
      const handler = adapter.browser.context.routes[0].handler;
      for (const [url, type] of [["https://fonts.example.test/css2?family=Archivo", "stylesheet"], ["https://static.example.test/s/font.woff2", "font"], ["https://static.example.test/logo.png", "image"]]) {
        const route = resourceRoute(url, type); await handler(route);
        expect(route).toMatchObject({ continued: true, aborted: false });
      }
    });

    test("still aborts navigation, non-GET, other resource types and unlisted origins", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await subresourceAttach(bridge);
      const handler = adapter.browser.context.routes[0].handler;
      const denied = [
        resourceRoute("https://fonts.example.test/", "document", "GET", true),
        resourceRoute("https://fonts.example.test/frame", "document", "GET", true),
        resourceRoute("https://fonts.example.test/font.woff2", "font", "GET", true),
        resourceRoute("https://fonts.example.test/font.woff2", "font", "POST"),
        resourceRoute("https://fonts.example.test/font.woff2", "font", "HEAD"),
        resourceRoute("https://fonts.example.test/app.js", "script"),
        resourceRoute("https://fonts.example.test/api", "xhr"),
        resourceRoute("https://fonts.example.test/api", "fetch"),
        resourceRoute("https://fonts.example.test/beacon", "ping", "POST"),
        resourceRoute("https://unlisted.example.test/font.woff2", "font"),
        resourceRoute("http://fonts.example.test/font.woff2", "font"),
      ];
      for (const route of denied) { await handler(route); expect(route).toMatchObject({ aborted: true, continued: false }); }
      // A request whose details cannot be read fails closed.
      const opaque = { request: () => ({ url: () => "https://fonts.example.test/font.woff2", method: () => "GET", resourceType: () => { throw new Error("detached"); }, isNavigationRequest: () => false }), abort: async () => { opaque.aborted = true; }, continue: async () => { opaque.continued = true; }, aborted: false, continued: false };
      await handler(opaque); expect(opaque).toMatchObject({ aborted: true, continued: false });
    });

    test("a qa-layout click whose top-level navigation targets a listed subresource origin still fails", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, 0); await subresourceAttach(bridge);
      const tabId = await firstTabId(bridge); const offOrigin = navigationRoute("https://fonts.example.test/");
      adapter.browser.context.page.onClick = async () => { await adapter.browser.context.routes[0].handler(offOrigin); };
      expect(await bridge.handle(request("click", "click", { tabId, selector: "a" }))).toMatchObject({ ok: false, code: "permission-denied" });
      expect(offOrigin.aborted).toBe(true);
    });

    test("absent subresourceOrigins keeps the off-origin abort for every resource type", async () => {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter); await qaAttach(bridge);
      const handler = adapter.browser.context.routes[0].handler;
      for (const type of ["stylesheet", "font", "image"]) { const route = resourceRoute("https://fonts.example.test/x", type); await handler(route); expect(route.aborted).toBe(true); }
      const sameOrigin = resourceRoute("https://example.test/style.css", "stylesheet"); await handler(sameOrigin); expect(sameOrigin.continued).toBe(true);
    });
  });

  describe("credential broker operations", () => {
    const CANARY = "CANARY-s3cr3t-7f1e9b";
    const LEASE = ["https://example.test", "https://other.test"];
    // An element as probeCredentialField sees it; defaults are a fillable password input.
    // `form` is the input's form owner (absent: none); `submitters` are the formmethod values of its associated buttons;
    // `prototypes: false` removes the window's HTMLFormElement, as a page that broke it would.
    interface FakeForm { method: string; submitters?: string[]; prototypes?: false }
    interface FakeField { localName?: string; type?: string; topDocument?: boolean; connected?: boolean; disabled?: boolean; readOnly?: boolean; visible?: boolean; form?: FakeForm }
    interface FieldHooks { onEvaluate?: () => void; onVisible?: () => void; onFill?: () => void; count?: () => Promise<number>; fillError?: Error }
    function probeCredentialFieldOf(field: FakeField) { return probeCredentialField(fakeElement(field)); }
    function fakeElement(field: FakeField): unknown {
      const doc: Record<string, unknown> = {}; const view: Record<string, unknown> = { document: doc };
      view.top = field.topDocument === false ? {} : view; doc.defaultView = view;
      let form: Record<string, unknown> | null = null;
      if (field.form) {
        // A control named "method" clobbers form.method; the probe must read through the prototype.
        form = { methodValue: field.form.method, method: { localName: "input" } };
        const owner = form;
        if (field.form.prototypes !== false) view.HTMLFormElement = { prototype: Object.defineProperty({}, "method", { get(this: { methodValue: string }) { return this.methodValue; } }) };
        doc.submitters = (field.form.submitters ?? []).map((formMethod) => ({ form: owner, formMethod }));
      }
      view.Document = { prototype: { querySelectorAll(this: { submitters?: unknown[] }, query: string) { expect(query).toBe("[formmethod]"); return this.submitters ?? []; } } };
      return { form, namespaceURI: "http://www.w3.org/1999/xhtml", localName: field.localName ?? "input", type: field.type ?? "password", isConnected: field.connected ?? true, readOnly: field.readOnly ?? false, ownerDocument: doc, matches: (query: string) => query === ":disabled" && (field.disabled ?? false), hasAttribute: () => false };
    }
    // Replaces the page's locator with one whose selector resolves to `matches[selector]`, and records every fill.
    // Any element access on a selector without exactly one match is recorded in `fills.touched`.
    function credentialFields(page: FakePage, matches: Record<string, FakeField[]>, hooks: FieldHooks = {}): Array<{ selector: string; value: string }> & { touched: number } {
      const fills = Object.assign([] as Array<{ selector: string; value: string }>, { touched: 0 });
      page.locator = (selector: string) => {
        const elements = matches[selector] ?? [];
        // As Playwright: several matches throw a strict-mode error; zero matches wait and time out.
        const single = (): FakeField => {
          if (elements.length === 1) return elements[0];
          fills.touched++;
          if (elements.length > 1) throw new Error(`strict mode violation: locator('${selector}') resolved to ${elements.length} elements`);
          throw Object.assign(new Error("Timeout 20000ms exceeded."), { name: "TimeoutError" });
        };
        return {
          count: hooks.count ?? (async () => elements.length),
          evaluate: async (fn: Function) => { const element = fakeElement(single()); hooks.onEvaluate?.(); return fn(element); },
          isVisible: async () => { const visible = single().visible ?? true; hooks.onVisible?.(); return visible; },
          fill: async (value: string, options: { timeout?: number }) => { single(); expect(options.timeout).toBe(2_000); hooks.onFill?.(); if (hooks.fillError) throw hooks.fillError; fills.push({ selector, value }); },
        };
      };
      return fills;
    }
    function leaseAttach(bridge: BrowserBridge, options: { allowInput?: boolean; allowObservation?: boolean; inputScope?: string } = {}) {
      return bridge.handle(request("attach", "attach", { origins: LEASE, allowInput: options.allowInput ?? false, allowMutations: false, allowObservation: options.allowObservation ?? false, ...(options.inputScope ? { inputScope: options.inputScope } : {}) }));
    }
    // The broker's caller has no observation grant, so tab ids come from bridge state as the daemon tracks them.
    function tabIdOf(bridge: BrowserBridge, page: FakePage): string { return (bridge as any).pageIds.get(page); }
    function credential(tabId: string, overrides: Record<string, unknown> = {}) { return { tabId, field: "password", selector: "#password", value: CANARY, expectOrigin: "https://example.test", ...overrides }; }
    async function leased(options: Parameters<typeof leaseAttach>[1] = {}, deadlineMs?: number) {
      configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, deadlineMs);
      expect(await leaseAttach(bridge, options)).toMatchObject({ ok: true });
      const page = adapter.browser.context.page; return { adapter, bridge, page, tabId: tabIdOf(bridge, page) };
    }

    test("committed-origin returns exactly the approved main-frame origin with no observation or input grant", async () => {
      const { bridge, page, tabId } = await leased();
      expect(await bridge.handle(request("origin", "committed-origin", { tabId }))).toEqual({ id: "origin", ok: true, result: { origin: "https://example.test" } });
      page.urlValue = "https://other.test/login?next=%2F";
      expect(await bridge.handle(request("origin-other", "committed-origin", { tabId }))).toEqual({ id: "origin-other", ok: true, result: { origin: "https://other.test" } });
    });

    test("committed-origin refuses an origin outside the lease, a missing or extra argument, and no attachment", async () => {
      const { bridge, page, tabId } = await leased();
      page.urlValue = "https://private.test/";
      expect(await bridge.handle(request("outside", "committed-origin", { tabId }))).toEqual({ id: "outside", ok: false, code: "permission-denied" });
      page.urlValue = "about:blank";
      expect(await bridge.handle(request("blank", "committed-origin", { tabId }))).toEqual({ id: "blank", ok: false, code: "permission-denied" });
      page.urlValue = "https://example.test/";
      for (const args of [{}, { tabId, frame: "main" }, { tabId: "not an id" }, { tabId: "a".repeat(64) }]) {
        expect(await bridge.handle(request("bad", "committed-origin", args))).toMatchObject({ ok: false, code: "invalid-request" });
      }
      expect(await new BrowserBridge(new FakeAdapter()).handle(request("detached", "committed-origin", { tabId }))).toMatchObject({ ok: false, code: "session-lost" });
    });

    test("credential-type fills each field into a fitting input and returns exactly {}", async () => {
      const { bridge, page, tabId } = await leased();
      const cases: Array<[string, string]> = [["password", "password"], ["username", "text"], ["username", "email"], ["username", "tel"], ["totp", "text"], ["totp", "tel"], ["totp", "number"]];
      for (const [field, type] of cases) {
        const fills = credentialFields(page, { "#field": [{ type }] });
        const response = await bridge.handle(request(`fill-${field}-${type}`, "credential-type", credential(tabId, { field, selector: "#field" })));
        expect(response).toEqual({ id: `fill-${field}-${type}`, ok: true, result: {} });
        expect(fills).toEqual([{ selector: "#field", value: CANARY }]);
      }
      // A missing, empty or unknown type attribute is normalized by the browser to "text".
      const fills = credentialFields(page, { "input[name=user]": [{ type: "text" }] });
      expect(await bridge.handle(request("default-type", "credential-type", credential(tabId, { field: "username", selector: "input[name=user]" })))).toEqual({ id: "default-type", ok: true, result: {} });
      expect(fills).toHaveLength(1);
    });

    test("credential-type needs no allowInput or observation grant but still requires an attachment", async () => {
      const { bridge, page, tabId } = await leased({ allowInput: false, allowObservation: false });
      const fills = credentialFields(page, { "#password": [{}] });
      expect(await bridge.handle(request("no-grants", "credential-type", credential(tabId)))).toEqual({ id: "no-grants", ok: true, result: {} });
      expect(fills).toHaveLength(1);
      expect(await bridge.handle(request("detach", "detach", {}))).toMatchObject({ ok: true });
      expect(await bridge.handle(request("after-detach", "credential-type", credential(tabId)))).toEqual({ id: "after-detach", ok: false, code: "session-lost" });
      expect(fills).toHaveLength(1);
    });

    test("refuses an expectOrigin that differs from the page or a page origin outside the lease", async () => {
      const { bridge, page, tabId } = await leased();
      const fills = credentialFields(page, { "#password": [{}] });
      // Both origins are leased, but the broker expected the other one.
      expect(await bridge.handle(request("mismatch", "credential-type", credential(tabId, { expectOrigin: "https://other.test" })))).toEqual({ id: "mismatch", ok: false, code: "permission-denied" });
      page.urlValue = "https://private.test/login";
      expect(await bridge.handle(request("outside", "credential-type", credential(tabId, { expectOrigin: "https://private.test" })))).toEqual({ id: "outside", ok: false, code: "permission-denied" });
      expect(fills).toEqual([]);
    });

    test("refuses zero or several selector matches with nothing filled", async () => {
      const { bridge, page, tabId } = await leased();
      const fills = credentialFields(page, { "#password": [], ".password": [{}, {}] });
      expect(await bridge.handle(request("zero", "credential-type", credential(tabId)))).toEqual({ id: "zero", ok: false, code: "invalid-request" });
      expect(await bridge.handle(request("two", "credential-type", credential(tabId, { selector: ".password" })))).toEqual({ id: "two", ok: false, code: "invalid-request" });
      expect(fills).toEqual([]);
      // The count gate refuses before any element is probed or filled.
      expect(fills.touched).toBe(0);
    });

    test("refuses an element whose kind or input type does not fit the field", async () => {
      const { bridge, page, tabId } = await leased();
      const denied: Array<[string, FakeField]> = [
        ["password", { type: "text" }], ["password", { type: "email" }], ["username", { type: "password" }], ["username", { type: "search" }],
        ["username", { type: "hidden" }], ["totp", { type: "password" }], ["totp", { type: "email" }], ["password", { localName: "textarea", type: "textarea" }],
        ["password", { localName: "div", type: "" }],
      ];
      for (const [field, element] of denied) {
        const fills = credentialFields(page, { "#field": [element] });
        expect(await bridge.handle(request(`deny-${field}`, "credential-type", credential(tabId, { field, selector: "#field" })))).toEqual({ id: `deny-${field}`, ok: false, code: "permission-denied" });
        expect(fills).toEqual([]);
      }
    });

    test("refuses a hidden, disabled, readonly, disconnected or non-top-document input", async () => {
      const { bridge, page, tabId } = await leased();
      for (const element of [{ visible: false }, { disabled: true }, { readOnly: true }, { connected: false }, { topDocument: false }] as FakeField[]) {
        const fills = credentialFields(page, { "#password": [element] });
        expect(await bridge.handle(request("unfit", "credential-type", credential(tabId)))).toEqual({ id: "unfit", ok: false, code: "permission-denied" });
        expect(fills).toEqual([]);
      }
    });

    test("refuses selectors that chain parts or enter a frame before resolving them", async () => {
      const { bridge, page, tabId } = await leased();
      let resolved = 0; const original = credentialFields(page, {}); const locator = page.locator;
      page.locator = (selector: string) => { resolved++; return locator(selector); };
      for (const selector of ["iframe >> #password", "#a>>#b", "internal:control=enter-frame", "iframe >> internal:control=enter-frame >> input", "INTERNAL:attr=[name=p]", "control=enter-frame", "internal:has=\"#x\""]) {
        expect(await bridge.handle(request("selector", "credential-type", credential(tabId, { selector })))).toEqual({ id: "selector", ok: false, code: "invalid-request" });
      }
      expect(resolved).toBe(0); expect(original).toEqual([]);
    });

    test("rejects malformed arguments as invalid-request", async () => {
      const { bridge, page, tabId } = await leased();
      const fills = credentialFields(page, { "#password": [{}] });
      const { tabId: _omit, ...withoutTab } = credential(tabId);
      const malformed: Record<string, unknown>[] = [
        withoutTab, { ...credential(tabId), extra: true }, credential(tabId, { field: "pin" }), credential(tabId, { field: undefined }),
        credential(tabId, { value: "" }), credential(tabId, { value: "x".repeat(1025) }), credential(tabId, { value: `${CANARY}\0` }), credential(tabId, { value: 1234 }),
        credential(tabId, { selector: "" }), credential(tabId, { expectOrigin: "http://example.test" }), credential(tabId, { expectOrigin: "https://example.test/" }),
        credential(tabId, { expectOrigin: "https://example.test/login" }), credential(tabId, { expectOrigin: "https://user:pw@example.test" }), credential(tabId, { expectOrigin: "https://example.test:443" }),
        credential(tabId, { expectOrigin: "example.test" }), credential(tabId, { expectOrigin: undefined }),
      ];
      for (const args of malformed) expect(await bridge.handle(request("malformed", "credential-type", args))).toEqual({ id: "malformed", ok: false, code: "invalid-request" });
      expect(fills).toEqual([]);
      // 1024 characters is the inclusive limit.
      expect(await bridge.handle(request("max", "credential-type", credential(tabId, { value: "x".repeat(1024) })))).toEqual({ id: "max", ok: true, result: {} });
    });

    test("both operations are denied under qa-layout", async () => {
      const { bridge, page, tabId } = await leased({ allowInput: true, allowObservation: true, inputScope: "qa-layout" });
      const fills = credentialFields(page, { "#password": [{}] });
      expect(await bridge.handle(request("qa-origin", "committed-origin", { tabId }))).toEqual({ id: "qa-origin", ok: false, code: "permission-denied" });
      expect(await bridge.handle(request("qa-type", "credential-type", credential(tabId)))).toEqual({ id: "qa-type", ok: false, code: "permission-denied" });
      expect(fills).toEqual([]);
    });

    test("a navigation between the origin check and the fill is refused with nothing filled", async () => {
      const { bridge, page, tabId } = await leased();
      // A navigation to another leased origin after the element checks.
      let fills = credentialFields(page, { "#password": [{}] }, { onVisible: () => { page.urlValue = "https://other.test/phish"; } });
      expect(await bridge.handle(request("nav-origin", "credential-type", credential(tabId)))).toEqual({ id: "nav-origin", ok: false, code: "permission-denied" });
      expect(fills).toEqual([]);
      // A navigation away and back to the same origin is caught by the main-frame event.
      page.urlValue = "https://example.test/";
      fills = credentialFields(page, { "#password": [{}] }, { onEvaluate: () => page.emit("framenavigated", page) });
      expect(await bridge.handle(request("nav-same", "credential-type", credential(tabId)))).toEqual({ id: "nav-same", ok: false, code: "permission-denied" });
      expect(fills).toEqual([]);
      // A subframe navigation does not void the main-frame check.
      fills = credentialFields(page, { "#password": [{}] }, { onEvaluate: () => page.emit("framenavigated", new FakePage("https://ads.test/")) });
      expect(await bridge.handle(request("nav-subframe", "credential-type", credential(tabId)))).toEqual({ id: "nav-subframe", ok: true, result: {} });
      expect(fills).toHaveLength(1);
      // The listener is removed once the request settles.
      expect((page.events.get("framenavigated") ?? []).length).toBe(1);
    });

    test("a navigation during the fill reports verification-failed, never {}", async () => {
      const { bridge, page, tabId } = await leased();
      credentialFields(page, { "#password": [{}] }, { onFill: () => { page.urlValue = "https://other.test/"; page.emit("framenavigated", page); } });
      expect(await bridge.handle(request("nav-during", "credential-type", credential(tabId)))).toEqual({ id: "nav-during", ok: false, code: "verification-failed" });
    });

    test("an abandoned request that settles after its deadline never fills", async () => {
      let release: () => void = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; });
      const { bridge, page, tabId } = await leased({}, 50);
      const fills = credentialFields(page, { "#password": [{}] }, { count: async () => { await gate; return 1; } });
      expect(await bridge.handle(request("hung", "credential-type", credential(tabId)))).toEqual({ id: "hung", ok: false, code: "timeout" });
      release(); await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(fills).toEqual([]);
      expect(await bridge.handle(request("next", "committed-origin", { tabId }))).toMatchObject({ ok: true });
    });

    describe("filled pages outlive no lease", () => {
      // Sends a request and keeps its response, so each test can prove the canary never left.
      function recorder(bridge: BrowserBridge) {
        const responses: BridgeResponse[] = [];
        const send = async (id: string, operation: string, args: Record<string, unknown>) => { const response = await bridge.handle(request(id, operation, args)); responses.push(response); return response; };
        return { responses, send };
      }
      function observerAttach(bridge: BrowserBridge) { return leaseAttach(bridge, { allowObservation: true }); }
      function expectNoCanary(responses: BridgeResponse[]): void { expect(responses.length).toBeGreaterThan(0); expect(JSON.stringify(responses)).not.toContain(CANARY); }

      test("the fill marks the page in memory and in its document, before the value moves", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        let markedAtFill: boolean | undefined;
        credentialFields(page, { "#password": [{}] }, { onFill: () => { markedAtFill = page.credentialMarker; } });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toEqual({ id: "fill", ok: true, result: {} });
        expect(markedAtFill).toBe(true);
        expect((bridge as any).filledPages.get(page)).toBe(page.targetId);
        expect((bridge as any).filledTargets.has(page.targetId)).toBe(true);
        expect(adapter.browser.context.cdpSessions).toBeGreaterThan(0); expect(adapter.browser.context.detachedSessions).toBe(adapter.browser.context.cdpSessions);
      });

      test("a mark that cannot be written refuses the fill as permission-denied, leaving nothing recorded", async () => {
        const { bridge, page, tabId } = await leased();
        for (const result of [false, undefined, "yes"]) {
          page.markerWriteResult = result;
          const fills = credentialFields(page, { "#password": [{}] });
          expect(await bridge.handle(request("unmarked", "credential-type", credential(tabId)))).toEqual({ id: "unmarked", ok: false, code: "permission-denied" });
          expect(fills).toEqual([]);
        }
        page.markerWriteResult = true;
        const evaluate = page.evaluate.bind(page);
        page.evaluate = async () => { throw new TypeError("Cannot redefine property: __sandbarCredentialFill"); };
        const fills = credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("redefined", "credential-type", credential(tabId)))).toEqual({ id: "redefined", ok: false, code: "permission-denied" });
        expect(fills).toEqual([]);
        expect((bridge as any).filledPages.size).toBe(0); expect((bridge as any).filledTargets.size).toBe(0);
        // A failed mark after an earlier successful fill keeps that fill's record.
        page.evaluate = evaluate;
        expect(await bridge.handle(request("filled", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        page.markerWriteResult = false;
        expect(await bridge.handle(request("unmarked-again", "credential-type", credential(tabId)))).toMatchObject({ ok: false, code: "permission-denied" });
        expect((bridge as any).filledTargets.has(page.targetId)).toBe(true);
      });

      test("a tab whose target id cannot be read is refused as permission-denied with nothing typed", async () => {
        const { bridge, page, tabId } = await leased();
        page.targetIdError = new Error("Protocol error (Target.getTargetInfo): No target with given id found");
        const fills = credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("no-target", "credential-type", credential(tabId)))).toEqual({ id: "no-target", ok: false, code: "permission-denied" });
        expect(fills).toEqual([]); expect(page.credentialMarker).toBe(false);
      });

      test("detach closes an unsubmitted filled page", async () => {
        const { bridge, page, tabId } = await leased(); const { responses, send } = recorder(bridge);
        credentialFields(page, { "#password": [{}] });
        expect(await send("fill", "credential-type", credential(tabId))).toMatchObject({ ok: true });
        expect(await send("detach", "detach", {})).toEqual({ id: "detach", ok: true, result: { attached: false } });
        expect(page.closed).toBe(1);
        expectNoCanary(responses);
      });

      test("release then reattach closes an unsubmitted filled page before it can be listed or observed", async () => {
        const { adapter, bridge, page, tabId } = await leased(); const { responses, send } = recorder(bridge);
        credentialFields(page, { "#password": [{}] });
        expect(await send("fill", "credential-type", credential(tabId))).toMatchObject({ ok: true });
        // The close at release fails, so the page outlives the lease with its marker.
        page.closeFailures = 1;
        expect(await send("release", "detach", {})).toMatchObject({ ok: true });
        expect(page.closed).toBe(0); expect(page.credentialMarker).toBe(true);
        // A new lease with an observation grant on the same origin.
        expect(await observerAttach(bridge)).toEqual({ id: "attach", ok: true, result: { attached: true, pageCount: 0 } });
        expect(page.closed).toBe(1);
        expect(await send("tabs", "tabs", {})).toEqual({ id: "tabs", ok: true, result: { tabs: [] } });
        expect(await send("shot", "screenshot", { tabId })).toMatchObject({ ok: false, code: "invalid-request" });
        expect(page.events.get("console") ?? []).toEqual([]);
        // Only the blank tab that keeps the seat browser alive remains.
        expect(adapter.browser.context.pages().map((open) => open.url())).toEqual(["about:blank"]);
        expectNoCanary(responses);
      });

      test("a fresh bridge instance (a restarted daemon) closes a marked page on attach", async () => {
        const { adapter, bridge, page, tabId } = await leased(); const { responses, send } = recorder(bridge);
        credentialFields(page, { "#password": [{}] });
        expect(await send("fill", "credential-type", credential(tabId))).toMatchObject({ ok: true });
        // The old bridge process is gone without detach; only the document marker remains.
        const foreignMarked = new FakePage("https://elsewhere.test/login"); foreignMarked.credentialMarker = true;
        const unrelated = new FakePage("https://elsewhere.test/news");
        adapter.browser.context.allPages.push(foreignMarked, unrelated);
        const restarted = new BrowserBridge(adapter); const after = recorder(restarted);
        expect(await observerAttach(restarted)).toEqual({ id: "attach", ok: true, result: { attached: true, pageCount: 0 } });
        expect(page.closed).toBe(1); expect(foreignMarked.closed).toBe(1); expect(unrelated.closed).toBe(0);
        expect(await after.send("tabs", "tabs", {})).toEqual({ id: "tabs", ok: true, result: { tabs: [] } });
        expect(await after.send("origin", "committed-origin", { tabId })).toMatchObject({ ok: false, code: "invalid-request" });
        expectNoCanary([...responses, ...after.responses]);
      });

      test("a filled tab that navigated since (a results page can echo the value) is still closed at release", async () => {
        const { bridge, page, tabId } = await leased(); const { responses, send } = recorder(bridge);
        credentialFields(page, { "#password": [{}] });
        expect(await send("fill", "credential-type", credential(tabId))).toMatchObject({ ok: true });
        page.navigate(`https://example.test/search?q=${CANARY}`);
        expect(page.credentialMarker).toBe(false);
        expect(await send("release", "detach", {})).toMatchObject({ ok: true });
        expect(page.closed).toBe(1);
        expect(await observerAttach(bridge)).toMatchObject({ ok: true, result: { pageCount: 0 } });
        expect(await send("tabs", "tabs", {})).toEqual({ id: "tabs", ok: true, result: { tabs: [] } });
        expect((bridge as any).filledTargets.size).toBe(0);
        expectNoCanary(responses);
      });

      test("after a reattach, whose Page wrappers are new, a filled tab that navigated is recognized by target id and closed", async () => {
        const { adapter, bridge, page, tabId } = await leased(); const { responses, send } = recorder(bridge);
        credentialFields(page, { "#password": [{}] });
        expect(await send("fill", "credential-type", credential(tabId))).toMatchObject({ ok: true });
        page.closeFailures = 1;
        expect(await send("release", "detach", {})).toMatchObject({ ok: true });
        expect(page.closed).toBe(0);
        // The next CDP connection sees the same tab, navigated (no marker), through a new wrapper.
        const sameTab = new FakePage(`https://example.test/search?q=${CANARY}`); sameTab.targetId = page.targetId;
        const other = new FakePage("https://example.test/news");
        adapter.browser.context.allPages = [sameTab, other];
        expect(await observerAttach(bridge)).toMatchObject({ ok: true, result: { pageCount: 1 } });
        expect(sameTab.closed).toBe(1); expect(other.closed).toBe(0);
        const tabs = await send("tabs", "tabs", {});
        expect((tabs.result as { tabs: unknown[] }).tabs).toHaveLength(1);
        expect((bridge as any).filledTargets.size).toBe(0); expect((bridge as any).filledPages.size).toBe(0);
        expectNoCanary(responses);
      });

      test("a fresh process recognizes a filled tab only by its document marker", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        // Navigated before the process died: the marker went with the document, and memory with the process.
        // The GET-form refusal keeps a value out of such a page's URL.
        page.navigate("https://example.test/account");
        expect(await observerAttach(new BrowserBridge(adapter))).toMatchObject({ ok: true, result: { pageCount: 1 } });
        expect(page.closed).toBe(0);
      });

      test("closing the seat's last tab opens a blank tab first, so the headed browser does not quit", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        const order: string[] = []; const context = adapter.browser.context; const newPage = context.newPage.bind(context);
        context.newPage = async () => { order.push("new"); return newPage(); };
        const close = page.close.bind(page); page.close = async () => { order.push("close"); return close(); };
        credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        expect(await bridge.handle(request("release", "detach", {}))).toMatchObject({ ok: true });
        expect(order).toEqual(["new", "close"]);
        expect(context.pages().map((open) => open.url())).toEqual(["about:blank"]);
        // With another tab still open, no blank tab is added.
        const second = await leased(); const other = new FakePage("https://example.test/news"); second.adapter.browser.context.allPages.push(other);
        const before = second.adapter.browser.context.allPages.length;
        credentialFields(second.page, { "#password": [{}] });
        expect(await second.bridge.handle(request("fill", "credential-type", credential(second.tabId)))).toMatchObject({ ok: true });
        expect(await second.bridge.handle(request("release", "detach", {}))).toMatchObject({ ok: true });
        expect(second.adapter.browser.context.allPages.length).toBe(before);
        expect(second.adapter.browser.context.pages()).toEqual([other]);
        // A blank tab that cannot be opened does not stop the credential tab from closing.
        const third = await leased(); third.adapter.browser.context.newPage = async () => { throw new Error("browser busy"); };
        credentialFields(third.page, { "#password": [{}] });
        expect(await third.bridge.handle(request("fill", "credential-type", credential(third.tabId)))).toMatchObject({ ok: true });
        expect(await third.bridge.handle(request("release", "detach", {}))).toMatchObject({ ok: true });
        expect(third.page.closed).toBe(1);
      });

      test("a tracked tab that was closed elsewhere is forgotten once every open tab names its target", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        await page.close(); // the human closed the tab
        const remaining = new FakePage("https://example.test/news"); adapter.browser.context.allPages.push(remaining);
        remaining.targetIdError = new Error("Target closed");
        expect(await bridge.handle(request("release", "detach", {}))).toMatchObject({ ok: true });
        // One open tab could not name its target, so the record is kept.
        expect((bridge as any).filledTargets.has(page.targetId)).toBe(true);
        remaining.targetIdError = undefined;
        expect(await observerAttach(bridge)).toMatchObject({ ok: true });
        expect((bridge as any).filledTargets.size).toBe(0); expect(remaining.closed).toBe(0);
      });

      test("a same-document navigation keeps the filled document, so the page still closes", async () => {
        const { bridge, page, tabId } = await leased();
        credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        page.urlValue = "https://example.test/login#step-2"; page.emit("framenavigated", page);
        expect(await bridge.handle(request("release", "detach", {}))).toMatchObject({ ok: true });
        expect(page.closed).toBe(1);
      });

      test("shutdown closes an unsubmitted filled page", async () => {
        const { bridge, page, tabId } = await leased();
        credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        await bridge.shutdown();
        expect(page.closed).toBe(1);
      });

      test("a page that cannot answer the marker read is closed when this process marked it or it is on the new lease", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        credentialFields(page, { "#password": [{}] });
        expect(await bridge.handle(request("fill", "credential-type", credential(tabId)))).toMatchObject({ ok: true });
        page.markerReadError = new Error("Execution context was destroyed");
        expect(await bridge.handle(request("release", "detach", {}))).toMatchObject({ ok: true });
        expect(page.closed).toBe(1);

        // A fresh process has no memory: an unanswerable leased-origin page closes, an unanswerable outside one stays.
        const leasedSilent = new FakePage("https://example.test/other"); leasedSilent.markerReadError = new Error("Target crashed");
        const outsideSilent = new FakePage("https://elsewhere.test/"); outsideSilent.markerReadError = new Error("Target crashed");
        adapter.browser.context.allPages.push(leasedSilent, outsideSilent);
        expect(await observerAttach(new BrowserBridge(adapter))).toMatchObject({ ok: true, result: { pageCount: 0 } });
        expect(leasedSilent.closed).toBe(1); expect(outsideSilent.closed).toBe(0);
      });

      test("attach refuses while a marked page cannot be closed, and a retry closes it", async () => {
        configured(); const adapter = new FakeAdapter(); const page = adapter.browser.context.page;
        page.credentialMarker = true; page.closeFailures = 1;
        const bridge = new BrowserBridge(adapter);
        expect(await observerAttach(bridge)).toEqual({ id: "attach", ok: false, code: "verification-failed" });
        expect(adapter.browser.closedConnections).toBe(1); expect(adapter.browser.context.routes).toEqual([]);
        expect(await observerAttach(bridge)).toMatchObject({ ok: true, result: { pageCount: 0 } });
        expect(page.closed).toBe(1);
      });
    });

    describe("seat X selections", () => {
      test("attach clears both selections before any page observer exists or a page is listed", async () => {
        configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
        expect(await leaseAttach(bridge, { allowObservation: true })).toMatchObject({ ok: true });
        expect(adapter.selectionClears).toEqual([{ observersInstalled: false }]);
      });

      test("attach refuses, and closes its connection, when the selections cannot be cleared; a retry attaches", async () => {
        configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, undefined, 20);
        adapter.clearFailure = new Error("xsel: Can't open display: :1");
        expect(await leaseAttach(bridge, { allowObservation: true })).toEqual({ id: "attach", ok: false, code: "verification-failed" });
        expect(adapter.browser.closedConnections).toBe(1); expect(adapter.browser.context.routes).toEqual([]);
        expect(await bridge.handle(request("tabs", "tabs", {}))).toMatchObject({ ok: false, code: "session-lost" });
        // A clear that hangs is bounded and refuses the same way.
        adapter.clearFailure = undefined; adapter.pendingClear = new Promise<void>(() => {});
        const started = Date.now();
        expect(await leaseAttach(bridge, { allowObservation: true })).toEqual({ id: "attach", ok: false, code: "verification-failed" });
        expect(Date.now() - started).toBeLessThan(1_000);
        adapter.pendingClear = undefined;
        expect(await leaseAttach(bridge, { allowObservation: true })).toMatchObject({ ok: true, result: { attached: true } });
      });

      test("each dispatched fill is followed by a clear, on success and on failure", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        const order: string[] = []; adapter.onClear = () => order.push("clear");
        credentialFields(page, { "#password": [{}] }, { onFill: () => order.push("fill") });
        adapter.selectionClears = [];
        expect(await bridge.handle(request("ok", "credential-type", credential(tabId)))).toEqual({ id: "ok", ok: true, result: {} });
        expect(order).toEqual(["fill", "clear"]);
        credentialFields(page, { "#password": [{}] }, { onFill: () => order.push("fill"), fillError: new Error("locator.fill: Target page, context or browser has been closed") });
        expect(await bridge.handle(request("failed", "credential-type", credential(tabId)))).toEqual({ id: "failed", ok: false, code: "session-lost" });
        expect(order).toEqual(["fill", "clear", "fill", "clear"]);
        credentialFields(page, { "#password": [{}] }, { onFill: () => { order.push("fill"); page.urlValue = "https://other.test/"; } });
        expect(await bridge.handle(request("moved", "credential-type", credential(tabId)))).toEqual({ id: "moved", ok: false, code: "verification-failed" });
        expect(order).toEqual(["fill", "clear", "fill", "clear", "fill", "clear"]);
      });

      test("a refusal before the fill is dispatched does not need a clear", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        credentialFields(page, { "#password": [{ type: "text" }] }); adapter.selectionClears = [];
        expect(await bridge.handle(request("unfit", "credential-type", credential(tabId)))).toMatchObject({ ok: false, code: "permission-denied" });
        expect(adapter.selectionClears).toEqual([]);
      });

      test("a failed or hung clear after a fill is best effort and bounded", async () => {
        configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, undefined, 20);
        expect(await leaseAttach(bridge)).toMatchObject({ ok: true });
        const page = adapter.browser.context.page; const tabId = tabIdOf(bridge, page);
        const fills = credentialFields(page, { "#password": [{}] });
        adapter.clearFailure = new Error("xsel failed");
        expect(await bridge.handle(request("clear-failed", "credential-type", credential(tabId)))).toEqual({ id: "clear-failed", ok: true, result: {} });
        adapter.clearFailure = undefined; adapter.pendingClear = new Promise<void>(() => {});
        const started = Date.now();
        expect(await bridge.handle(request("clear-hung", "credential-type", credential(tabId)))).toEqual({ id: "clear-hung", ok: true, result: {} });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(fills).toHaveLength(2);
      });

      test("detach clears the selections, best effort and bounded", async () => {
        configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter, undefined, undefined, 20);
        expect(await leaseAttach(bridge)).toMatchObject({ ok: true }); adapter.selectionClears = [];
        expect(await bridge.handle(request("detach", "detach", {}))).toEqual({ id: "detach", ok: true, result: { attached: false } });
        expect(adapter.selectionClears).toHaveLength(1);
        expect(await leaseAttach(bridge)).toMatchObject({ ok: true });
        adapter.clearFailure = new Error("xsel failed");
        expect(await bridge.handle(request("detach-failed", "detach", {}))).toEqual({ id: "detach-failed", ok: true, result: { attached: false } });
        adapter.clearFailure = undefined;
        expect(await leaseAttach(bridge)).toMatchObject({ ok: true });
        adapter.pendingClear = new Promise<void>(() => {});
        const started = Date.now();
        expect(await bridge.handle(request("detach-hung", "detach", {}))).toEqual({ id: "detach-hung", ok: true, result: { attached: false } });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(adapter.browser.closedConnections).toBe(3);
      });

      test("shutdown clears the selections, attached or not, and a failure does not stop it", async () => {
        configured();
        const attachedAdapter = new FakeAdapter(); const attached = new BrowserBridge(attachedAdapter);
        expect(await leaseAttach(attached)).toMatchObject({ ok: true }); attachedAdapter.selectionClears = [];
        attachedAdapter.clearFailure = new Error("xsel failed");
        await attached.shutdown();
        expect(attachedAdapter.selectionClears).toHaveLength(1); expect(attachedAdapter.browser.closedConnections).toBe(1);
        const idleAdapter = new FakeAdapter(); const idle = new BrowserBridge(idleAdapter);
        await idle.shutdown();
        expect(idleAdapter.selectionClears).toHaveLength(1);
      });

      test("the production clear runs fixed xsel argv on :1 and requires both selections to read back empty", async () => {
        const calls: Array<{ file: string; args: string[]; options: any }> = []; let leftover = "";
        const exec = spyOn(childProcess, "execFile").mockImplementation((file: any, args: any, options: any, callback: any) => {
          calls.push({ file, args, options });
          callback(null, Buffer.from(args.includes("--output") && args[0] === "--primary" ? leftover : ""), Buffer.alloc(0)); return {} as any;
        });
        try {
          await new NodeAdapter().clearSelections();
          expect(calls.map((call) => [call.file, ...call.args])).toEqual([
            ["/usr/bin/xsel", "--clipboard", "--clear"], ["/usr/bin/xsel", "--clipboard", "--output", "--selectionTimeout", "500"],
            ["/usr/bin/xsel", "--primary", "--clear"], ["/usr/bin/xsel", "--primary", "--output", "--selectionTimeout", "500"],
          ]);
          for (const call of calls) expect(call.options).toEqual({ encoding: "buffer", timeout: 1_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin", DISPLAY: ":1", HOME: "/config" } });
          leftover = CANARY;
          const failure = await new NodeAdapter().clearSelections().then(() => undefined, (error: Error) => error);
          expect(failure?.message).toBe("selection not empty after clear");
          expect(String(failure)).not.toContain(CANARY);
        } finally { exec.mockRestore(); }
      });
    });

    describe("GET forms and pre-dispatch refusals", () => {
      test("a field in a form that submits by GET is refused for every field, with nothing typed, marked or cleared", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        const getForms: Array<[string, FakeForm]> = [
          ["explicit or default method get", { method: "get" }],
          ["post form with a formmethod=get submitter", { method: "post", submitters: ["get"] }],
          ["post form with an empty or invalid formmethod (the GET state)", { method: "post", submitters: [""] }],
          ["a method that cannot be read", { method: "post", prototypes: false }],
          ["an unknown method value", { method: "put" }],
        ];
        for (const [label, form] of getForms) {
          for (const [field, type] of [["username", "text"], ["password", "password"], ["totp", "tel"]]) {
            const fills = credentialFields(page, { "#field": [{ type, form }] }); adapter.selectionClears = [];
            const response = await bridge.handle(request("get-form", "credential-type", credential(tabId, { field, selector: "#field" })));
            expect(response, label).toEqual({ id: "get-form", ok: false, code: "permission-denied" });
            expect(fills).toEqual([]); expect(page.credentialMarker).toBe(false); expect(adapter.selectionClears).toEqual([]);
            expect((bridge as any).filledTargets.size).toBe(0);
          }
        }
      });

      test("POST, dialog and form-less inputs are allowed", async () => {
        const { bridge, page, tabId } = await leased();
        for (const form of [{ method: "post" }, { method: "dialog" }, { method: "post", submitters: ["post", "dialog"] }, undefined] as Array<FakeForm | undefined>) {
          const fills = credentialFields(page, { "#password": [{ form }] });
          expect(await bridge.handle(request("allowed", "credential-type", credential(tabId)))).toEqual({ id: "allowed", ok: true, result: {} });
          expect(fills).toHaveLength(1);
        }
      });

      test("the probe reads the form method through the prototype, so a control named method cannot clobber it", () => {
        const facts = probeCredentialFieldOf({ type: "password", form: { method: "get" } });
        expect(facts.formMethod).toBe("get");
        // A direct form.method read would see the clobbering control, not "post".
        expect(probeCredentialFieldOf({ type: "password", form: { method: "post" } }).formMethod).toBe("post");
        expect(probeCredentialFieldOf({ type: "password" }).formMethod).toBe("none");
      });

      test("no failure before the fill is dispatched is verification-failed", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        const codes: string[] = [];
        const attempt = async (setup: () => void, args: Record<string, unknown> = {}) => { setup(); const response = await bridge.handle(request("pre", "credential-type", credential(tabId, args))); expect(response.ok).toBe(false); codes.push(response.code!); };
        await attempt(() => credentialFields(page, { "#password": [] }));
        await attempt(() => credentialFields(page, { "#password": [{}, {}] }));
        await attempt(() => credentialFields(page, { "#password": [{ type: "text" }] }));
        await attempt(() => credentialFields(page, { "#password": [{ visible: false }] }));
        await attempt(() => credentialFields(page, { "#password": [{ form: { method: "get" } }] }));
        await attempt(() => { credentialFields(page, { "#password": [{}] }); page.markerWriteResult = false; });
        await attempt(() => { page.markerWriteResult = true; page.targetIdError = new Error("gone"); credentialFields(page, { "#password": [{}] }); });
        await attempt(() => { page.targetIdError = undefined; adapter.credentialPolicyValue = false; credentialFields(page, { "#password": [{}] }); });
        // A probe answer of the wrong shape.
        await attempt(() => { adapter.credentialPolicyValue = true; credentialFields(page, { "#password": [{}] }); const locator = page.locator; page.locator = (selector: string) => ({ ...locator(selector), evaluate: async () => ({ input: true, type: "password" }) }); });
        expect(codes).toHaveLength(9);
        for (const code of codes) expect(["permission-denied", "invalid-request"]).toContain(code);
        expect(adapter.selectionClears.length).toBe(1); // only the attach
      });
    });

    describe("seat Chromium credential policy", () => {
      test("doctor attests the policy with one boolean and nothing else about it", async () => {
        configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
        expect(await bridge.handle(request("doctor", "doctor", {}))).toMatchObject({ ok: true, result: { credentialPolicy: true } });
        for (const value of [false, new Error("EACCES /etc/chromium/policies/managed")]) {
          adapter.credentialPolicyValue = value;
          const doctor = await bridge.handle(request("doctor", "doctor", {}));
          expect(doctor).toMatchObject({ ok: true, result: { credentialPolicy: false } });
          expect(JSON.stringify(doctor)).not.toContain("policies");
        }
      });

      test("credential-type refuses, typing nothing, while the policy is not in effect", async () => {
        const { adapter, bridge, page, tabId } = await leased();
        for (const value of [false, new Error("unreadable")]) {
          adapter.credentialPolicyValue = value;
          const fills = credentialFields(page, { "#password": [{}] });
          expect(await bridge.handle(request("no-policy", "credential-type", credential(tabId)))).toEqual({ id: "no-policy", ok: false, code: "permission-denied" });
          expect(fills).toEqual([]); expect(page.credentialMarker).toBe(false);
        }
      });

      test("the image's policy file is exactly the required policy, at the path Chromium reads", async () => {
        expect(CHROMIUM_MANAGED_POLICY_DIR).toBe("/etc/chromium/policies/managed");
        const shipped = join(import.meta.dir, "../root/etc/chromium/policies/managed/sandbar.json");
        const document = JSON.parse(await fs.readFile(shipped, "utf8"));
        expect(document).toEqual(CREDENTIAL_POLICY);
        expect(credentialPolicyHolds([document])).toBe(true);
        expect(await readCredentialPolicy(dirname(shipped))).toBe(true);
      });

      test("the policy holds only when every key is set as required and no file contradicts it", () => {
        expect(credentialPolicyHolds([CREDENTIAL_POLICY])).toBe(true);
        expect(credentialPolicyHolds([{ ...CREDENTIAL_POLICY }, { HomepageLocation: "https://example.test" }])).toBe(true);
        expect(credentialPolicyHolds([])).toBe(false);
        for (const key of Object.keys(CREDENTIAL_POLICY)) {
          const { [key]: _dropped, ...partial } = CREDENTIAL_POLICY as Record<string, unknown>;
          expect(credentialPolicyHolds([partial])).toBe(false);
          expect(credentialPolicyHolds([CREDENTIAL_POLICY, { [key]: true }])).toBe(false);
        }
        expect(credentialPolicyHolds([{ ...CREDENTIAL_POLICY, AutofillSettings: [{ url_pattern: "*", blocked_types: ["payments"] }] }])).toBe(false);
        for (const bad of [null, [], "x", 1]) expect(credentialPolicyHolds([CREDENTIAL_POLICY, bad])).toBe(false);
      });

      test("reading the policy directory fails closed on a missing directory, broken JSON or an oversized file, and follows symlinks", async () => {
        const root = await fs.mkdtemp(join(tmpdir(), "sandbar-policy-"));
        try {
          expect(await readCredentialPolicy(join(root, "absent"))).toBe(false);
          const valid = join(root, "valid"); await fs.mkdir(valid); await fs.writeFile(join(valid, "sandbar.json"), JSON.stringify(CREDENTIAL_POLICY));
          expect(await readCredentialPolicy(valid)).toBe(true);
          const broken = join(root, "broken"); await fs.mkdir(broken); await fs.writeFile(join(broken, "sandbar.json"), JSON.stringify(CREDENTIAL_POLICY)); await fs.writeFile(join(broken, "other.json"), "{ not json");
          expect(await readCredentialPolicy(broken)).toBe(false);
          const large = join(root, "large"); await fs.mkdir(large); await fs.writeFile(join(large, "sandbar.json"), JSON.stringify({ ...CREDENTIAL_POLICY, Padding: "x".repeat(70 * 1024) }));
          expect(await readCredentialPolicy(large)).toBe(false);
          const linked = join(root, "linked"); await fs.mkdir(linked); await fs.symlink(join(valid, "sandbar.json"), join(linked, "sandbar.json"));
          expect(await readCredentialPolicy(linked)).toBe(true);
          const contradicted = join(root, "contradicted"); await fs.mkdir(contradicted); await fs.writeFile(join(contradicted, "a.json"), JSON.stringify(CREDENTIAL_POLICY)); await fs.writeFile(join(contradicted, "b.json"), JSON.stringify({ PasswordManagerEnabled: true }));
          expect(await readCredentialPolicy(contradicted)).toBe(false);
        } finally { await fs.rm(root, { recursive: true, force: true }); }
      });
    });

    test("the canary value never appears in any response or console line, success or failure", async () => {
      const { bridge, page, tabId } = await leased();
      const responses: BridgeResponse[] = []; const logged: unknown[][] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => spyOn(console, method).mockImplementation((...line: unknown[]) => { logged.push(line); }));
      const send = async (args: Record<string, unknown>) => { responses.push(await bridge.handle(request("canary", "credential-type", args))); };
      credentialFields(page, { "#password": [{}] });
      await send(credential(tabId));
      credentialFields(page, { "#password": [{ type: "text" }] });
      await send(credential(tabId));
      credentialFields(page, { "#password": [{}] }, { fillError: new Error(`locator.fill: Error: could not type "${CANARY}" into input`) });
      await send(credential(tabId));
      credentialFields(page, { "#password": [{}] }, { fillError: Object.assign(new Error(`Timeout 2000ms exceeded filling "${CANARY}"`), { name: "TimeoutError" }) });
      await send(credential(tabId));
      credentialFields(page, { "#password": [{}] }, { onFill: () => { page.urlValue = "https://other.test/"; } });
      await send(credential(tabId));
      await send(credential(tabId, { value: `${CANARY}\0` }));
      await send(credential(tabId, { value: CANARY.repeat(60) }));
      await send(credential(tabId, { expectOrigin: `https://${CANARY.toLowerCase()}.test` }));
      await send(credential(tabId, { selector: `#${CANARY} >> input` }));
      await send(credential(tabId, { field: CANARY }));
      await send({ ...credential(tabId), [CANARY]: CANARY });
      responses.push(await bridge.handle(request("origin", "committed-origin", { tabId })));
      for (const spy of spies) spy.mockRestore();
      expect(responses.filter((response) => response.ok)).toHaveLength(2);
      expect(responses.filter((response) => !response.ok).length).toBe(10);
      for (const response of responses) expect(JSON.stringify(response)).not.toContain(CANARY);
      expect(JSON.stringify(responses).toLowerCase()).not.toContain(CANARY.toLowerCase());
      expect(logged).toEqual([]);
    });
  });
});
