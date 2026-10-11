// Small HTTP helpers: errors, body reading, JSON responses, cookies,
// security headers and a tiny path router.
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_JSON_BODY = 1024 * 1024; // 1 MB (CONTRACTS-v2)

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Content-Security-Policy for the app.
 * - 'self' covers the Vite bundle, the service worker, /models and /wasm.
 * - 'wasm-unsafe-eval' lets MediaPipe compile its WebAssembly.
 * - https://accounts.google.com: Google Identity Services script, its
 *   button iframe and its fetches (gsi/client, gsi/button, gsi/style).
 * - blob:/data: images for canvas snapshots and inline icons.
 * - form-action allows the GIS redirect flow to post back to us.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' blob: data: https://*.googleusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "worker-src 'self' blob:",
  "media-src 'self' blob: mediastream:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Headers set on every response.
 * NOTE: deliberately NO `Cross-Origin-Opener-Policy: same-origin`. Google
 * Identity Services opens/redirects through accounts.google.com and needs
 * a window relationship with the opener (popup / One Tap / FedCM fallback);
 * COOP same-origin severs it and breaks sign-in. (Google documents
 * `same-origin-allow-popups` as the strictest value that still works; we
 * leave the browser default.)
 */
export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Frame-Options", "DENY");
}

/** Read the raw body, enforcing `limit` bytes (413 when exceeded). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, "too_large", `Body exceeds ${limit} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, "too_large", `Body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Read and parse a JSON body (400 on bad JSON / empty, 413 on oversize). */
export async function readJson(req: IncomingMessage, limit = MAX_JSON_BODY): Promise<unknown> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) throw new HttpError(400, "bad_request", "Empty body");
  try {
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "bad_request", "Body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: code, message });
}

export function redirect(res: ServerResponse, location: string, status = 303): void {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", 0);
  res.end();
}

// ---------------------------------------------------------------- cookies

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!name || name in out) continue; // first occurrence wins
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSec)}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader("Set-Cookie");
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  list.push(cookie);
  res.setHeader("Set-Cookie", list);
}

// ---------------------------------------------------------------- routing

export type Params = Record<string, string>;

/**
 * Match "/api/scans/:id" against a pathname. Params are taken raw (still
 * percent-encoded), so an encoded id simply fails the id regex later.
 */
export function matchPath(pattern: string, pathname: string): Params | null {
  const p = pattern.split("/");
  const s = pathname.split("/");
  if (p.length !== s.length) return null;
  const params: Params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      if (!s[i]) return null;
      params[p[i].slice(1)] = s[i];
    } else if (p[i] !== s[i]) {
      return null;
    }
  }
  return params;
}

/** Split req.url into a raw pathname and query (no decoding, no normalising). */
export function splitUrl(url: string | undefined): { pathname: string; query: string } {
  const u = url ?? "/";
  const q = u.indexOf("?");
  const pathname = q >= 0 ? u.slice(0, q) : u;
  return { pathname: pathname.startsWith("/") ? pathname : "/" + pathname, query: q >= 0 ? u.slice(q + 1) : "" };
}
