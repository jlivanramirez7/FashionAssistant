// The app: security headers, /api routes and static files.
// createApp(deps) is what index.ts mounts and what tests drive.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import {
  HttpError,
  appendSetCookie,
  matchPath,
  readJson,
  sendError,
  sendJson,
  setSecurityHeaders,
  splitUrl,
} from "./http.ts";
import type { Params } from "./http.ts";
import { clearSessionCookie, getSession, handleGoogleSignIn } from "./auth.ts";
import type { AuthDeps, Session, VerifyIdToken } from "./auth.ts";
import { createStaticServer } from "./static.ts";
import type { Store } from "./store.ts";
import {
  isValidId,
  validateDevice,
  validateFactors,
  validateNewScan,
  validateScanPatch,
  validateUserPatch,
} from "./validate.ts";

export type LogFn = (severity: "INFO" | "WARNING" | "ERROR", message: string) => void;

export interface AppDeps {
  config: Config;
  store: Store;
  verifyIdToken: VerifyIdToken;
  /** Clock (epoch ms); injectable for session-expiry tests. */
  now?: () => number;
  log?: LogFn;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** Structured one-line logs for Cloud Logging. Never pass secrets here. */
export const defaultLog: LogFn = (severity, message) => {
  const line = JSON.stringify({ severity, message });
  if (severity === "ERROR") console.error(line);
  else console.log(line);
};

export const XRW_HEADER = "x-requested-with";
export const XRW_VALUE = "fashion-assistant";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Params;
  session: Session;
  deps: AuthDeps;
}

type Handler = (ctx: Ctx) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  handler: Handler;
}

function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

