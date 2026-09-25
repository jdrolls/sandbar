import { expect, test } from "bun:test";

const confirmation = process.env.SANDBAR_NATIVE_TEST_CONFIRM;
const seat = process.env.SANDBAR_NATIVE_TEST_SEAT;
const enabled = confirmation === "synthetic" && typeof seat === "string" && seat.length > 0;
const runtimeTest = enabled ? test : test.skip;
const seatName = seat ?? "";

interface SeatInspection {
  Config?: { Labels?: Record<string, unknown> };
  State?: { Running?: unknown };
}

interface ProbeResult {
  ok: boolean;
  checks?: Record<string, boolean>;
  evidence?: Record<string, string>;
  error?: string;
}

function inspectSyntheticSeat(name: string): void {
  // A container name, not an ID or Docker path, makes the exact target visible
  // in the required inspect call and prevents option-like argument handling.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    throw new Error("SANDBAR_NATIVE_TEST_SEAT must be one exact Docker container name");
  }
  const inspection = Bun.spawnSync({ cmd: ["docker", "inspect", name], stdout: "pipe", stderr: "pipe" });
  if (inspection.exitCode !== 0) throw new Error("could not inspect SANDBAR_NATIVE_TEST_SEAT");
  let records: unknown;
  try { records = JSON.parse(new TextDecoder().decode(inspection.stdout)); }
  catch { throw new Error("Docker inspect returned invalid JSON"); }
  if (!Array.isArray(records) || records.length !== 1 || !records[0] || typeof records[0] !== "object") {
    throw new Error("SANDBAR_NATIVE_TEST_SEAT did not resolve to exactly one container");
  }
  const inspected = records[0] as SeatInspection;
  const labels = inspected.Config?.Labels;
  if (labels?.["io.dora.issue"] !== "1686" || labels["io.dora.purpose"] !== "synthetic") {
    throw new Error("refusing native runtime test: target is not the owned #1686 synthetic seat");
  }
  if (inspected.State?.Running !== true) throw new Error("SANDBAR_NATIVE_TEST_SEAT is not running");
}

