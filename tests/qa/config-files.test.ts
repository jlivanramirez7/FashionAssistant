// QA: deployment / config files (design doc sections 9-12).
import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import {
  ALLOWED_EMAIL, DB_ID, FIREBASEAPP_HOST, PROJECT_ID, exists, readText, repoPath, stripComments,
} from "./_helpers";

const ENV_KEYS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIRESTORE_DATABASE_ID",
  "VITE_ALLOWED_EMAIL",
];

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

describe("firestore.rules (section 11)", () => {
  const rules = readText("firestore.rules");
  const code = rules.replace(/\/\/.*$/gm, "");

  it("uses rules_version 2", () => {
    expect(code).toMatch(/rules_version\s*=\s*['"]2['"]\s*;/);
  });
  it("allowlists exactly the owner email, verified, Google provider", () => {
    expect(code).toContain(`request.auth.token.email == '${ALLOWED_EMAIL}'`);
    expect(code).toMatch(/request\.auth\.token\.email_verified\s*==\s*true/);
    expect(code).toMatch(/request\.auth\.token\.firebase\.sign_in_provider\s*==\s*'google\.com'/);
    expect(code).toMatch(/request\.auth\s*!=\s*null/);
    const emails = code.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(new Set(emails)).toEqual(new Set([ALLOWED_EMAIL]));
  });
  it("one subtree rule users/{uid}/{document=**} gated on uid and isAllowedUser", () => {
    expect(code).toMatch(/match\s+\/users\/\{uid\}\/\{document=\*\*\}/);
    expect(code).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+isAllowedUser\(\)\s*&&\s*request\.auth\.uid\s*==\s*uid\s*;/);
    const allows = code.match(/\ballow\b/g) ?? [];
    expect(allows.length).toBe(1);
  });
  it("has no open rules", () => {
    expect(code).not.toMatch(/if\s+true/);
    expect(code).not.toMatch(/allow\s+[\w\s,]+;\s*$/m); // allow without condition
    expect(code).not.toMatch(/request\.time\s*</); // test-mode expiry rule
  });
});

describe("firebase.json / .firebaserc / indexes", () => {
  it("firebase.json targets the named database and rules file", () => {
    const j = JSON.parse(readText("firebase.json"));
    expect(j.firestore.database).toBe(DB_ID);
    expect(j.firestore.rules).toBe("firestore.rules");
    expect(j.firestore.indexes).toBe("firestore.indexes.json");
    expect(j.emulators.auth.port).toBe(9099);
    expect(j.emulators.firestore.port).toBe(8081);
  });
  it(".firebaserc default project", () => {
    expect(JSON.parse(readText(".firebaserc")).projects.default).toBe(PROJECT_ID);
  });
  it("firestore.indexes.json is valid JSON", () => {
    expect(() => JSON.parse(readText("firestore.indexes.json"))).not.toThrow();
  });
});

describe("nginx.conf (sections 9, 10, 12)", () => {
  const conf = readText("nginx.conf").replace(/#.*$/gm, "");

  it("listens on 8080 with SPA fallback and sw.js no-cache", () => {
    expect(conf).toMatch(/listen\s+8080\s*;/);
    expect(conf).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html\s*;/);
    expect(conf).toMatch(/location\s*=\s*\/sw\.js\s*\{[^}]*Cache-Control\s+"no-cache"/);
  });
  for (const loc of ["/__/auth/", "/__/firebase/"]) {
    it(`proxies ${loc} to ${FIREBASEAPP_HOST}`, () => {
      const esc = loc.replace(/\//g, "\\/");
      const m = conf.match(new RegExp(`location\\s+${esc}\\s*\\{([^}]*)\\}`));
      expect(m, `missing location ${loc}`).toBeTruthy();
      const body = m![1];
      expect(body).toMatch(new RegExp(`proxy_pass\\s+https://${FIREBASEAPP_HOST.replace(/\./g, "\\.")}\\s*;`));
      expect(body).toMatch(/proxy_ssl_server_name\s+on\s*;/);
      expect(body).toContain(`proxy_set_header Host ${FIREBASEAPP_HOST};`);
    });
  }
  it("never sets Cross-Origin-Opener-Policy (breaks dev popup)", () => {
    expect(conf.toLowerCase()).not.toContain("cross-origin-opener-policy");
  });
});

describe("Dockerfile", () => {
  const d = readText("Dockerfile");
  it("multi-stage node 22 build -> nginx serving dist on 8080", () => {
    expect(d).toMatch(/FROM\s+node:22[\w.-]*\s+AS\s+build/i);
    expect(d).toMatch(/RUN\s+npm\s+ci/);
    expect(d).toMatch(/RUN\s+npm\s+run\s+build/);
    expect(d).toMatch(/FROM\s+nginx:/);
    expect(d).toMatch(/COPY\s+nginx\.conf\s+\/etc\/nginx\/conf\.d\/default\.conf/);
    expect(d).toMatch(/COPY\s+--from=build\s+\/app\/dist\s+\/usr\/share\/nginx\/html/);
    expect(d).toMatch(/EXPOSE\s+8080/);
  });
  it("copies scripts/ before npm ci (postinstall needs setup-assets.mjs)", () => {
    expect(d.indexOf("COPY scripts")).toBeGreaterThan(-1);
    expect(d.indexOf("COPY scripts")).toBeLessThan(d.indexOf("npm ci"));
  });
});

describe(".env files (section 12)", () => {
  for (const f of [".env.example", ".env.development", ".env.production"]) {
    it(`${f} has every VITE_* key, the db id, project and allowed email`, () => {
      const env = parseEnv(readText(f));
      for (const k of ENV_KEYS) expect(env, `${f} missing ${k}`).toHaveProperty(k);
      expect(env.VITE_FIRESTORE_DATABASE_ID).toBe(DB_ID);
      expect(env.VITE_ALLOWED_EMAIL).toBe(ALLOWED_EMAIL);
      expect(env.VITE_FIREBASE_PROJECT_ID).toBe(PROJECT_ID);
      expect(env.VITE_FIREBASE_AUTH_DOMAIN).not.toMatch(/^https?:\/\//);
    });
  }
  it(".env.development uses the firebaseapp.com auth domain (popup in dev)", () => {
    expect(parseEnv(readText(".env.development")).VITE_FIREBASE_AUTH_DOMAIN).toBe(FIREBASEAPP_HOST);
  });
  it("no real secrets beyond public Firebase identifiers", () => {
    for (const f of [".env.example", ".env.development", ".env.production"]) {
      const t = readText(f);
      expect(t).not.toMatch(/PRIVATE|SECRET|PASSWORD|BEGIN [A-Z ]*KEY/i);
    }
  });
});

describe(".gitignore / .dockerignore", () => {
  it("gitignore covers node_modules, dist, generated assets, fixtures, certs", () => {
    const g = readText(".gitignore");
    for (const p of ["node_modules", "dist", "public/models", "public/wasm", ".env.local", "fixtures"]) {
      expect(g, `.gitignore missing ${p}`).toContain(p);
    }
  });
  it("dockerignore excludes node_modules, dist, .git, fixtures", () => {
    const g = readText(".dockerignore");
    for (const p of ["node_modules", "dist", ".git", "fixtures"]) expect(g).toContain(p);
  });
});

describe("package.json scripts (section 12)", () => {
  const pkg = JSON.parse(readText("package.json"));
  it("has the documented scripts", () => {
    expect(pkg.scripts.build).toBe("tsc --noEmit && vite build");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.postinstall).toBe("node scripts/setup-assets.mjs");
    expect(pkg.scripts["deploy:rules"]).toBe("firebase deploy --only firestore:rules");
    expect(pkg.scripts.deploy).toMatch(/gcloud run deploy fashion-assistant --source \. --region us-central1 --allow-unauthenticated --max-instances 2/);
  });
  it("runtime deps are exactly firebase, mediapipe, fflate", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@mediapipe/tasks-vision", "fflate", "firebase"]);
  });
});

describe("vite.config.ts (section 12)", () => {
  const v = stripComments(readText("vite.config.ts"));
  it("service worker never answers /__/ (navigateFallbackDenylist)", () => {
    expect(v).toMatch(/navigateFallbackDenylist\s*:\s*\[\s*\/\^\\\/__\\\/\/\s*\]/);
  });
  it("build input is index.html only (replay.html never in dist)", () => {
    expect(v).toMatch(/input\s*:\s*["']index\.html["']/);
    expect(v).not.toMatch(/replay/);
  });
  it("PWA manifest: autoUpdate, standalone, portrait, 3 icons incl. maskable", () => {
    expect(v).toMatch(/registerType\s*:\s*["']autoUpdate["']/);
    expect(v).toMatch(/display\s*:\s*["']standalone["']/);
    expect(v).toMatch(/orientation\s*:\s*["']portrait["']/);
    expect(v).toContain("/icons/icon-192.png");
    expect(v).toContain("/icons/icon-512.png");
    expect(v).toMatch(/icon-512-maskable\.png[^}]*purpose\s*:\s*["']maskable["']/);
  });
  it("MediaPipe /models/ and /wasm/ are runtime CacheFirst, not precached", () => {
    expect(v).toMatch(/\/models\//);
    expect(v).toMatch(/\/wasm\//);
    expect(v).toMatch(/handler\s*:\s*["']CacheFirst["']/);
    const globs = v.match(/globPatterns\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(globs).not.toMatch(/task|tflite|wasm/);
  });
  it("basicSsl only for the dev server", () => {
    expect(v).toMatch(/command\s*===\s*["']serve["']\s*\?\s*\[\s*basicSsl\(\)\s*\]/);
  });
});

describe("tsconfig / html entries", () => {
  it("tsconfig is strict", () => {
    expect(JSON.parse(readText("tsconfig.json")).compilerOptions.strict).toBe(true);
  });
  it("index.html loads src/main.ts; replay.html loads src/dev/replay.ts", () => {
    expect(readText("index.html")).toContain('src="/src/main.ts"');
    expect(readText("replay.html")).toContain('src="/src/dev/replay.ts"');
    expect(readText("index.html")).not.toMatch(/replay|debug/i);
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
  // Concatenate IDAT chunks and inflate to prove the file is decodable.
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
        expect(s.screenMatch.width).toBeLessThan(s.screenMatch.height); // portrait CSS px
        expect([2, 3]).toContain(s.screenMatch.dpr);
      }
    }
    // Android UA models must not map to two entries.
    const ua = specs.flatMap((s: { uaModels?: string[] }) => s.uaModels ?? []);
    expect(new Set(ua).size).toBe(ua.length);
    // At least one iPhone family and one Android model (section 4, M1).
    expect(specs.some((s: { screenMatch?: unknown }) => !!s.screenMatch)).toBe(true);
    expect(specs.some((s: { uaModels?: string[] }) => !!s.uaModels?.length)).toBe(true);
  });
});
