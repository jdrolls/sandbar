import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

setDefaultTimeout(30_000);

const sessionScript = join(import.meta.dir, "../root/usr/local/bin/sandbar-session.sh");
const indexHtml = join(import.meta.dir, "../root/usr/local/share/sandbar-ui/index.html");
const retryHint = "Hermes exited with an error. You can retry with: hermes";
const temporaryDirectories: string[] = [];
const spawned: Array<{ kill: () => void }> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(import.meta.dir, ".sandbar-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!/bin/bash\n${source}`);
  chmodSync(path, 0o755);
}

// Runs the real session script with stubbed hermes, pgrep and bash. The stub bash records that the
// script exec'd it and exits, so a missing `exec bash` shows up as an absent log entry.
function runSession(hermesExit: number): { exitCode: number; stdout: string; log: string[] } {
  const root = temporaryDirectory();
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(bin, { recursive: true });

  // Stand-in for xfce4-session: the script reads DBUS_SESSION_BUS_ADDRESS from its /proc environ.
  const xfce = Bun.spawn({
    cmd: ["sleep", "30"],
    env: { PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/sandbar-test-bus" },
  });
  spawned.push(xfce);

  writeExecutable(join(bin, "pgrep"), `printf '%s\\n' ${xfce.pid}`);
  writeExecutable(join(bin, "hermes"), `printf 'hermes %s\\n' "$*" >> "${log}"\nexit ${hermesExit}`);
  writeExecutable(join(bin, "bash"), `printf 'bash\\n' >> "${log}"\nexit 0`);

  const result = Bun.spawnSync({
    cmd: ["/bin/bash", sessionScript],
    // A provider key skips onboarding, so only the final hermes invocation is exercised.
    env: { PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: "test-key" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = Bun.file(log).size ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout), log: calls };
}

afterEach(() => {
  for (const process of spawned.splice(0)) process.kill();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("sandbar-session.sh", () => {
  test("leaves a bash shell without the retry hint after a clean Hermes exit", () => {
    const result = runSession(0);
    expect(result.log).toEqual(["hermes ", "bash"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(retryHint);
  });

  test("leaves a bash shell and prints the retry hint after a failed Hermes exit", () => {
    const result = runSession(1);
    expect(result.log).toEqual(["hermes ", "bash"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(retryHint);
  });
});

describe("Sandbar Window HTTPS hint", () => {
  const html = readFileSync(indexHtml, "utf8");

  test("shows only outside a secure context", () => {
    expect(html).toContain("if (!window.isSecureContext) hint.hidden = false;");
  });

  test("does not gate on protocol or hostname", () => {
    const script = html.slice(html.lastIndexOf("<script"));
    expect(script).not.toMatch(/location\.(protocol|hostname)\s*[!=]==?\s*["'](http:|localhost|127\.0\.0\.1)/);
    expect(script).not.toContain("remoteHttp");
  });
});
