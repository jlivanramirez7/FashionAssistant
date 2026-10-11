// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteScan, flushOutbox, getScan, listScans, saveScan, updateScan } from "../../src/data/scans";
import { OUTBOX_KEY, isValidClientId, readOutbox } from "../../src/data/outbox";
import type { Diagnostics, ScanDoc } from "../../src/types";
import { json, mockFetch, setOnline } from "./fetchMock";

function scan(createdAt = 1000, extra: Partial<ScanDoc> = {}): ScanDoc {
  return {
    createdAt,
    status: "complete",
    heightCm: 175,
    bodyType: "male",
    subjectLabel: "me",
    scaleSource: "height",
    deviceId: "dev",
    appVersion: "0.1.0",
    viewsCaptured: ["front", "side", "back"],
    measurements: { chest: { valueCm: 100, uncertaintyCm: 2, confidence: 0.8 } },
    rawMeasurements: { chest: 98 },
    diagnostics: { processingMs: 1 } as Diagnostics,
    ...extra,
  };
}

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saveScan", () => {
  it("POSTs /api/scans with a clientId (no id) and returns the server id", async () => {
    const { calls } = mockFetch(() => json(200, { id: "srv-1" }));
    await expect(saveScan("u", { ...scan(), id: "old" })).resolves.toBe("srv-1");
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/scans", credentials: "same-origin" });
    expect(calls[0].headers["X-Requested-With"]).toBe("fashion-assistant");
    const body = calls[0].body as ScanDoc & { clientId: string };
    expect(body.id).toBeUndefined();
    expect(isValidClientId(body.clientId)).toBe(true);
    expect(body.measurements).toEqual(scan().measurements);
    expect(readOutbox()).toEqual([]);
  });

  it("queues offline without calling fetch", async () => {
    setOnline(false);
    const { calls } = mockFetch(() => json(200, { id: "x" }));
    const id = await saveScan("u", scan());
    expect(calls).toHaveLength(0);
    expect(isValidClientId(id)).toBe(true);
    const box = readOutbox();
    expect(box).toHaveLength(1);
    expect(box[0].clientId).toBe(id);
    expect(box[0].scan).toEqual(scan());
  });

  it("queues on a network error, reusing the clientId already sent", async () => {
    const { calls } = mockFetch(() => "network-error");
    const id = await saveScan("u", scan());
    expect((calls[0].body as { clientId: string }).clientId).toBe(id);
    expect(readOutbox().map((e) => e.clientId)).toEqual([id]);
  });

  it("throws server errors (not queued)", async () => {
    mockFetch(() => json(400, { error: "invalid", message: "bad scan" }));
    await expect(saveScan("u", scan())).rejects.toThrow("bad scan");
    expect(readOutbox()).toEqual([]);
  });
});

