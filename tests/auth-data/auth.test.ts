import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedFor, shouldUseRedirect } from "../../src/auth/allowlist";

const OWNER = "jlivanramirez7@gmail.com";

describe("isAllowedFor", () => {
  it("allows the verified owner (case-insensitive)", () => {
    expect(isAllowedFor({ email: OWNER, emailVerified: true }, OWNER)).toBe(true);
    expect(isAllowedFor({ email: "JLivanRamirez7@Gmail.com", emailVerified: true }, OWNER)).toBe(true);
    expect(isAllowedFor({ email: OWNER, emailVerified: true }, "  JLIVANRAMIREZ7@gmail.com ")).toBe(true);
  });
  it("rejects null, unverified, other or missing emails", () => {
    expect(isAllowedFor(null, OWNER)).toBe(false);
    expect(isAllowedFor(undefined, OWNER)).toBe(false);
    expect(isAllowedFor({ email: OWNER, emailVerified: false }, OWNER)).toBe(false);
    expect(isAllowedFor({ email: "someone@gmail.com", emailVerified: true }, OWNER)).toBe(false);
    expect(isAllowedFor({ email: null, emailVerified: true }, OWNER)).toBe(false);
    expect(isAllowedFor({ email: `${OWNER}.evil.com`, emailVerified: true }, OWNER)).toBe(false);
  });
  it("fails closed when no allowed email is configured", () => {
    expect(isAllowedFor({ email: "", emailVerified: true }, "")).toBe(false);
    expect(isAllowedFor({ email: OWNER, emailVerified: true }, "")).toBe(false);
  });
});

describe("shouldUseRedirect", () => {
  it("redirects only when the auth domain is the app's own host", () => {
    expect(shouldUseRedirect("app-xyz-uc.a.run.app", "app-xyz-uc.a.run.app")).toBe(true);
    expect(shouldUseRedirect("fashionassitant.firebaseapp.com", "localhost:5173")).toBe(false);
    expect(shouldUseRedirect("", "")).toBe(false);
  });
});

describe("config + isAllowed (env driven)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("isAllowed uses VITE_ALLOWED_EMAIL lowercased", async () => {
    vi.stubEnv("VITE_ALLOWED_EMAIL", "JLivanRamirez7@gmail.com");
    vi.resetModules();
    const config = await import("../../src/config");
    expect(config.ALLOWED_EMAIL).toBe(OWNER);
    const { isAllowed } = await import("../../src/auth/authGuard");
    expect(isAllowed({ email: OWNER, emailVerified: true })).toBe(true);
    expect(isAllowed({ email: "x@y.z", emailVerified: true })).toBe(false);
    expect(isAllowed(null)).toBe(false);
  }, 60_000);

  it("isFirebaseConfigured is false while apiKey/appId are empty", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "fashionassitant");
    vi.resetModules();
    const config = await import("../../src/config");
    expect(config.isFirebaseConfigured()).toBe(false);
    // getFirebase must refuse rather than init with empty keys.
    const { getFirebase } = await import("../../src/auth/firebase");
    expect(() => getFirebase()).toThrow(/not configured/);
  }, 60_000);

  it("isFirebaseConfigured is true once keys exist; database id defaults", async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "key");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:2:web:3");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "fashionassitant");
    vi.stubEnv("VITE_FIRESTORE_DATABASE_ID", "");
    vi.resetModules();
    const config = await import("../../src/config");
    expect(config.isFirebaseConfigured()).toBe(true);
    expect(config.FIRESTORE_DATABASE_ID).toBe("fashionassitant-db");
    expect(config.APP_VERSION).toBe("0.1.0");
  });
});
