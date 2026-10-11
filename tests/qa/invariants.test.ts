// @vitest-environment jsdom
// QA: cross-module invariants checked statically (source scans) and at runtime.
// Static checks skip files that do not exist yet; each failure names the owner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_EMAIL, exists, fn, listFiles, loadModule, readOwned, readText, stripComments, type Team } from "./_helpers";

const OWNERS: [RegExp, Team][] = [
  [/^src\/(config\.ts|auth\/|data\/)/, "A auth-data"],
  [/^src\/(device\/|capture\/|wakeLock\.ts)/, "B device-capture"],
  [/^src\/(geometry|measure|pipeline)\//, "C geometry-measure"],
  [/^src\/vision\//, "D vision"],
  [/^src\/(main\.ts|flow\/|ui\/|units\.ts)/, "E ui-flow"],
  [/^src\/dev\//, "F dev-tools"],
];
function owner(path: string): Team {
  return OWNERS.find(([re]) => re.test(path))?.[1] ?? "orchestrator";
}
const srcTs = () => listFiles("src", (p) => p.endsWith(".ts"));
const code = (p: string) => stripComments(readText(p));

/** Collect "[team] file: problem" for every file where `bad` matches. */
function scan(files: string[], bad: RegExp, what: string): string[] {
  return files.filter((p) => bad.test(code(p))).map((p) => `[${owner(p)}] ${p}: ${what}`);
}

describe("privacy: no image ever leaves the device (section 1, 8)", () => {
  it("no upload channels: no sendBeacon/XHR/WebSocket; no third-party SDKs", () => {
    const files = srcTs();
    const problems = [
      ...scan(files, /navigator\.sendBeacon|XMLHttpRequest|new\s+WebSocket/, "uses a raw network upload API"),
      ...scan(files, /from\s+["'](firebase(\/[\w-]+)?|@google-cloud\/firestore|google-auth-library)["']/, "imports a server/Firebase SDK in the client"),
    ];
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("fetch() only in src/data + src/auth (same-origin /api) and static assets (profiles, MediaPipe)", () => {
    const allowed = /^src\/(data\/|auth\/|device\/profiles\.ts|vision\/|dev\/)/;
    const problems = srcTs()
      .filter((p) => !allowed.test(p) && /\bfetch\s*\(/.test(code(p)))
      .map((p) => `[${owner(p)}] ${p}: unexpected fetch() - API calls belong in src/data`);
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("client talks only to its own origin + accounts.google.com (GIS)", () => {
    const problems: string[] = [];
    for (const p of srcTs()) {
      for (const m of code(p).matchAll(/["'`](https?:\/\/[^"'`\s/]+)/g)) {
        // http://www.w3.org = SVG/XML namespace URIs (identifiers, never fetched)
        if (!/^https:\/\/accounts\.google\.com$/.test(m[1]) && !/localhost|127\.0\.0\.1|example|^http:\/\/www\.w3\.org$/.test(m[1])) {
          problems.push(`[${owner(p)}] ${p}: external origin ${m[1]}`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("data layer never references image types", () => {
    const files = listFiles("src/data", (p) => p.endsWith(".ts"));
    const problems = scan(files, /\b(ImageBitmap|ImageData|HTMLCanvasElement|OffscreenCanvas|toDataURL|toBlob|CapturedFrame|ViewCapture)\b/, "data layer references image data");
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("no hard-coded secrets in src or server (OAuth client id is public, client secret is not used)", () => {
    const files = [...srcTs(), ...listFiles("server", (p) => p.endsWith(".ts"))];
    const problems = scan(files, /AIza[0-9A-Za-z_-]{20,}|-----BEGIN|client_secret|GOCSPX-/, "hard-coded key/secret");
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("dev-only code stays out of the app path (sections 6 S3, 8, 12)", () => {
  it("non-dev src never statically imports src/dev or fflate", () => {
    const files = srcTs().filter((p) => !p.startsWith("src/dev/"));
    const problems = [
      ...scan(files, /^\s*import\s+(?!type\b)[^;]*from\s+["'][^"']*\/dev\/[^"']*["']/m, "static import of src/dev (must be dynamic import() behind a DEV/debug guard)"),
      ...scan(files, /from\s+["']fflate["']|import\(\s*["']fflate["']\s*\)/, "imports fflate outside src/dev"),
    ];
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("every dynamic import of src/dev is guarded by import.meta.env.DEV / debug flag", () => {
    const files = srcTs().filter((p) => !p.startsWith("src/dev/") && /import\(\s*["'][^"']*\/dev\//.test(code(p)));
    const problems = files
      .filter((p) => !/import\.meta\.env\.DEV/.test(code(p)) || !/debug/i.test(code(p)))
      .map((p) => `[${owner(p)}] ${p}: dynamic import of src/dev without an import.meta.env.DEV / ?debug=1 guard`);
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("[F dev-tools] debugEnabled() is false on a production host even with ?debug=1 (static check)", () => {
    const src = stripComments(readOwned("src/dev/debugCapture.ts", "F dev-tools"));
    expect(src, "[F dev-tools] debugEnabled must check import.meta.env.DEV").toMatch(/import\.meta\.env\.DEV/);
    expect(src, "[F dev-tools] debugEnabled must check the host for ?debug=1").toMatch(/location\.(host|hostname)/);
  });
});

describe("camera frames are unmirrored; only the preview is mirrored (sections 2, 6, 8)", () => {
  it("no mirroring transforms in capture/vision/geometry/measure/pipeline code", () => {
    const files = srcTs().filter((p) => /^src\/(capture|vision|geometry|measure|pipeline)\//.test(p));
    const problems = scan(files, /scaleX\(\s*-1\s*\)|\.scale\(\s*-1\s*,|setTransform\(\s*-1\b|flipHorizontal|mirror\s*[:=]\s*true/, "mirrors frame data");
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("[E ui-flow] the preview <video> is mirrored with CSS scaleX(-1)", () => {
    const css = readOwned("src/ui/styles.css", "E ui-flow");
    expect(css, "[E ui-flow] styles.css must mirror the video preview").toMatch(/video[^{]*\{[^}]*transform\s*:\s*scaleX\(\s*-1\s*\)/);
  });
  it("[B device-capture] front camera, 1080x1920 ideal, 720x1280 fallback", () => {
    const src = stripComments(readOwned("src/capture/camera.ts", "B device-capture"));
    expect(src).toMatch(/facingMode\s*:\s*(\{\s*(ideal|exact)\s*:\s*)?["']user["']/);
    expect(src).toMatch(/1080/);
    expect(src).toMatch(/1920/);
    expect(src).toMatch(/720/);
    expect(src).toMatch(/1280/);
  });
});

describe("spoken/on-screen text never says turn left/right (section 5, 6)", () => {
  it("no 'turn left/right' in UI, flow, capture or vision text", () => {
    const files = srcTs().filter((p) => /^src\/(ui|flow|capture|vision)\//.test(p));
    const problems = scan(files, /["'`][^"'`]*\bturn\s+(to\s+(the|your)\s+)?(left|right)\b[^"'`]*["'`]/i, "says turn left/right");
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("v2 client wiring (CONTRACTS-v2: GIS + /api)", () => {
  it("[A2 client-data] API calls: same-origin /api paths, credentials same-origin, X-Requested-With on writes", () => {
    const files = listFiles("src/data", (p) => p.endsWith(".ts")).concat(listFiles("src/auth", (p) => p.endsWith(".ts")));
    const all = files.map((p) => code(p)).join("\n");
    expect(all, "client must call /api/...").toMatch(/["'`]\/api\//);
    expect(all, 'fetch must use credentials: "same-origin"').toMatch(/credentials\s*:\s*["']same-origin["']/);
    expect(all, "writes must send an X-Requested-With header").toMatch(/X-Requested-With/i);
    expect(all, "X-Requested-With value must be fashion-assistant").toMatch(/["']fashion-assistant["']/);
    const absolute = scan(files, /fetch\(\s*["'`]https?:/, "fetches an absolute URL (must be same-origin /api)");
    expect(absolute, absolute.join("\n")).toEqual([]);
  });
  it("[A2 client-data] GIS: redirect ux_mode, login_uri /api/auth/google, script from accounts.google.com/gsi/client", () => {
    const g = listFiles("src/auth", (p) => p.endsWith(".ts")).map((p) => code(p)).join("\n");
    expect(g).toContain("https://accounts.google.com/gsi/client");
    expect(g).toMatch(/ux_mode\s*:\s*["']redirect["']/);
    expect(g).toMatch(/\/api\/auth\/google/);
    expect(g).toMatch(/auto_select\s*:\s*false/);
    expect(g).toContain("This app is private.");
    expect(g).toMatch(/history\.replaceState/);
  });
  it("[A2 client-data] outbox key fa.outbox; flush on 'online'; clientId sent", () => {
    const d = listFiles("src/data", (p) => p.endsWith(".ts")).map((p) => code(p)).join("\n");
    expect(d).toContain("fa.outbox");
    expect(d).toMatch(/["']online["']/);
    expect(d).toMatch(/clientId/);
  });
  it("[A2 client-data] delete-all: DELETE /api/me/data, clears outbox + deviceId", () => {
    const d = stripComments(readOwned("src/data/deleteAll.ts", "A2 client-data"));
    expect(d).toMatch(/\/api\/me\/data/);
    expect(d).toMatch(/clearDeviceId\s*\(|removeItem\(\s*["']fa\.deviceId["']/);
    expect(d + listFiles("src/data", (p) => p.endsWith(".ts")).map((p) => code(p)).join("\n")).toMatch(/fa\.outbox/);
  });
  it("[E2 ui] main.ts: not-configured message, readAuthError, getCurrentUser; no Firebase calls", () => {
    const m = stripComments(readOwned("src/main.ts", "E2 ui"));
    expect(m).toMatch(/isAuthConfigured\s*\(/);
    expect(m).toMatch(/readAuthError\s*\(/);
    expect(m).toMatch(/getCurrentUser\s*\(/);
    expect(m).not.toMatch(/finishRedirect|watchAuth|isFirebaseConfigured/);
    const all = srcTs().map((p) => code(p)).join("\n");
    expect(all, "VITE_GOOGLE_CLIENT_ID setup hint must be shown when not configured").toMatch(/VITE_GOOGLE_CLIENT_ID/);
  });
  it("[E2 ui] sign-in screen renders the official GIS button (no custom button)", () => {
    const s = stripComments(readOwned("src/ui/screens/signIn.ts", "E2 ui"));
    expect(s).toMatch(/renderSignInButton\s*\(/);
  });
});

describe("[S server] static invariants", () => {
  const serverFiles = () => listFiles("server", (p) => p.endsWith(".ts"));
  it("imports: node:* builtins, the two Google libs, relative .ts files, src/types.ts only", () => {
    const problems: string[] = [];
    for (const p of serverFiles()) {
      for (const m of code(p).matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'\n]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1] ?? m[2];
        const ok = spec.startsWith("node:") || spec === "@google-cloud/firestore" || spec === "google-auth-library" ||
          (spec.startsWith(".") && spec.endsWith(".ts") && (!spec.includes("/src/") || spec.endsWith("/src/types.ts")));
        if (!ok) problems.push(`[S server] ${p}: import "${spec}"`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("only store-firestore.ts touches Firestore; uid-scoped paths per section 11", () => {
    const users = serverFiles().filter((p) => /@google-cloud\/firestore/.test(code(p)));
    expect(users.every((p) => /store-firestore\.ts$/.test(p)), `Firestore imported in: ${users.join(", ")}`).toBe(true);
    if (exists("server/store-firestore.ts")) {
      const s = code("server/store-firestore.ts");
      expect(s, "named database id").toMatch(/databaseId/);
      for (const c of ["users", "scans", "devices", "settings", "correctionFactors", "sessions"]) expect(s, `path segment ${c}`).toContain(`"${c}"`);
    }
  });
  it("sessions: 32 random bytes, sha256-hashed at rest, cookie fa_session HttpOnly SameSite=Lax 30 days", () => {
    const all = serverFiles().map((p) => code(p)).join("\n");
    expect(all).toMatch(/randomBytes\(\s*32\s*\)/);
    expect(all).toMatch(/createHash\(\s*["']sha256["']\s*\)/);
    expect(all).toContain("fa_session");
    expect(all).toMatch(/HttpOnly|httpOnly\s*:\s*true/);
    expect(all).toMatch(/SameSite=Lax|sameSite\s*:\s*["']Lax["']/);
    expect(all).toMatch(/verifyIdToken/);
    expect(all).toMatch(/email_verified/);
  });
  it("config defaults: fashionassitant-db, fashionassitant, 8080, memory outside production", () => {
    const c = stripComments(readOwned("server/config.ts", "S server"));
    expect(c).toContain('"fashionassitant-db"');
    expect(c).toContain('"fashionassitant"');
    expect(c).toMatch(/8080/);
    expect(c).toMatch(/["']memory["']/);
    expect(c).toMatch(/\.env\.production/);
    expect(c).toMatch(/\.env\.development/);
    expect(c).toMatch(/toLowerCase\(\)/);
  });
});

describe("[A2 client-data] runtime: config + allowlist + auth error", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("not configured when VITE_GOOGLE_CLIENT_ID is empty; APP_VERSION 0.1.0", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    const c = await loadModule("src/config", "A2 client-data");
    expect(c.isAuthConfigured()).toBe(false);
    expect(c.APP_VERSION).toBe("0.1.0");
    vi.resetModules();
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "123-abc.apps.googleusercontent.com");
    const c2 = await loadModule("src/config", "A2 client-data");
    expect(c2.isAuthConfigured()).toBe(true);
    expect(c2.GOOGLE_CLIENT_ID).toBe("123-abc.apps.googleusercontent.com");
  });
  it("ALLOWED_EMAIL lowercased; isAllowed truth table; empty allowlist fails closed", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ALLOWED_EMAIL", "JLivanRamirez7@Gmail.com");
    const c = await loadModule("src/config", "A2 client-data");
    expect(c.ALLOWED_EMAIL).toBe(ALLOWED_EMAIL);
    const g = await loadModule("src/auth/authGuard", "A2 client-data");
    const isAllowed = fn(g, "isAllowed", "A2 client-data", "src/auth/authGuard");
    expect(isAllowed({ email: ALLOWED_EMAIL, emailVerified: true })).toBe(true);
    expect(isAllowed({ email: "JLIVANRAMIREZ7@GMAIL.COM", emailVerified: true })).toBe(true);
    expect(isAllowed({ email: ALLOWED_EMAIL, emailVerified: false })).toBe(false);
    expect(isAllowed({ email: "someone.else@gmail.com", emailVerified: true })).toBe(false);
    expect(isAllowed(null)).toBe(false);
    vi.resetModules();
    vi.stubEnv("VITE_ALLOWED_EMAIL", "");
    const g2 = await loadModule("src/auth/authGuard", "A2 client-data");
    expect(g2.isAllowed({ email: ALLOWED_EMAIL, emailVerified: true })).toBe(false);
  }, 60_000);
  it("readAuthError reads ?auth_error= and removes it from the URL", async () => {
    const g = await loadModule("src/auth/authGuard", "A2 client-data");
    const read = fn(g, "readAuthError", "A2 client-data", "src/auth/authGuard");
    for (const [q, want] of [["auth_error=private&", "private"], ["auth_error=failed&", "failed"], ["", null], ] as const) {
      history.replaceState(null, "", `/?${q}keep=1`);
      expect(read(), q || "(none)").toBe(want);
      expect(location.search, "auth_error must be removed").not.toContain("auth_error");
    }
    expect(g.PRIVATE_MESSAGE).toBe("This app is private.");
  });
});

describe("[A auth-data] runtime: deviceId", () => {
  it("stable UUID stored under fa.deviceId; clearDeviceId removes it", async () => {
    localStorage.clear();
    const d = await loadModule("src/data/deviceId", "A auth-data");
    const id1 = d.getDeviceId();
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(d.getDeviceId()).toBe(id1);
    expect(localStorage.getItem("fa.deviceId")).toBe(id1);
    d.clearDeviceId();
    expect(localStorage.getItem("fa.deviceId")).toBeNull();
    expect(d.getDeviceId()).not.toBe(id1);
  });
});

describe("[B device-capture] runtime: wake lock degrades gracefully", () => {
  it("acquire/release resolve when navigator.wakeLock is missing", async () => {
    const w = await loadModule("src/wakeLock", "B device-capture");
    await expect(w.acquireWakeLock()).resolves.toBeUndefined();
    await expect(w.releaseWakeLock()).resolves.toBeUndefined();
  });
});

describe("[D vision] landmarks are normalized; crops and quality work in pixels", () => {
  it("regionCrops(normalized landmarks, W, H) returns pixel boxes inside the frame", async () => {
    const m = await loadModule("src/vision/crops", "D vision");
    const { renderView } = await import("./_scene");
    const W = 360, H = 640;
    const sv = renderView({ width: W, height: H, f: 441, thetaDeg: 75, lensOffsetCm: 14 }, "front", 250);
    const boxes = fn(m, "regionCrops", "D vision", "src/vision/crops")(sv.landmarks, W, H);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= W + 1e-6 && b.y + b.h <= H + 1e-6, `${b.name} ${JSON.stringify(b)}`).toBe(true);
      expect(b.w, `${b.name} width in pixels`).toBeGreaterThan(2);
    }
    const torso = boxes.find((b: { name: string }) => /torso/i.test(b.name));
    if (torso) {
      // torso landmarks (normalized) * W must lie inside the box
      const sx = sv.landmarks[11].x * W, hy = sv.landmarks[23].y * H;
      expect(sx >= torso.x && sx <= torso.x + torso.w && hy >= torso.y && hy <= torso.y + torso.h).toBe(true);
    }
  });
});
