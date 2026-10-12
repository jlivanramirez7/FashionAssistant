// QA: deployment / config files for v2 (docs/CONTRACTS-v2.md: no Firebase;
// Node 24 server on Cloud Run is the only Firestore client).
import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { ALLOWED_EMAIL, DB_ID, PROJECT_ID, exists, listFiles, readText, repoPath, stripComments } from "./_helpers";

const ENV_KEYS = ["VITE_GOOGLE_CLIENT_ID", "VITE_ALLOWED_EMAIL", "FIRESTORE_DATABASE_ID", "GOOGLE_CLOUD_PROJECT"];

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

describe("Firebase is gone (CONTRACTS-v2)", () => {
  it("[orchestrator] firebase.json, .firebaserc, firestore.indexes.json, nginx.conf are deleted", () => {
    const present = ["firebase.json", ".firebaserc", "firestore.indexes.json", "nginx.conf"].filter(exists);
    expect(present, `[orchestrator] delete: ${present.join(", ")}`).toEqual([]);
  });
  it("[orchestrator] package.json: no firebase deps; runtime deps are exactly the v2 set", () => {
    const pkg = JSON.parse(readText("package.json"));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((k) => /firebase/i.test(k))).toEqual([]);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@google-cloud/firestore", "@mediapipe/tasks-vision", "fflate", "google-auth-library"]);
    expect(exists("node_modules/firebase"), "firebase still installed in node_modules").toBe(false);
  });
  it("[A2/E2/S] no 'firebase' in src/ or server/ code (comments excluded)", () => {
    const files = [...listFiles("src", (p) => p.endsWith(".ts")), ...listFiles("server", (p) => p.endsWith(".ts"))];
    const hits = files.filter((p) => /firebase/i.test(stripComments(readText(p))));
    expect(hits, `still referencing firebase:\n${hits.join("\n")}`).toEqual([]);
  });
  it("[A2 client-data] Firebase-only client files are deleted", () => {
    const present = ["src/auth/firebase.ts", "src/data/sdk.ts", "src/data/write.ts"].filter(exists);
    expect(present, `[A2 client-data] delete: ${present.join(", ")}`).toEqual([]);
  });
});

