// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedFor } from "../../src/auth/allowlist";
import { json, mockFetch } from "./fetchMock";

const OWNER = "jlivanramirez7@gmail.com";

async function loadGuard(env: Record<string, string> = {}) {
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", env.VITE_GOOGLE_CLIENT_ID ?? "client-123.apps.googleusercontent.com");
  vi.stubEnv("VITE_ALLOWED_EMAIL", env.VITE_ALLOWED_EMAIL ?? "JLivanRamirez7@gmail.com");
  vi.resetModules();
  return import("../../src/auth/authGuard");
}

function fakeGis() {
  const id = { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() };
  return id;
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  delete window.google;
  document.head.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isAllowedFor / isAllowed", () => {
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
  it("isAllowed uses VITE_ALLOWED_EMAIL", async () => {
    const g = await loadGuard();
    expect(g.isAllowed({ email: OWNER, emailVerified: true })).toBe(true);
    expect(g.isAllowed({ email: "x@y.z", emailVerified: true })).toBe(false);
    expect(g.isAllowed(null)).toBe(false);
    expect(g.PRIVATE_MESSAGE).toBe("This app is private.");
  });
});

describe("config", () => {
  it("isAuthConfigured follows VITE_GOOGLE_CLIENT_ID", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "");
    vi.resetModules();
    expect((await import("../../src/config")).isAuthConfigured()).toBe(false);
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", " abc ");
    vi.stubEnv("VITE_ALLOWED_EMAIL", "A@B.COM");
    vi.resetModules();
    const c = await import("../../src/config");
    expect(c.isAuthConfigured()).toBe(true);
    expect(c.GOOGLE_CLIENT_ID).toBe("abc");
    expect(c.ALLOWED_EMAIL).toBe("a@b.com");
    expect(c.APP_VERSION).toBe("0.1.0");
  });
});

describe("readAuthError", () => {
  it("returns null when absent and leaves the URL alone", async () => {
    const g = await loadGuard();
    history.replaceState(null, "", "/?debug=1#x");
    expect(g.readAuthError()).toBeNull();
    expect(location.search).toBe("?debug=1");
  });
  it("reads private / failed and strips only that param", async () => {
    const g = await loadGuard();
    history.replaceState(null, "", "/?debug=1&auth_error=private#top");
    expect(g.readAuthError()).toBe("private");
    expect(location.search).toBe("?debug=1");
    expect(location.hash).toBe("#top");
    expect(g.readAuthError()).toBeNull();
    history.replaceState(null, "", "/?auth_error=failed");
    expect(g.readAuthError()).toBe("failed");
    expect(location.search).toBe("");
  });
  it("treats unknown values as failed", async () => {
    const g = await loadGuard();
    history.replaceState(null, "", "/?auth_error=whatever");
    expect(g.readAuthError()).toBe("failed");
  });
});

describe("getCurrentUser", () => {
  it("GETs /api/me with same-origin credentials", async () => {
    const g = await loadGuard();
    const { calls } = mockFetch(() => json(200, { uid: "sub-1", email: OWNER }));
    await expect(g.getCurrentUser()).resolves.toEqual({ uid: "sub-1", email: OWNER });
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/me", credentials: "same-origin" });
  });
  it("401 => null and forgets the cached user", async () => {
    const g = await loadGuard();
    mockFetch(() => json(200, { uid: "sub-1", email: OWNER }), () => json(401, { error: "unauthenticated", message: "x" }));
    await g.getCurrentUser();
    await expect(g.getCurrentUser()).resolves.toBeNull();
    expect(localStorage.getItem("fa.lastUser")).toBeNull();
  });
  it("offline: returns the last confirmed user, else throws", async () => {
    const g = await loadGuard();
    mockFetch(() => "network-error");
    await expect(g.getCurrentUser()).rejects.toThrow(/Network error/);
    mockFetch(() => json(200, { uid: "sub-1", email: OWNER }), () => "network-error");
    await g.getCurrentUser();
    await expect(g.getCurrentUser()).resolves.toEqual({ uid: "sub-1", email: OWNER });
  });
  it("other server errors are thrown with the server message", async () => {
    const g = await loadGuard();
    mockFetch(() => json(500, { error: "internal", message: "Firestore down" }));
    await expect(g.getCurrentUser()).rejects.toThrow("Firestore down");
  });
});

describe("signOutUser", () => {
  it("POSTs /api/logout with X-Requested-With, clears cache, disables GIS auto-select", async () => {
    const g = await loadGuard();
    const gis = fakeGis();
    window.google = { accounts: { id: gis } };
    localStorage.setItem("fa.lastUser", JSON.stringify({ uid: "1", email: OWNER }));
    const { calls } = mockFetch(() => json(200, { ok: true }));
    await g.signOutUser();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/logout" });
    expect(calls[0].headers["X-Requested-With"]).toBe("fashion-assistant");
    expect(localStorage.getItem("fa.lastUser")).toBeNull();
    expect(gis.disableAutoSelect).toHaveBeenCalled();
  });
  it("works when GIS is not loaded", async () => {
    const g = await loadGuard();
    mockFetch(() => json(200, { ok: true }));
    await expect(g.signOutUser()).resolves.toBeUndefined();
  });
});

describe("renderSignInButton", () => {
  it("initializes GIS in redirect mode and renders the button", async () => {
    const g = await loadGuard();
    const gis = fakeGis();
    window.google = { accounts: { id: gis } };
    const el = document.createElement("div");
    await g.renderSignInButton(el);
    expect(gis.initialize).toHaveBeenCalledWith({
      client_id: "client-123.apps.googleusercontent.com",
      ux_mode: "redirect",
      login_uri: location.origin + "/api/auth/google",
      auto_select: false,
    });
    expect(gis.renderButton).toHaveBeenCalledWith(el, {
      theme: "filled_black",
      size: "large",
      text: "signin_with",
      shape: "pill",
    });
  });

  it("loads the GIS script once", async () => {
    const g = await loadGuard();
    const p1 = g.renderSignInButton(document.createElement("div"));
    const p2 = g.renderSignInButton(document.createElement("div"));
    const scripts = document.head.querySelectorAll('script[src="https://accounts.google.com/gsi/client"]');
    expect(scripts).toHaveLength(1);
    const gis = fakeGis();
    window.google = { accounts: { id: gis } };
    scripts[0].dispatchEvent(new Event("load"));
    await Promise.all([p1, p2]);
    expect(gis.renderButton).toHaveBeenCalledTimes(2);
    await g.renderSignInButton(document.createElement("div"));
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it("rejects when the script fails to load", async () => {
    const g = await loadGuard();
    const p = g.renderSignInButton(document.createElement("div"));
    document.head.querySelector("script")!.dispatchEvent(new Event("error"));
    await expect(p).rejects.toThrow(/Could not load Google sign-in/);
  });

  it("throws when not configured", async () => {
    const g = await loadGuard({ VITE_GOOGLE_CLIENT_ID: "" });
    await expect(g.renderSignInButton(document.createElement("div"))).rejects.toThrow(/not configured/);
  });
});
