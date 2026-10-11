// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, errorFromResponse, NetworkError } from "../../src/data/api";
import { getUserDoc, saveUserDoc } from "../../src/data/user";
import { getDeviceRecord, saveDeviceRecord } from "../../src/data/devices";
import { getCorrectionFactors, saveCorrectionFactors } from "../../src/data/settings";
import { deleteAllMyData } from "../../src/data/deleteAll";
import { getDeviceId } from "../../src/data/deviceId";
import { OUTBOX_KEY } from "../../src/data/outbox";
import { scanPatchBody, userPatchBody, applyScanPatch, sortScansNewestFirst } from "../../src/data/serialize";
import type { DeviceProfile, ScanDoc } from "../../src/types";
import { json, mockFetch, setOnline } from "./fetchMock";

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WRITE_HEADER = "fashion-assistant";

describe("api()", () => {
  it("GET: same-origin credentials, no X-Requested-With, no body", async () => {
    const { calls } = mockFetch(() => json(200, { a: 1 }));
    await expect(api("GET", "/api/x")).resolves.toEqual({ a: 1 });
    expect(calls[0]).toMatchObject({ url: "/api/x", method: "GET", credentials: "same-origin", body: undefined });
    expect(calls[0].headers["X-Requested-With"]).toBeUndefined();
  });

  it("writes carry X-Requested-With and a JSON body", async () => {
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await api("POST", "/api/x", { b: 2 });
    expect(calls[0].headers["X-Requested-With"]).toBe(WRITE_HEADER);
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body).toEqual({ b: 2 });
    await api("DELETE", "/api/x");
    expect(calls[1].headers["X-Requested-With"]).toBe(WRITE_HEADER);
    expect(calls[1].body).toBeUndefined();
  });

  it("maps JSON errors to ApiError with the server message", async () => {
    mockFetch(() => json(400, { error: "invalid_body", message: "measurements.chest must be a number" }));
    const err = (await api("PATCH", "/api/user", {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("measurements.chest must be a number");
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_body");
  });

  it("maps fetch rejections to NetworkError", async () => {
    mockFetch(() => "network-error");
    await expect(api("GET", "/api/x")).rejects.toBeInstanceOf(NetworkError);
  });

  it("returns null for an empty body and throws on invalid JSON", async () => {
    mockFetch(() => new Response("", { status: 200 }), () => new Response("<html>", { status: 200 }));
    await expect(api("GET", "/api/x")).resolves.toBeNull();
    await expect(api("GET", "/api/x")).rejects.toThrow(/invalid response/);
  });
});

describe("errorFromResponse", () => {
  it("uses fallback messages for non-JSON bodies", () => {
    expect(errorFromResponse(401, "").message).toMatch(/sign in/);
    expect(errorFromResponse(403, "nope").message).toBe("Not allowed.");
    expect(errorFromResponse(404, "").message).toBe("Not found.");
    const e = errorFromResponse(502, "<html>Bad gateway</html>");
    expect(e.message).toBe("Request failed (502).");
    expect(e.code).toBe("http_502");
  });
  it("keeps the code when the message is missing", () => {
    const e = errorFromResponse(403, JSON.stringify({ error: "csrf" }));
    expect(e.code).toBe("csrf");
    expect(e.message).toBe("Not allowed.");
  });
});

describe("serialize helpers", () => {
  it("scanPatchBody drops id and turns undefined tapeMeasurements into null", () => {
    expect(scanPatchBody({ id: "x", subjectLabel: "P2", tapeMeasurements: undefined, status: undefined })).toEqual({
      subjectLabel: "P2",
      tapeMeasurements: null,
    });
  });
  it("userPatchBody turns undefined heightCm into null", () => {
    expect(userPatchBody({ units: "cm", heightCm: undefined, bodyType: undefined })).toEqual({ units: "cm", heightCm: null });
  });
  it("applyScanPatch merges and removes tapeMeasurements", () => {
    const s = { id: "a", createdAt: 1, subjectLabel: "me", tapeMeasurements: { chest: 99 } } as unknown as ScanDoc;
    expect(applyScanPatch(s, { subjectLabel: "P3", id: "zz" })).toMatchObject({ id: "a", subjectLabel: "P3", tapeMeasurements: { chest: 99 } });
    expect("tapeMeasurements" in applyScanPatch(s, { tapeMeasurements: undefined })).toBe(false);
    expect(s.tapeMeasurements).toEqual({ chest: 99 }); // not mutated
  });
  it("sortScansNewestFirst", () => {
    const s = [1, 3, 2].map((t) => ({ id: String(t), createdAt: t }) as ScanDoc);
    expect(sortScansNewestFirst(s).map((x) => x.id)).toEqual(["3", "2", "1"]);
  });
});

describe("user", () => {
  it("getUserDoc GETs /api/user and returns null when absent", async () => {
    const { calls } = mockFetch(() => json(200, null), () => json(200, { email: "a", createdAt: 1, units: "in", bodyType: "male" }));
    await expect(getUserDoc("ignored")).resolves.toBeNull();
    await expect(getUserDoc("ignored")).resolves.toMatchObject({ bodyType: "male" });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "/api/user"],
      ["GET", "/api/user"],
    ]);
  });
  it("saveUserDoc PATCHes /api/user with the patch", async () => {
    const { calls } = mockFetch(() => json(200, { email: "a" }));
    await saveUserDoc("ignored", { heightCm: 170, units: "cm" });
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "/api/user", body: { heightCm: 170, units: "cm" } });
    expect(calls[0].headers["X-Requested-With"]).toBe(WRITE_HEADER);
  });
});

