import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const platformUrl = new URL(process.env.SANDBAR_PLATFORM_URL ?? "http://localhost:9000");
const platformToken = process.env.SANDBAR_PLATFORM_TOKEN;
if (!platformToken) throw new Error("SANDBAR_PLATFORM_TOKEN is required.");

const PLATFORM_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 130_000; // Desktop bash permits a maximum 120-second command.

type JsonRecord = Record<string, unknown>;

interface ControlTarget {
  id: string;
  basePort: number;
  controlToken: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: string, isError = false) {
  return { isError, content: [{ type: "text" as const, text: value }] };
}

function requireRecord(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`"${name}" must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function requireInteger(value: unknown, name: string, minimum?: number, maximum?: number): number {
  if (!Number.isInteger(value) || typeof value !== "number") throw new Error(`"${name}" must be an integer.`);
  if (minimum !== undefined && value < minimum) throw new Error(`"${name}" must be at least ${minimum}.`);
  if (maximum !== undefined && value > maximum) throw new Error(`"${name}" must be at most ${maximum}.`);
  return value;
}

async function fetchJson(url: string | URL, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    let parsed: unknown = null;
    if (body) {
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        throw new Error("Sandbar returned invalid JSON.");
      }
    }
    if (!response.ok) throw new Error(`Sandbar request failed with HTTP ${response.status}.`);
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Sandbar request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function platformRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  return fetchJson(new URL(path, platformUrl), {
    ...init,
    headers: { authorization: `Bearer ${platformToken}`, ...(init.headers ?? {}) },
  }, PLATFORM_TIMEOUT_MS);
}

function platformComputer(value: unknown): ControlTarget | null {
  if (!isRecord(value) || typeof value.id !== "string" || !Number.isInteger(value.base_port) ||
      typeof value.control_token !== "string") return null;
  if (value.base_port < 1 || value.base_port > 65_532 || !/^[a-f0-9]{32}$/.test(value.control_token)) return null;
  return { id: value.id, basePort: value.base_port, controlToken: value.control_token };
}

async function computerById(id: string): Promise<ControlTarget> {
  const payload = requireRecord(await platformRequest("/api/computers"), "Platform returned an invalid computer list.");
  if (!Array.isArray(payload.computers)) throw new Error("Platform returned an invalid computer list.");
  const computer = payload.computers.map(platformComputer).find((item): item is ControlTarget => item?.id === id);
  if (!computer) throw new Error("Computer not found or platform response was invalid.");
  return computer;
}

function controlUrl(target: ControlTarget, endpoint: string): URL {
  const hostname = platformUrl.hostname.includes(":") ? `[${platformUrl.hostname}]` : platformUrl.hostname;
  return new URL(`http://${hostname}:${target.basePort + 3}${endpoint}`);
}

