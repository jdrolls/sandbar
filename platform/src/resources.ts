export interface ComputerResourceLimits {
  /** Docker's NanoCpus value: one CPU equals 1_000_000_000. */
  readonly nanoCpus: number;
  /** Docker memory limit in bytes. */
  readonly memoryBytes: number;
  /** Docker process-count limit. */
  readonly pidsLimit: number;
}

/** Bounded virtual desktop dimensions passed to Webtop/Selkies. */
export interface DesktopResolutionConfiguration {
  /** Initial fixed virtual desktop width in pixels. */
  readonly width: number;
  /** Initial fixed virtual desktop height in pixels. */
  readonly height: number;
  /** Largest framebuffer Webtop will permit, formatted as WIDTHxHEIGHT. */
  readonly maxResolution: string;
}

/** Host address used for every Docker-published Sandbar port. */
export interface SandbarNetworkConfiguration {
  /** Either loopback or one usable address in Tailscale's IPv4 CGNAT range. */
  readonly bindIp: string;
}

const CPU_NANOSECONDS = 1_000_000_000;
const DEFAULT_CPU_LIMIT = "1";
const DEFAULT_MEMORY_LIMIT = "2147483648"; // 2 GiB
const DEFAULT_PIDS_LIMIT = "512";
const DEFAULT_DESKTOP_WIDTH = "1920";
const DEFAULT_DESKTOP_HEIGHT = "1080";
const DEFAULT_DESKTOP_MAX_RES = "1920x1080";
// Webtop's own default maximum. Keeping this as a hard ceiling prevents an
// accidental platform setting from creating an unbounded Xvfb framebuffer.
const MAX_DESKTOP_WIDTH = 15_360;
const MAX_DESKTOP_HEIGHT = 8_640;

function invalidEnvironment(name: string, expectation: string): never {
  throw new Error(`${name} must be ${expectation}.`);
}

function parsePositiveInteger(name: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    return invalidEnvironment(name, "a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return invalidEnvironment(name, "a positive safe integer");
  }
  return parsed;
}

function parseDesktopDimension(name: string, value: string, maximum: number): number {
  const dimension = parsePositiveInteger(name, value);
  if (dimension > maximum) {
    return invalidEnvironment(name, `a positive integer no greater than ${maximum}`);
  }
  return dimension;
}

function parseDesktopMaxResolution(value: string): readonly [number, number] {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (match === null) {
    return invalidEnvironment("SANDBAR_COMPUTER_DESKTOP_MAX_RES", "WIDTHxHEIGHT using positive decimal integers");
  }
  return [
    parseDesktopDimension("SANDBAR_COMPUTER_DESKTOP_MAX_RES", match[1], MAX_DESKTOP_WIDTH),
    parseDesktopDimension("SANDBAR_COMPUTER_DESKTOP_MAX_RES", match[2], MAX_DESKTOP_HEIGHT),
  ];
}

function parseCpuLimit(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) {
    return invalidEnvironment("SANDBAR_COMPUTER_CPU_LIMIT", "a positive decimal CPU count with at most nine decimal places");
  }
  const parsed = Number(value);
  const nanoCpus = parsed * CPU_NANOSECONDS;
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(nanoCpus)) {
    return invalidEnvironment("SANDBAR_COMPUTER_CPU_LIMIT", "a positive CPU count supported by Docker");
  }
  return nanoCpus;
}

