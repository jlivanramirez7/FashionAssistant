// JSON client for the server API (docs/CONTRACTS-v2.md).

export const REQUESTED_WITH = "fashion-assistant";

/** The server answered with an error status ({ error, message } body). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** The request never reached the server (offline, DNS, CORS, aborted...). */
export class NetworkError extends Error {
  constructor(message = "Network error - you appear to be offline.") {
    super(message);
    this.name = "NetworkError";
  }
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Builds the error thrown for a non-2xx response from its status and (maybe JSON) body text. */
export function errorFromResponse(status: number, bodyText: string): ApiError {
  let code = `http_${status}`;
  let message = "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error) code = parsed.error;
      if (typeof parsed.message === "string") message = parsed.message;
    }
  } catch {
    /* not JSON */
  }
  if (!message) {
    message =
      status === 401
        ? "You are signed out. Please sign in again."
        : status === 403
          ? "Not allowed."
          : status === 404
            ? "Not found."
            : `Request failed (${status}).`;
  }
  return new ApiError(status, code, message);
}

/** fetch wrapper: same-origin cookies, JSON in/out, X-Requested-With on writes, errors thrown. */
export async function api<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Requested-With"] = REQUESTED_WITH;
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new NetworkError(err instanceof Error && err.message ? `Network error: ${err.message}` : undefined);
  }
  const text = await res.text();
  if (!res.ok) throw errorFromResponse(res.status, text);
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, "bad_json", "The server sent an invalid response.");
  }
}

/** Encodes one path segment (ids are validated server side). */
export function seg(id: string): string {
  return encodeURIComponent(id);
}
