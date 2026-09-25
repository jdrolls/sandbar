import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const browserService = join(import.meta.dir, "../root/custom-services.d/sandbar-browser");
const controlService = join(import.meta.dir, "../root/custom-services.d/sandbar-control-api");
const tuiService = join(import.meta.dir, "../root/custom-services.d/sandbar-tui");
const dockerfile = join(import.meta.dir, "../Dockerfile");
const nativeInput = join(import.meta.dir, "../browser-control/native-input.c");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(directory: string, name: string, source: string): void {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${source}`);
  chmodSync(path, 0o755);
}

function runService(environment: Record<string, string> = {}): { exitCode: number; log: string } {
  // /tmp can be mounted noexec in CI; fixtures must be executable because
  // PATH intentionally resolves only these test doubles.
  const directory = mkdtempSync(join(import.meta.dir, ".sandbar-shared-browser-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "calls.log");
  writeFileSync(log, "");
  executable(directory, "sleep", "printf 'sleep %s\\n' \"$*\" >> \"$SANDBAR_TEST_LOG\"\n");
  executable(directory, "xdotool", "printf 'xdotool %s\\n' \"$*\" >> \"$SANDBAR_TEST_LOG\"\necho '1920 1080'\n");
  executable(directory, "pgrep", `printf 'pgrep %s\\n' "$*" >> "$SANDBAR_TEST_LOG"
if [ "$*" = "-u abc xfce4-session" ]; then exit 0; fi
if [ "$*" = "-u abc -x chromium" ] && [ "\${SANDBAR_TEST_EXISTING_BROWSER:-0}" = "1" ]; then exit 0; fi
if [ "$*" = "-u abc -x chromium" ]; then exit 1; fi
`);
  executable(directory, "install", "printf 'install %s\\n' \"$*\" >> \"$SANDBAR_TEST_LOG\"\n");
  executable(directory, "chromium", "printf 'chromium %s\\n' \"$*\" >> \"$SANDBAR_TEST_LOG\"\n");
  executable(directory, "s6-setuidgid", `printf 's6-setuidgid %s\\n' "$*" >> "$SANDBAR_TEST_LOG"
shift
if [ "$1" = "env" ]; then
  shift
  export "$1" "$2"
  shift 2
fi
exec "$@"
`);

  const result = Bun.spawnSync({
    cmd: ["/bin/bash", browserService],
    env: {
      PATH: directory,
      SANDBAR_TEST_LOG: log,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, log: readFileSync(log, "utf8") };
}

describe("shared-browser seat startup", () => {
  test("pins the Hermes installer source to the configured commit", () => {
    const source = readFileSync(dockerfile, "utf8");

    expect(source).toContain('https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_COMMIT}/scripts/install.sh');
    expect(source).toContain('bash -s -- --commit "${HERMES_COMMIT}"');
    expect(source).not.toContain("https://hermes-agent.nousresearch.com/install.sh");
  });

  test("builds the internal libxdo helper without adding runtime privileges", () => {
    const source = readFileSync(dockerfile, "utf8");

    expect(source).toContain("FROM debian:bookworm-slim AS sandbar-native-input-build");
    expect(source).toContain("gcc libc6-dev libxdo-dev libxtst-dev");
    expect(source).toContain("gcc -O2 -Wall -Wextra -Werror -std=c11 native-input.c -o native-input -lxdo -lX11 -lXtst");
    expect(source).toContain("COPY --from=sandbar-native-input-build /opt/sandbar-browser/native-input /opt/sandbar-browser/native-input");
    expect(source).not.toMatch(/(?:setcap|cap_add|privileged)/i);
  });

  test("makes native pointer injection fail closed before any button event", () => {
    // This is a source-contract test: native X11 execution belongs to the
    // Docker build image, where libxdo/X11 development headers are installed.
    const source = readFileSync(nativeInput, "utf8");
    const pointerGuard = source.slice(
      source.indexOf("static bool prepare_pointer_input"),
      source.indexOf("static bool enable_parent_death_signal"),
    );
    const main = source.slice(source.indexOf("int main"));

    expect(source).toContain("#include <sys/prctl.h>");
    expect(source).toContain("#define MAX_POINTER_CHAIN_DEPTH 64");
    expect(source).toContain("XGetGeometry");
    expect(source).toContain("XTranslateCoordinates");
    expect(source).toContain("XQueryPointer");
    expect(source).toContain("#define MAX_TEXT_BYTES 4096");
    expect(source).toContain("#define TEXT_KEY_DELAY_US 1");
    expect(source).toMatch(/getppid\(\)[\s\S]*prctl\(PR_SET_PDEATHSIG, SIGTERM\)[\s\S]*getppid\(\)/);
    expect(main.indexOf("if (!enable_parent_death_signal()) return 1;")).toBeLessThan(main.indexOf("xdo_new(\":1\")"));
    expect(pointerGuard.indexOf("expected_window_contains_point")).toBeLessThan(pointerGuard.indexOf("xdo_move_mouse"));
    expect(pointerGuard.indexOf("xdo_move_mouse")).toBeLessThan(pointerGuard.indexOf("XSync(display, False)"));
    expect(pointerGuard.indexOf("XSync(display, False)")).toBeLessThan(pointerGuard.indexOf("pointer_target_is_in_expected_window"));
    expect(pointerGuard).toContain("focus_belongs_to(display, expected)");
    expect(main).toContain("if (!prepare_pointer_input(xdo, display, expected, x, y)) goto done;");
    expect(main.indexOf("if (!prepare_pointer_input(xdo, display, expected, x, y)) goto done;")).toBeLessThan(main.indexOf("xdo_click_window"));
  });

  test("keeps the browser service inert for legacy seats", () => {
    const result = runService();

    expect(result.exitCode).toBe(0);
    expect(result.log).toBe("sleep infinity\n");
  });

  test("requires namespace mode before launching a shared browser", () => {
    const result = runService({ SANDBAR_SHARED_BROWSER: "1" });

    expect(result.exitCode).toBe(1);
    expect(result.log).not.toContain("chromium ");
  });

  test("starts one owned browser with a private profile and loopback-only CDP", () => {
    const result = runService({ SANDBAR_SHARED_BROWSER: "1", SANDBAR_BROWSER_SANDBOX: "namespace" });

    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("pgrep -u abc -x chromium\n");
    expect(result.log).toContain("install -d -m 0700 -o abc -g abc /config/sandbar-browser\n");
    expect(result.log).toContain("chromium --user-data-dir=/config/sandbar-browser --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check\n");
    expect(result.log).not.toMatch(/--(?:no-sandbox|disable-[^ ]*sandbox|single-process)/);
  });

  test("does not start a second browser or accept unsafe inherited flags", () => {
    const existing = runService({
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
      SANDBAR_TEST_EXISTING_BROWSER: "1",
    });
    expect(existing.exitCode).toBe(1);
    expect(existing.log).not.toContain("chromium ");

    const unsafe = runService({
      SANDBAR_SHARED_BROWSER: "1",
      SANDBAR_BROWSER_SANDBOX: "namespace",
      CHROMIUM_FLAGS: "--no-sandbox",
    });
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.log).not.toContain("chromium ");
  });

  test("disables legacy raw services in shared mode while retaining them for default seats", () => {
    for (const service of [controlService, tuiService]) {
      const source = readFileSync(service, "utf8");
      expect(source).toContain('if [ "${SANDBAR_SHARED_BROWSER:-}" = "1" ]; then');
      expect(source).toContain("exec sleep infinity");
    }
  });
});
