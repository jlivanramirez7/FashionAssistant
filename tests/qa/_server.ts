// QA harness for the v2 server (docs/CONTRACTS-v2.md, team S).
// Starts server createApp(deps) on an ephemeral port with the MEMORY store and a
// FAKE ID-token verifier (never calls Google/GCP), and provides a fetch shim so
// the CLIENT src/data + src/auth modules can be driven against the real routes.
// Discovery is by contract, not by guessed file layout, so a missing piece fails
// with a clear "[S server] ..." message instead of crashing the run.
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_EMAIL, listFiles, loadModule, readText, type Mod } from "./_helpers";

export const CLIENT_ID = "qa-client.apps.googleusercontent.com";
export const OWNER_SUB = "100000000000000000001";

/** Fake GIS ID tokens: "qa:<email>:<sub>:<verified 1|0>". Anything else is invalid. */
export function fakeToken(email: string, sub = OWNER_SUB, verified = true): string {
  return `qa:${email}:${sub}:${verified ? 1 : 0}`;
}

export const verifyCalls: unknown[][] = [];

/** Injectable verifier. Accepts either (idToken) or ({ idToken, audience }). */
export async function fakeVerifyIdToken(...args: unknown[]): Promise<Record<string, unknown>> {
  verifyCalls.push(args);
  const a0 = args[0] as unknown;
  const token = typeof a0 === "string" ? a0 : (a0 as { idToken?: string })?.idToken;
  const m = typeof token === "string" ? /^qa:([^:]+):([^:]+):([01])$/.exec(token) : null;
  if (!m) throw new Error("invalid token (QA fake verifier)");
  const payload = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: m[2], email: m[1], email_verified: m[3] === "1", exp: Math.floor(Date.now() / 1000) + 3600 };
  return payload;
}

