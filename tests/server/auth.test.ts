import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TTL_MS, emailAllowed, hashSessionId, newSessionId } from "../../server/auth.ts";
import type { Config } from "../../server/config.ts";
import { rawRequest, sessionCookieFrom, startHarness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

function postSignIn(form: Record<string, string>, cookie?: string, contentType = "application/x-www-form-urlencoded") {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (cookie !== undefined) headers.Cookie = cookie;
  return rawRequest(h.port, "/api/auth/google", { method: "POST", headers, body: new URLSearchParams(form).toString() });
}

describe("POST /api/auth/google", () => {
  it("valid token + CSRF => session cookie and 303 to /", async () => {
    const res = await h.signIn("good");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
    const set = (res.headers["set-cookie"] ?? []).find((c) => c.startsWith("fa_session="))!;
    expect(set).toMatch(/^fa_session=[A-Za-z0-9_-]{43};/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(set).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(set).not.toContain("Secure"); // cookieSecure=false in the harness
    expect(h.store.sessionCount()).toBe(1);

    const me = await h.api("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json()).toEqual({ uid: "uid-1", email: "allowed@example.com" });
  });

  it("stores only the sha256 of the session id", async () => {
    await h.signIn("good");
    const id = h.cookie.split("=")[1];
    expect(await h.store.getSession(id)).toBeNull();
    expect(await h.store.getSession(hashSessionId(id))).toMatchObject({ uid: "uid-1" });
  });

  it("CSRF mismatch => failed", async () => {
    const res = await postSignIn({ credential: "good", g_csrf_token: "a" }, "g_csrf_token=b");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/?auth_error=failed");
    expect(sessionCookieFrom(res)).toBe("");
    expect(h.store.sessionCount()).toBe(0);
  });

  it("missing CSRF cookie or body token => failed", async () => {
    expect((await postSignIn({ credential: "good", g_csrf_token: "a" })).headers.location).toBe("/?auth_error=failed");
    expect((await postSignIn({ credential: "good" }, "g_csrf_token=a")).headers.location).toBe("/?auth_error=failed");
  });

  it("invalid token => failed, and the token is never logged", async () => {
    const res = await postSignIn({ credential: "garbage-token-XYZ", g_csrf_token: "a" }, "g_csrf_token=a");
    expect(res.headers.location).toBe("/?auth_error=failed");
    expect(h.logs.join("\n")).not.toContain("garbage-token-XYZ");
  });

  it("wrong email => private", async () => {
    const res = await h.signIn("wrong");
    expect(res.headers.location).toBe("/?auth_error=private");
    expect(sessionCookieFrom(res)).toBe("");
    expect(h.store.sessionCount()).toBe(0);
  });

  it("unverified email => private", async () => {
    const res = await h.signIn("unverified");
    expect(res.headers.location).toBe("/?auth_error=private");
    expect(h.store.sessionCount()).toBe(0);
  });

  it("non-form content type => failed", async () => {
    const res = await postSignIn({ credential: "good", g_csrf_token: "a" }, "g_csrf_token=a", "application/json");
    expect(res.headers.location).toBe("/?auth_error=failed");
  });

  it("GET is not allowed", async () => {
    expect((await h.request("/api/auth/google")).status).toBe(405);
  });

  it("sets Secure on the cookie when configured", async () => {
    const h2 = await startHarness({ cookieSecure: true });
    try {
      const res = await h2.signIn("good");
      expect((res.headers["set-cookie"] ?? []).join(";")).toContain("Secure");
    } finally {
      await h2.close();
    }
  });

  it("empty client id => failed; empty allowlist => private", async () => {
    const h2 = await startHarness({ googleClientId: "" });
    const h3 = await startHarness({ allowedEmail: "" });
    try {
      expect((await h2.signIn("good")).headers.location).toBe("/?auth_error=failed");
      expect((await h3.signIn("good")).headers.location).toBe("/?auth_error=private");
    } finally {
      await h2.close();
      await h3.close();
    }
  });
});

describe("sessions", () => {
  it("/api routes need a session (401)", async () => {
    for (const p of ["/api/me", "/api/user", "/api/scans", "/api/scans/abc", "/api/devices/d1", "/api/settings/correctionFactors"]) {
      const res = await h.api("GET", p);
      expect(res.status, p).toBe(401);
      expect(res.json()).toMatchObject({ error: "unauthenticated" });
    }
  });

  it("guards run before body parsing/validation", async () => {
    // No session + garbage/invalid bodies: 401, never 400/413.
    for (const [method, p] of [
      ["DELETE", "/api/scans/abc"],
      ["POST", "/api/scans"],
      ["PATCH", "/api/user"],
      ["PUT", "/api/devices/bad.id"],
    ]) {
      const res = await h.request(p, {
        method,
        headers: { "X-Requested-With": "fashion-assistant", "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status, `${method} ${p}`).toBe(401);
    }
    const big = await h.request("/api/scans", {
      method: "POST",
      headers: { "X-Requested-With": "fashion-assistant", "Content-Length": 5 * 1024 * 1024 },
      body: "x",
    }).catch(() => null);
    if (big) expect(big.status).toBe(401);
    // Missing X-Requested-With beats validation too (403).
    await h.signIn("good");
    const res = await h.request("/api/scans", { method: "POST", headers: { Cookie: h.cookie }, body: "{not json" });
    expect(res.status).toBe(403);
  });

  it("unknown or malformed session cookies => 401", async () => {
    h.cookie = `fa_session=${newSessionId()}`;
    expect((await h.api("GET", "/api/me")).status).toBe(401);
    h.cookie = "fa_session=not-a-valid-id";
    expect((await h.api("GET", "/api/me")).status).toBe(401);
  });

  it("expires after 30 days", async () => {
    await h.signIn("good");
    h.clock.now += SESSION_TTL_MS - 1000;
    expect((await h.api("GET", "/api/me")).status).toBe(200);
    h.clock.now += 2000;
    expect((await h.api("GET", "/api/me")).status).toBe(401);
    expect(h.store.sessionCount()).toBe(0); // expired session cleaned up
  });

  it("re-checks the allowlist on every request", async () => {
    await h.signIn("good");
    expect((await h.api("GET", "/api/me")).status).toBe(200);
    h.config.allowedEmail = "new-owner@example.com";
    expect((await h.api("GET", "/api/me")).status).toBe(401);
    h.config.allowedEmail = "allowed@example.com";
    expect((await h.api("GET", "/api/me")).status).toBe(200);
  });

  it("logout deletes the session and clears the cookie", async () => {
    await h.signIn("good");
    const res = await h.api("POST", "/api/logout");
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((res.headers["set-cookie"] ?? []).join(";")).toMatch(/fa_session=;.*Max-Age=0/);
    expect(h.store.sessionCount()).toBe(0);
    expect((await h.api("GET", "/api/me")).status).toBe(401);
  });

  it("state-changing requests need X-Requested-With", async () => {
    await h.signIn("good");
    for (const [method, p] of [
      ["POST", "/api/logout"],
      ["PATCH", "/api/user"],
      ["POST", "/api/scans"],
      ["DELETE", "/api/scans/abc"],
      ["PUT", "/api/devices/d1"],
      ["DELETE", "/api/me/data"],
    ]) {
      const res = await h.api(method, p, {}, { "X-Requested-With": "XMLHttpRequest" });
      expect(res.status, `${method} ${p}`).toBe(403);
      expect(res.json()).toMatchObject({ error: "forbidden" });
    }
    expect(h.store.sessionCount()).toBe(1);
  });
});

describe("emailAllowed", () => {
  const cfg = { allowedEmail: "a@b.com" } as Config;
  it("compares case-insensitively and rejects empty", () => {
    expect(emailAllowed("A@B.com", cfg)).toBe(true);
    expect(emailAllowed("x@b.com", cfg)).toBe(false);
    expect(emailAllowed(undefined, cfg)).toBe(false);
    expect(emailAllowed("a@b.com", { allowedEmail: "" } as Config)).toBe(false);
  });
});
