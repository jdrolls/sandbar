import { afterEach, describe, expect, test } from "bun:test";
import {
  namespaceBrowserSeccompProfile,
  NamespaceSandboxPrerequisiteError,
  namespaceSandboxImageCapability,
  namespaceSandboxImageCapabilityLabel,
} from "./browser-sandbox";
import { DockerDesktop } from "./docker";
import type { Computer } from "./db";

const computer: Computer = {
  id: "seat-1",
  name: "Namespace seat",
  agent: "none",
  basePort: 12_000,
  controlToken: "a".repeat(32),
  createdAt: "2026-07-19T00:00:00.000Z",
};

const defaultImage = "ghcr.io/jdrolls/sandbar-desktop:latest";
const inspectedImageId = `sha256:${"a".repeat(64)}`;
const originalFetch = globalThis.fetch;
const originalImage = process.env.SANDBAR_IMAGE;

type DockerRequest = { path: string; body: unknown };
interface DockerFetchOptions {
  daemonArchitecture?: unknown;
  image?: unknown;
  imageStatus?: number;
}

function compatibleImage(architecture = "amd64", imageId = inspectedImageId): Record<string, unknown> {
  return {
    Id: imageId,
    Architecture: architecture,
    Config: { Labels: { [namespaceSandboxImageCapabilityLabel]: namespaceSandboxImageCapability } },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalImage === undefined) delete process.env.SANDBAR_IMAGE;
  else process.env.SANDBAR_IMAGE = originalImage;
});

function installDockerFetch({
  daemonArchitecture = "x86_64",
  image = compatibleImage(),
  imageStatus = 200,
}: DockerFetchOptions = {}): DockerRequest[] {
  const requests: DockerRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname.replace(/^\/v1\.44/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ path, body });
    if (path === "/info") return Response.json({ Architecture: daemonArchitecture });
    if (path.startsWith("/images/")) {
      return imageStatus === 200
        ? Response.json(image)
        : Response.json({ message: "image inspection failed" }, { status: imageStatus });
    }
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  return requests;
}

function createRequest(requests: DockerRequest[]): Record<string, unknown> {
  const request = requests.find(({ path }) => path === "/containers/create");
  expect(request).toBeDefined();
  return request?.body as Record<string, unknown>;
}

function expectCompatibilityRefusal(requests: DockerRequest[], expectedPaths: string[]): void {
  expect(requests.map(({ path }) => path)).toEqual(expectedPaths);
  expect(requests.some(({ path }) => ["/networks/create", "/volumes/create", "/containers/create"].includes(path))).toBe(false);
}

describe("DockerDesktop namespace browser sandbox opt-in", () => {
  test("accepts a proven daemon and paired capable amd64 image before creating the seat", async () => {
    const requests = installDockerFetch();
    await new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace", ANTHROPIC_API_KEY: "test" });

    expect(requests.slice(0, 2).map(({ path }) => path)).toEqual([
      "/info",
      `/images/${encodeURIComponent(defaultImage)}/json`,
    ]);
    const config = createRequest(requests);
    expect(config.Image).toBe(inspectedImageId);
    expect(config.Env).toContain("SANDBAR_BROWSER_SANDBOX=namespace");
    const hostConfig = config.HostConfig as Record<string, unknown>;
    expect(hostConfig.NetworkMode).toBe("sandbar-seat-1-network");
    expect(hostConfig.NanoCpus).toBe(1_000_000_000);
    expect(hostConfig.Memory).toBe(2_147_483_648);
    expect(hostConfig.PidsLimit).toBe(512);
    expect(hostConfig.SecurityOpt).toEqual([
      "no-new-privileges:true",
      `seccomp=${JSON.stringify(namespaceBrowserSeccompProfile())}`,
    ]);
    expect(hostConfig).not.toHaveProperty("Privileged");
    expect(hostConfig).not.toHaveProperty("CapAdd");
  });

  test("pins namespace creation to the inspected immutable image Id when a mutable tag drifts", async () => {
    const selectedImage = "registry.example/sandbar:latest";
    const immutableImageId = `sha256:${"b".repeat(64)}`;
    process.env.SANDBAR_IMAGE = selectedImage;
    const requests = installDockerFetch({ image: compatibleImage("amd64", immutableImageId) });

    await new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" });

    expect(requests[1].path).toBe(`/images/${encodeURIComponent(selectedImage)}/json`);
    expect(createRequest(requests).Image).toBe(immutableImageId);
  });

  test("rejects an unsupported daemon architecture before image lookup or mutations", async () => {
    const requests = installDockerFetch({ daemonArchitecture: "aarch64" });
    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" })).rejects.toBeInstanceOf(NamespaceSandboxPrerequisiteError);
    expectCompatibilityRefusal(requests, ["/info"]);
  });

  test("rejects an image lookup failure before mutations", async () => {
    const requests = installDockerFetch({ imageStatus: 404 });
    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" })).rejects.toThrow("image inspection failed");
    expectCompatibilityRefusal(requests, ["/info", `/images/${encodeURIComponent(defaultImage)}/json`]);
  });

  test("rejects an inspected image without an Id before mutations", async () => {
    const image = compatibleImage();
    delete image.Id;
    const requests = installDockerFetch({ image });

    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" })).rejects.toBeInstanceOf(NamespaceSandboxPrerequisiteError);
    expectCompatibilityRefusal(requests, ["/info", `/images/${encodeURIComponent(defaultImage)}/json`]);
  });

  test("rejects an inspected image with a malformed Id before mutations", async () => {
    const requests = installDockerFetch({ image: compatibleImage("amd64", "sha256:not-a-canonical-digest") });

    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" })).rejects.toThrow("canonical image Id");
    expectCompatibilityRefusal(requests, ["/info", `/images/${encodeURIComponent(defaultImage)}/json`]);
  });

  test("rejects a selected image without the namespace capability label before mutations", async () => {
    const requests = installDockerFetch({ image: { Id: inspectedImageId, Architecture: "amd64", Config: { Labels: {} } } });
    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" })).rejects.toBeInstanceOf(NamespaceSandboxPrerequisiteError);
    expectCompatibilityRefusal(requests, ["/info", `/images/${encodeURIComponent(defaultImage)}/json`]);
  });

  test("rejects a selected image with the wrong architecture before mutations", async () => {
    const requests = installDockerFetch({ image: compatibleImage("arm64") });
    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "namespace" })).rejects.toThrow("amd64 image");
    expectCompatibilityRefusal(requests, ["/info", `/images/${encodeURIComponent(defaultImage)}/json`]);
  });

  test("preserves the legacy create configuration without compatibility lookups", async () => {
    const requests = installDockerFetch();
    await new DockerDesktop().createAndStart(computer, { ANTHROPIC_API_KEY: "test" });

    expect(requests.some(({ path }) => path === "/info" || path.startsWith("/images/"))).toBe(false);
    const config = createRequest(requests);
    expect(config.Env).not.toContain("SANDBAR_BROWSER_SANDBOX=namespace");
    const hostConfig = config.HostConfig as Record<string, unknown>;
    expect(hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
  });

  test("rejects invalid modes before any Docker request", async () => {
    const requests = installDockerFetch();
    await expect(new DockerDesktop().createAndStart(computer, { SANDBAR_BROWSER_SANDBOX: "on" })).rejects.toThrow("SANDBAR_BROWSER_SANDBOX");
    expect(requests).toEqual([]);
  });
});