/** Minimal dist/ fixture for static-serving checks. */
export function makeDistFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "fa-qa-dist-"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "wasm"));
  mkdirSync(join(dir, "models"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>QA index</title><div id=app></div>");
  writeFileSync(join(dir, "sw.js"), "self.addEventListener('fetch',()=>{}); /* QA sw */");
  writeFileSync(join(dir, "manifest.webmanifest"), JSON.stringify({ name: "QA" }));
  writeFileSync(join(dir, "assets", "index-QA.js"), `console.log(${JSON.stringify("x".repeat(4000))});`);
  writeFileSync(join(dir, "wasm", "qa.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(join(dir, "models", "qa.task"), Buffer.alloc(64, 1));
  writeFileSync(join(dir, "models", "qa.tflite"), Buffer.alloc(64, 2));
  writeFileSync(join(dir, "device-profiles.json"), "[]");
  return dir;
}

/** Find the server file exporting createApp (contract: "Export createApp(deps)"). */
async function findCreateApp(): Promise<{ file: string; createApp: (deps: unknown) => unknown }> {
  const files = listFiles("server", (p) => p.endsWith(".ts") && !p.endsWith("/index.ts"));
  if (!files.length) throw new Error("[S server] MISSING server/*.ts (not built yet)");
  const file = files.find((f) => /export\s+(async\s+)?(function|const)\s+createApp\b/.test(readText(f)));
  if (!file) throw new Error("[S server] no server/*.ts exports createApp(deps) (CONTRACTS-v2 team S)");
  const mod = await loadModule(file.replace(/\.ts$/, ""), "S server");
  if (typeof mod.createApp !== "function") throw new Error(`[S server] ${file} createApp is not a function`);
  return { file, createApp: mod.createApp };
}

/** Find a memory Store factory/class in server/store-memory.ts. */
async function makeMemoryStore(): Promise<unknown> {
  const mod = await loadModule("server/store-memory", "S server").catch((e: Error) => {
    throw e;
  });
  const looksLikeStore = (s: unknown) =>
    !!s && typeof (s as Mod).createScan === "function" && typeof (s as Mod).getSession === "function";
  for (const [name, val] of Object.entries(mod)) {
    if (typeof val !== "function") continue;
    for (const make of [() => (val as () => unknown)(), () => new (val as new () => unknown)()]) {
      try {
        const s = make();
        if (looksLikeStore(s)) return s;
      } catch {
        /* try the next shape */
      }
    }
    void name;
  }
  for (const val of Object.values(mod)) if (looksLikeStore(val)) return val;
  throw new Error("[S server] server/store-memory.ts exports no memory Store (factory, class or instance with createScan/getSession)");
}

/** Build a server config: use server/config.ts's loader if it accepts an env object; else a literal. */
async function makeConfig(distDir: string, allowed: string): Promise<Record<string, unknown>> {
  const env: Record<string, string> = {
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ALLOWED_EMAIL: allowed,
    FIRESTORE_DATABASE_ID: "fashionassitant-db",
    GOOGLE_CLOUD_PROJECT: "fashionassitant",
    DATA_BACKEND: "memory",
    PORT: "0",
    DIST_DIR: distDir,
    COOKIE_SECURE: "false",
    NODE_ENV: "test",
  };
  const literal = {
    googleClientId: CLIENT_ID, allowedEmail: allowed, firestoreDatabaseId: "fashionassitant-db",
    googleCloudProject: "fashionassitant", dataBackend: "memory", port: 0, distDir, cookieSecure: false,
  };
  try {
    const mod = await loadModule("server/config", "S server");
    for (const [name, val] of Object.entries(mod)) {
      if (typeof val !== "function" || !/config/i.test(name)) continue;
      try {
        const c = (val as (e: unknown) => unknown)(env);
        if (c && typeof c === "object" && JSON.stringify(c).includes(distDir)) return { ...literal, ...(c as object) };
      } catch {
        /* not an env loader */
      }
    }
  } catch {
    /* fall back to the literal */
  }
  return literal;
}

export interface Harness {
  base: string;
  server: Server;
  distDir: string;
  config: Record<string, unknown>;
  store: unknown;
  close(): Promise<void>;
}

export async function startServer(allowed = ALLOWED_EMAIL): Promise<Harness> {
  const { createApp } = await findCreateApp();
  const store = await makeMemoryStore();
  const distDir = makeDistFixture();
  const config = await makeConfig(distDir, allowed);
  const deps = { ...config, config, store, verifyIdToken: fakeVerifyIdToken, verify: fakeVerifyIdToken, distDir, now: () => Date.now() };
  let handler = createApp(deps) as unknown;
  if (handler && typeof handler === "object" && "then" in (handler as object)) handler = await (handler as Promise<unknown>);
  if (typeof handler !== "function") throw new Error("[S server] createApp(deps) must return (req, res) => void");
  const server = createServer(handler as Parameters<typeof createServer>[1]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    distDir,
    config,
    store,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------- raw HTTP client

export interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
  text: string;
  json: unknown;
}

export function raw(base: string, method: string, path: string, opts: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["content-length"] = String(Buffer.byteLength(opts.body));
    const req = request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const text = body.toString("utf8");
        let json: unknown = undefined;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
      });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Cookie name=value pairs from Set-Cookie headers (attributes dropped). */
export function cookiesFrom(res: RawResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

export function setCookieLine(res: RawResponse, name: string): string | undefined {
  return ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((l) => l.startsWith(`${name}=`));
}

/** Sign in through the GIS redirect target; returns the fa_session cookie value (or null). */
export async function signInRaw(base: string, token: string, csrf = "qa-csrf-1", cookieCsrf = csrf): Promise<{ res: RawResponse; session: string | null }> {
  const body = new URLSearchParams({ credential: token, g_csrf_token: csrf }).toString();
  const res = await raw(base, "POST", "/api/auth/google", {
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `g_csrf_token=${cookieCsrf}` },
    body,
  });
  const c = cookiesFrom(res);
  return { res, session: c.fa_session && c.fa_session.length > 0 ? c.fa_session : null };
}

// ---------------------------------------------------------------- client fetch shim

export interface ShimRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials?: string;
  body?: string;
}

export interface FetchShim {
  fetch: typeof fetch;
  jar: Record<string, string>;
  log: ShimRecord[];
  offline: boolean;
}

function headersToObject(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && !(Array.isArray(h))) {
    (h as Headers).forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h as [string, string][]) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

/** fetch() replacement that sends same-origin "/api/..." requests to the harness server. */
export function makeFetchShim(base: string, jar: Record<string, string> = {}): FetchShim {
  const shim: FetchShim = { jar, log: [], offline: false, fetch: undefined as unknown as typeof fetch };
  shim.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (shim.offline) throw new TypeError("Failed to fetch");
    const u = new URL(url, "https://app.example");
    if (u.origin !== "https://app.example" && !url.startsWith("/")) {
      throw new Error(`QA fetch shim: client fetched a non-same-origin URL ${url}`);
    }
    const headers = headersToObject(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    let body: string | undefined;
    if (typeof init.body === "string") body = init.body;
    else if (init.body != null) body = String(init.body);
    shim.log.push({ method, path: u.pathname + u.search, headers, credentials: init.credentials, body });
    const cookie = Object.entries(shim.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.cookie = cookie;
    if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await raw(base, method, u.pathname + u.search, { headers, body });
    for (const line of ([] as string[]).concat(res.headers["set-cookie"] ?? [])) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (!v || expired) delete shim.jar[k];
      else shim.jar[k] = v;
    }
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined || k === "set-cookie") continue;
      outHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    }
    const noBody = res.status === 204 || res.status === 304;
    return new Response(noBody ? null : new Uint8Array(res.body), { status: res.status, headers: outHeaders });
  }) as typeof fetch;
  return shim;
}

/** CONTRACTS-v2 route table: [method, path regex]. */
export const ROUTES: [string, RegExp][] = [
  ["GET", /^\/api\/health$/],
  ["POST", /^\/api\/auth\/google$/],
  ["GET", /^\/api\/me$/],
  ["POST", /^\/api\/logout$/],
  ["GET", /^\/api\/user$/],
  ["PATCH", /^\/api\/user$/],
  ["GET", /^\/api\/scans$/],
  ["POST", /^\/api\/scans$/],
  ["GET", /^\/api\/scans\/[A-Za-z0-9_-]{1,64}$/],
  ["PATCH", /^\/api\/scans\/[A-Za-z0-9_-]{1,64}$/],
  ["DELETE", /^\/api\/scans\/[A-Za-z0-9_-]{1,64}$/],
  ["GET", /^\/api\/devices\/[A-Za-z0-9_-]{1,64}$/],
  ["PUT", /^\/api\/devices\/[A-Za-z0-9_-]{1,64}$/],
  ["GET", /^\/api\/settings\/correctionFactors$/],
  ["PUT", /^\/api\/settings\/correctionFactors$/],
  ["DELETE", /^\/api\/me\/data$/],
];

export function isContractRoute(method: string, path: string): boolean {
  const p = path.split("?")[0];
  return ROUTES.some(([m, re]) => m === method && re.test(p));
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
