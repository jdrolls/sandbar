import { computerPort } from "./ports";
import type { Computer } from "./db";

const DOCKER_API = "http://localhost/v1.44";
const DOCKER_SOCKET = "/var/run/docker.sock";
const DESKTOP_PORTS = ["3000/tcp", "3001/tcp", "7681/tcp", "8080/tcp"] as const;

interface UnixRequestInit extends RequestInit {
  unix: string;
}

interface DockerErrorPayload {
  message?: unknown;
}

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dockerRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${DOCKER_API}${path}`, { ...init, unix: DOCKER_SOCKET } as UnixRequestInit);
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail = isRecord(payload) && typeof (payload as DockerErrorPayload).message === "string"
      ? (payload as DockerErrorPayload).message
      : `Docker API returned HTTP ${response.status}.`;
    throw new DockerError(response.status, detail);
  }
  return payload;
}

function containerName(id: string): string {
  return `sandbar-${id}`;
}

function volumeName(id: string): string {
  return `sandbar-${id}-config`;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export type DockerState = "running" | "created" | "exited" | "paused" | "restarting" | "dead" | "unknown" | "missing";

export class DockerDesktop {
  async createAndStart(computer: Computer, createEnv: Readonly<Record<string, string>>): Promise<void> {
    const volume = volumeName(computer.id);
    let volumeCreated = false;
    let containerCreated = false;
    try {
      await dockerRequest("/volumes/create", jsonRequest("POST", { Name: volume }));
      volumeCreated = true;

      const bindings: Record<string, Array<{ HostPort: string }>> = {
        "3000/tcp": [{ HostPort: String(computerPort.desktopHttp(computer.basePort)) }],
        "3001/tcp": [{ HostPort: String(computerPort.desktopHttps(computer.basePort)) }],
        "7681/tcp": [{ HostPort: String(computerPort.chat(computer.basePort)) }],
        "8080/tcp": [{ HostPort: String(computerPort.control(computer.basePort)) }],
      };
      const exposedPorts: Record<string, Record<string, never>> = Object.fromEntries(
        DESKTOP_PORTS.map((port) => [port, {}]),
      );
      const environment = new Map<string, string>(Object.entries(createEnv));
      environment.set("SANDBAR_TOKEN", computer.controlToken);
      environment.set("SANDBAR_AGENT", computer.agent);

      await dockerRequest(
        `/containers/create?name=${encodeURIComponent(containerName(computer.id))}`,
        jsonRequest("POST", {
          Image: process.env.SANDBAR_IMAGE ?? "ghcr.io/jdrolls/sandbar-desktop:latest",
          Env: Array.from(environment, ([key, value]) => `${key}=${value}`),
          ExposedPorts: exposedPorts,
          HostConfig: {
            PortBindings: bindings,
            ShmSize: 1_073_741_824,
            RestartPolicy: { Name: "unless-stopped" },
            Mounts: [{ Type: "volume", Source: volume, Target: "/config" }],
          },
        }),
      );
      containerCreated = true;
      await dockerRequest(`/containers/${encodeURIComponent(containerName(computer.id))}/start`, jsonRequest("POST"));
    } catch (error) {
      // Best-effort rollback ensures failed creations do not leave secret-bearing containers behind.
      if (containerCreated) await this.ignoreMissing(() => this.removeContainer(computer.id, true));
      if (volumeCreated) await this.ignoreMissing(() => this.removeVolume(computer.id));
      throw error;
    }
  }

  async inspect(computer: Computer): Promise<DockerState> {
    try {
      const payload = await dockerRequest(`/containers/${encodeURIComponent(containerName(computer.id))}/json`);
      if (!isRecord(payload) || !isRecord(payload.State)) return "unknown";
      const status = payload.State.Status;
      if (status === "running" || status === "created" || status === "exited" || status === "paused" || status === "restarting" || status === "dead") {
        return status;
      }
      return "unknown";
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return "missing";
      return "unknown";
    }
  }

  async start(computer: Computer): Promise<void> {
    try {
      await dockerRequest(`/containers/${encodeURIComponent(containerName(computer.id))}/start`, jsonRequest("POST"));
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 304)) throw error;
    }
  }

  async stop(computer: Computer): Promise<void> {
    try {
      await dockerRequest(`/containers/${encodeURIComponent(containerName(computer.id))}/stop?t=15`, jsonRequest("POST"));
    } catch (error) {
      if (!(error instanceof DockerError && (error.status === 304 || error.status === 404))) throw error;
    }
  }

  async removeContainer(id: string, force = false): Promise<void> {
    try {
      await dockerRequest(`/containers/${encodeURIComponent(containerName(id))}?force=${force ? "true" : "false"}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
  }

  async removeVolume(id: string): Promise<void> {
    try {
      await dockerRequest(`/volumes/${encodeURIComponent(volumeName(id))}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
  }

  private async ignoreMissing(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      // Cleanup errors cannot safely replace the original create/start failure.
    }
  }
}
