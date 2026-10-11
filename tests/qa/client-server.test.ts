// @vitest-environment jsdom
// QA: the CLIENT data/auth modules (team A2) driven against the REAL server
// routes (team S) through a fetch shim. Proves paths, methods, headers and
// payloads agree end to end, including the offline outbox (idempotent flush).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MEASUREMENT_KEYS, type ScanDoc } from "../../src/types";
import { ALLOWED_EMAIL, fn, loadModule, type Mod } from "./_helpers";
import { ID_RE, fakeToken, isContractRoute, makeFetchShim, signInRaw, startServer, type FetchShim, type Harness } from "./_server";

const T = "A2 client-data" as const;
let H: Harness | null = null;
let startError: Error | null = null;
let shim: FetchShim;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  try {
    H = await startServer();
  } catch (e) {
    startError = e as Error;
  }
}, 60_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await H?.close();
});

async function freshSession(sub = "sub-client") {
  if (!H) throw startError ?? new Error("[S server] harness did not start");
  const { session } = await signInRaw(H.base, fakeToken(ALLOWED_EMAIL, sub));
  if (!session) throw new Error("[S server] sign-in did not return a session");
  shim = makeFetchShim(H.base, { fa_session: session });
  globalThis.fetch = shim.fetch;
  (window as unknown as { fetch: typeof fetch }).fetch = shim.fetch;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const load = (p: string) => loadModule(p, T);

function scan(over: Partial<ScanDoc> = {}): ScanDoc {
  const m: ScanDoc["measurements"] = {};
  const r: ScanDoc["rawMeasurements"] = {};
  MEASUREMENT_KEYS.forEach((k, i) => {
    m[k] = { valueCm: 40 + i, uncertaintyCm: 1, confidence: 0.8 };
    r[k] = 40 + i;
  });
  return {
    createdAt: Date.now(), status: "complete", heightCm: 175, bodyType: "female", subjectLabel: "me", scaleSource: "height",
    deviceId: "dev-c", appVersion: "0.1.0", viewsCaptured: ["front", "side", "back"], measurements: m, rawMeasurements: r,
    diagnostics: {
      userAgent: "QA", deviceModelGuess: "QA", modelSource: "generic", videoWidth: 1080, videoHeight: 1920, focalLengthPxSpec: 1442,
      lensOffsetCm: 14, lensHeightCm: 13.5, tiltDeg: 75, rollDeg: 0, distanceM: { front: 2.5 }, scaleAgreementPct: 0.4,
      qualityScores: {}, retakes: [], processingMs: 1, modelVersions: {},
    },
    ...over,
  };
}

/** Every request the client made: contract route, credentials, write header. */
function requestProblems(): string[] {
  const out: string[] = [];
  for (const r of shim.log) {
    if (!r.path.startsWith("/api/")) continue;
    if (!isContractRoute(r.method, r.path)) out.push(`${r.method} ${r.path} is not a CONTRACTS-v2 route`);
    if (r.credentials && r.credentials !== "same-origin" && r.credentials !== "include") out.push(`${r.method} ${r.path} credentials=${r.credentials}`);
    if (r.method !== "GET" && r.headers["x-requested-with"] !== "fashion-assistant") out.push(`${r.method} ${r.path} missing X-Requested-With: fashion-assistant`);
  }
  return out;
}

async function settle(ms = 50) {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, ms / 10));
}