describe("firestore.rules: deny-all (the server uses IAM and bypasses rules)", () => {
  const code = readText("firestore.rules").replace(/\/\/.*$/gm, "");
  it("rules_version 2, a single catch-all deny", () => {
    expect(code).toMatch(/rules_version\s*=\s*['"]2['"]\s*;/);
    expect(code).toMatch(/match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
    expect((code.match(/\ballow\b/g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/if\s+true|request\.auth/);
  });
});

describe("Dockerfile (v2: Node 24 build + runtime, no nginx)", () => {
  const d = readText("Dockerfile");
  const stages = d.split(/^FROM\s+/m).slice(1);
  it("two node:24 stages, no nginx", () => {
    expect(stages.length).toBe(2);
    for (const s of stages) expect(s).toMatch(/^node:24[\w.-]*/);
    expect(d.toLowerCase()).not.toContain("nginx");
  });
  it("build stage: scripts before npm ci, npm run build, asset verify, prune dev deps", () => {
    const b = stages[0];
    expect(b.indexOf("COPY scripts")).toBeGreaterThan(-1);
    expect(b.indexOf("COPY scripts")).toBeLessThan(b.indexOf("npm ci"));
    expect(b).toMatch(/RUN\s+npm\s+run\s+build/);
    for (const f of ["pose_landmarker_lite.task", "pose_landmarker_heavy.task", "selfie_multiclass_256x256.tflite"]) {
      expect(b, `asset verify must check dist/models/${f}`).toContain(`test -s dist/models/${f}`);
    }
    expect(b).toContain("dist/wasm/*.wasm");
    expect(b.indexOf("dist/models")).toBeGreaterThan(b.indexOf("npm run build"));
    expect(b).toMatch(/npm\s+prune\s+--omit=dev/);
  });
  it("runtime stage: NODE_ENV=production, PORT 8080, non-root, copies dist/server/types/.env.production, CMD node server/index.ts", () => {
    const r = stages[1];
    expect(r).toMatch(/ENV\s+NODE_ENV=production/);
    expect(r).toMatch(/ENV\s+PORT=8080/);
    expect(r).toMatch(/EXPOSE\s+8080/);
    expect(r).toMatch(/USER\s+node/);
    for (const p of ["/app/dist", "/app/server", "/app/src/types.ts", "/app/.env.production", "/app/node_modules", "/app/package.json"]) {
      expect(r, `runtime must COPY --from=build ${p}`).toContain(`COPY --from=build ${p} `);
    }
    expect(r).toMatch(/CMD\s+\[\s*"node"\s*,\s*"server\/index\.ts"\s*\]/);
  });
  it(".dockerignore keeps server, env file, scripts and src in the build context", () => {
    const ig = readText(".dockerignore").split(/\r?\n/).map((l) => l.trim());
    for (const p of ["server", ".env.production", "scripts", "src"]) expect(ig, `.dockerignore must not exclude ${p}`).not.toContain(p);
    for (const p of ["node_modules", "dist", ".git", "fixtures"]) expect(ig).toContain(p);
  });
});

describe(".env files (v2)", () => {
  for (const f of [".env.example", ".env.development", ".env.production"]) {
    it(`${f}: client id, allowed email, server-only db id + project; no Firebase keys`, () => {
      const text = readText(f);
      const env = parseEnv(text);
      for (const k of ENV_KEYS) expect(env, `${f} missing ${k}`).toHaveProperty(k);
      expect(env.VITE_ALLOWED_EMAIL).toBe(ALLOWED_EMAIL);
      expect(env.FIRESTORE_DATABASE_ID).toBe(DB_ID);
      expect(env.GOOGLE_CLOUD_PROJECT).toBe(PROJECT_ID);
      expect(Object.keys(env).filter((k) => /FIREBASE/.test(k)), `${f} has Firebase keys`).toEqual([]);
      expect(env.VITE_FIRESTORE_DATABASE_ID, "db id must stay server-only (no VITE_ prefix)").toBeUndefined();
      expect(text).not.toMatch(/PRIVATE|SECRET|PASSWORD|BEGIN [A-Z ]*KEY|client_secret/i);
      if (env.VITE_GOOGLE_CLIENT_ID) expect(env.VITE_GOOGLE_CLIENT_ID).toMatch(/^[\w-]+\.apps\.googleusercontent\.com$/);
    });
  }
  it(".env.development selects the memory backend; production does not", () => {
    expect(parseEnv(readText(".env.development")).DATA_BACKEND).toBe("memory");
    expect(parseEnv(readText(".env.production")).DATA_BACKEND ?? "firestore").toBe("firestore");
  });
});

describe(".gitignore", () => {
  it("covers node_modules, dist, generated assets, fixtures, certs", () => {
    const g = readText(".gitignore");
    for (const p of ["node_modules", "dist", "public/models", "public/wasm", ".env.local", "fixtures"]) expect(g, `.gitignore missing ${p}`).toContain(p);
  });
});

describe("package.json scripts + tsconfigs (v2)", () => {
  const pkg = JSON.parse(readText("package.json"));
  it("typecheck runs both tsconfigs; build typechecks first; start runs the server", () => {
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit && tsc --noEmit -p tsconfig.server.json");
    expect(pkg.scripts.build).toBe("npm run typecheck && vite build");
    expect(pkg.scripts.start).toBe("node server/index.ts");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.postinstall).toBe("node scripts/setup-assets.mjs");
    expect(pkg.scripts["deploy:rules"], "firebase CLI is gone").toBeUndefined();
    expect(pkg.scripts.deploy).toContain("gcloud run deploy fashion-assistant --source . --region us-central1 --allow-unauthenticated --max-instances 2");
  });
  it("tsconfig.server.json: Node type-stripping rules (erasable syntax, .ts imports)", () => {
    const j = JSON.parse(readText("tsconfig.server.json"));
    const c = j.compilerOptions;
    expect(c.strict).toBe(true);
    expect(c.erasableSyntaxOnly).toBe(true);
    expect(c.allowImportingTsExtensions).toBe(true);
    expect(c.verbatimModuleSyntax).toBe(true);
    expect(c.module).toBe("NodeNext");
    expect(j.include).toEqual(expect.arrayContaining(["server", "tests/server", "src/types.ts"]));
  });
  it("tsconfig.json (client) is strict", () => {
    expect(JSON.parse(readText("tsconfig.json")).compilerOptions.strict).toBe(true);
  });
});

describe("vite.config.ts (v2)", () => {
  const v = stripComments(readText("vite.config.ts"));
  it("service worker never answers /api/ navigations", () => {
    expect(v).toMatch(/navigateFallbackDenylist\s*:\s*\[\s*\/\^\\\/api\\\/\/\s*\]/);
  });
  it("dev server proxies /api to the local Node server on 8080", () => {
    expect(v).toMatch(/proxy\s*:\s*\{\s*["']\/api["']\s*:\s*["']http:\/\/localhost:8080["']/);
  });
  it("build input is index.html only (replay.html never in dist)", () => {
    expect(v).toMatch(/input\s*:\s*["']index\.html["']/);
    expect(v).not.toMatch(/replay/);
  });
  it("PWA manifest: updates applied on a safe screen, standalone, portrait, maskable icon", () => {
    // "prompt" + src/main.ts registerSW: a new version reloads the page only on
    // boot / sign-in / Home, never in the middle of a scan (2026-10-12).
    expect(v).toMatch(/registerType\s*:\s*["']prompt["']/);
    const main = readText("src/main.ts");
    expect(main).toMatch(/virtual:pwa-register/);
    expect(main).toMatch(/UPDATE_SAFE[^\n]*\["boot", "signin", "home"\]/);
    expect(v).toMatch(/display\s*:\s*["']standalone["']/);
    expect(v).toMatch(/orientation\s*:\s*["']portrait["']/);
    expect(v).toMatch(/icon-512-maskable\.png[^}]*purpose\s*:\s*["']maskable["']/);
  });
  it("precache excludes dev chunks and wasm; models/wasm runtime CacheFirst", () => {
    expect(v).toMatch(/globIgnores\s*:\s*\[[^\]]*debugCapture[^\]]*\]/);
    expect(v).toMatch(/globIgnores\s*:\s*\[[^\]]*wasm[^\]]*\]/);
    expect(v).toMatch(/handler\s*:\s*["']CacheFirst["']/);
    const globs = v.match(/globPatterns\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(globs).not.toMatch(/task|tflite|wasm/);
  });
});

describe("html entries", () => {
  it("index.html loads src/main.ts; replay.html loads src/dev/replay.ts", () => {
    expect(readText("index.html")).toContain('src="/src/main.ts"');
    expect(readText("replay.html")).toContain('src="/src/dev/replay.ts"');
    expect(readText("index.html")).not.toMatch(/replay|debug|firebase/i);
  });
});

// PNG width/height from the IHDR chunk + sanity check that the IDAT inflates.
function pngInfo(rel: string): { w: number; h: number } {
  const b = readFileSync(repoPath(rel));
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((x, i) => {
    if (b[i] !== x) throw new Error(`${rel} is not a PNG`);
  });
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  let off = 8;
  const idat: Buffer[] = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  inflateSync(Buffer.concat(idat));
  return { w, h };
}

describe("[E ui-flow] PWA icons (public/icons)", () => {
  for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["icon-512-maskable.png", 512]] as const) {
    it(`${name} is a valid ${size}x${size} PNG`, () => {
      const rel = `public/icons/${name}`;
      if (!exists(rel)) throw new Error(`[E ui-flow] MISSING FILE ${rel}`);
      expect(pngInfo(rel)).toEqual({ w: size, h: size });
    });
  }
});

describe("[B device-capture] public/device-profiles.json", () => {
  it("is a plain DeviceSpec[] with plausible values", () => {
    const rel = "public/device-profiles.json";
    if (!exists(rel)) throw new Error(`[B device-capture] MISSING FILE ${rel}`);
    const specs = JSON.parse(readText(rel));
    expect(Array.isArray(specs), "must be a plain array").toBe(true);
    expect(specs.length).toBeGreaterThan(0);
    const models = new Set<string>();
    for (const s of specs) {
      const where = `entry ${JSON.stringify(s.model)}`;
      expect(typeof s.model, where).toBe("string");
      expect(models.has(s.model), `${where} duplicated`).toBe(false);
      models.add(s.model);
      expect(!!(s.uaModels?.length || s.screenMatch), `${where} needs uaModels or screenMatch`).toBe(true);
      expect(s.phoneHeightMm, where).toBeGreaterThan(120);
      expect(s.phoneHeightMm, where).toBeLessThan(185);
      expect(s.frontLensFromTopMm, where).toBeGreaterThan(2);
      expect(s.frontLensFromTopMm, where).toBeLessThan(25);
      const lensCm = (s.phoneHeightMm - s.frontLensFromTopMm) / 10;
      expect(lensCm, `${where} L_lens`).toBeGreaterThan(11);
      expect(lensCm, `${where} L_lens`).toBeLessThan(18);
      expect(s.front35mmEqMm, where).toBeGreaterThanOrEqual(15); // ultra-wide fronts exist (Pixel 9 Pro ~17)
      expect(s.front35mmEqMm, where).toBeLessThanOrEqual(35);
      if (s.screenMatch) {
        expect(s.screenMatch.width).toBeLessThan(s.screenMatch.height);
        expect([2, 3]).toContain(s.screenMatch.dpr);
      }
    }
    const ua = specs.flatMap((s: { uaModels?: string[] }) => s.uaModels ?? []);
    expect(new Set(ua).size).toBe(ua.length);
    expect(specs.some((s: { screenMatch?: unknown }) => !!s.screenMatch)).toBe(true);
    expect(specs.some((s: { uaModels?: string[] }) => !!s.uaModels?.length)).toBe(true);
  });
});
