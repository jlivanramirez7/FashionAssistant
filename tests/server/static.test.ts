import { gunzipSync } from "node:zlib";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheControlFor, contentTypeFor, isSpaRoute, resolveSafePath } from "../../server/static.ts";
import { startHarness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

describe("static files over HTTP", () => {
  it("serves index.html at / with no-cache and security headers", async () => {
    const res = await h.request("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.text).toContain("Fashion Assistant");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toMatch(/script-src[^;]*https:\/\/accounts\.google\.com/);
    expect(csp).toMatch(/frame-src[^;]*https:\/\/accounts\.google\.com/);
    expect(csp).toMatch(/connect-src[^;]*https:\/\/accounts\.google\.com/);
    expect(csp).toMatch(/img-src[^;]*blob:[^;]*data:/);
    expect(res.headers["cross-origin-opener-policy"]).toBeUndefined();
  });

  it("sw.js is no-cache; /assets are immutable", async () => {
    const sw = await h.request("/sw.js");
    expect(sw.headers["cache-control"]).toBe("no-cache");
    expect(sw.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const js = await h.request("/assets/index-abc123.js");
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const css = await h.request("/assets/index-abc123.css");
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
  });

  it("MIME types for wasm, models and manifest", async () => {
    const wasm = await h.request("/wasm/vision_wasm_internal.wasm");
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    expect(wasm.body.subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
    const model = await h.request("/models/pose_landmarker_lite.task", { method: "HEAD" });
    expect(model.status).toBe(200);
    expect(model.headers["content-type"]).toBe("application/octet-stream");
    expect(model.headers["content-length"]).toBe("4096");
    expect(model.body.length).toBe(0);
    const mf = await h.request("/manifest.webmanifest");
    expect(mf.headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
  });

  it("gzips text when accepted, never binaries", async () => {
    const js = await h.request("/assets/index-abc123.js", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(js.headers["content-encoding"]).toBe("gzip");
    expect(js.headers.vary).toBe("Accept-Encoding");
    expect(gunzipSync(js.body).toString()).toContain("console.log('app');");
    const plain = await h.request("/assets/index-abc123.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const model = await h.request("/models/pose_landmarker_lite.task", { headers: { "Accept-Encoding": "gzip" } });
    expect(model.headers["content-encoding"]).toBeUndefined();
    expect(model.body.length).toBe(4096);
  });

  it("ETag revalidation => 304", async () => {
    const first = await h.request("/sw.js");
    const etag = String(first.headers.etag);
    const again = await h.request("/sw.js", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("SPA fallback for extension-less GETs, 404 for missing files", async () => {
    const res = await h.request("/history/abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Fashion Assistant");
    expect((await h.request("/missing.js")).status).toBe(404);
    expect((await h.request("/assets/nope.css")).status).toBe(404);
  });

  it("non-GET to static paths => 405", async () => {
    expect((await h.request("/", { method: "POST" })).status).toBe(405);
  });

  it("path traversal attempts never leak files outside dist", async () => {
    const attempts = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/%2e%2e/secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%2fsecret.txt",
      "/..%5csecret.txt",
      "/assets\\..\\..\\secret.txt",
      "/%5c..%5c..%5csecret.txt",
      "/assets/%00../secret.txt",
      "/%c0%ae%c0%ae/secret.txt",
      "//secret.txt",
    ];
    for (const p of attempts) {
      const res = await h.request(p);
      expect(res.text, p).not.toContain("TOP-SECRET");
      expect([400, 404], p).toContain(res.status);
    }
  });
});

describe("pure helpers", () => {
  const root = path.resolve("/srv/dist");
  it("resolveSafePath", () => {
    expect(resolveSafePath(root, "/")).toBe("");
    expect(resolveSafePath(root, "/assets/a.js")).toBe(path.join("assets", "a.js"));
    expect(resolveSafePath(root, "/a%20b.png")).toBe("a b.png");
    expect(resolveSafePath(root, "/../x")).toBeNull();
    expect(resolveSafePath(root, "/%2e%2e/x")).toBeNull();
    expect(resolveSafePath(root, "/a/./b")).toBeNull();
    expect(resolveSafePath(root, "/a\\b")).toBeNull();
    expect(resolveSafePath(root, "/%5c")).toBeNull();
    expect(resolveSafePath(root, "/%00")).toBeNull();
    expect(resolveSafePath(root, "/%E0%A4%A")).toBeNull();
    expect(resolveSafePath(root, "/C:/Windows")).toBeNull();
  });

  it("isSpaRoute / contentTypeFor / cacheControlFor", () => {
    expect(isSpaRoute("/")).toBe(true);
    expect(isSpaRoute("/history")).toBe(true);
    expect(isSpaRoute("/x.js")).toBe(false);
    expect(contentTypeFor("a.tflite")).toBe("application/octet-stream");
    expect(contentTypeFor("a.wasm")).toBe("application/wasm");
    expect(contentTypeFor("a.unknownext")).toBe("application/octet-stream");
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor(path.join("assets", "x.js"))).toContain("immutable");
    expect(cacheControlFor(path.join("models", "m.task"))).toBe("public, max-age=3600");
  });
});
