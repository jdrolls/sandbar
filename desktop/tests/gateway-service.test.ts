import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

setDefaultTimeout(30_000);

const serviceSource = join(import.meta.dir, "../root/custom-services.d/sandbar-gateway");
const dockerfile = join(import.meta.dir, "../Dockerfile");
const temporaryDirectories: string[] = [];

interface Fixture {
  service: string;
  log: string;
  hermesHome: string;
  sitePackages: string;
  pth: string;
  venv: string;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(import.meta.dir, ".sandbar-gateway-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${source}`);
  chmodSync(path, 0o755);
}

// Rewrites the service's absolute /config paths into a temp tree and stubs the
// binaries it execs. The sleep stub exits 42 for finite sleeps so the service's
// "wait for a gateway config" loop terminates; `sleep infinity` exits 0.
function fixture(options: { hermes?: boolean } = {}): Fixture {
  const root = temporaryDirectory();
  const bin = join(root, "bin");
  const config = join(root, "config");
  const hermesHome = join(config, ".hermes");
  const venv = join(root, "venv");
  const sitePackages = join(venv, "lib/python3.13/site-packages");
  const log = join(root, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(hermesHome, { recursive: true });
  mkdirSync(sitePackages, { recursive: true });
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(log, "");
  if (options.hermes !== false) writeExecutable(join(venv, "bin/hermes"), "exit 0");

  writeExecutable(join(bin, "sleep"), `
printf 'sleep %s\\n' "$*" >> "$SANDBAR_TEST_LOG"
[ "$1" = infinity ] && exit 0
exit 42
`);
  writeExecutable(join(bin, "s6-setuidgid"), `
printf 's6-setuidgid %s\\n' "$*" >> "$SANDBAR_TEST_LOG"
printf 'HERMES_S6_SUPERVISED_CHILD=%s\\nHOME=%s\\n' "\${HERMES_S6_SUPERVISED_CHILD-}" "\${HOME-}" >> "$SANDBAR_TEST_LOG"
exit 0
`);

  const service = join(root, "run");
  const source = readFileSync(serviceSource, "utf8")
    .replaceAll("/usr/local/lib/hermes-agent/venv", venv)
    .replaceAll("/config", config);
  writeFileSync(service, source);
  chmodSync(service, 0o755);
  return { service, log, hermesHome, sitePackages, pth: join(sitePackages, "sandbar-hermes-vendor.pth"), venv };
}

function run(f: Fixture, environment: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["/bin/bash", f.service],
    env: {
      PATH: `${join(f.service, "../bin")}:/usr/bin:/bin`,
      SANDBAR_TEST_LOG: f.log,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
    log: readFileSync(f.log, "utf8"),
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("sandbar-gateway service", () => {
  test("shared seats sleep without touching Hermes", () => {
    const f = fixture();
    writeFileSync(join(f.hermesHome, ".env"), "TELEGRAM_BOT_TOKEN=abc\n");
    const result = run(f, { SANDBAR_SHARED_BROWSER: "1" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toBe("sleep infinity\n");
    expect(existsSync(f.pth)).toBe(false);
  });

  test("SANDBAR_AGENT=none sleeps even with a bot token", () => {
    const f = fixture();
    const result = run(f, { SANDBAR_AGENT: "none", TELEGRAM_BOT_TOKEN: "abc" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toBe("sleep infinity\n");
    expect(existsSync(f.pth)).toBe(false);
  });

  test("SANDBAR_GATEWAY=0 sleeps even with a bot token", () => {
    const f = fixture();
    const result = run(f, { SANDBAR_GATEWAY: "0", TELEGRAM_BOT_TOKEN: "abc" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toBe("sleep infinity\n");
  });

  test("without a gateway config it waits and never starts Hermes", () => {
    const f = fixture();
    // A provider key alone is not a gateway config.
    writeFileSync(join(f.hermesHome, ".env"), "ANTHROPIC_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=\nDISCORD_BOT_TOKEN=\"\"\nSLACK_BOT_TOKEN=''\n");
    const result = run(f, { OPENAI_API_KEY: "sk-test" });
    expect(result.exitCode).toBe(42);
    expect(result.log).toBe("sleep 15\n");
    expect(existsSync(f.pth)).toBe(false);
  });

  test("a token added while it waits starts the gateway without a restart", () => {
    const f = fixture();
    // First finite sleep: the user runs `hermes setup`, then the loop retries.
    writeExecutable(join(f.service, "../bin/sleep"), `
printf 'sleep %s\\n' "$*" >> "$SANDBAR_TEST_LOG"
[ "$1" = infinity ] && exit 0
printf 'TELEGRAM_BOT_TOKEN=abc\\n' > "${f.hermesHome}/.env"
exit 0
`);
    const result = run(f);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toStartWith("sleep 15\ns6-setuidgid abc ");
  });

  test("a bot token in the container environment starts the gateway as abc", () => {
    const f = fixture();
    const result = run(f, { TELEGRAM_BOT_TOKEN: "abc" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toBe(
      `s6-setuidgid abc ${f.venv}/bin/hermes gateway run --replace\n`
        + `HERMES_S6_SUPERVISED_CHILD=1\nHOME=${join(f.hermesHome, "..")}\n`,
    );
  });

  test("a bot token in Hermes' .env starts the gateway", () => {
    const f = fixture();
    writeFileSync(join(f.hermesHome, ".env"), "# comment\nexport DISCORD_BOT_TOKEN=abc\n");
    const result = run(f);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toContain("gateway run --replace\n");
    expect(result.log).toContain("HERMES_S6_SUPERVISED_CHILD=1\n");
  });

  test("SANDBAR_GATEWAY=1 forces the gateway without a token", () => {
    const f = fixture();
    const result = run(f, { SANDBAR_GATEWAY: "1" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.log).toContain("gateway run --replace\n");
  });

  test("a missing Hermes venv sleeps instead of crash-looping", () => {
    const f = fixture({ hermes: false });
    const result = run(f, { TELEGRAM_BOT_TOKEN: "abc" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("cannot find");
    expect(result.log).toBe("sleep infinity\n");
  });

  test("the vendor .pth is written, repaired, and left alone when current", () => {
    const f = fixture();
    const expected = `${join(f.hermesHome, "telegram_vendor")}\n${join(f.hermesHome, "vendor")}\n`;

    expect(run(f, { TELEGRAM_BOT_TOKEN: "abc" }).exitCode).toBe(0);
    expect(readFileSync(f.pth, "utf8")).toBe(expected);
    expect(statSync(f.pth).mode & 0o777).toBe(0o644);

    // Stale content is repaired.
    writeFileSync(f.pth, "/stale\n");
    expect(run(f, { TELEGRAM_BOT_TOKEN: "abc" }).exitCode).toBe(0);
    expect(readFileSync(f.pth, "utf8")).toBe(expected);

    // A current file is not rewritten on restart.
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(f.pth, past, past);
    expect(run(f, { TELEGRAM_BOT_TOKEN: "abc" }).exitCode).toBe(0);
    expect(readFileSync(f.pth, "utf8")).toBe(expected);
    expect(statSync(f.pth).mtimeMs).toBe(past.getTime());
  });

  test("ships as an executable lsio service that the image already copies", () => {
    expect(readFileSync(serviceSource, "utf8").startsWith("#!/usr/bin/with-contenv bash\n")).toBe(true);
    expect(statSync(serviceSource).mode & 0o111).not.toBe(0);
    expect(readFileSync(dockerfile, "utf8")).toContain("COPY --chmod=755 root/ /");
  });
});
