// @vitest-environment jsdom
// QA: cross-module invariants checked statically (source scans) and at runtime.
// Static checks skip files that do not exist yet; each failure names the owner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_EMAIL, DB_ID, exists, fn, listFiles, loadModule, readOwned, readText, stripComments, type Team } from "./_helpers";

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
  it("nothing imports firebase/storage or posts binary data", () => {
    const files = srcTs();
    const problems = [
      ...scan(files, /from\s+["']firebase\/storage["']|import\(\s*["']firebase\/storage["']\s*\)/, "imports firebase/storage"),
      ...scan(files, /navigator\.sendBeacon|XMLHttpRequest|new\s+WebSocket/, "uses a network upload API"),
      ...scan(files, /method\s*:\s*["'](POST|PUT)["']/i, "issues a POST/PUT request"),
    ];
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("fetch() only for static assets (device-profiles.json, MediaPipe wasm/models)", () => {
    const allowed = /^src\/(device\/profiles\.ts|vision\/|dev\/)/;
    const problems = srcTs()
      .filter((p) => !allowed.test(p) && /\bfetch\s*\(/.test(code(p)))
      .map((p) => `[${owner(p)}] ${p}: unexpected fetch() - only static assets may be fetched`);
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("data layer (A) never references image types", () => {
    const files = listFiles("src/data", (p) => p.endsWith(".ts"));
    const problems = scan(files, /\b(ImageBitmap|ImageData|HTMLCanvasElement|OffscreenCanvas|toDataURL|toBlob|CapturedFrame|ViewCapture)\b/, "data layer references image data");
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("no hard-coded Firebase API key or secrets in src", () => {
    const problems = scan(srcTs(), /AIza[0-9A-Za-z_-]{20,}|-----BEGIN/, "hard-coded key/secret");
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

describe("Firebase wiring (sections 9, 10, 11)", () => {
  it("[A auth-data] named database + persistent cache; getFirestore() never used", () => {
    const fb = stripComments(readOwned("src/auth/firebase.ts", "A auth-data"));
    expect(fb).toMatch(/initializeFirestore\s*\(/);
    expect(fb).toMatch(/FIRESTORE_DATABASE_ID/);
    expect(fb).toMatch(/persistentLocalCache/);
    const problems = scan(srcTs(), /\bgetFirestore\s*\(/, "uses getFirestore() (would hit the (default) database)");
    expect(problems, problems.join("\n")).toEqual([]);
  });
  it("[A auth-data] sign-in: login_hint, redirect iff authDomain === location.host, private message", () => {
    const g = stripComments(readOwned("src/auth/authGuard.ts", "A auth-data")) + (exists("src/auth/allowlist.ts") ? code("src/auth/allowlist.ts") : "");
    expect(g).toMatch(/login_hint/);
    expect(g).toMatch(/location\.host\b/);
    expect(g).toMatch(/signInWithRedirect/);
    expect(g).toMatch(/signInWithPopup/);
    expect(g).toMatch(/getRedirectResult/);
    expect(g).toContain("This app is private.");
  });
  it("[A auth-data] delete-all: batches <= 500, terminate + clearIndexedDbPersistence, clears deviceId", () => {
    const d = stripComments(readOwned("src/data/deleteAll.ts", "A auth-data"));
    expect(d).toMatch(/\b500\b/);
    expect(d).toMatch(/terminate\s*\(/);
    expect(d).toMatch(/clearIndexedDbPersistence\s*\(/);
    expect(d).toMatch(/clearDeviceId\s*\(|removeItem\(\s*["']fa\.deviceId["']/);
    for (const sub of ["scans", "devices", "settings"]) expect(d, `deleteAll must cover ${sub}`).toContain(sub);
  });
  it("[E ui-flow] main.ts: not-configured message, finishRedirect before watchAuth", () => {
    const m = stripComments(readOwned("src/main.ts", "E ui-flow"));
    expect(m).toMatch(/isFirebaseConfigured\s*\(/);
    const fr = m.search(/finishRedirect\s*\(/);
    const wa = m.search(/watchAuth\s*\(/);
    expect(fr, "finishRedirect() must be called").toBeGreaterThan(-1);
    expect(wa, "watchAuth() must be called").toBeGreaterThan(-1);
    expect(fr, "finishRedirect() must come before watchAuth()").toBeLessThan(wa);
  });
});

describe("[A auth-data] runtime: config + allowlist", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("config defaults: named db id, APP_VERSION, not configured when keys are empty", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_FIRESTORE_DATABASE_ID", "");
    vi.stubEnv("VITE_FIREBASE_API_KEY", "");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "");
    const c = await loadModule("src/config", "A auth-data");
    expect(c.FIRESTORE_DATABASE_ID).toBe(DB_ID);
    expect(c.APP_VERSION).toBe("0.1.0");
    expect(c.isFirebaseConfigured()).toBe(false);
  });
  it("ALLOWED_EMAIL is lowercased; isAllowed truth table", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ALLOWED_EMAIL", "JLivanRamirez7@Gmail.com");
    const c = await loadModule("src/config", "A auth-data");
    expect(c.ALLOWED_EMAIL).toBe(ALLOWED_EMAIL);
    const g = await loadModule("src/auth/authGuard", "A auth-data");
    const isAllowed = fn(g, "isAllowed", "A auth-data", "src/auth/authGuard");
    expect(isAllowed({ email: ALLOWED_EMAIL, emailVerified: true })).toBe(true);
    expect(isAllowed({ email: "JLIVANRAMIREZ7@GMAIL.COM", emailVerified: true })).toBe(true);
    expect(isAllowed({ email: ALLOWED_EMAIL, emailVerified: false })).toBe(false);
    expect(isAllowed({ email: "someone.else@gmail.com", emailVerified: true })).toBe(false);
    expect(isAllowed({ email: `x${ALLOWED_EMAIL}`, emailVerified: true })).toBe(false);
    expect(isAllowed({ email: null, emailVerified: true })).toBe(false);
    expect(isAllowed(null)).toBe(false);
  }, 60_000);
  it("empty allowlist fails closed", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ALLOWED_EMAIL", "");
    const g = await loadModule("src/auth/authGuard", "A auth-data");
    expect(g.isAllowed({ email: ALLOWED_EMAIL, emailVerified: true })).toBe(false);
  }, 60_000);
  it("importing auth/firebase does not initialise Firebase (lazy)", async () => {
    vi.resetModules();
    const fb = await loadModule("src/auth/firebase", "A auth-data");
    expect(typeof fb.getFirebase).toBe("function");
    expect(fb.app ?? fb.auth ?? fb.db, "no eager app/auth/db exports").toBeUndefined();
  }, 60_000);
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
