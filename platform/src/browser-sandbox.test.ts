import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import baseline from "./seccomp/docker-default.json" with { type: "json" };
import {
  assertNamespaceSandboxArchitecture,
  namespaceBrowserSeccompProfile,
  namespaceSandboxImageCapability,
  namespaceSandboxImageCapabilityLabel,
  parseBrowserSandboxMode,
  parseSharedBrowserOptIn,
  sharedBrowserEnvironmentKey,
  sharedBrowserImageCapability,
  sharedBrowserImageCapabilityLabel,
} from "./browser-sandbox";

const expectedAdditions = [
  { names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: 268_435_473, op: "SCMP_CMP_EQ" }] },
  { names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: 1_879_048_209, op: "SCMP_CMP_EQ" }] },
  { names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: 536_870_929, op: "SCMP_CMP_EQ" }] },
  { names: ["unshare"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: 268_435_456, op: "SCMP_CMP_EQ" }] },
  { names: ["chroot"], action: "SCMP_ACT_ALLOW" },
];

describe("namespace browser sandbox policy", () => {
  test("uses distinct fixed namespace and shared-seat image capability contracts", () => {
    expect(namespaceSandboxImageCapabilityLabel).toBe("io.sandbar.chromium-sandbox");
    expect(namespaceSandboxImageCapability).toBe("namespace-v1");
    expect(sharedBrowserImageCapabilityLabel).toBe("io.sandbar.shared-browser");
    expect(sharedBrowserImageCapability).toBe("shared-seat-v1");
    expect(sharedBrowserImageCapabilityLabel).not.toBe(namespaceSandboxImageCapabilityLabel);
    expect(sharedBrowserImageCapability).not.toBe(namespaceSandboxImageCapability);
  });

  test("pins the raw vendored profile to Docker's upstream Git blob", async () => {
    const bytes = Buffer.from(await Bun.file(new URL("./seccomp/docker-default.json", import.meta.url)).arrayBuffer());
    const gitBlob = Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes]);

    expect(createHash("sha1").update(gitBlob).digest("hex")).toBe("77df9d19e844f4403e41e401aca25ab28861e317");
  });

  test("preserves the immutable baseline and appends exactly five narrow rules", () => {
    const baselineBeforeGeneration = JSON.stringify(baseline);
    const profile = namespaceBrowserSeccompProfile();

    expect(profile).toEqual({
      ...baseline,
      syscalls: [...baseline.syscalls, ...expectedAdditions],
    });
    expect(profile.syscalls).toHaveLength(baseline.syscalls.length + expectedAdditions.length);
    expect(profile.syscalls.slice(-expectedAdditions.length)).toEqual(expectedAdditions);
    expect(JSON.stringify(baseline)).toBe(baselineBeforeGeneration);
  });

  test("accepts only explicit legacy or namespace modes", () => {
    expect(parseBrowserSandboxMode(undefined)).toBe("legacy");
    expect(parseBrowserSandboxMode("legacy")).toBe("legacy");
    expect(parseBrowserSandboxMode("namespace")).toBe("namespace");
    for (const invalid of ["", "default", "Namespace", "enabled", "namespace "]) {
      expect(() => parseBrowserSandboxMode(invalid)).toThrow("SANDBAR_BROWSER_SANDBOX");
    }
  });

  test("accepts only the explicit shared-browser opt-in", () => {
    expect(parseSharedBrowserOptIn(undefined)).toBe(false);
    expect(parseSharedBrowserOptIn("1")).toBe(true);
    for (const invalid of ["", "0", "true", " 1"]) {
      expect(() => parseSharedBrowserOptIn(invalid)).toThrow(sharedBrowserEnvironmentKey);
    }
  });

  test("fails closed for architectures that have not been proven", () => {
    expect(() => assertNamespaceSandboxArchitecture("aarch64")).toThrow("x86_64 or x64");
    expect(() => assertNamespaceSandboxArchitecture(undefined)).toThrow("x86_64 or x64");
    expect(() => assertNamespaceSandboxArchitecture("x86_64")).not.toThrow();
    expect(() => assertNamespaceSandboxArchitecture("x64")).not.toThrow();
  });
});