const probeSource = String.raw`
"use strict";
const { createHash, randomBytes } = require("node:crypto");
const { mkdtemp, mkdir, chmod, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFile, spawn } = require("node:child_process");

const DISPLAY = ":1";
const HELPER = "/opt/sandbar-browser/native-input";
const COMMAND_TIMEOUT_MS = 3_000;
const WINDOW_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const PROBE_WATCHDOG_MS = 60_000;
const children = new Set();
const evidence = {};
const checks = {};
let profileRoot;
let stopping = false;
let emitted = false;

function emit(result) {
  if (emitted) return;
  emitted = true;
  process.stdout.write(JSON.stringify(result) + "\n");
}

function fail(message) { throw new Error(message); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function command(file, args, timeout = COMMAND_TIMEOUT_MS, maxBuffer = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      env: { PATH: "/usr/bin:/bin", DISPLAY, HOME: "/config" },
      encoding: "buffer", timeout, maxBuffer,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = Buffer.from(stderr || Buffer.alloc(0)).subarray(0, 1024).toString("utf8");
        reject(error);
      } else resolve(Buffer.from(stdout));
    });
  });
}
async function xdotool(args) { return (await command("xdotool", args)).toString("utf8"); }
async function helper(xid, pid, operation, values) {
  try {
    await command(HELPER, [String(xid), String(pid), operation, ...values], COMMAND_TIMEOUT_MS, 1024);
    return true;
  } catch { return false; }
}
function shellFields(output) {
  const fields = new Map();
  for (const line of output.split("\n")) {
    const match = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
    if (match) fields.set(match[1], Number(match[2]));
  }
  return fields;
}
async function waitForWindow(pid) {
  const deadline = Date.now() + WINDOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const ids = [...new Set((await xdotool(["search", "--onlyvisible", "--pid", String(pid)])).trim().split(/\s+/).filter(Boolean))];
      if (ids.length === 1 && /^\d+$/.test(ids[0])) return ids[0];
      if (ids.length > 1) fail("a scratch Mousepad child exposed more than one visible window");
    } catch (error) {
      // xdotool uses status 1 while a just-started child has no visible window.
      if (error && typeof error === "object" && error.code !== 1) throw error;
    }
    await sleep(100);
  }
  fail("scratch Mousepad window did not become visible");
}
async function launchScratchMousepad() {
  if (!profileRoot) fail("private XDG profile was not prepared");
  const childRoot = join(profileRoot, randomBytes(12).toString("hex"));
  const config = join(childRoot, "config");
  const cache = join(childRoot, "cache");
  const data = join(childRoot, "data");
  await mkdir(childRoot, { mode: 0o700 });
  await Promise.all([config, cache, data].map(async (directory) => {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  }));
  const child = spawn("mousepad", ["--disable-server"], {
    detached: false,
    stdio: "ignore",
    env: {
      PATH: "/usr/bin:/bin", DISPLAY, HOME: "/config", GSETTINGS_BACKEND: "memory",
      XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data,
    },
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) fail("could not create scratch Mousepad child");
  children.add(child);
  child.once("exit", () => children.delete(child));
  return { child, pid: child.pid, xid: await waitForWindow(child.pid) };
}
async function activate(xid) { await xdotool(["windowactivate", "--sync", xid]); }
async function geometry(xid) {
  const fields = shellFields(await xdotool(["getwindowgeometry", "--shell", xid]));
  const x = fields.get("X"); const y = fields.get("Y");
  const width = fields.get("WIDTH"); const height = fields.get("HEIGHT");
  if (![x, y, width, height].every(Number.isInteger) || width < 100 || height < 100) fail("scratch Mousepad geometry was invalid");
  return { x, y, width, height };
}
async function screenshot(xid) {
  if (!/^[0-9]+$/.test(xid)) fail("invalid screenshot window ID");
  // Scrot reopens stdout; supply an OS pipe rather than Node's socket-backed fd.
  return command("/bin/bash", ["-o", "pipefail", "-c", 'scrot --window "$1" - | /bin/cat', "sandbar-screenshot", xid], COMMAND_TIMEOUT_MS, 5 * 1024 * 1024);
}
function pngDimensions(image) {
  const signature = "89504e470d0a1a0a";
  if (image.length < 24 || image.subarray(0, 8).toString("hex") !== signature || image.subarray(12, 16).toString("ascii") !== "IHDR") {
    fail("scrot did not return a PNG screenshot");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 7680 || height > 7680) fail("scrot returned unsafe screenshot dimensions");
  return { width, height, bytes: image.length };
}
function recordPng(label, image) {
  // These pixels are emitted only by the explicit synthetic opt-in test. They
  // make a failed scroll assertion inspectable without claiming a hash proves
  // that libxdo interpreted every embedded newline as a Return key.
  evidence[label] = digest(image);
  evidence[label + "Hash"] = evidence[label];
  evidence[label + "Png"] = image.toString("base64");
  evidence[label + "PngInfo"] = JSON.stringify(pngDimensions(image));
}
async function scrollReadiness(xid, pid, point) {
  const current = await geometry(xid);
  const activeWindow = (await xdotool(["getactivewindow"])).trim();
  const windowPid = (await xdotool(["getwindowpid", xid])).trim();
  const pointer = shellFields(await xdotool(["getmouselocation", "--shell"]));
  const pointInside = point.x >= current.x && point.y >= current.y &&
    point.x < current.x + current.width && point.y < current.y + current.height;
  const ready = activeWindow === xid && windowPid === String(pid) && pointInside;
  return {
    ready, activeWindow, windowPid, geometry: current, point,
    pointInside, pointerX: pointer.get("X"), pointerY: pointer.get("Y"), pointerWindow: pointer.get("WINDOW"),
  };
}
async function responsive(xid, label) {
  const display = await xdotool(["getdisplaygeometry"]);
  if (!/^\d+\s+\d+\s*$/.test(display)) fail(label + ": X display did not respond");
  await xdotool(["getactivewindow"]);
  await xdotool(["getwindowgeometry", "--shell", xid]);
}
async function rejected(label, xid, pid, operation, values) {
  if (await helper(xid, pid, operation, values)) fail(label + ": helper unexpectedly accepted unsafe input");
  await responsive(xid, label);
}
async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(CLEANUP_TIMEOUT_MS),
  ]);
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }
  await Promise.all([...children].map(waitForExit));
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }
  await Promise.all([...children].map(waitForExit));
  if (profileRoot) await rm(profileRoot, { recursive: true, force: true });
}
async function main() {
  if (process.versions.node !== "22.22.0") fail("probe must run through the image-pinned Node 22.22.0 runtime");
  profileRoot = await mkdtemp(join(tmpdir(), "sandbar-native-input-runtime-"));
  await chmod(profileRoot, 0o700);
  const target = await launchScratchMousepad();
  const foreign = await launchScratchMousepad();
  const targetPid = Number((await xdotool(["getwindowpid", target.xid])).trim());
  if (targetPid !== target.pid) fail("target X11 PID does not match the test-created Mousepad child");
  await activate(target.xid);
  const bounds = await geometry(target.xid);
  const point = { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) };
  if (point.x < 0 || point.y < 0 || point.x > 7680 || point.y > 7680) fail("scratch point was outside helper bounds");
  const empty = await screenshot(target.xid);
  if (!await helper(target.xid, target.pid, "type", ["TYPE_MARKER"])) fail("typing helper call failed");
  const typed = await screenshot(target.xid);
  checks.typingVisible = !empty.equals(typed);
  if (!checks.typingVisible) fail("typing produced no visual Mousepad change");
  evidence.typingBefore = digest(empty); evidence.typingAfter = digest(typed);

  if (!await helper(target.xid, target.pid, "key", ["BackSpace"])) fail("key helper call failed");
  const keyed = await screenshot(target.xid);
  checks.keyVisible = !typed.equals(keyed);
  if (!checks.keyVisible) fail("key produced no visual Mousepad change");
  evidence.keyAfter = digest(keyed);

  if (!await helper(target.xid, target.pid, "click", [String(point.x), String(point.y)])) fail("click helper call failed");
  const pointer = shellFields(await xdotool(["getmouselocation", "--shell"]));
  checks.clickMovedPointer = pointer.get("X") === point.x && pointer.get("Y") === point.y;
  if (!checks.clickMovedPointer) fail("click did not place the pointer at the owned Mousepad point");
  if (!await helper(target.xid, target.pid, "type", [" CLICK_MARKER"])) fail("typing after click failed");
  const clicked = await screenshot(target.xid);
  checks.clickFollowedByVisibleInput = !keyed.equals(clicked);
  if (!checks.clickFollowedByVisibleInput) fail("click-following input produced no visual Mousepad change");
  evidence.clickAfter = digest(clicked);

  const lines = Array.from({ length: 110 }, (_, index) => "line-" + String(index).padStart(3, "0") + " native-scroll-marker");
  // This is one native type request with embedded LF. Its visible multiline
  // content is the regression check for libxdo's otherwise dropped newlines.
  const fixture = "\n" + lines.join("\n");
  const fixtureBytes = Buffer.byteLength(fixture);
  if (fixtureBytes > 4096) fail("fixed scroll fixture exceeded helper text bound");
  if (!await helper(target.xid, target.pid, "type", [fixture])) fail("scroll fixture typing failed");
  await responsive(target.xid, "scroll-fixture");
  const readinessBeforeScroll = await scrollReadiness(target.xid, target.pid, point);
  evidence.scrollFixture = JSON.stringify({ lines: lines.length, bytes: fixtureBytes, newlineStrategy: "embedded-LF" });
  evidence.scrollReadinessBefore = JSON.stringify(readinessBeforeScroll);
  if (!readinessBeforeScroll.ready) fail("scroll fixture was not ready in the owned Mousepad window");
  const beforeScroll = await screenshot(target.xid);
  recordPng("scrollBefore", beforeScroll);
  if (!await helper(target.xid, target.pid, "scroll", [String(point.x), String(point.y), "0", "-8"])) fail("scroll helper call failed");
  await responsive(target.xid, "scroll-after-helper");
  const readinessAfterScroll = await scrollReadiness(target.xid, target.pid, point);
  evidence.scrollReadinessAfter = JSON.stringify(readinessAfterScroll);
  if (!readinessAfterScroll.ready) fail("scroll changed owned Mousepad readiness");
  const afterScroll = await screenshot(target.xid);
  recordPng("scrollAfter", afterScroll);
  checks.scrollVisible = !beforeScroll.equals(afterScroll);
  if (!checks.scrollVisible) fail("scroll produced no visual Mousepad change; root cause is unknown (see synthetic scroll PNG evidence)");

  const beforeWrongPid = await screenshot(target.xid);
  const wrongPid = target.pid === 2_147_483_647 ? target.pid - 1 : target.pid + 1;
  await rejected("wrong-pid", target.xid, wrongPid, "type", ["MUST_NOT_TYPE"]);
  // A single screenshot equality check flaps with the editor caret. Instead,
  // require a matching frame during a bounded blink cycle; injected text can
  // never restore the original frame, while an idle caret eventually does.
  const wrongPidHashes = [];
  let wrongPidMatchedBaseline = false;
  let lastWrongPid = beforeWrongPid;
  const wrongPidDeadline = Date.now() + 3_000;
  do {
    lastWrongPid = await screenshot(target.xid);
    wrongPidHashes.push(digest(lastWrongPid));
    if (beforeWrongPid.equals(lastWrongPid)) {
      wrongPidMatchedBaseline = true;
      break;
    }
    await sleep(100);
  } while (Date.now() < wrongPidDeadline);
  checks.wrongPidNoVisualInput = wrongPidMatchedBaseline;
  evidence.wrongPidBefore = digest(beforeWrongPid);
  evidence.wrongPidSamples = JSON.stringify(wrongPidHashes);
  if (!checks.wrongPidNoVisualInput) {
    recordPng("wrongPidBefore", beforeWrongPid);
    recordPng("wrongPidAfter", lastWrongPid);
    fail("wrong PID changed the owned Mousepad image or the caret never returned to its baseline frame");
  }

  await activate(foreign.xid);
  await rejected("foreign-focus", target.xid, target.pid, "type", ["MUST_NOT_TYPE"]);
  await activate(target.xid);

  const outside = bounds.x + bounds.width <= 7680
    ? { x: bounds.x + bounds.width, y: point.y }
    : { x: bounds.x - 1, y: point.y };
  if (outside.x < 0 || outside.x > 7680) fail("could not construct an in-range out-of-bounds point");
  await rejected("out-of-bounds", target.xid, target.pid, "click", [String(outside.x), String(outside.y)]);

  // This second, test-created Mousepad window is a foreign X target. Raise it
  // over the owned editor without activating it: the helper must see target
  // focus but reject the foreign pointer child before issuing a button event.
  await xdotool(["windowsize", foreign.xid, String(Math.max(240, Math.floor(bounds.width / 2))), String(Math.max(180, Math.floor(bounds.height / 2)))]);
  await xdotool(["windowmove", foreign.xid, String(point.x - 100), String(point.y - 80)]);
  await activate(target.xid);
  await xdotool(["windowraise", foreign.xid]);
  // XFCE may focus a newly raised window under the pointer. Restore keyboard
  // focus without raising the target; retain the foreign pointer occlusion.
  await xdotool(["windowfocus", "--sync", target.xid]);
  if ((await xdotool(["getwindowfocus"])).trim() !== target.xid) fail("could not focus target beneath foreign overlay");
  await rejected("foreign-overlay", target.xid, target.pid, "click", [String(point.x), String(point.y)]);
  const location = shellFields(await xdotool(["getmouselocation", "--shell"]));
  const pointerWindow = location.get("WINDOW");
  checks.overlayPointerWasForeign = Number.isInteger(pointerWindow) && pointerWindow !== Number(target.xid);
  if (!checks.overlayPointerWasForeign) fail("foreign overlay did not cover the helper pointer point");

  checks.xResponsiveAfterFailures = true;
  evidence.node = process.versions.node;
  evidence.targetWindow = target.xid;
  return { ok: true, checks, evidence };
}

let signalFailure;
const stopForSignal = (signal) => {
  if (signalFailure) return;
  signalFailure = new Error("probe received " + signal);
  void cleanup().finally(() => {
    emit({ ok: false, checks, evidence, error: signalFailure.message });
    process.exit(1);
  });
};
const watchdog = setTimeout(() => stopForSignal("in-container watchdog timeout"), PROBE_WATCHDOG_MS);
watchdog.unref();
process.once("SIGTERM", () => stopForSignal("SIGTERM"));
process.once("SIGINT", () => stopForSignal("SIGINT"));
main().then(async (result) => {
  clearTimeout(watchdog);
  await cleanup();
  if (signalFailure) throw signalFailure;
  emit(result);
}).catch(async (error) => {
  clearTimeout(watchdog);
  try { await cleanup(); } catch {}
  emit({ ok: false, checks, evidence, error: error instanceof Error ? error.message : "probe failed" });
  process.exitCode = 1;
});
`;

