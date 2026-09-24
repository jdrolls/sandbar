import dockerDefaultSeccomp from "./seccomp/docker-default.json" with { type: "json" };

export const browserSandboxEnvironmentKey = "SANDBAR_BROWSER_SANDBOX";
export const namespaceSandboxImageCapabilityLabel = "io.sandbar.chromium-sandbox";
export const namespaceSandboxImageCapability = "namespace-v1";
export type BrowserSandboxMode = "legacy" | "namespace";

interface SeccompArgument {
  index: number;
  value: number;
  op: "SCMP_CMP_EQ";
}

interface SeccompSyscallRule {
  names: string[];
  action: "SCMP_ACT_ALLOW";
  args?: SeccompArgument[];
}

interface SeccompProfile {
  defaultAction: string;
  defaultErrnoRet?: number;
  archMap?: unknown[];
  syscalls: unknown[];
  [key: string]: unknown;
}

const namespaceSandboxArchitectures = new Set(["x86_64", "x64"]);

/**
 * Resolves the only browser sandbox modes accepted at the create boundary.
 * Absence deliberately retains the historical unsandboxed Chromium launch.
 */
export function parseBrowserSandboxMode(value: string | undefined): BrowserSandboxMode {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "namespace") return "namespace";
  throw new Error(`${browserSandboxEnvironmentKey} must be "legacy" or "namespace".`);
}

export function isBrowserSandboxEnvironmentKey(key: string): boolean {
  return key === browserSandboxEnvironmentKey;
}

export function assertNamespaceSandboxArchitecture(architecture: unknown): void {
  if (typeof architecture !== "string" || !namespaceSandboxArchitectures.has(architecture)) {
    throw new Error(`Namespace Chromium sandboxing is supported only on Docker architectures x86_64 or x64; Docker reported ${typeof architecture === "string" ? JSON.stringify(architecture) : "no architecture"}.`);
  }
}

function cloneProfile(): SeccompProfile {
  // The vendored Docker baseline is deliberately never mutated. Docker needs a
  // JSON value in SecurityOpt, so clone before appending narrowly-scoped rules.
  return JSON.parse(JSON.stringify(dockerDefaultSeccomp)) as SeccompProfile;
}

function namespaceRule(name: string, value?: number): SeccompSyscallRule {
  return value === undefined
    ? { names: [name], action: "SCMP_ACT_ALLOW" }
    : { names: [name], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value, op: "SCMP_CMP_EQ" }] };
}

/**
 * Produces Docker's pinned default policy plus the five syscall rules Chromium
 * needs to create its user, PID, and network namespaces. No host path or
 * caller-provided seccomp policy is accepted.
 */
export function namespaceBrowserSeccompProfile(): SeccompProfile {
  const profile = cloneProfile();
  profile.syscalls.push(
    namespaceRule("clone", 268_435_473), // CLONE_NEWUSER | SIGCHLD
    namespaceRule("clone", 1_879_048_209), // CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | SIGCHLD
    namespaceRule("clone", 536_870_929), // CLONE_NEWPID | SIGCHLD
    namespaceRule("unshare", 268_435_456), // CLONE_NEWUSER
    namespaceRule("chroot"),
  );
  return profile;
}

export function namespaceBrowserSecurityOpt(): string {
  return `seccomp=${JSON.stringify(namespaceBrowserSeccompProfile())}`;
}
