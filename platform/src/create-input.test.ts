import { describe, expect, test } from "bun:test";
import { NamespaceSandboxPrerequisiteError } from "./browser-sandbox";
import { HttpError, mapApiError, validateCreate } from "./create-input";
import { DockerError } from "./docker";

function expectBadRequest(body: Record<string, unknown>, message: string): void {
  let thrown: unknown;
  try {
    validateCreate(body);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(400);
  expect((thrown as Error).message).toBe(message);
}

describe("computer create input validation", () => {
  test("retains the legacy default when the sandbox setting is absent", () => {
    expect(validateCreate({})).toEqual({
      name: "Sandbar computer",
      agent: "hermes",
      env: {},
    });
  });

  test("accepts only explicit legacy and namespace sandbox modes", () => {
    for (const mode of ["legacy", "namespace"]) {
      expect(validateCreate({ env: { SANDBAR_BROWSER_SANDBOX: mode } }).env).toEqual({
        SANDBAR_BROWSER_SANDBOX: mode,
      });
    }
  });

  test("rejects unknown, empty, and non-string sandbox modes", () => {
    const modeError = 'SANDBAR_BROWSER_SANDBOX must be "legacy" or "namespace".';
    expectBadRequest({ env: { SANDBAR_BROWSER_SANDBOX: "enabled" } }, modeError);
    expectBadRequest({ env: { SANDBAR_BROWSER_SANDBOX: "" } }, modeError);
    expectBadRequest({ env: { SANDBAR_BROWSER_SANDBOX: 1 } }, "Environment contains an invalid key or value.");
  });

  test("does not accept callers' Chromium flags or image selection", () => {
    for (const key of ["CHROMIUM_FLAGS", "SANDBAR_IMAGE"]) {
      expectBadRequest({ env: { [key]: "--no-sandbox" } }, "Environment contains an invalid key or value.");
    }
  });
});

describe("API client error mapping", () => {
  test("maps namespace configuration prerequisites to a safe actionable 422 response", () => {
    const daemonDetail = 'Docker reported "private-daemon-secret" and label "private.image.label=secret".';
    const mapped = mapApiError(new NamespaceSandboxPrerequisiteError(daemonDetail));

    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped).toMatchObject({
      status: 422,
      message: "Namespace browser sandbox prerequisites are not met. Verify Docker and the selected Sandbar image support namespace sandboxing.",
    });
    expect(mapped?.message).not.toContain("private-daemon-secret");
    expect(mapped?.message).not.toContain("private.image.label");
  });

  test("preserves input validation errors as 400 responses", () => {
    const invalidMode = new HttpError(400, 'SANDBAR_BROWSER_SANDBOX must be "legacy" or "namespace".');
    expect(mapApiError(invalidMode)).toBe(invalidMode);
  });

  test("maps Docker transport errors to a generic 502 response", () => {
    expect(mapApiError(new DockerError(500, "daemon private detail"))).toMatchObject({
      status: 502,
      message: "Docker operation failed.",
    });
  });

  test("leaves unknown errors for the generic server handler", () => {
    expect(mapApiError(new Error("unexpected failure"))).toBeUndefined();
  });
});