function parseIpv4(value: string): readonly [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject ambiguous forms such as leading-zero octal-looking addresses.
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Parses the only host bind addresses Sandbar permits. Loopback is the secure
 * default. A Tailscale CGNAT address is an intentional direct-tailnet opt-in;
 * wildcard, LAN, public, and CIDR-edge addresses are not valid listeners.
 */
export function parseSandbarBindIp(environment: Readonly<Record<string, string | undefined>>): string {
  const value = environment.SANDBAR_BIND_IP ?? "127.0.0.1";
  const octets = parseIpv4(value);
  if (value === "127.0.0.1") return value;
  if (octets !== null) {
    const [first, second, third, fourth] = octets;
    const isTailscaleCgnat = first === 100 && second >= 64 && second <= 127;
    const isCgnatNetworkAddress = first === 100 && second === 64 && third === 0 && fourth === 0;
    const isCgnatBroadcastAddress = first === 100 && second === 127 && third === 255 && fourth === 255;
    if (isTailscaleCgnat && !isCgnatNetworkAddress && !isCgnatBroadcastAddress) return value;
  }
  return invalidEnvironment("SANDBAR_BIND_IP", "127.0.0.1 or a usable Tailscale CGNAT IPv4 address (100.64.0.1 through 100.127.255.254)");
}

export function parseSandbarNetworkConfiguration(environment: Readonly<Record<string, string | undefined>>): SandbarNetworkConfiguration {
  return { bindIp: parseSandbarBindIp(environment) };
}

/**
 * Reads limits once during platform startup. A malformed limit must stop startup
 * rather than silently launch computers with weaker or unexpected constraints.
 */
export function parseComputerResourceLimits(environment: Readonly<Record<string, string | undefined>>): ComputerResourceLimits {
  return {
    nanoCpus: parseCpuLimit(environment.SANDBAR_COMPUTER_CPU_LIMIT ?? DEFAULT_CPU_LIMIT),
    memoryBytes: parsePositiveInteger("SANDBAR_COMPUTER_MEMORY_LIMIT", environment.SANDBAR_COMPUTER_MEMORY_LIMIT ?? DEFAULT_MEMORY_LIMIT),
    pidsLimit: parsePositiveInteger("SANDBAR_COMPUTER_PIDS_LIMIT", environment.SANDBAR_COMPUTER_PIDS_LIMIT ?? DEFAULT_PIDS_LIMIT),
  };
}

/**
 * Reads desktop dimensions once at startup. Values are intentionally bounded to
 * Webtop's supported maximum so an accidental environment value cannot turn a
 * seat into an oversized Xvfb workload.
 */
export function parseDesktopResolutionConfiguration(environment: Readonly<Record<string, string | undefined>>): DesktopResolutionConfiguration {
  const width = parseDesktopDimension(
    "SANDBAR_COMPUTER_DESKTOP_WIDTH",
    environment.SANDBAR_COMPUTER_DESKTOP_WIDTH ?? DEFAULT_DESKTOP_WIDTH,
    MAX_DESKTOP_WIDTH,
  );
  const height = parseDesktopDimension(
    "SANDBAR_COMPUTER_DESKTOP_HEIGHT",
    environment.SANDBAR_COMPUTER_DESKTOP_HEIGHT ?? DEFAULT_DESKTOP_HEIGHT,
    MAX_DESKTOP_HEIGHT,
  );
  const [maxWidth, maxHeight] = parseDesktopMaxResolution(
    environment.SANDBAR_COMPUTER_DESKTOP_MAX_RES ?? DEFAULT_DESKTOP_MAX_RES,
  );
  if (width > maxWidth || height > maxHeight) {
    return invalidEnvironment(
      "SANDBAR_COMPUTER_DESKTOP_MAX_RES",
      "at least SANDBAR_COMPUTER_DESKTOP_WIDTH by SANDBAR_COMPUTER_DESKTOP_HEIGHT",
    );
  }
  return { width, height, maxResolution: `${maxWidth}x${maxHeight}` };
}

export const computerResourceLimits = parseComputerResourceLimits(process.env);
/** Parsed once before Docker requests so every generated desktop has the same bounded configuration. */
export const desktopResolutionConfiguration = parseDesktopResolutionConfiguration(process.env);
/** Parsed once before Docker requests so every generated desktop mapping shares one safe bind address. */
export const sandbarNetworkConfiguration = parseSandbarNetworkConfiguration(process.env);
