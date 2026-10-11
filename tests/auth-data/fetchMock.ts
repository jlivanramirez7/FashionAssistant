import { vi } from "vitest";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

export type Responder = (call: Call) => Response | Promise<Response> | "network-error";

export function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Installs a fetch mock; responders are used in order (the last one repeats). */
export function mockFetch(...responders: Responder[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      credentials: init?.credentials,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const responder = responders[Math.min(i++, responders.length - 1)];
    const res = await responder(call);
    if (res === "network-error") throw new TypeError("Failed to fetch");
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
}
