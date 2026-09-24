import { browserSandboxEnvironmentKey, isBrowserSandboxEnvironmentKey, parseBrowserSandboxMode } from "./browser-sandbox";

const ENVIRONMENT_KEY = /^(?:[A-Z][A-Z0-9_]*_API_KEY|CUSTOM_USER|PASSWORD|SANDBAR_BROWSER_SANDBOX)$/;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface CreateInput {
  name: string;
  agent: "hermes" | "none";
  env: Record<string, string>;
}

/** Validates the JSON fields accepted by POST /api/computers before Docker work. */
export function validateCreate(body: Record<string, unknown>): CreateInput {
  const rawName = body.name;
  if (rawName !== undefined && typeof rawName !== "string") throw new HttpError(400, '"name" must be a string.');
  const name = (rawName ?? "Sandbar computer").trim();
  if (!name || name.length > 80) throw new HttpError(400, '"name" must be 1 to 80 characters.');

  const agent = body.agent ?? "hermes";
  if (agent !== "hermes" && agent !== "none") throw new HttpError(400, '"agent" must be "hermes" or "none".');

  if (body.env !== undefined && !isRecord(body.env)) throw new HttpError(400, '"env" must be an object.');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.env ?? {})) {
    if (!ENVIRONMENT_KEY.test(key) || typeof value !== "string") {
      throw new HttpError(400, "Environment contains an invalid key or value.");
    }
    if (isBrowserSandboxEnvironmentKey(key)) {
      try {
        parseBrowserSandboxMode(value);
      } catch {
        throw new HttpError(400, `${browserSandboxEnvironmentKey} must be "legacy" or "namespace".`);
      }
    }
    env[key] = value;
  }
  return { name, agent, env };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
