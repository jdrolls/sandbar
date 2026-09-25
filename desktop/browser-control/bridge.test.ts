import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { BrowserBridge, NodeAdapter, type BridgeAdapter, type LaunchedMousepad } from "./bridge";

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
  async close(): Promise<void> { this.closed++; }
  async goto(url: string): Promise<void> { this.gotoUrls.push(url); this.urlValue = url; }
  async bringToFront(): Promise<void> {}
  frames(): FakePage[] { return [this]; }
  locator(_selector: string): any { return { innerText: async () => "semantic page text", click: async () => {}, pressSequentially: async () => {}, selectOption: async () => {}, waitFor: async () => {}, setInputFiles: async () => {} }; }
  async screenshot(): Promise<Buffer> { return Buffer.from("png"); }
  async setViewportSize(_size: unknown): Promise<void> {}
  async viewportSize(): Promise<{ width: number; height: number }> { return { width: 800, height: 600 }; }
  async waitForTimeout(_milliseconds: number): Promise<void> {}
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
  pages(): FakePage[] { return this.allPages; }
  serviceWorkers(): FakeWorker[] { return this.workers; }
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

  test("rejects malformed schemas and omits browser URLs from doctor", async () => {
    configured(); const adapter = new FakeAdapter(); const bridge = new BrowserBridge(adapter);
    expect(await bridge.handle({ id: "bad id", operation: "doctor", args: {} })).toMatchObject({ ok: false, code: "invalid-request" });
    const doctor = await bridge.handle(request("doctor", "doctor", {}));
    expect(doctor).toMatchObject({ ok: true, result: { pageCount: 1, attached: false, display: { width: 1024, height: 768 } } });
    expect(JSON.stringify(doctor)).not.toContain("http");
    expect(adapter.browser.closedConnections).toBe(1);
  });
});
