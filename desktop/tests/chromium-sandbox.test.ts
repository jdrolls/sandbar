import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const launcher = join(import.meta.dir, "../root/etc/chromium.d/99-sandbar");

function sourceLauncher(environment: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["/bin/sh", "-c", `set -e; . "$1"; printf '%s' "$CHROMIUM_FLAGS"`, "sh", launcher],
    env: { PATH: process.env.PATH ?? "", ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("Sandbar Chromium launcher policy", () => {
  test("keeps the historical no-sandbox default", () => {
    const result = sourceLauncher();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(" --no-sandbox --no-first-run");
  });

  test("uses Chromium's namespace sandbox when explicitly selected", () => {
    const result = sourceLauncher({ SANDBAR_BROWSER_SANDBOX: "namespace", CHROMIUM_FLAGS: "--enable-features=Foo" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("--enable-features=Foo --no-first-run");
  });

  test("rejects invalid and whitespace-malformed modes", () => {
    for (const mode of ["", "enabled", " namespace", "namespace ", "\tnamespace"]) {
      const result = sourceLauncher({ SANDBAR_BROWSER_SANDBOX: mode });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("SANDBAR_BROWSER_SANDBOX must be legacy or namespace.");
    }
  });

  test("rejects inherited sandbox-disabling flags in namespace mode", () => {
    for (const flag of [
      "--no-sandbox",
      "--no-sandbox=1",
      "--disable-setuid-sandbox",
      "--disable-namespace-sandbox",
      "--disable-seccomp-filter-sandbox",
      "--disable-gpu-sandbox",
      "--no-zygote-sandbox",
      "--single-process",
      "--single-process=true",
    ]) {
      const result = sourceLauncher({ SANDBAR_BROWSER_SANDBOX: "namespace", CHROMIUM_FLAGS: `--enable-features=Foo \t${flag} ` });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Sandbar refuses sandbox-disabling Chromium flags in namespace mode.");
    }
  });
});
