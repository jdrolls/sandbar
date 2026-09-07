import { describe, expect, test } from "bun:test";
import { parseDesktopResolutionConfiguration } from "./resources";

describe("parseDesktopResolutionConfiguration", () => {
  test("uses a 1920x1080 fixed desktop and framebuffer cap by default", () => {
    expect(parseDesktopResolutionConfiguration({})).toEqual({
      width: 1920,
      height: 1080,
      maxResolution: "1920x1080",
    });
  });

  test("accepts an explicitly bounded operator configuration", () => {
    expect(parseDesktopResolutionConfiguration({
      SANDBAR_COMPUTER_DESKTOP_WIDTH: "1280",
      SANDBAR_COMPUTER_DESKTOP_HEIGHT: "720",
      SANDBAR_COMPUTER_DESKTOP_MAX_RES: "1920x1080",
    })).toEqual({
      width: 1280,
      height: 720,
      maxResolution: "1920x1080",
    });
  });

  test("accepts desktop dimensions at the hard ceiling", () => {
    expect(parseDesktopResolutionConfiguration({
      SANDBAR_COMPUTER_DESKTOP_WIDTH: "15360",
      SANDBAR_COMPUTER_DESKTOP_HEIGHT: "8640",
      SANDBAR_COMPUTER_DESKTOP_MAX_RES: "15360x8640",
    })).toEqual({
      width: 15360,
      height: 8640,
      maxResolution: "15360x8640",
    });
  });

  test("rejects malformed and unsafe desktop dimensions", () => {
    const invalidConfigurations = [
      { SANDBAR_COMPUTER_DESKTOP_WIDTH: "1920px" },
      { SANDBAR_COMPUTER_DESKTOP_HEIGHT: "01080" },
      { SANDBAR_COMPUTER_DESKTOP_MAX_RES: "1920X1080" },
      { SANDBAR_COMPUTER_DESKTOP_MAX_RES: "1920x0" },
      { SANDBAR_COMPUTER_DESKTOP_MAX_RES: "15361x1080" },
      { SANDBAR_COMPUTER_DESKTOP_WIDTH: "1921", SANDBAR_COMPUTER_DESKTOP_MAX_RES: "1920x1080" },
      {
        SANDBAR_COMPUTER_DESKTOP_WIDTH: "1920",
        SANDBAR_COMPUTER_DESKTOP_HEIGHT: "1081",
        SANDBAR_COMPUTER_DESKTOP_MAX_RES: "1920x1080",
      },
    ];

    for (const environment of invalidConfigurations) {
      expect(() => parseDesktopResolutionConfiguration(environment)).toThrow();
    }
  });
});
