import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

setDefaultTimeout(30_000);

const initSource = join(import.meta.dir, "../root/custom-cont-init.d/86-sandbar-shared-viewer");
const runnerSource = join(import.meta.dir, "../root/etc/sandbar/selkies-shared-run");
const dockerfile = join(import.meta.dir, "../Dockerfile");
const temporaryDirectories: string[] = [];
const vendorRunContents = "#!/usr/bin/env bash\nprintf '%s\\n' 'vendor launched' >> \"$SANDBAR_TEST_VENDOR_LOG\"\n";

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(import.meta.dir, ".sandbar-shared-viewer-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${source}`);
  chmodSync(path, 0o755);
}

function run(script: string, environment: Record<string, string>): Result {
  const result = Bun.spawnSync({
    cmd: ["/bin/bash", script],
    env: { PATH: `${join(environment.SANDBAR_TEST_BIN ?? "", "")}${environment.SANDBAR_TEST_BIN ? ":" : ""}/usr/bin:/bin`, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function initFixture(): { init: string; sharedRun: string; vendorRun: string; bin: string } {
  const root = temporaryDirectory();
  const bin = join(root, "bin");
  const sharedDirectory = join(root, "etc/sandbar");
  const serviceDirectory = join(root, "etc/s6-overlay/s6-rc.d/svc-selkies");
  mkdirSync(bin, { recursive: true });
  mkdirSync(sharedDirectory, { recursive: true });
  mkdirSync(serviceDirectory, { recursive: true });

  const sharedRun = join(sharedDirectory, "selkies-shared-run");
  const vendorRun = join(serviceDirectory, "run");
  writeFileSync(sharedRun, "locked shared runner\n");
  writeFileSync(vendorRun, vendorRunContents);
  chmodSync(sharedRun, 0o755);
  chmodSync(vendorRun, 0o755);

  writeExecutable(join(bin, "stat"), "printf '0:0\\n'");
  writeExecutable(join(bin, "chown"), "exit 0");
  writeExecutable(join(bin, "install"), `
source="\${@: -2:1}"
destination="\${@: -1}"
/bin/cp "$source" "$destination"
/bin/chmod 0755 "$destination"
`);

  const init = join(root, "init");
  const source = readFileSync(initSource, "utf8")
    .replaceAll("/etc/sandbar", sharedDirectory)
    .replaceAll("/etc/s6-overlay", join(root, "etc/s6-overlay"))
    .replaceAll("/usr/bin/stat", join(bin, "stat"))
    .replaceAll("/usr/bin/install", join(bin, "install"))
    .replaceAll("/bin/chown", join(bin, "chown"));
  writeFileSync(init, source);
  chmodSync(init, 0o755);
  return { init, sharedRun, vendorRun, bin };
}

function expectVendorNotLaunchable(vendorRun: string, bin: string): void {
  const vendorLog = join(temporaryDirectory(), "vendor.log");
  writeFileSync(vendorLog, "");

  const result = run(vendorRun, {
    SANDBAR_TEST_BIN: bin,
    SANDBAR_TEST_VENDOR_LOG: vendorLog,
  });

  expect(result.exitCode, `${result.stderr}\n${readFileSync(vendorRun, "utf8")}`).toBe(1);
  expect(readFileSync(vendorLog, "utf8")).toBe("");
  expect(readFileSync(vendorRun, "utf8")).toContain("service disabled during initialization");
  expect(statSync(vendorRun).mode & 0o777).toBe(0o755);
}

function runnerFixture(): { runner: string; bin: string; log: string; lock: string } {
  const root = temporaryDirectory();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "calls.log");
  const lock = join(root, "audio.lock");
  writeFileSync(log, "");
  writeExecutable(join(bin, "sleep"), "exit 0");
  writeExecutable(join(bin, "s6-setuidgid"), `
printf '%s\\0' "$@" >> "$SANDBAR_TEST_LOG"
if [ "$2" = "with-contenv" ] && [ "$3" = "pactl" ]; then
  if [ "$4" = "info" ]; then exit "\${SANDBAR_TEST_PACTL_INFO_STATUS:-0}"; fi
  exit "\${SANDBAR_TEST_PACTL_LOAD_STATUS:-0}"
fi
exit 0
`);

  const runner = join(root, "run");
  const source = readFileSync(runnerSource, "utf8")
    .replaceAll("/dev/shm/audio.lock", lock)
    .replaceAll("/lsiopy/bin/python3", join(bin, "python3"));
  writeFileSync(runner, source);
  chmodSync(runner, 0o755);
  return { runner, bin, log, lock };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("locked shared Selkies viewer", () => {
  test("leaves the vendor Selkies run untouched when shared mode is absent", () => {
    const { init, vendorRun, bin } = initFixture();

    const result = run(init, { SANDBAR_TEST_BIN: bin });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(vendorRun, "utf8")).toBe(vendorRunContents);
  });

  test("installs the fixed root-owned runner only for the exact opt-in", () => {
    const { init, sharedRun, vendorRun, bin } = initFixture();

    const result = run(init, {
      SANDBAR_TEST_BIN: bin,
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(vendorRun, "utf8")).toBe(readFileSync(sharedRun, "utf8"));
    expect(statSync(vendorRun).mode & 0o777).toBe(0o755);
    const source = readFileSync(initSource, "utf8");
    expect(source).toContain("/usr/bin/install -o root -g root -m 0755");
    expect(source).toContain("/bin/chown root:root \"$staged_run\"");
  });

  test("fails closed when installing the shared runner fails", () => {
    const { init, vendorRun, bin } = initFixture();
    writeExecutable(join(bin, "install"), "exit 1");

    const result = run(init, {
      SANDBAR_TEST_BIN: bin,
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
    });

    expect(result.exitCode).not.toBe(0);
    expectVendorNotLaunchable(vendorRun, bin);
  });

  test("replaces vendor Selkies with a non-launchable runner for every bad opt-in or prerequisite", () => {
    for (const environment of [
      { SANDBAR_SHARED_BROWSER: "true", SANDBAR_BROWSER_SANDBOX: "namespace" },
      { SANDBAR_SHARED_BROWSER: "1" },
      { SANDBAR_SHARED_BROWSER: "1", SANDBAR_BROWSER_SANDBOX: "namespace", DEV_MODE: "1" },
    ]) {
      const { init, vendorRun, bin } = initFixture();
      const result = run(init, { SANDBAR_TEST_BIN: bin, ...environment });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain("could not install the failing Selkies run");
      expectVendorNotLaunchable(vendorRun, bin);
    }

    const { init, sharedRun, vendorRun, bin } = initFixture();
    rmSync(sharedRun);
    const result = run(init, {
      SANDBAR_TEST_BIN: bin,
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
    });
    expect(result.exitCode).toBe(1);
    expectVendorNotLaunchable(vendorRun, bin);
  });

  test("pins Selkies to websocket-only mode and retains optional audio setup", () => {
    const { runner, bin, log, lock } = runnerFixture();
    const result = run(runner, {
      SANDBAR_TEST_BIN: bin,
      SANDBAR_TEST_LOG: log,
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
    });

    const argumentsSeen = readFileSync(log, "utf8").split("\0").filter(Boolean);
    expect(result.exitCode).toBe(0);
    expect(argumentsSeen).toEqual(expect.arrayContaining([
      "abc",
      "with-contenv",
      "pactl",
      "info",
      "load-module",
      "module-null-sink",
      "sink_name=output",
      "sink_properties=device.description=Output",
      "sink_name=input",
      "sink_properties=device.description=Input",
      join(bin, "python3"),
      "-m",
      "selkies",
      "--addr=localhost",
      "--mode=websockets",
      "--enable-dual-mode=false|locked",
    ]));
    expect(argumentsSeen).not.toContain("--enable-dual-mode=false");
    expect(existsSync(lock)).toBe(true);
  });

  test("rejects invalid runtime state and continues without audio when PulseAudio is unavailable", () => {
    const invalid = runnerFixture();
    const invalidResult = run(invalid.runner, {
      SANDBAR_TEST_BIN: invalid.bin,
      SANDBAR_TEST_LOG: invalid.log,
      SANDBAR_SHARED_BROWSER: "0",
      SANDBAR_BROWSER_SANDBOX: "namespace",
    });
    expect(invalidResult.exitCode).toBe(1);
    expect(readFileSync(invalid.log, "utf8")).toBe("");

    const unavailable = runnerFixture();
    const unavailableResult = run(unavailable.runner, {
      SANDBAR_TEST_BIN: unavailable.bin,
      SANDBAR_TEST_LOG: unavailable.log,
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
      SANDBAR_TEST_PACTL_INFO_STATUS: "1",
    });
    expect(unavailableResult.exitCode).toBe(0);
    expect(unavailableResult.stderr).toContain("continuing without audio sinks");
    const unavailableArguments = readFileSync(unavailable.log, "utf8").split("\0").filter(Boolean);
    expect(unavailableArguments).toContain(join(unavailable.bin, "python3"));
    expect(unavailableArguments).toContain("--enable-dual-mode=false|locked");
    expect(unavailableArguments).not.toContain("--enable-dual-mode=false");
    expect(existsSync(unavailable.lock)).toBe(false);
  });

  test("ships both overlay scripts executable with the viewer-lock capability", () => {
    const source = readFileSync(dockerfile, "utf8");
    expect(source).toContain("COPY --chmod=755 root/ /");
    expect(source).toContain('io.sandbar.shared-viewer="viewer-lock-v1"');
  });
});