const probeWrapper = String.raw`
probe_pid=""
eof_pid=""
# Non-interactive Bash gives background jobs /dev/null stdin unless explicit.
exec 3<&0
cleanup() {
  if [ -n "$probe_pid" ] && kill -0 "$probe_pid" 2>/dev/null; then
    kill -TERM "$probe_pid" 2>/dev/null || true
  fi
  if [ -n "$eof_pid" ] && kill -0 "$eof_pid" 2>/dev/null; then
    kill -TERM "$eof_pid" 2>/dev/null || true
  fi
}
trap 'cleanup; exit 143' HUP INT TERM
/usr/local/bin/sandbar-node -e "$1" &
probe_pid="$!"
# Keep Docker stdin open while the probe runs. If the client disappears, EOF
# reaches this in-container reader and terminates the owned probe, whose own
# signal path cleans up only its Mousepad children.
(
  while IFS= read -r ignored; do :; done <&3
  if kill -0 "$probe_pid" 2>/dev/null; then kill -TERM "$probe_pid" 2>/dev/null || true; fi
) &
eof_pid="$!"
wait "$probe_pid"
status="$?"
if kill -0 "$eof_pid" 2>/dev/null; then kill -TERM "$eof_pid" 2>/dev/null || true; fi
wait "$eof_pid" 2>/dev/null || true
trap - HUP INT TERM
exit "$status"
`;