describe("[A2 client-data x S server] client modules against the real routes", () => {
  it("auth: getCurrentUser, signOutUser (session gone server-side)", async () => {
    await freshSession("sub-auth");
    const g: Mod = await load("src/auth/authGuard");
    const me = await fn(g, "getCurrentUser", T, "src/auth/authGuard")();
    expect(me).toEqual({ uid: "sub-auth", email: ALLOWED_EMAIL });
    await fn(g, "signOutUser", T, "src/auth/authGuard")();
    expect(await g.getCurrentUser(), "after sign-out").toBeNull();
    expect(requestProblems()).toEqual([]);
  });

  it("user, scans (all 23 keys), devices, settings round trip via src/data", async () => {
    await freshSession("sub-data");
    const user = await load("src/data/user");
    await fn(user, "saveUserDoc", T, "src/data/user")("ignored-uid", { heightCm: 172, units: "cm", bodyType: "female" });
    const u = await fn(user, "getUserDoc", T, "src/data/user")("ignored-uid");
    expect(u).toMatchObject({ email: ALLOWED_EMAIL, heightCm: 172, units: "cm", bodyType: "female" });

    const scans = await load("src/data/scans");
    const s = scan();
    const id = await fn(scans, "saveScan", T, "src/data/scans")("ignored-uid", s);
    expect(id).toMatch(ID_RE);
    const got = await fn(scans, "getScan", T, "src/data/scans")("ignored-uid", id);
    for (const k of MEASUREMENT_KEYS) expect(got.measurements[k], k).toEqual(s.measurements[k]);
    const tape = { chest: 99, bust: 99, inseam: 77 };
    await fn(scans, "updateScan", T, "src/data/scans")("ignored-uid", id, { tapeMeasurements: tape });
    expect((await scans.getScan("ignored-uid", id)).tapeMeasurements).toEqual(tape);
    const list = await fn(scans, "listScans", T, "src/data/scans")("ignored-uid");
    expect(list.map((x: ScanDoc) => x.id)).toContain(id);
    await fn(scans, "deleteScan", T, "src/data/scans")("ignored-uid", id);
    expect(await scans.getScan("ignored-uid", id)).toBeNull();

    const devices = await load("src/data/devices");
    const prof = { deviceId: "dev-c", label: "QA", deviceModelGuess: "QA", modelSource: "generic", screen: { width: 1, height: 2, devicePixelRatio: 3 }, lensOffsetCm: 13.2, lensOffsetSource: "paper", front35mmEqMm: 26, focalLengthPx: 1400, focalLengthSource: "paper", captureWidth: 1080, captureHeight: 1920, calibrationScans: 2 };
    await fn(devices, "saveDeviceRecord", T, "src/data/devices")("ignored-uid", prof);
    expect((await fn(devices, "getDeviceRecord", T, "src/data/devices")("ignored-uid", "dev-c")).lensOffsetCm).toBe(13.2);
    expect(await devices.getDeviceRecord("ignored-uid", "unknown-dev")).toBeNull();

    const settings = await load("src/data/settings");
    await fn(settings, "saveCorrectionFactors", T, "src/data/settings")("ignored-uid", { male: {}, female: { chest: 1.03 }, unspecified: {} });
    expect((await fn(settings, "getCorrectionFactors", T, "src/data/settings")("ignored-uid")).female.chest).toBe(1.03);

    expect(requestProblems(), requestProblems().join("\n")).toEqual([]);
  }, 30_000);

  it("offline saveScan: outbox fa.outbox, id returned, flushed once on 'online', idempotent re-flush", async () => {
    await freshSession("sub-outbox");
    const scans = await load("src/data/scans");
    shim.offline = true;
    const id = await fn(scans, "saveScan", T, "src/data/scans")("ignored-uid", scan({ subjectLabel: "offline" }));
    expect(id, "offline saveScan must still return a client id").toMatch(ID_RE);
    const box = localStorage.getItem("fa.outbox");
    expect(box, "scan must be in localStorage fa.outbox while offline").toBeTruthy();
    expect(box!).toContain(id);
    expect(box!, "outbox must hold numbers only, no image data").not.toMatch(/data:image|base64,/);

    shim.offline = false;
    window.dispatchEvent(new Event("online"));
    await settle(200);
    if (typeof scans.flushOutbox === "function") await scans.flushOutbox();
    const posts = shim.log.filter((r) => r.method === "POST" && r.path === "/api/scans");
    expect(posts.length, "outbox flush must POST /api/scans").toBeGreaterThan(0);
    expect(posts.every((p) => (p.body ?? "").includes(`"clientId":"${id}"`)), "flush must send clientId = the returned id").toBe(true);
    const list1 = (await scans.listScans("ignored-uid")) as ScanDoc[];
    expect(list1.filter((s) => s.id === id).length, "exactly one doc with the client id").toBe(1);
    const left = localStorage.getItem("fa.outbox");
    expect(!left || !left.includes(id), "outbox emptied after a successful flush").toBe(true);

    // Re-flush the same item (e.g. two tabs / crash before removal): no duplicate.
    localStorage.setItem("fa.outbox", box!);
    window.dispatchEvent(new Event("online"));
    await settle(200);
    if (typeof scans.flushOutbox === "function") await scans.flushOutbox();
    const list2 = (await scans.listScans("ignored-uid")) as ScanDoc[];
    expect(list2.filter((s) => s.id === id).length, "idempotent: still exactly one").toBe(1);
    expect(requestProblems(), requestProblems().join("\n")).toEqual([]);
  }, 30_000);

  it("deleteAllMyData: DELETE /api/me/data, clears outbox + deviceId, session gone", async () => {
    await freshSession("sub-delete");
    const dev = await load("src/data/deviceId");
    dev.getDeviceId();
    localStorage.setItem("fa.outbox", "[]");
    const scans = await load("src/data/scans");
    await scans.saveScan("ignored-uid", scan());
    const del = await load("src/data/deleteAll");
    await fn(del, "deleteAllMyData", T, "src/data/deleteAll")("ignored-uid");
    expect(shim.log.some((r) => r.method === "DELETE" && r.path === "/api/me/data")).toBe(true);
    expect(localStorage.getItem("fa.deviceId")).toBeNull();
    expect(localStorage.getItem("fa.outbox") ?? "[]").toMatch(/^\[\]$|^$/);
    const g = await load("src/auth/authGuard");
    expect(await g.getCurrentUser()).toBeNull();
    expect(requestProblems()).toEqual([]);
  }, 30_000);

  it("deleteAllMyData throws when offline (never silently pretends)", async () => {
    await freshSession("sub-delete-offline");
    shim.offline = true;
    const del = await load("src/data/deleteAll");
    await expect(fn(del, "deleteAllMyData", T, "src/data/deleteAll")("ignored-uid")).rejects.toBeTruthy();
  });
});