describe("flushOutbox", () => {
  async function queueTwo(): Promise<[string, string]> {
    setOnline(false);
    mockFetch(() => json(200, {}));
    const a = await saveScan("u", scan(1));
    const b = await saveScan("u", scan(2));
    setOnline(true);
    return [a, b];
  }

  it("POSTs each queued scan with its clientId and empties the outbox", async () => {
    const [a, b] = await queueTwo();
    const { calls } = mockFetch((c) => json(200, { id: (c.body as { clientId: string }).clientId }));
    await expect(flushOutbox()).resolves.toBe(2);
    expect(calls.map((c) => [c.method, c.url, (c.body as { clientId: string }).clientId])).toEqual([
      ["POST", "/api/scans", a],
      ["POST", "/api/scans", b],
    ]);
    expect(calls[0].headers["X-Requested-With"]).toBe("fashion-assistant");
    expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  it("stops at a network error and keeps the rest", async () => {
    const [, b] = await queueTwo();
    mockFetch(() => json(200, { id: "x" }), () => "network-error");
    await expect(flushOutbox()).resolves.toBe(1);
    expect(readOutbox().map((e) => e.clientId)).toEqual([b]);
  });

  it("keeps everything on 401 (signed out) and retries later", async () => {
    const [a, b] = await queueTwo();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(() => json(401, { error: "unauthenticated", message: "no session" }));
    await expect(flushOutbox()).resolves.toBe(0);
    expect(readOutbox().map((e) => e.clientId)).toEqual([a, b]);
  });

  it("drops a scan the server permanently rejects (400) and continues", async () => {
    const [, b] = await queueTwo();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls } = mockFetch(() => json(400, { error: "invalid", message: "bad" }), () => json(200, { id: b }));
    await expect(flushOutbox()).resolves.toBe(1);
    expect(calls).toHaveLength(2);
    expect(readOutbox()).toEqual([]);
  });

  it("concurrent calls share one run (no double POST)", async () => {
    await queueTwo();
    const { calls } = mockFetch(() => json(200, { id: "x" }));
    const [r1, r2] = await Promise.all([flushOutbox(), flushOutbox()]);
    expect(r1).toBe(2);
    expect(r2).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("flushes on the window 'online' event", async () => {
    const [a] = await queueTwo();
    const { calls } = mockFetch(() => json(200, { id: "x" }));
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(readOutbox()).toEqual([]));
    expect((calls[0].body as { clientId: string }).clientId).toBe(a);
  });

  it("ignores a corrupt outbox", async () => {
    localStorage.setItem(OUTBOX_KEY, "{not json");
    const { calls } = mockFetch(() => json(200, {}));
    await expect(flushOutbox()).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("outbox scans behave like stored scans", () => {
  async function queued(): Promise<string> {
    setOnline(false);
    mockFetch(() => json(200, {}));
    const id = await saveScan("u", scan(5));
    setOnline(true);
    return id;
  }

  it("getScan returns the queued scan without fetching", async () => {
    const id = await queued();
    const { calls } = mockFetch(() => json(200, {}));
    await expect(getScan("u", id)).resolves.toEqual({ ...scan(5), id });
    expect(calls).toHaveLength(0);
  });

  it("updateScan patches the queued scan locally", async () => {
    const id = await queued();
    const { calls } = mockFetch(() => json(200, {}));
    await updateScan("u", id, { tapeMeasurements: { chest: 99 }, subjectLabel: "Person 2" });
    expect(calls).toHaveLength(0);
    expect(readOutbox()[0].scan).toMatchObject({ tapeMeasurements: { chest: 99 }, subjectLabel: "Person 2" });
  });

  it("deleteScan removes the queued scan without fetching", async () => {
    const id = await queued();
    const { calls } = mockFetch(() => json(200, {}));
    await deleteScan("u", id);
    expect(calls).toHaveLength(0);
    expect(readOutbox()).toEqual([]);
  });

  it("listScans merges queued scans (deduped by id), newest first", async () => {
    const id = await queued();
    const server = [
      { ...scan(9), id: "s9" },
      { ...scan(1), id: "s1" },
    ];
    const { calls } = mockFetch(() => json(200, server));
    const list = await listScans("u");
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/scans" });
    expect(list.map((s) => s.id)).toEqual(["s9", id, "s1"]);
    // Already synced (server returns it) -> not duplicated
    mockFetch(() => json(200, [{ ...scan(5), id }]));
    expect((await listScans("u")).map((s) => s.id)).toEqual([id]);
  });
});

describe("server-backed scan calls", () => {
  it("getScan GETs /api/scans/:id and maps 404 to null", async () => {
    const { calls } = mockFetch(() => json(200, { ...scan(), id: "a b" }), () => json(404, { error: "not_found", message: "x" }));
    await expect(getScan("u", "a b")).resolves.toMatchObject({ id: "a b" });
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/scans/a%20b" });
    await expect(getScan("u", "zzz")).resolves.toBeNull();
  });

  it("getScan rethrows other errors", async () => {
    mockFetch(() => json(500, { error: "internal", message: "boom" }));
    await expect(getScan("u", "a")).rejects.toThrow("boom");
  });

  it("updateScan PATCHes with null for removed tapeMeasurements", async () => {
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await updateScan("u", "s1", { tapeMeasurements: undefined, subjectLabel: "P" });
    expect(calls[0]).toMatchObject({ method: "PATCH", url: "/api/scans/s1", body: { tapeMeasurements: null, subjectLabel: "P" } });
    expect(calls[0].headers["X-Requested-With"]).toBe("fashion-assistant");
  });

  it("updateScan with an empty patch does nothing", async () => {
    const { calls } = mockFetch(() => json(200, {}));
    await updateScan("u", "s1", { id: "x" });
    expect(calls).toHaveLength(0);
  });

  it("deleteScan DELETEs /api/scans/:id", async () => {
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await deleteScan("u", "s1");
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "/api/scans/s1" });
    expect(calls[0].headers["X-Requested-With"]).toBe("fashion-assistant");
  });

  it("listScans propagates server errors with their message", async () => {
    mockFetch(() => json(401, { error: "unauthenticated", message: "Session expired" }));
    await expect(listScans("u")).rejects.toThrow("Session expired");
  });
});
