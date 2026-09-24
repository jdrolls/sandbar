import {
  assertNamespaceSandboxArchitecture,
  browserSandboxEnvironmentKey,
  namespaceBrowserSecurityOpt,
  NamespaceSandboxPrerequisiteError,
  namespaceSandboxImageCapability,
  namespaceSandboxImageCapabilityLabel,
  parseBrowserSandboxMode,
} from "./browser-sandbox";
import { computerPort } from "./ports";
import { computerResourceLimits, desktopResolutionConfiguration, sandbarNetworkConfiguration } from "./resources";
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

function networkName(id: string): string {
  return `sandbar-${id}-network`;
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function assertNamespaceSandboxImageCapability(image: unknown): void {
  const architecture = isRecord(image) ? image.Architecture : undefined;
  const config = isRecord(image) ? image.Config : undefined;
  const labels = isRecord(config) ? config.Labels : undefined;
  const capability = isRecord(labels) ? labels[namespaceSandboxImageCapabilityLabel] : undefined;

  if (architecture !== "amd64") {
    throw new NamespaceSandboxPrerequisiteError(
      `Namespace Chromium sandboxing requires an amd64 image; Docker reported ${typeof architecture === "string" ? JSON.stringify(architecture) : "no image architecture"}.`,
    );
  }
  if (capability !== namespaceSandboxImageCapability) {
    throw new NamespaceSandboxPrerequisiteError(
      `Namespace Chromium sandboxing requires image label ${namespaceSandboxImageCapabilityLabel}=${namespaceSandboxImageCapability}.`,
    );
  }
}

function assertCanonicalImageId(image: unknown): string {
  const imageId = isRecord(image) ? image.Id : undefined;
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new NamespaceSandboxPrerequisiteError(
      "Namespace Chromium sandboxing requires Docker to report a canonical image Id (sha256:<64 lowercase hexadecimal characters>).",
    );
  }
  return imageId;
}

async function assertNamespaceSandboxCompatibility(image: string): Promise<string> {
  const info = await dockerRequest("/info");
  assertNamespaceSandboxArchitecture(isRecord(info) ? info.Architecture : undefined);

  const inspectedImage = await dockerRequest(`/images/${encodeURIComponent(image)}/json`);
  assertNamespaceSandboxImageCapability(inspectedImage);
  return assertCanonicalImageId(inspectedImage);
}

export type DockerState = "running" | "created" | "exited" | "paused" | "restarting" | "dead" | "unknown" | "missing";

export class DockerDesktop {
  async createAndStart(computer: Computer, createEnv: Readonly<Record<string, string>>): Promise<void> {
    // Resolve and prove the opt-in before creating any Docker resource. Existing
    // seats stay on the legacy path and do not incur an extra /info request.
    const browserSandboxMode = parseBrowserSandboxMode(createEnv[browserSandboxEnvironmentKey]);
    // Resolve once so the capability inspection and container creation cannot
    // accidentally target different images if the process environment changes.
    const configuredImage = process.env.SANDBAR_IMAGE ?? "ghcr.io/jdrolls/sandbar-desktop:latest";
    const image = browserSandboxMode === "namespace"
      ? await assertNamespaceSandboxCompatibility(configuredImage)
      : configuredImage;

    const volume = volumeName(computer.id);
    const network = networkName(computer.id);
    let networkCreated = false;
    let volumeCreated = false;
    let containerCreated = false;
    try {
      // A user-defined bridge gives this computer NATed internet access without
      // placing it on the default bridge or another computer's network.
      await dockerRequest("/networks/create", jsonRequest("POST", {
        Name: network,
        Driver: "bridge",
        Internal: false,
        CheckDuplicate: true,
      }));
      networkCreated = true;

      await dockerRequest("/volumes/create", jsonRequest("POST", { Name: volume }));
      volumeCreated = true;

      const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
        "3000/tcp": [{ HostIp: sandbarNetworkConfiguration.bindIp, HostPort: String(computerPort.desktopHttp(computer.basePort)) }],
        "3001/tcp": [{ HostIp: sandbarNetworkConfiguration.bindIp, HostPort: String(computerPort.desktopHttps(computer.basePort)) }],
        "7681/tcp": [{ HostIp: sandbarNetworkConfiguration.bindIp, HostPort: String(computerPort.chat(computer.basePort)) }],
        "8080/tcp": [{ HostIp: sandbarNetworkConfiguration.bindIp, HostPort: String(computerPort.control(computer.basePort)) }],
      };
      const exposedPorts: Record<string, Record<string, never>> = Object.fromEntries(
        DESKTOP_PORTS.map((port) => [port, {}]),
      );
      const environment = new Map<string, string>(Object.entries(createEnv));
      // Configure Selkies at container creation. MAX_RES blocks a connected
      // viewer from expanding Xvfb beyond the operator-approved framebuffer.
      environment.set("SELKIES_MANUAL_WIDTH", String(desktopResolutionConfiguration.width));
      environment.set("SELKIES_MANUAL_HEIGHT", String(desktopResolutionConfiguration.height));
      environment.set("MAX_RES", desktopResolutionConfiguration.maxResolution);
      environment.set("SANDBAR_TOKEN", computer.controlToken);
      environment.set("SANDBAR_AGENT", computer.agent);
      if (browserSandboxMode === "namespace") {
        environment.set(browserSandboxEnvironmentKey, "namespace");
      }

      await dockerRequest(
        `/containers/create?name=${encodeURIComponent(containerName(computer.id))}`,
        jsonRequest("POST", {
          Image: image,
          Env: Array.from(environment, ([key, value]) => `${key}=${value}`),
          ExposedPorts: exposedPorts,
          HostConfig: {
            NetworkMode: network,
            PortBindings: bindings,
            ShmSize: 1_073_741_824,
            NanoCpus: computerResourceLimits.nanoCpus,
            Memory: computerResourceLimits.memoryBytes,
            PidsLimit: computerResourceLimits.pidsLimit,
            SecurityOpt: browserSandboxMode === "namespace"
              ? ["no-new-privileges:true", namespaceBrowserSecurityOpt()]
              : ["no-new-privileges:true"],
            RestartPolicy: { Name: "unless-stopped" },
            Mounts: [{ Type: "volume", Source: volume, Target: "/config" }],
          },
          NetworkingConfig: {
            EndpointsConfig: { [network]: {} },
          },
        }),
      );
      containerCreated = true;
      await dockerRequest(`/containers/${encodeURIComponent(containerName(computer.id))}/start`, jsonRequest("POST"));
    } catch (error) {
      // Docker has no multi-resource transaction, so unwind in dependency order.
      // This keeps failed create attempts from leaving a desktop or private network behind.
      if (containerCreated) await this.ignoreMissing(() => this.removeContainer(computer.id, true));
      if (volumeCreated) await this.ignoreMissing(() => this.removeVolume(computer.id));
      if (networkCreated) await this.ignoreMissing(() => this.removeNetwork(computer.id));
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

  async removeNetwork(id: string): Promise<void> {
    try {
      await dockerRequest(`/networks/${encodeURIComponent(networkName(id))}`, { method: "DELETE" });
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
