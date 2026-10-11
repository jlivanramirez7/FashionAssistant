// Sign-in with Google Identity Services (redirect ux_mode) and server
// sessions (CONTRACTS-v2 "Auth"). Never log ID tokens, session ids or
// cookies: errors from the verifier are swallowed without their message
// because google-auth-library may echo the token in it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { OAuth2Client } from "google-auth-library";
import type { Config } from "./config.ts";
import { appendSetCookie, parseCookies, readBody, redirect, serializeCookie } from "./http.ts";
import type { SessionRecord, Store } from "./store.ts";

export const SESSION_COOKIE = "fa_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes base64url
const MAX_FORM_BODY = 64 * 1024;

/** The subset of the ID token payload the server uses. */
export interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

/** Verifies a Google ID token for `audience`; throws when invalid. */
export type VerifyIdToken = (idToken: string, audience: string) => Promise<IdTokenClaims>;

/** Real verifier backed by google-auth-library (checks signature, aud, iss, exp). */
export function createGoogleVerifier(): VerifyIdToken {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) throw new Error("ID token has no payload");
    return { sub: payload.sub, email: payload.email, email_verified: payload.email_verified };
  };
}

export interface Session extends SessionRecord {
  idHash: string;
}

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sessionCookie(id: string, config: Config): string {
  return serializeCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAgeSec: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(config: Config): string {
  return serializeCookie(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAgeSec: 0,
  });
}

/** true when the (verified) email may use the app. Empty allowlist => nobody. */
export function emailAllowed(email: string | undefined, config: Config): boolean {
  return !!config.allowedEmail && !!email && email.trim().toLowerCase() === config.allowedEmail;
}

export interface AuthDeps {
  config: Config;
  store: Store;
  verifyIdToken: VerifyIdToken;
  now: () => number;
  log: (severity: "INFO" | "WARNING" | "ERROR", message: string) => void;
}

export type SignInOutcome = "ok" | "private" | "failed";

/**
 * POST /api/auth/google (GIS redirect target). Double-submit CSRF check,
 * ID token verification, allowlist. Always answers with a 303.
 */
export async function handleGoogleSignIn(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<SignInOutcome> {
  const outcome = await signIn(req, res, deps);
  if (outcome === "ok") redirect(res, "/");
  else redirect(res, `/?auth_error=${outcome}`);
  return outcome;
}

async function signIn(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<SignInOutcome> {
  const { config } = deps;
  let form: URLSearchParams;
  try {
    const type = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!type.startsWith("application/x-www-form-urlencoded")) return "failed";
    form = new URLSearchParams((await readBody(req, MAX_FORM_BODY)).toString("utf8"));
  } catch {
    return "failed";
  }

  const cookieToken = parseCookies(req.headers.cookie).g_csrf_token ?? "";
  const bodyToken = form.get("g_csrf_token") ?? "";
  if (!cookieToken || !bodyToken || !safeEqual(cookieToken, bodyToken)) {
    deps.log("WARNING", "sign-in rejected: CSRF token missing or mismatched");
    return "failed";
  }

  const credential = form.get("credential") ?? "";
  if (!credential || !config.googleClientId) {
    deps.log("WARNING", config.googleClientId ? "sign-in rejected: no credential" : "sign-in rejected: GOOGLE_CLIENT_ID not configured");
    return "failed";
  }

  let claims: IdTokenClaims;
  try {
    claims = await deps.verifyIdToken(credential, config.googleClientId);
  } catch {
    // Do not log the error: its message can contain the token.
    deps.log("WARNING", "sign-in rejected: ID token verification failed");
    return "failed";
  }

  if (claims.email_verified !== true || !emailAllowed(claims.email, config)) {
    deps.log("WARNING", "sign-in rejected: account not allowed");
    return "private";
  }

  const id = newSessionId();
  const now = deps.now();
  await deps.store.createSession(hashSessionId(id), {
    uid: claims.sub,
    email: (claims.email ?? "").toLowerCase(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  appendSetCookie(res, sessionCookie(id, config));
  deps.log("INFO", "sign-in ok");
  return "ok";
}

/**
 * Valid session for this request or null (no/garbled cookie, unknown,
 * expired, or email no longer allowed). Expired sessions are deleted.
 */
export async function getSession(req: IncomingMessage, deps: AuthDeps): Promise<Session | null> {
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!id || !SESSION_ID_RE.test(id)) return null;
  const idHash = hashSessionId(id);
  const rec = await deps.store.getSession(idHash);
  if (!rec) return null;
  if (rec.expiresAt <= deps.now()) {
    await deps.store.deleteSession(idHash).catch(() => undefined);
    return null;
  }
  if (!emailAllowed(rec.email, deps.config)) return null;
  return { ...rec, idHash };
}