describe("devices", () => {
  const profile = { deviceId: "dev 1/x", label: "iPhone", focalLengthPx: 1500 } as DeviceProfile;
  it("getDeviceRecord GETs /api/devices/:id (encoded)", async () => {
    const { calls } = mockFetch(() => json(200, null));
    await expect(getDeviceRecord("u", "dev 1/x")).resolves.toBeNull();
    expect(calls[0].url).toBe("/api/devices/dev%201%2Fx");
  });
  it("saveDeviceRecord PUTs the profile", async () => {
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await saveDeviceRecord("u", profile);
    expect(calls[0]).toMatchObject({ method: "PUT", url: "/api/devices/dev%201%2Fx", body: profile });
    expect(calls[0].headers["X-Requested-With"]).toBe(WRITE_HEADER);
  });
});

describe("settings", () => {
  it("getCorrectionFactors GETs the settings doc", async () => {
    const f = { male: { chest: 1.02 }, female: {}, unspecified: {}, updatedAt: 5 };
    const { calls } = mockFetch(() => json(200, f));
    await expect(getCorrectionFactors("u")).resolves.toEqual(f);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/settings/correctionFactors" });
  });
  it("saveCorrectionFactors PUTs and stamps updatedAt when missing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await saveCorrectionFactors("u", { male: {}, female: { hips: 0.98 }, unspecified: {} });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "/api/settings/correctionFactors",
      body: { male: {}, female: { hips: 0.98 }, unspecified: {}, updatedAt: 1234 },
    });
    await saveCorrectionFactors("u", { male: {}, female: {}, unspecified: {}, updatedAt: 7 });
    expect((calls[1].body as { updatedAt: number }).updatedAt).toBe(7);
  });
});

describe("deleteAllMyData", () => {
  it("DELETEs /api/me/data then clears outbox, deviceId and cached user", async () => {
    const id = getDeviceId();
    localStorage.setItem(OUTBOX_KEY, "[]");
    localStorage.setItem("fa.lastUser", JSON.stringify({ uid: "1", email: "e" }));
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await deleteAllMyData("u");
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "/api/me/data" });
    expect(calls[0].headers["X-Requested-With"]).toBe(WRITE_HEADER);
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
    expect(localStorage.getItem("fa.deviceId")).toBeNull();
    expect(localStorage.getItem("fa.lastUser")).toBeNull();
    expect(getDeviceId()).not.toBe(id);
  });
  it("throws when offline without calling the server", async () => {
    setOnline(false);
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await expect(deleteAllMyData("u")).rejects.toThrow(/offline/);
    expect(calls).toHaveLength(0);
  });
  it("keeps local data when the server fails", async () => {
    getDeviceId();
    mockFetch(() => json(500, { error: "internal", message: "Firestore unavailable" }));
    await expect(deleteAllMyData("u")).rejects.toThrow("Firestore unavailable");
    expect(localStorage.getItem("fa.deviceId")).not.toBeNull();
  });
});
