import { isAuthorized, loginCookie, logoutCookie } from "./auth";
import { SandbarDatabase, type Computer } from "./db";
import { DockerDesktop, DockerError, type DockerState } from "./docker";
import { dashboardPage, loginPage, type ComputerView } from "./html";
import { allocatePortBlock, computerPort } from "./ports";

const DATA_DIRECTORY = process.env.SANDBAR_DATA_DIR ?? "/data";
const MAX_JSON_BYTES = 1_024 * 1_024;
const ENVIRONMENT_KEY = /^(?:[A-Z][A-Z0-9_]*_API_KEY|CUSTOM_USER|PASSWORD)$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function redirect(location: string, cookie: string): Response {
  return new Response(null, { status: 303, headers: { location, "set-cookie": cookie, "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
    throw new HttpError(413, "Request body is too large.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) throw new HttpError(400, "Request body must be a JSON object.");
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "9000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SANDBAR_PLATFORM_PORT must be a valid TCP port.");
  }
  return port;
}

function hostnameFor(request: Request): string {
  try {
    return new URL(request.url).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

function portsFor(basePort: number): Record<string, number> {
  return {
    desktop_http: computerPort.desktopHttp(basePort),
    desktop_https: computerPort.desktopHttps(basePort),
    chat: computerPort.chat(basePort),
    control: computerPort.control(basePort),
  };
}

function validateCreate(body: Record<string, unknown>): { name: string; agent: "hermes" | "none"; env: Record<string, string> } {
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
    env[key] = value;
  }
  return { name, agent, env };
}

function computerResponse(computer: Computer, state: DockerState): Record<string, unknown> {
  return {
    id: computer.id,
    name: computer.name,
    agent: computer.agent,
    base_port: computer.basePort,
    ports: portsFor(computer.basePort),
    state,
    control_token: computer.controlToken,
    created_at: computer.createdAt,
  };
}

const database = new SandbarDatabase(DATA_DIRECTORY);
const platformToken = database.getOrCreatePlatformToken(DATA_DIRECTORY);
const docker = new DockerDesktop();
const platformPort = parsePort(process.env.SANDBAR_PLATFORM_PORT);

// Port probing cannot reserve a port, so serialize create requests through Docker creation.
let creationTail: Promise<void> = Promise.resolve();
async function withCreationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = creationTail;
  let release: (() => void) | undefined;
  creationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

async function views(): Promise<ComputerView[]> {
  return Promise.all(database.listComputers().map(async (computer) => ({ computer, state: await docker.inspect(computer) })));
}

async function requireComputer(id: string): Promise<Computer> {
  const computer = database.getComputer(id);
  if (computer === null) throw new HttpError(404, "Computer not found.");
  return computer;
}

async function handleApi(request: Request, url: URL): Promise<Response> {
  if (!isAuthorized(request, platformToken.token)) {
    return json({ error: "Unauthorized." }, 401, { "www-authenticate": 'Bearer realm="sandbar-platform"' });
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && url.pathname === "/api/computers") {
    const listed = await views();
    return json({ computers: listed.map(({ computer, state }) => computerResponse(computer, state)) });
  }

  if (request.method === "POST" && url.pathname === "/api/computers") {
    const input = validateCreate(await readJson(request));
    const created = await withCreationLock(async () => {
      const basePort = await allocatePortBlock(database.listComputers().map((computer) => computer.basePort));
      const computer: Computer = {
        id: crypto.randomUUID(),
        name: input.name,
        agent: input.agent,
        basePort,
        controlToken: crypto.getRandomValues(new Uint8Array(16)).reduce((token, byte) => token + byte.toString(16).padStart(2, "0"), ""),
        createdAt: new Date().toISOString(),
      };
      await docker.createAndStart(computer, input.env);
      database.addComputer(computer);
      return computer;
    });
    return json({ computer: computerResponse(created, "running") }, 201);
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "computers") {
    const id = segments[2];
    const action = segments[3];
    if (request.method === "POST" && (action === "start" || action === "stop")) {
      const computer = await requireComputer(id);
      if (action === "start") await docker.start(computer);
      else await docker.stop(computer);
      return json({ status: "ok" });
    }
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "computers" && request.method === "DELETE") {
    const computer = await requireComputer(segments[2]);
    const purge = url.searchParams.get("purge") === "true";
    await docker.removeContainer(computer.id, true);
    if (purge) await docker.removeVolume(computer.id);
    database.deleteComputer(computer.id);
    return json({ status: "ok" });
  }

  return json({ error: "Not found." }, 404);
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: platformPort,
  async fetch(request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/health") return json({ status: "ok" });
      if (url.pathname.startsWith("/api/")) return await handleApi(request, url);

      if (request.method === "GET" && url.pathname === "/") {
        if (!isAuthorized(request, platformToken.token)) {
          return new Response(loginPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        return new Response(dashboardPage(await views(), hostnameFor(request)), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (request.method === "POST" && url.pathname === "/login") {
        const form = await request.formData();
        const token = form.get("token");
        if (typeof token !== "string" || !isAuthorized(new Request(request.url, { headers: { authorization: `Bearer ${token}` } }), platformToken.token)) {
          return json({ error: "Unauthorized." }, 401);
        }
        return redirect("/", loginCookie(platformToken.token));
      }
      if (request.method === "POST" && url.pathname === "/logout") return redirect("/", logoutCookie());
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof DockerError) return json({ error: "Docker operation failed." }, 502);
      return json({ error: "Internal server error." }, 500);
    }
  },
});

if (platformToken.created) {
  console.log(`\n╔══════════════════════════════════════════════════════════╗\n║ Sandbar platform is ready                                ║\n║ Dashboard: http://localhost:${server.port}                         ║\n║ Platform token: ${platformToken.token}                  ║\n║ Save this token; it is required to access Sandbar.       ║\n╚══════════════════════════════════════════════════════════╝\n`);
} else {
  console.log(`Sandbar platform listening at http://0.0.0.0:${server.port}`);
}