function idParam(params: Params, name: string): string {
  const id = params[name];
  if (!isValidId(id)) throw badRequest(`${name} must match ^[A-Za-z0-9_-]{1,64}$`);
  return id;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: "/api/me",
    handler: async ({ res, session }) => sendJson(res, 200, { uid: session.uid, email: session.email }),
  },
  {
    method: "POST",
    pattern: "/api/logout",
    handler: async ({ res, session, deps }) => {
      await deps.store.deleteSession(session.idHash);
      appendSetCookie(res, clearSessionCookie(deps.config));
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "DELETE",
    pattern: "/api/me/data",
    handler: async ({ res, session, deps }) => {
      await deps.store.deleteAllForUser(session.uid);
      await deps.store.deleteSessionsForUid(session.uid);
      appendSetCookie(res, clearSessionCookie(deps.config));
      deps.log("INFO", "deleted all data for the signed-in user");
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: "/api/user",
    handler: async ({ res, session, deps }) => sendJson(res, 200, await deps.store.getUser(session.uid)),
  },
  {
    method: "PATCH",
    pattern: "/api/user",
    handler: async ({ req, res, session, deps }) => {
      const r = validateUserPatch(await readJson(req));
      if (!r.ok) throw badRequest(r.message);
      sendJson(res, 200, await deps.store.patchUser(session.uid, session.email, r.value, deps.now()));
    },
  },
  {
    method: "GET",
    pattern: "/api/scans",
    handler: async ({ res, session, deps }) => sendJson(res, 200, await deps.store.listScans(session.uid)),
  },
  {
    method: "POST",
    pattern: "/api/scans",
    handler: async ({ req, res, session, deps }) => {
      const r = validateNewScan(await readJson(req));
      if (!r.ok) throw badRequest(r.message);
      const id = await deps.store.createScan(session.uid, r.value.scan, r.value.clientId);
      sendJson(res, 200, { id });
    },
  },
  {
    method: "GET",
    pattern: "/api/scans/:id",
    handler: async ({ res, params, session, deps }) => {
      const scan = await deps.store.getScan(session.uid, idParam(params, "id"));
      if (!scan) throw new HttpError(404, "not_found", "Scan not found");
      sendJson(res, 200, scan);
    },
  },
  {
    method: "PATCH",
    pattern: "/api/scans/:id",
    handler: async ({ req, res, params, session, deps }) => {
      const id = idParam(params, "id");
      const r = validateScanPatch(await readJson(req));
      if (!r.ok) throw badRequest(r.message);
      if (!(await deps.store.patchScan(session.uid, id, r.value))) {
        throw new HttpError(404, "not_found", "Scan not found");
      }
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "DELETE",
    pattern: "/api/scans/:id",
    handler: async ({ res, params, session, deps }) => {
      await deps.store.deleteScan(session.uid, idParam(params, "id"));
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: "/api/devices/:deviceId",
    handler: async ({ res, params, session, deps }) => {
      sendJson(res, 200, await deps.store.getDevice(session.uid, idParam(params, "deviceId")));
    },
  },
  {
    method: "PUT",
    pattern: "/api/devices/:deviceId",
    handler: async ({ req, res, params, session, deps }) => {
      const deviceId = idParam(params, "deviceId");
      const r = validateDevice(await readJson(req), deviceId);
      if (!r.ok) throw badRequest(r.message);
      await deps.store.putDevice(session.uid, deviceId, r.value, deps.now());
      sendJson(res, 200, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: "/api/settings/correctionFactors",
    handler: async ({ res, session, deps }) => sendJson(res, 200, await deps.store.getFactors(session.uid)),
  },
  {
    method: "PUT",
    pattern: "/api/settings/correctionFactors",
    handler: async ({ req, res, session, deps }) => {
      const r = validateFactors(await readJson(req));
      if (!r.ok) throw badRequest(r.message);
      await deps.store.putFactors(session.uid, r.value, deps.now());
      sendJson(res, 200, { ok: true });
    },
  },
];

/** Firestore INVALID_ARGUMENT (e.g. a value it cannot store) -> 400. */
function isInvalidArgument(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 3;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, deps: AuthDeps): Promise<void> {
  const method = req.method ?? "GET";

  if (pathname === "/api/health") {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Use GET");
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === "/api/auth/google") {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
    await handleGoogleSignIn(req, res, deps);
    return;
  }

  if (WRITE_METHODS.has(method) && req.headers[XRW_HEADER] !== XRW_VALUE) {
    throw new HttpError(403, "forbidden", `Missing header X-Requested-With: ${XRW_VALUE}`);
  }

  const session = await getSession(req, deps);
  if (!session) throw new HttpError(401, "unauthenticated", "Sign in required");

  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.pattern, pathname);
    if (!params) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    await route.handler({ req, res, params, session, deps });
    return;
  }
  if (pathMatched) throw new HttpError(405, "method_not_allowed", `${method} not allowed here`);
  throw new HttpError(404, "not_found", "Unknown API route");
}

export function createApp(deps: AppDeps): RequestHandler {
  const log = deps.log ?? defaultLog;
  const authDeps: AuthDeps = {
    config: deps.config,
    store: deps.store,
    verifyIdToken: deps.verifyIdToken,
    now: deps.now ?? Date.now,
    log,
  };
  const statics = createStaticServer(deps.config.distDir);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const { pathname } = splitUrl(req.url);
    const method = req.method ?? "GET";

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, authDeps);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      throw new HttpError(405, "method_not_allowed", "Use GET");
    }
    if (!(await statics.serve(req, res, pathname))) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(method === "HEAD" ? undefined : "Not found");
    }
  }

  return (req, res) => {
    // Cloud Run logs every request itself; we only log failures (path
    // only - never headers, cookies or bodies).
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("Connection", "close");
        sendError(res, err.status, err.code, err.message);
      } else if (isInvalidArgument(err)) {
        sendError(res, 400, "bad_request", "The data could not be stored");
      } else {
        // Store errors (e.g. Firestore PERMISSION_DENIED) are safe to log;
        // the auth path never lets verifier errors reach here.
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        log("ERROR", `request failed: ${req.method} ${splitUrl(req.url).pathname}: ${detail.slice(0, 500)}`);
        sendError(res, 500, "internal", "Internal server error");
      }
    });
  };
}
