// Test harness: runs createApp on an ephemeral port with the memory
// store, a fake ID-token verifier, a controllable clock and a temp dist/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../server/api.ts";
import type { IdTokenClaims, VerifyIdToken } from "../../server/auth.ts";
import type { Config } from "../../server/config.ts";
import { MemoryStore } from "../../server/store-memory.ts";
import type { DeviceProfile, ScanDoc } from "../../src/types.ts";

export const CLIENT_ID = "test-client.apps.googleusercontent.com";
export const ALLOWED = "allowed@example.com";

/** Fake verifier: token string -> claims; anything else throws. */
export const TOKENS: Record<string, IdTokenClaims> = {
  good: { sub: "uid-1", email: "Allowed@Example.com", email_verified: true },
  wrong: { sub: "uid-2", email: "someone@example.com", email_verified: true },
  unverified: { sub: "uid-3", email: ALLOWED, email_verified: false },
};

export const fakeVerify: VerifyIdToken = async (idToken, audience) => {
  if (audience !== CLIENT_ID) throw new Error("wrong audience");
  const claims = TOKENS[idToken];
  if (!claims) throw new Error(`Wrong number of segments in token: ${idToken}`);
  return claims;
};

export interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: () => unknown;
}

export interface ReqOpts {
  method?: string;
  headers?: Record<string, string | number>;
  body?: string | Buffer;
}

export interface Harness {
  url: string;
  port: number;
  store: MemoryStore;
  config: Config;
  clock: { now: number };
  logs: string[];
  root: string;
  request(path: string, opts?: ReqOpts): Promise<Res>;
  /** JSON API call with the session cookie and X-Requested-With on writes. */
  api(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Res>;
  /** Signs in through POST /api/auth/google and remembers the session cookie. */
  signIn(token?: string): Promise<Res>;
  cookie: string;
  close(): Promise<void>;
}

export function writeDist(root: string): string {
  const dist = path.join(root, "dist");
  mkdirSync(path.join(dist, "assets"), { recursive: true });
  mkdirSync(path.join(dist, "models"), { recursive: true });
  mkdirSync(path.join(dist, "wasm"), { recursive: true });
  writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>Fashion Assistant</title><div id=app></div>" + " ".repeat(2000));
  writeFileSync(path.join(dist, "sw.js"), "self.addEventListener('install', () => {});\n".repeat(50));
  writeFileSync(path.join(dist, "assets", "index-abc123.js"), "console.log('app');\n".repeat(200));
  writeFileSync(path.join(dist, "assets", "index-abc123.css"), "body{color:#111}\n".repeat(100));
  writeFileSync(path.join(dist, "manifest.webmanifest"), JSON.stringify({ name: "Fashion Assistant" }));
  writeFileSync(path.join(dist, "models", "pose_landmarker_lite.task"), Buffer.alloc(4096, 7));
  writeFileSync(path.join(dist, "wasm", "vision_wasm_internal.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  // A file OUTSIDE dist that traversal attempts try to reach.
  writeFileSync(path.join(root, "secret.txt"), "TOP-SECRET");
  return dist;
}

export function rawRequest(port: number, reqPath: string, opts: ReqOpts = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...opts.headers };
    if (opts.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length" || k.toLowerCase() === "transfer-encoding")) {
      headers["Content-Length"] = Buffer.byteLength(opts.body);
    }
    const req = httpRequest(
      { host: "127.0.0.1", port, path: reqPath, method: opts.method ?? "GET", headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: () => JSON.parse(text) as unknown });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function sessionCookieFrom(res: Res): string {
  const set = res.headers["set-cookie"] ?? [];
  const c = set.find((s) => s.startsWith("fa_session="));
  return c ? c.split(";")[0] : "";
}

export async function startHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "fa-server-"));
  const distDir = writeDist(root);
  const config: Config = {
    production: false,
    googleClientId: CLIENT_ID,
    allowedEmail: ALLOWED,
    firestoreDatabaseId: "test-db",
    googleCloudProject: "test-project",
    dataBackend: "memory",
    port: 0,
    distDir,
    cookieSecure: false,
    ...overrides,
  };
  const store = new MemoryStore();
  const clock = { now: Date.UTC(2026, 9, 10, 12, 0, 0) };
  const logs: string[] = [];
  const app = createApp({
    config,
    store,
    verifyIdToken: fakeVerify,
    now: () => clock.now,
    log: (sev, msg) => logs.push(`${sev} ${msg}`),
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;

  const h: Harness = {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    config,
    clock,
    logs,
    root,
    cookie: "",
    request: (p, opts) => rawRequest(port, p, opts),
    async api(method, p, body, extraHeaders = {}) {
      const headers: Record<string, string> = { ...extraHeaders };
      if (h.cookie) headers.Cookie = h.cookie;
      if (method !== "GET" && method !== "HEAD" && !("X-Requested-With" in headers)) {
        headers["X-Requested-With"] = "fashion-assistant";
      }
      let payload: string | undefined;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
      }
      return rawRequest(port, p, { method, headers, body: payload });
    },
    async signIn(token = "good") {
      const res = await rawRequest(port, "/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "g_csrf_token=csrf123" },
        body: new URLSearchParams({ credential: token, g_csrf_token: "csrf123" }).toString(),
      });
      const c = sessionCookieFrom(res);
      if (c) h.cookie = c;
      return res;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}

export function sampleScan(overrides: Partial<ScanDoc> = {}): ScanDoc {
  return {
    createdAt: Date.UTC(2026, 9, 1),
    status: "complete",
    heightCm: 180,
    bodyType: "male",
    subjectLabel: "me",
    scaleSource: "height",
    deviceId: "3f2b1c9e-1111-4222-8333-944455556666",
    appVersion: "0.1.0",
    viewsCaptured: ["front", "side", "back"],
    measurements: { chest: { valueCm: 98.4, uncertaintyCm: 2.6, confidence: 0.82 } },
    rawMeasurements: { chest: 97.1, height: 180 },
    diagnostics: {
      userAgent: "test",
      deviceModelGuess: "Pixel 8",
      modelSource: "ua-client-hints",
      videoWidth: 1920,
      videoHeight: 1080,
      focalLengthPxSpec: 1500,
      lensOffsetCm: 14,
      lensHeightCm: 13.5,
      tiltDeg: 75,
      rollDeg: 0.5,
      distanceM: { front: 2.5 },
      scaleAgreementPct: 1.2,
      qualityScores: { front: 0.9 },
      retakes: [{ step: "side", reason: "blurry" }],
      processingMs: 4200,
      modelVersions: { pose: "heavy-1" },
    },
    ...overrides,
  };
}

export function sampleDevice(deviceId: string): DeviceProfile {
  return {
    deviceId,
    label: "Android Chrome",
    deviceModelGuess: "Pixel 8",
    modelSource: "ua-client-hints",
    screen: { width: 412, height: 915, devicePixelRatio: 2.625 },
    phoneHeightMm: 150.5,
    lensOffsetCm: 14,
    lensOffsetSource: "profile",
    front35mmEqMm: 26,
    focalLengthPx: 1500,
    focalLengthSource: "spec",
    captureWidth: 1920,
    captureHeight: 1080,
    calibrationScans: 0,
  };
}
