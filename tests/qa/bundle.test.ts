// QA: production bundle checks. Run AFTER `npm run build`; skipped when dist/
// is missing. Rules (orchestrator, phase 1):
//  - replay.html / replay code never in dist
//  - src/dev/debugCapture.ts + fflate allowed ONLY in a lazily loaded chunk,
//    never in the entry chunk index.html loads or anything it imports statically
//  - sw.js denies /__/ navigations; MediaPipe models are not precached
//  - the named database id and allowed email are baked in
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_EMAIL, DB_ID, listFiles, repoPath } from "./_helpers";

const DIST = repoPath("dist");
const HAS_DIST = existsSync(join(DIST, "index.html"));
if (!HAS_DIST) console.warn("[QA bundle] dist/ missing - run `npm run build` first; bundle checks skipped.");

const read = (rel: string) => readFileSync(repoPath(rel), "utf8");

/** Strings that only exist in fflate / F's debug + replay code. */
const FFLATE = ["invalid zip data", "date not in range 1980-2099", "invalid block type"];
const DEBUG = ["Not a debug capture zip", "Frame missing from zip", "Unsupported debug manifest version"];
const REPLAY = ["Replay (dev only)", "Pick a debug-capture .zip", "Running pipeline..."];

function jsFiles(): string[] {
  return listFiles("dist", (p) => p.endsWith(".js") || p.endsWith(".mjs"));
}

/** Entry chunk(s) referenced by dist/index.html. */
function entryChunks(): string[] {
  const html = read("dist/index.html");
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="\/?([^"]+)"/g)) out.add(`dist/${m[1]}`);
  for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/?([^"]+)"/g)) out.add(`dist/${m[1]}`);
  return [...out];
}

/** Entry chunks + everything reachable through STATIC imports (dynamic import() excluded). */
function staticGraph(): string[] {
  const seen = new Set<string>();
  const queue = entryChunks();
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !existsSync(repoPath(f))) continue;
    seen.add(f);
    const src = read(f);
    const dir = f.slice(0, f.lastIndexOf("/"));
    // import{..}from"./x.js"  |  import"./x.js"  |  export{..}from"./x.js"  (not import("./x.js"))
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const parts = `${dir}/${m[1]}`.split("/");
      const norm: string[] = [];
      for (const p of parts) {
        if (p === "..") norm.pop();
        else if (p !== ".") norm.push(p);
      }
      queue.push(norm.join("/"));
    }
  }
  return [...seen];
}

describe.skipIf(!HAS_DIST)("production bundle (dist/)", () => {
  it("dist has index.html, sw.js, manifest; no replay.html or replay/debug file names", () => {
    expect(existsSync(join(DIST, "sw.js")), "sw.js").toBe(true);
    expect(listFiles("dist", (p) => p.endsWith(".webmanifest")).length, "web manifest").toBeGreaterThan(0);
    expect(existsSync(join(DIST, "replay.html")), "dist/replay.html must not exist").toBe(false);
    const bad = listFiles("dist", (p) => /replay/i.test(basename(p)));
    expect(bad, "files named *replay*").toEqual([]);
  });

  it("no replay code anywhere in dist JS", () => {
    const hits = jsFiles().flatMap((f) => REPLAY.filter((s) => read(f).includes(s)).map((s) => `${f}: "${s}"`));
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("entry chunk (and its static imports) contain no debugCapture / fflate code", () => {
    const graph = staticGraph();
    expect(graph.length, "could not find the entry chunk in dist/index.html").toBeGreaterThan(0);
    const hits = graph.flatMap((f) => [...FFLATE, ...DEBUG].filter((s) => read(f).includes(s)).map((s) => `${f}: "${s}"`));
    expect(hits, `dev-only code reached the entry chunk:\n${hits.join("\n")}`).toEqual([]);
  });

  it("if debugCapture/fflate is in dist at all, it is only in lazily loaded chunks", () => {
    const graph = new Set(staticGraph());
    const lazy = jsFiles().filter((f) => [...FFLATE, ...DEBUG].some((s) => read(f).includes(s)));
    for (const f of lazy) expect(graph.has(f), `${f} is statically reachable from index.html`).toBe(false);
    if (lazy.length) console.info(`[QA bundle] lazy dev chunk(s): ${lazy.join(", ")}`);
  });

  it("sw.js: navigateFallbackDenylist /^\\/__\\// present; no models/ precached", () => {
    const sw = read("dist/sw.js");
    expect(sw, "sw.js must deny /__/ navigations").toMatch(/denylist\s*:\s*\[\s*\/\^\\\/__\\\/\//);
    expect(sw).not.toMatch(/["']models\/[^"']+\.(task|tflite)["']/);
    expect(sw).not.toMatch(/url\s*:\s*["']replay\.html["']/);
    if (/url\s*:\s*["']wasm\//.test(sw)) console.warn("[QA bundle] note: wasm/*.js is precached by globPatterns (also runtime-cached)");
  });

  it("named database id and allowed email are baked into the app", () => {
    const all = jsFiles().map(read).join("\n");
    expect(all, `"${DB_ID}" not in bundle (named database not used?)`).toContain(DB_ID);
    expect(all.toLowerCase(), "allowed email not in bundle (.env.production)").toContain(ALLOWED_EMAIL);
    expect(all, "emulator wiring must not ship").not.toMatch(/connectFirestoreEmulator\s*\(|localhost:8081/);
  });

  it("MediaPipe models + wasm ship in dist (setup-assets only warns on download failure)", () => {
    const need: [string, number][] = [
      ["dist/models/pose_landmarker_lite.task", 1e6],
      ["dist/models/pose_landmarker_heavy.task", 1e6],
      ["dist/models/selfie_multiclass_256x256.tflite", 1e6],
      ["dist/wasm/vision_wasm_internal.wasm", 1e6],
      ["dist/wasm/vision_wasm_internal.js", 1e4],
    ];
    const bad = need.filter(([p, min]) => !existsSync(repoPath(p)) || statSync(repoPath(p)).size < min).map(([p]) => p);
    expect(bad, `missing/truncated (models must be served in production): ${bad.join(", ")}`).toEqual([]);
  });

  it("service worker precache: report dev-only chunks and wasm loaders (warning only)", () => {
    const sw = read("dist/sw.js");
    const urls = [...sw.matchAll(/url\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    const dev = urls.filter((u) => /debugCapture|\/debug-/.test(u));
    const wasm = urls.filter((u) => u.startsWith("wasm/"));
    if (dev.length) console.warn(`[QA bundle] dev-only chunks precached for every user: ${dev.join(", ")}`);
    if (wasm.length) console.warn(`[QA bundle] wasm loaders precached: ${wasm.join(", ")}`);
    expect(urls).toContain("index.html");
  });

  it("entry JS stays reasonably small (MediaPipe should be lazy-loaded)", () => {
    const size = staticGraph().reduce((n, f) => n + statSync(repoPath(f)).size, 0);
    console.info(`[QA bundle] entry static graph: ${(size / 1024).toFixed(0)} KiB`);
    expect(size, "entry static graph > 1.5 MiB").toBeLessThan(1.5 * 1024 * 1024);
  });
});
