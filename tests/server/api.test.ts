import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScanDoc, UserDoc } from "../../src/types.ts";
import { sampleDevice, sampleScan, startHarness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  await h.signIn("good");
});
afterEach(async () => {
  await h.close();
});

describe("health and routing", () => {
  it("GET /api/health without auth", async () => {
    h.cookie = "";
    const res = await h.api("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("unknown /api routes => 404 JSON; wrong method => 405", async () => {
    const res = await h.api("GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toMatchObject({ error: "not_found" });
    expect((await h.api("GET", "/api")).status).toBe(404);
    expect((await h.api("PUT", "/api/scans", {})).status).toBe(405);
  });

  it("security headers on API responses", async () => {
    const res = await h.api("GET", "/api/me");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["cross-origin-opener-policy"]).toBeUndefined();
  });
});

describe("/api/user", () => {
  it("GET is null before the first write", async () => {
    const res = await h.api("GET", "/api/user");
    expect(res.status).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("first PATCH fills defaults from the session; later PATCH merges; null deletes", async () => {
    let res = await h.api("PATCH", "/api/user", { heightCm: 180, email: "ignored@x.com" });
    expect(res.status).toBe(200);
    const first = res.json() as UserDoc;
    expect(first).toEqual({ email: "allowed@example.com", createdAt: h.clock.now, units: "in", bodyType: "unspecified", heightCm: 180 });

    h.clock.now += 5000;
    res = await h.api("PATCH", "/api/user", { units: "cm" });
    expect(res.json()).toEqual({ ...first, units: "cm" }); // createdAt unchanged

    res = await h.api("PATCH", "/api/user", { heightCm: null, bodyType: "female" });
    const after = res.json() as UserDoc;
    expect(after.heightCm).toBeUndefined();
    expect("heightCm" in after).toBe(false);
    expect(after.bodyType).toBe("female");
    expect((await h.api("GET", "/api/user")).json()).toEqual(after);
  });

  it("rejects bad values and unknown fields", async () => {
    expect((await h.api("PATCH", "/api/user", { units: "ft" })).status).toBe(400);
    expect((await h.api("PATCH", "/api/user", { heightCm: "180" })).status).toBe(400);
    expect((await h.api("PATCH", "/api/user", { isAdmin: true })).status).toBe(400);
    expect((await h.api("PATCH", "/api/user", [1, 2])).status).toBe(400);
  });
});

describe("/api/scans", () => {
  it("POST, GET by id, list newest first", async () => {
    const older = await h.api("POST", "/api/scans", sampleScan({ createdAt: 1000 }));
    const newer = await h.api("POST", "/api/scans", sampleScan({ createdAt: 2000, subjectLabel: "Person 3" }));
    expect(older.status).toBe(200);
    const olderId = (older.json() as { id: string }).id;
    const newerId = (newer.json() as { id: string }).id;
    expect(olderId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(olderId).not.toBe(newerId);

    const got = (await h.api("GET", `/api/scans/${olderId}`)).json() as ScanDoc;
    expect(got).toEqual({ ...sampleScan({ createdAt: 1000 }), id: olderId });

    const list = (await h.api("GET", "/api/scans")).json() as ScanDoc[];
    expect(list.map((s) => s.id)).toEqual([newerId, olderId]);
  });

  it("clientId POST is idempotent", async () => {
    const clientId = "0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
    const a = await h.api("POST", "/api/scans", { ...sampleScan(), clientId });
    const b = await h.api("POST", "/api/scans", { ...sampleScan({ subjectLabel: "retry" }), clientId });
    expect(a.json()).toEqual({ id: clientId });
    expect(b.json()).toEqual({ id: clientId });
    const list = (await h.api("GET", "/api/scans")).json() as ScanDoc[];
    expect(list).toHaveLength(1);
    expect(list[0].subjectLabel).toBe("me"); // first write wins
    expect("clientId" in list[0]).toBe(false);
  });

  it("rejects a bad clientId", async () => {
    const res = await h.api("POST", "/api/scans", { ...sampleScan(), clientId: "../../etc" });
    expect(res.status).toBe(400);
  });

  it("GET unknown id => 404; bad id => 400", async () => {
    expect((await h.api("GET", "/api/scans/doesNotExist")).status).toBe(404);
    expect((await h.api("GET", "/api/scans/bad%2Fid")).status).toBe(400);
    expect((await h.api("GET", `/api/scans/${"a".repeat(65)}`)).status).toBe(400);
    expect((await h.api("GET", "/api/scans/bad.id")).status).toBe(400);
  });

  it("PATCH merges, tapeMeasurements null deletes, unknown scan 404", async () => {
    const { id } = (await h.api("POST", "/api/scans", sampleScan())).json() as { id: string };
    let res = await h.api("PATCH", `/api/scans/${id}`, { tapeMeasurements: { chest: 99 } });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    let scan = (await h.api("GET", `/api/scans/${id}`)).json() as ScanDoc;
    expect(scan.tapeMeasurements).toEqual({ chest: 99 });
    expect(scan.measurements).toEqual(sampleScan().measurements);

    res = await h.api("PATCH", `/api/scans/${id}`, { tapeMeasurements: null, status: "partial" });
    expect(res.status).toBe(200);
    scan = (await h.api("GET", `/api/scans/${id}`)).json() as ScanDoc;
    expect("tapeMeasurements" in scan).toBe(false);
    expect(scan.status).toBe("partial");

    expect((await h.api("PATCH", "/api/scans/missing", { status: "partial" })).status).toBe(404);
    expect((await h.api("PATCH", `/api/scans/${id}`, { tapeMeasurements: { shoeSize: 9 } })).status).toBe(400);
  });

  it("DELETE removes the scan", async () => {
    const { id } = (await h.api("POST", "/api/scans", sampleScan())).json() as { id: string };
    const res = await h.api("DELETE", `/api/scans/${id}`);
    expect(res.json()).toEqual({ ok: true });
    expect((await h.api("GET", `/api/scans/${id}`)).status).toBe(404);
  });

  it("validation: unknown measurement keys, missing fields, image data", async () => {
    const bad1 = sampleScan();
    (bad1.rawMeasurements as Record<string, number>).shoeSize = 9;
    expect((await h.api("POST", "/api/scans", bad1)).status).toBe(400);

    const { heightCm: _h, ...missing } = sampleScan();
    expect((await h.api("POST", "/api/scans", missing)).status).toBe(400);

    const img = sampleScan();
    (img.diagnostics as unknown as Record<string, unknown>).snapshot = "data:image/png;base64,iVBORw0KGgo=";
    const res = await h.api("POST", "/api/scans", img);
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({ error: "bad_request" });

    const pixels = sampleScan();
    (pixels.diagnostics as unknown as Record<string, unknown>).mask = new Array(20_000).fill(1);
    expect((await h.api("POST", "/api/scans", pixels)).status).toBe(400);

    expect((await h.api("GET", "/api/scans")).json()).toEqual([]);
  });

  it("rejects bodies over 1 MB with 413", async () => {
    const big = sampleScan();
    (big.diagnostics as unknown as Record<string, unknown>).blob = Array.from({ length: 200 }, () => "x".repeat(6000));
    const res = await h.api("POST", "/api/scans", big);
    expect(res.status).toBe(413);
    expect(res.json()).toMatchObject({ error: "too_large" });
  });

  it("rejects chunked bodies over 1 MB (no Content-Length) with 413", async () => {
    const res = await h.request("/api/settings/correctionFactors", {
      method: "PUT",
      headers: { Cookie: h.cookie, "X-Requested-With": "fashion-assistant", "Transfer-Encoding": "chunked" },
      body: "x".repeat(1024 * 1024 + 10),
    });
    expect(res.status).toBe(413);
  });

  it("rejects invalid JSON", async () => {
    const res = await h.request("/api/scans", {
      method: "POST",
      headers: { Cookie: h.cookie, "X-Requested-With": "fashion-assistant", "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("/api/devices and correction factors", () => {
  const deviceId = "3f2b1c9e-1111-4222-8333-944455556666";

  it("device GET null, PUT, GET returns the profile", async () => {
    expect((await h.api("GET", `/api/devices/${deviceId}`)).json()).toBeNull();
    const res = await h.api("PUT", `/api/devices/${deviceId}`, sampleDevice(deviceId));
    expect(res.json()).toEqual({ ok: true });
    const got = (await h.api("GET", `/api/devices/${deviceId}`)).json() as Record<string, unknown>;
    expect(got).toMatchObject(sampleDevice(deviceId) as unknown as Record<string, unknown>);
    expect(got.updatedAt).toBe(h.clock.now);
    // Round-tripping the stored doc (with updatedAt) is accepted.
    expect((await h.api("PUT", `/api/devices/${deviceId}`, got)).status).toBe(200);
  });

  it("device validation", async () => {
    expect((await h.api("PUT", "/api/devices/bad.id", sampleDevice("bad.id"))).status).toBe(400);
    expect((await h.api("PUT", `/api/devices/${deviceId}`, sampleDevice("other"))).status).toBe(400);
    expect((await h.api("PUT", `/api/devices/${deviceId}`, { ...sampleDevice(deviceId), focalLengthPx: "x" })).status).toBe(400);
  });

  it("correction factors GET null, PUT, GET", async () => {
    expect((await h.api("GET", "/api/settings/correctionFactors")).json()).toBeNull();
    const f = { male: { chest: 1.02 }, female: {}, unspecified: { hips: 0.98 } };
    expect((await h.api("PUT", "/api/settings/correctionFactors", f)).json()).toEqual({ ok: true });
    expect((await h.api("GET", "/api/settings/correctionFactors")).json()).toEqual({ ...f, updatedAt: h.clock.now });
    expect((await h.api("PUT", "/api/settings/correctionFactors", { male: { foo: 1 } })).status).toBe(400);
  });
});

describe("DELETE /api/me/data", () => {
  it("wipes users/{uid} with subcollections and every session of the uid", async () => {
    const deviceId = "dev-1";
    await h.api("PATCH", "/api/user", { heightCm: 170 });
    await h.api("POST", "/api/scans", sampleScan());
    await h.api("PUT", `/api/devices/${deviceId}`, sampleDevice(deviceId));
    await h.api("PUT", "/api/settings/correctionFactors", { male: {}, female: {}, unspecified: {} });
    const firstCookie = h.cookie;
    await h.signIn("good"); // a second session (another device)
    expect(h.store.sessionCount()).toBe(2);

    const res = await h.api("DELETE", "/api/me/data");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((res.headers["set-cookie"] ?? []).join(";")).toMatch(/fa_session=;.*Max-Age=0/);
    expect(h.store.sessionCount()).toBe(0);
    expect(h.store.hasUserData("uid-1")).toBe(false);
    expect(await h.store.listScans("uid-1")).toEqual([]);

    expect((await h.api("GET", "/api/me")).status).toBe(401);
    h.cookie = firstCookie;
    expect((await h.api("GET", "/api/me")).status).toBe(401);

    await h.signIn("good");
    expect((await h.api("GET", "/api/user")).json()).toBeNull();
    expect((await h.api("GET", "/api/scans")).json()).toEqual([]);
    expect((await h.api("GET", `/api/devices/${deviceId}`)).json()).toBeNull();
    expect((await h.api("GET", "/api/settings/correctionFactors")).json()).toBeNull();
  });
});

describe("internal errors", () => {
  it("store failures => 500 JSON without leaking details", async () => {
    h.store.listScans = async () => {
      throw new Error("boom");
    };
    const res = await h.api("GET", "/api/scans");
    expect(res.status).toBe(500);
    expect(res.json()).toEqual({ error: "internal", message: "Internal server error" });
    expect(h.logs.some((l) => l.startsWith("ERROR") && l.includes("boom"))).toBe(true);
  });

  it("logs never contain session ids or cookies", async () => {
    await h.api("GET", "/api/me");
    await h.api("POST", "/api/logout");
    const id = h.cookie.split("=")[1];
    expect(h.logs.join("\n")).not.toContain(id);
  });
});
