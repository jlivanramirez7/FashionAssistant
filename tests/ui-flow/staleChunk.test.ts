// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStaleChunkError, reloadForNewVersion } from "../../src/ui/staleChunk";

describe("stale chunk after a deploy", () => {
  beforeEach(() => sessionStorage.clear());

  it("recognises the browsers' missing-module errors", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/setup-CMCalJrA.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError(new Error("You are signed out."))).toBe(false);
  });

  it("reloads once, then not again within a minute", () => {
    const reload = vi.fn();
    expect(reloadForNewVersion(1_000_000, reload)).toBe(true);
    expect(reloadForNewVersion(1_030_000, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewVersion(1_070_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
