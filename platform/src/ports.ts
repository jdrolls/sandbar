import { createServer } from "node:net";

const PORTS_PER_COMPUTER = 4;
const BLOCK_STRIDE = 10;
const MAX_PORT = 65_535;

function parsePortBase(value: string | undefined): number {
  const parsed = Number(value ?? "20000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PORT - PORTS_PER_COMPUTER) {
    throw new Error("SANDBAR_PORT_BASE must leave room for four valid TCP ports.");
  }
  return parsed;
}

function portCanBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    const finish = (available: boolean): void => {
      server.removeAllListeners();
      resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "0.0.0.0", port, exclusive: true }, () => {
      server.close((error) => finish(error === undefined));
    });
  });
}

async function blockCanBind(basePort: number): Promise<boolean> {
  const checks = await Promise.all(
    Array.from({ length: PORTS_PER_COMPUTER }, (_, index) => portCanBind(basePort + index)),
  );
  return checks.every(Boolean);
}

function overlapsExistingBlock(candidate: number, allocated: readonly number[]): boolean {
  return allocated.some((existing) => candidate < existing + PORTS_PER_COMPUTER && existing < candidate + PORTS_PER_COMPUTER);
}

/**
 * Finds a four-port block. The caller must serialize allocation through container
 * creation; binding is necessarily a best-effort availability check before Docker owns it.
 */
export async function allocatePortBlock(allocatedBasePorts: readonly number[]): Promise<number> {
  const base = parsePortBase(process.env.SANDBAR_PORT_BASE);
  for (let candidate = base; candidate + PORTS_PER_COMPUTER - 1 <= MAX_PORT; candidate += BLOCK_STRIDE) {
    if (overlapsExistingBlock(candidate, allocatedBasePorts)) {
      continue;
    }
    if (await blockCanBind(candidate)) {
      return candidate;
    }
  }
  throw new Error("No free Sandbar four-port block is available.");
}

export const computerPort = {
  desktopHttp: (basePort: number): number => basePort,
  desktopHttps: (basePort: number): number => basePort + 1,
  chat: (basePort: number): number => basePort + 2,
  control: (basePort: number): number => basePort + 3,
};
