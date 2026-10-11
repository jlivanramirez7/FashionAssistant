// Static file serving for dist/ (CONTRACTS-v2 "Static serving"): MIME
// types, cache headers, gzip for text, ETag/304, SPA fallback and a
// path-traversal-proof resolver.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".tflite": "application/octet-stream",
  ".binarypb": "application/octet-stream",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".webmanifest", ".txt", ".svg"]);
const NO_CACHE_FILES = new Set(["index.html", "sw.js", "registerSW.js", "manifest.webmanifest"]);
const MAX_GZIP_SOURCE = 5 * 1024 * 1024;

export function contentTypeFor(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Cache-Control for a request path relative to dist ("assets/x.js"). */
export function cacheControlFor(rel: string): string {
  const posix = rel.split(path.sep).join("/");
  if (NO_CACHE_FILES.has(posix)) return "no-cache";
  if (posix.startsWith("assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

/**
 * Map a raw URL pathname to a path relative to `root`, or null when it is
 * unsafe: bad percent-encoding, NUL, backslashes, "." / ".." segments
 * (literal or encoded) or anything resolving outside root.
 */
export function resolveSafePath(root: string, rawPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (!decoded.startsWith("/")) return null;
  const segments = decoded.split("/").slice(1);
  for (const seg of segments) {
    if (seg === "." || seg === "..") return null;
    if (seg.includes(":")) return null; // Windows drive / ADS tricks
  }
  const rootAbs = path.resolve(root);
  const full = path.resolve(rootAbs, "." + decoded);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
  return path.relative(rootAbs, full);
}

/** SPA fallback applies when the last segment has no file extension. */
export function isSpaRoute(rawPathname: string): boolean {
  const last = rawPathname.split("/").pop() ?? "";
  return !last.includes(".");
}

function acceptsGzip(req: IncomingMessage): boolean {
  const ae = String(req.headers["accept-encoding"] ?? "");
  return /\bgzip\b/i.test(ae) && !/\bgzip\s*;\s*q=0(\.0*)?\b/i.test(ae);
}

interface GzipEntry {
  key: string;
  data: Buffer;
}

export interface StaticServer {
  /** Serves the request (GET/HEAD). Returns false when nothing matched (caller sends 404). */
  serve(req: IncomingMessage, res: ServerResponse, rawPathname: string): Promise<boolean>;
}

export function createStaticServer(distDir: string): StaticServer {
  const root = path.resolve(distDir);
  const gzipCache = new Map<string, GzipEntry>();

  async function fileStat(rel: string) {
    try {
      const st = await stat(path.join(root, rel));
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  }

  async function sendFile(req: IncomingMessage, res: ServerResponse, rel: string, size: number, mtimeMs: number): Promise<void> {
    const file = path.join(root, rel);
    const ext = path.extname(rel).toLowerCase();
    const etag = `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
    res.setHeader("Content-Type", contentTypeFor(rel));
    res.setHeader("Cache-Control", cacheControlFor(rel));
    res.setHeader("ETag", etag);
    const compressible = COMPRESSIBLE.has(ext);
    if (compressible) res.setHeader("Vary", "Accept-Encoding");

    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }

    if (compressible && size <= MAX_GZIP_SOURCE && acceptsGzip(req)) {
      const key = `${size}-${mtimeMs}`;
      let entry = gzipCache.get(rel);
      if (!entry || entry.key !== key) {
        entry = { key, data: gzipSync(await readFile(file)) };
        gzipCache.set(rel, entry);
      }
      res.statusCode = 200;
      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Content-Length", entry.data.length);
      res.end(req.method === "HEAD" ? undefined : entry.data);
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Length", size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(file);
      stream.on("error", () => {
        res.destroy();
        resolve();
      });
      stream.on("end", resolve);
      stream.pipe(res);
    });
  }

  return {
    async serve(req, res, rawPathname) {
      const rel = resolveSafePath(root, rawPathname);
      if (rel === null) return false;
      const target = rel === "" || rawPathname.endsWith("/") ? path.join(rel, "index.html") : rel;
      const st = await fileStat(target);
      if (st) {
        await sendFile(req, res, target, st.size, st.mtimeMs);
        return true;
      }
      if (isSpaRoute(rawPathname)) {
        const index = await fileStat("index.html");
        if (index) {
          await sendFile(req, res, "index.html", index.size, index.mtimeMs);
          return true;
        }
      }
      return false;
    },
  };
}