async function controlRequest(target: ControlTarget, endpoint: string, method: "GET" | "POST", body?: JsonRecord): Promise<unknown> {
  return fetchJson(controlUrl(target, endpoint), {
    method,
    headers: {
      authorization: `Bearer ${target.controlToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }, CONTROL_TIMEOUT_MS);
}

function publicComputer(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { control_token: _controlToken, ...safe } = value;
  return safe;
}

const tools = [
  { name: "sandbar_list_computers", description: "List Sandbar computers and their Docker state.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "sandbar_create_computer", description: "Create and start a Sandbar computer.", inputSchema: { type: "object", properties: { name: { type: "string" }, agent: { type: "string", enum: ["hermes", "none"] } }, additionalProperties: false } },
  { name: "sandbar_delete_computer", description: "Delete a computer while keeping its configuration volume.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "sandbar_screenshot", description: "Capture a PNG screenshot from a computer desktop.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "sandbar_bash", description: "Run a bash command inside a computer.", inputSchema: { type: "object", properties: { id: { type: "string" }, command: { type: "string" }, timeout: { type: "integer", minimum: 1, maximum: 120 } }, required: ["id", "command"], additionalProperties: false } },
  { name: "sandbar_click", description: "Click a computer desktop at X/Y coordinates.", inputSchema: { type: "object", properties: { id: { type: "string" }, x: { type: "integer" }, y: { type: "integer" }, button: { type: "string", enum: ["left", "right", "double"] } }, required: ["id", "x", "y"], additionalProperties: false } },
  { name: "sandbar_type", description: "Type text into the focused application on a computer.", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false } },
  { name: "sandbar_key", description: "Press a keyboard key or X11 key chord on a computer.", inputSchema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" } }, required: ["id", "key"], additionalProperties: false } },
];

async function runTool(name: string, arguments_: JsonRecord) {
  switch (name) {
    case "sandbar_list_computers": {
      const payload = requireRecord(await platformRequest("/api/computers"), "Platform returned an invalid computer list.");
      if (!Array.isArray(payload.computers)) throw new Error("Platform returned an invalid computer list.");
      return text(JSON.stringify({ computers: payload.computers.map(publicComputer) }));
    }
    case "sandbar_create_computer": {
      const nameValue = optionalString(arguments_.name, "name");
      const agent = arguments_.agent;
      if (agent !== undefined && agent !== "hermes" && agent !== "none") throw new Error('"agent" must be "hermes" or "none".');
      const payload = await platformRequest("/api/computers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(nameValue === undefined ? {} : { name: nameValue }), ...(agent === undefined ? {} : { agent }) }),
      });
      return text(JSON.stringify(publicComputer(requireRecord(payload, "Platform returned an invalid create response.").computer)));
    }
    case "sandbar_delete_computer": {
      const id = requireString(arguments_.id, "id");
      await platformRequest(`/api/computers/${encodeURIComponent(id)}`, { method: "DELETE" });
      return text("Computer deleted.");
    }
    case "sandbar_screenshot": {
      const target = await computerById(requireString(arguments_.id, "id"));
      const payload = requireRecord(await controlRequest(target, "/screenshot", "GET"), "Computer returned an invalid screenshot.");
      if (typeof payload.image !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.image)) throw new Error("Computer returned an invalid screenshot.");
      return { content: [{ type: "image" as const, data: payload.image, mimeType: "image/png" }] };
    }
    case "sandbar_bash": {
      const target = await computerById(requireString(arguments_.id, "id"));
      const command = requireString(arguments_.command, "command");
      const timeout = arguments_.timeout === undefined ? 15 : requireInteger(arguments_.timeout, "timeout", 1, 120);
      const payload = requireRecord(await controlRequest(target, "/bash", "POST", { command, timeout }), "Computer returned an invalid bash response.");
      if (typeof payload.stdout !== "string" || typeof payload.stderr !== "string" || !Number.isInteger(payload.exit_code)) {
        throw new Error("Computer returned an invalid bash response.");
      }
      return text(JSON.stringify(payload));
    }
    case "sandbar_click": {
      const target = await computerById(requireString(arguments_.id, "id"));
      const button = arguments_.button ?? "left";
      if (button !== "left" && button !== "right" && button !== "double") throw new Error('"button" must be "left", "right", or "double".');
      await controlRequest(target, "/click", "POST", { x: requireInteger(arguments_.x, "x"), y: requireInteger(arguments_.y, "y"), button });
      return text("Click sent.");
    }
    case "sandbar_type": {
      const target = await computerById(requireString(arguments_.id, "id"));
      await controlRequest(target, "/type", "POST", { text: requireString(arguments_.text, "text") });
      return text("Text sent.");
    }
    case "sandbar_key": {
      const target = await computerById(requireString(arguments_.id, "id"));
      const key = requireString(arguments_.key, "key");
      if (!/^[A-Za-z0-9_+]+$/.test(key)) throw new Error('"key" must match ^[A-Za-z0-9_+]+$.');
      await controlRequest(target, "/key", "POST", { key });
      return text("Key sent.");
    }
    default:
      throw new Error("Unknown tool.");
  }
}

const server = new Server({ name: "sandbar-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const arguments_ = request.params.arguments ?? {};
    if (!isRecord(arguments_)) return text("Tool arguments must be an object.", true);
    return await runTool(request.params.name, arguments_);
  } catch (error) {
    // MCP errors are intentionally generic enough not to disclose platform credentials.
    return text(error instanceof Error ? error.message : "Sandbar request failed.", true);
  }
});

await server.connect(new StdioServerTransport());
