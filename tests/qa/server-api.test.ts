// QA: server HTTP contract (docs/CONTRACTS-v2.md, team S), driven over real HTTP
// against createApp(deps) with the memory store and a fake ID-token verifier.
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEASUREMENT_KEYS, type ScanDoc } from "../../src/types";
import { ALLOWED_EMAIL } from "./_helpers";
import { cookiesFrom, fakeToken, raw, setCookieLine, signInRaw, startServer, type Harness, type RawResponse } from "./_server";

let H: Harness | null = null;
let startError: Error | null = null;
let session = "";

beforeAll(async () => {
  try {
    H = await startServer();
    const s = await signInRaw(H.base, fakeToken(ALLOWED_EMAIL));
    session = s.session ?? "";
  } catch (e) {
    startError = e as Error;
  }
}, 60_000);
afterAll(async () => {
  await H?.close();
});

function h(): Harness {
  if (!H) throw startError ?? new Error("[S server] harness did not start");
  return H;
}
const WRITE = { "x-requested-with": "fashion-assistant", "content-type": "application/json" };
const auth = (extra: Record<string, string> = {}) => ({ cookie: `fa_session=${session}`, ...extra });
const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  raw(h().base, method, path, {
    headers: auth({ ...(method === "GET" ? {} : WRITE), ...headers }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function scan(over: Partial<ScanDoc> = {}): ScanDoc & { clientId?: string } {
  const m: ScanDoc["measurements"] = {};
  const r: ScanDoc["rawMeasurements"] = {};
  MEASUREMENT_KEYS.forEach((k, i) => {
    m[k] = { valueCm: 30 + i, uncertaintyCm: 1.5, confidence: 0.8 };
    r[k] = 30 + i;
  });
  return {
    createdAt: 1_760_000_000_000, status: "complete", heightCm: 175, bodyType: "unspecified", subjectLabel: "me",
    scaleSource: "height", deviceId: "dev-qa", appVersion: "0.1.0", viewsCaptured: ["front", "side", "back"],
    measurements: m, rawMeasurements: r,
    diagnostics: {
      userAgent: "QA", deviceModelGuess: "QA", modelSource: "generic", videoWidth: 1080, videoHeight: 1920,
      focalLengthPxSpec: 1442, lensOffsetCm: 14, lensHeightCm: 13.5, tiltDeg: 75, rollDeg: 0,
      distanceM: { front: 2.5, side: 2.5, back: 2.5 }, scaleAgreementPct: 0.4, qualityScores: { front: 0.9 },
      retakes: [], processingMs: 8000, modelVersions: { pose: "heavy" },
    },
    ...over,
  };
}
const isErr = (r: RawResponse) => typeof (r.json as { error?: unknown })?.error === "string";

describe("[S server] auth: GIS redirect target, CSRF, allowlist, session cookie", () => {
  it("health is public; /api/me needs a session (401 JSON error)", async () => {
    const hl = await raw(h().base, "GET", "/api/health");
    expect(hl.status).toBe(200);
    expect(hl.json).toEqual({ ok: true });
    const me = await raw(h().base, "GET", "/api/me");
    expect(me.status).toBe(401);
    expect(isErr(me), `error body ${me.text}`).toBe(true);
  });

  it("allowed account: 303 -> / with fa_session HttpOnly; SameSite=Lax; Path=/; Max-Age 30 days", async () => {
    const { res, session: s } = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL, "sub-cookie-check"));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
    expect(s, "fa_session cookie").toBeTruthy();
    expect(s!).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    const line = setCookieLine(res, "fa_session")!;
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\/(;|$)/i);
    expect(line).toMatch(/;\s*Max-Age=2592000\b/i);
    const me = await raw(h().base, "GET", "/api/me", { headers: { cookie: `fa_session=${s}` } });
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ uid: "sub-cookie-check", email: ALLOWED_EMAIL });
  });

  it("allowed email is matched case-insensitively", async () => {
    const { res, session: s } = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL.toUpperCase(), "sub-upper"));
    expect(res.headers.location).toBe("/");
    expect(s).toBeTruthy();
  });

  it("other account -> /?auth_error=private and NO session", async () => {
    const { res, session: s } = await signInRaw(h().base, fakeToken("someone.else@gmail.com", "sub-other"));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/?auth_error=private");
    expect(s).toBeNull();
  });

  it("unverified email is refused (no session)", async () => {
    const { res, session: s } = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL, "sub-unverified", false));
    expect(res.status).toBe(303);
    expect(String(res.headers.location)).toMatch(/^\/\?auth_error=(private|failed)$/);
    expect(s).toBeNull();
  });

  it("CSRF mismatch, missing CSRF cookie, or a bad token -> /?auth_error=failed, no session", async () => {
    const a = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL), "body-csrf", "other-cookie-csrf");
    const b = await raw(h().base, "POST", "/api/auth/google", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ credential: fakeToken(ALLOWED_EMAIL), g_csrf_token: "x" }).toString(),
    });
    const c = await signInRaw(h().base, "not-a-real-token");
    for (const [name, r] of [["csrf mismatch", a.res], ["no csrf cookie", b], ["bad token", c.res]] as const) {
      expect(r.status, name).toBe(303);
      expect(r.headers.location, name).toBe("/?auth_error=failed");
      expect(cookiesFrom(r).fa_session ?? "", name).toBe("");
    }
  });

  it("unknown / forged session cookie -> 401", async () => {
    const r = await raw(h().base, "GET", "/api/me", { headers: { cookie: "fa_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(r.status).toBe(401);
  });

  it("state-changing requests without X-Requested-With: fashion-assistant -> 403", async () => {
    const r = await raw(h().base, "PATCH", "/api/user", {
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ units: "cm" }),
    });
    expect(r.status).toBe(403);
    const r2 = await raw(h().base, "POST", "/api/logout", { headers: auth({ "x-requested-with": "evil" }) });
    expect(r2.status).toBe(403);
  });

  it("logout deletes the session server-side and clears the cookie", async () => {
    const { session: s } = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL, "sub-logout"));
    const out = await raw(h().base, "POST", "/api/logout", { headers: { cookie: `fa_session=${s}`, "x-requested-with": "fashion-assistant" } });
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ ok: true });
    const line = setCookieLine(out, "fa_session") ?? "";
    expect(line, "cookie must be cleared").toMatch(/fa_session=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    const me = await raw(h().base, "GET", "/api/me", { headers: { cookie: `fa_session=${s}` } });
    expect(me.status, "old cookie must not work after logout").toBe(401);
  });
});

