// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearDeviceId, getDeviceId } from "../../src/data/deviceId";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("deviceId", () => {
  beforeEach(() => {
    localStorage.clear();
    clearDeviceId();
  });

  it("creates a UUID once and stores it under fa.deviceId", () => {
    const id = getDeviceId();
    expect(id).toMatch(UUID);
    expect(localStorage.getItem("fa.deviceId")).toBe(id);
    expect(getDeviceId()).toBe(id);
  });

  it("reuses an existing stored id", () => {
    localStorage.setItem("fa.deviceId", "existing-id");
    expect(getDeviceId()).toBe("existing-id");
  });

  it("clearDeviceId removes it so a new id is generated", () => {
    const first = getDeviceId();
    clearDeviceId();
    expect(localStorage.getItem("fa.deviceId")).toBeNull();
    const second = getDeviceId();
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });
});
