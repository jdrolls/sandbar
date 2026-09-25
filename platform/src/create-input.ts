import {
  browserSandboxEnvironmentKey,
  isBrowserSandboxEnvironmentKey,
  isSharedBrowserEnvironmentKey,
  NamespaceSandboxPrerequisiteError,
  parseBrowserSandboxMode,
  parseSharedBrowserOptIn,
  sharedBrowserEnvironmentKey,
} from "./browser-sandbox";
import { DockerError } from "./docker";

const ENVIRONMENT_KEY = /^(?:[A-Z][A-Z0-9_]*_API_KEY|CUSTOM_USER|PASSWORD|SANDBAR_BROWSER_SANDBOX|SANDBAR_SHARED_BROWSER)$/;

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

/**
 * Converts known errors to safe API responses without exposing Docker details.
 */
export function mapApiError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (error instanceof NamespaceSandboxPrerequisiteError) {
    return new HttpError(
      422,
      "Namespace browser sandbox prerequisites are not met. Verify Docker and the selected Sandbar image support namespace sandboxing.",
    );
  }
  if (error instanceof DockerError) return new HttpError(502, "Docker operation failed.");
  return undefined;
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
    if (isSharedBrowserEnvironmentKey(key)) {
      try {
        parseSharedBrowserOptIn(value);
      } catch {
        throw new HttpError(400, `${sharedBrowserEnvironmentKey} must be "1" when set.`);
      }
    }
    env[key] = value;
  }
  if (parseSharedBrowserOptIn(env[sharedBrowserEnvironmentKey]) && parseBrowserSandboxMode(env[browserSandboxEnvironmentKey]) !== "namespace") {
    throw new HttpError(400, `${sharedBrowserEnvironmentKey}=1 requires ${browserSandboxEnvironmentKey}=namespace.`);
  }
  return { name, agent, env };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