describe("[S server] API routes, idempotency and validation", () => {
  it("every protected route rejects a request with no session (401)", async () => {
    const paths: [string, string][] = [
      ["GET", "/api/user"], ["GET", "/api/scans"], ["GET", "/api/scans/abc"], ["GET", "/api/devices/dev1"],
      ["GET", "/api/settings/correctionFactors"], ["PATCH", "/api/user"], ["POST", "/api/scans"],
      ["PUT", "/api/devices/dev1"], ["PUT", "/api/settings/correctionFactors"], ["DELETE", "/api/scans/abc"], ["DELETE", "/api/me/data"],
    ];
    const bad: string[] = [];
    for (const [m, p] of paths) {
      // Every non-GET carries a JSON body (DELETE too): the auth guard must run BEFORE body parsing.
      const hasBody = m !== "GET";
      const r = await raw(h().base, m, p, {
        headers: { "x-requested-with": "fashion-assistant", ...(hasBody ? { "content-type": "application/json" } : {}) },
        body: hasBody ? "{}" : undefined,
      });
      if (r.status !== 401) bad.push(`${m} ${p} -> ${r.status}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("PATCH /api/user: first write fills email/createdAt/units/bodyType defaults; heightCm null deletes", async () => {
    const r = await api("PATCH", "/api/user", { heightCm: 175 });
    expect(r.status).toBe(200);
    const u = r.json as Record<string, unknown>;
    expect(u.email).toBe(ALLOWED_EMAIL);
    expect(typeof u.createdAt).toBe("number");
    expect(u.units).toBe("in");
    expect(u.bodyType).toBe("unspecified");
    expect(u.heightCm).toBe(175);
    const r2 = await api("PATCH", "/api/user", { heightCm: null, units: "cm" });
    expect((r2.json as Record<string, unknown>).heightCm).toBeUndefined();
    expect((r2.json as Record<string, unknown>).units).toBe("cm");
  });

  it("POST /api/scans with clientId is idempotent (same id, no duplicate)", async () => {
    const clientId = "qa-client-id-0001";
    const a = await api("POST", "/api/scans", { ...scan(), clientId });
    const b = await api("POST", "/api/scans", { ...scan(), clientId });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.json as { id: string }).id).toBe(clientId);
    expect((b.json as { id: string }).id).toBe(clientId);
    const list = (await api("GET", "/api/scans")).json as ScanDoc[];
    expect(list.filter((s) => s.id === clientId).length).toBe(1);
  });

  it("scan round trip keeps all 23 keys; list newest first; tape PATCH and null-delete; 404 after delete", async () => {
    const older = await api("POST", "/api/scans", scan({ createdAt: 1_700_000_000_000 }));
    const tape: Record<string, number> = {};
    MEASUREMENT_KEYS.forEach((k, i) => (tape[k] = 31 + i));
    const created = await api("POST", "/api/scans", scan({ createdAt: 1_790_000_000_000 }));
    const id = (created.json as { id: string }).id;
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const got = (await api("GET", `/api/scans/${id}`)).json as ScanDoc;
    for (const k of MEASUREMENT_KEYS) {
      expect(got.measurements[k], `measurements.${k}`).toEqual(scan().measurements[k]);
      expect(got.rawMeasurements[k], `raw.${k}`).toBe(scan().rawMeasurements[k]);
    }
    expect(got.createdAt).toBe(1_790_000_000_000);
    const list = (await api("GET", "/api/scans")).json as ScanDoc[];
    const times = list.map((s) => s.createdAt);
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(list[0].id).toBe(id);
    expect((await api("PATCH", `/api/scans/${id}`, { tapeMeasurements: tape })).json).toEqual({ ok: true });
    const withTape = (await api("GET", `/api/scans/${id}`)).json as ScanDoc;
    for (const k of MEASUREMENT_KEYS) expect(withTape.tapeMeasurements?.[k], `tape.${k}`).toBe(tape[k]);
    await api("PATCH", `/api/scans/${id}`, { tapeMeasurements: null });
    expect(((await api("GET", `/api/scans/${id}`)).json as ScanDoc).tapeMeasurements).toBeUndefined();
    expect((await api("DELETE", `/api/scans/${id}`)).json).toEqual({ ok: true });
    expect((await api("GET", `/api/scans/${id}`)).status).toBe(404);
    await api("DELETE", `/api/scans/${(older.json as { id: string }).id}`);
  });

  it("devices and correction factors: PUT then GET; unknown device -> null", async () => {
    expect((await api("GET", "/api/devices/never-seen")).json).toBeNull();
    const dev = { deviceId: "dev-qa", label: "QA", deviceModelGuess: "QA", modelSource: "generic", screen: { width: 390, height: 844, devicePixelRatio: 3 }, lensOffsetCm: 14, lensOffsetSource: "generic", front35mmEqMm: 26, focalLengthPx: 1442, focalLengthSource: "spec", captureWidth: 1080, captureHeight: 1920, calibrationScans: 0 };
    expect((await api("PUT", "/api/devices/dev-qa", dev)).json).toEqual({ ok: true });
    expect(((await api("GET", "/api/devices/dev-qa")).json as Record<string, unknown>).lensOffsetCm).toBe(14);
    const f = { male: { chest: 1.02 }, female: {}, unspecified: { hips: 0.98 }, updatedAt: 1_760_000_000_000 };
    expect((await api("PUT", "/api/settings/correctionFactors", f)).json).toEqual({ ok: true });
    const back = (await api("GET", "/api/settings/correctionFactors")).json as Record<string, Record<string, number>>;
    expect(back.male.chest).toBe(1.02);
    expect(back.unspecified.hips).toBe(0.98);
  });

  it("NO image data accepted: data: URLs, strings > 10 kB, big number arrays, bodies > 1 MB", async () => {
    const bad: [string, unknown][] = [
      ["data URL", scan({ subjectLabel: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" })],
      ["11 kB string", scan({ subjectLabel: "x".repeat(11_000) })],
      ["20k-number array", { ...scan(), frames: Array.from({ length: 20_000 }, (_, i) => i % 255) }],
      ["unknown measurement key", scan({ measurements: { foo: { valueCm: 1, uncertaintyCm: 1, confidence: 1 } } as unknown as ScanDoc["measurements"] })],
      ["non-numeric measurement", scan({ rawMeasurements: { chest: "98" } as unknown as ScanDoc["rawMeasurements"] })],
      ["bad clientId", { ...scan(), clientId: "../../etc" }],
    ];
    const accepted: string[] = [];
    for (const [name, body] of bad) {
      const r = await api("POST", "/api/scans", body);
      if (r.status < 400 || r.status >= 500) accepted.push(`${name} -> ${r.status}`);
      else expect(isErr(r), `${name}: error JSON`).toBe(true);
    }
    const huge = await raw(h().base, "POST", "/api/scans", { headers: auth(WRITE), body: JSON.stringify({ ...scan(), subjectLabel: "y".repeat(1_100_000) }) });
    if (!(huge.status === 413 || huge.status === 400)) accepted.push(`>1 MB body -> ${huge.status}`);
    const patch = await api("PATCH", "/api/user", { heightCm: "data:image/png;base64,AAAA" });
    if (patch.status < 400 || patch.status >= 500) accepted.push(`PATCH user with data URL -> ${patch.status}`);
    expect(accepted, `server accepted image-like/invalid data:\n${accepted.join("\n")}`).toEqual([]);
  });

  it("ids are validated; unknown /api routes are 404 JSON", async () => {
    const r = await api("GET", "/api/scans/bad%20id!");
    expect([400, 404]).toContain(r.status);
    const u = await api("GET", "/api/nope");
    expect(u.status).toBe(404);
    expect(isErr(u)).toBe(true);
  });

  it("DELETE /api/me/data wipes the user and ALL of this uid's sessions", async () => {
    const one = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL, "sub-wipe"));
    const two = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL, "sub-wipe"));
    const hdr = (s: string | null) => ({ cookie: `fa_session=${s}`, ...WRITE });
    await raw(h().base, "POST", "/api/scans", { headers: hdr(one.session), body: JSON.stringify(scan()) });
    await raw(h().base, "PATCH", "/api/user", { headers: hdr(one.session), body: JSON.stringify({ heightCm: 170 }) });
    const del = await raw(h().base, "DELETE", "/api/me/data", { headers: hdr(one.session) });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect((await raw(h().base, "GET", "/api/me", { headers: hdr(two.session) })).status, "other session of the same uid").toBe(401);
    const three = await signInRaw(h().base, fakeToken(ALLOWED_EMAIL, "sub-wipe"));
    expect((await raw(h().base, "GET", "/api/scans", { headers: hdr(three.session) })).json).toEqual([]);
    expect((await raw(h().base, "GET", "/api/user", { headers: hdr(three.session) })).json).toBeNull();
  });
});

describe("[S server] static serving and security headers", () => {
  it("MIME types and cache headers", async () => {
    const cases: [string, RegExp][] = [
      ["/", /^text\/html/], ["/index.html", /^text\/html/], ["/sw.js", /javascript/],
      ["/manifest.webmanifest", /^application\/manifest\+json/], ["/wasm/qa.wasm", /^application\/wasm/],
      ["/models/qa.task", /^application\/octet-stream/], ["/models/qa.tflite", /^application\/octet-stream/],
      ["/assets/index-QA.js", /javascript/], ["/device-profiles.json", /^application\/json/],
    ];
    const bad: string[] = [];
    for (const [p, ct] of cases) {
      const r = await raw(h().base, "GET", p);
      if (r.status !== 200 || !ct.test(String(r.headers["content-type"]))) bad.push(`${p} -> ${r.status} ${r.headers["content-type"]}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(String((await raw(h().base, "GET", "/")).headers["cache-control"])).toMatch(/no-cache/);
    expect(String((await raw(h().base, "GET", "/sw.js")).headers["cache-control"])).toMatch(/no-cache/);
    expect(String((await raw(h().base, "GET", "/assets/index-QA.js")).headers["cache-control"])).toMatch(/immutable/);
  });

  it("gzip for text when accepted", async () => {
    const r = await raw(h().base, "GET", "/assets/index-QA.js", { headers: { "accept-encoding": "gzip" } });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(r.body).toString()).toContain("console.log");
  });

  it("SPA fallback only for extension-less non-API GETs", async () => {
    const r = await raw(h().base, "GET", "/history");
    expect(r.status).toBe(200);
    expect(r.text).toContain("QA index");
    expect((await raw(h().base, "GET", "/missing.js")).status).toBe(404);
    const a = await raw(h().base, "GET", "/api/does-not-exist");
    expect(a.text).not.toContain("QA index");
  });

  it("path traversal is impossible", async () => {
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/assets/..%2f..%2fpackage.json", "/..%5cpackage.json", "/%2e%2e%2f%2e%2e%2fpackage.json"]) {
      const r = await raw(h().base, "GET", p);
      expect(r.text, p).not.toContain('"name": "fashion-assistant"');
      expect(r.text, p).not.toContain("fashion-assistant");
    }
  });

  it("security headers: CSP allows GIS + wasm, no COOP same-origin, nosniff", async () => {
    const r = await raw(h().base, "GET", "/");
    const coop = String(r.headers["cross-origin-opener-policy"] ?? "");
    expect(coop, "COOP same-origin breaks the GIS flow").not.toMatch(/^same-origin$/i);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const csp = String(r.headers["content-security-policy"] ?? "");
    expect(csp, "HTML must carry a Content-Security-Policy").not.toBe("");
    const dir = (name: string) => (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? "");
    const scriptSrc = dir("script-src") || dir("default-src");
    expect(scriptSrc, "script-src must allow https://accounts.google.com/gsi/client").toMatch(/https:\/\/accounts\.google\.com/);
    expect(scriptSrc, "script-src must allow WebAssembly compile").toMatch(/'wasm-unsafe-eval'|'unsafe-eval'/);
    const frameSrc = dir("frame-src") || dir("child-src") || dir("default-src");
    expect(frameSrc, "frame-src must allow the GIS button iframe").toMatch(/https:\/\/accounts\.google\.com/);
    const styleSrc = dir("style-src") || dir("default-src");
    expect(styleSrc, "style-src must allow GIS styles").toMatch(/https:\/\/accounts\.google\.com/);
    const connect = dir("connect-src") || dir("default-src");
    expect(connect, "connect-src must allow same-origin /api").toMatch(/'self'/);
    expect(csp, "no wildcard script sources").not.toMatch(/script-src[^;]*\s\*(\s|;|$)/);
  });
});