async function runProbe(name: string): Promise<ProbeResult> {
  const child = Bun.spawn({
    cmd: ["docker", "exec", "-i", "--user", "abc", name, "/bin/bash", "-c", probeWrapper, "sandbar-native-probe", probeSource],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain both Docker streams while the probe runs. Mousepad/X11 diagnostics
  // must never back-pressure a bounded test cleanup path.
  const stdoutRead = new Response(child.stdout).text();
  const stderrRead = new Response(child.stderr).text();
  // Do not close this control pipe while the probe is live: its in-container
  // EOF reader is the remote cleanup path if the Docker client vanishes.
  const timeout = setTimeout(() => child.kill("SIGTERM"), 75_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  try { child.stdin.end(); } catch {}
  const [stdout, stderr] = await Promise.all([stdoutRead, stderrRead]);
  const resultLine = stdout.trim();
  let result: ProbeResult;
  try { result = JSON.parse(resultLine) as ProbeResult; }
  catch { throw new Error(`native probe did not return one JSON result (exit ${exitCode}): ${(resultLine || stderr).slice(0, 1_024)}`); }
  if (exitCode !== 0 && result.ok) throw new Error(`native probe exited ${exitCode} after reporting success`);
  return result;
}

runtimeTest("runs real native X11 input only in the confirmed owned synthetic #1686 seat", async () => {
  inspectSyntheticSeat(seatName);
  const result = await runProbe(seatName);
  if (!result.ok) {
    // The probe emits PNG pixels only under this explicit synthetic opt-in.
    // Keep them in the test output so the seat owner can diagnose failures.
    console.error("native-input synthetic diagnostic: " + JSON.stringify(result));
  }
  expect(result).toMatchObject({ ok: true });
  expect(result.checks).toEqual({
    typingVisible: true,
    keyVisible: true,
    clickMovedPointer: true,
    clickFollowedByVisibleInput: true,
    scrollVisible: true,
    wrongPidNoVisualInput: true,
    overlayPointerWasForeign: true,
    xResponsiveAfterFailures: true,
  });
  expect(result.evidence?.node).toBe("22.22.0");
  expect(result.evidence?.typingBefore).not.toBe(result.evidence?.typingAfter);
  expect(result.evidence?.scrollBefore).not.toBe(result.evidence?.scrollAfter);
}, 90_000);
