import { describe, expect, test } from "bun:test";
import { HttpError, validateCreate } from "./create-input";

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
