// Troubleshooting reports via the API (users/{uid}/diagnostics/{id}).
// Frames arrive here already JPEG-encoded (bytes only).
import type { DiagAttempt, DiagReport } from "../types";
import { api, errorFromResponse, NetworkError, REQUESTED_WITH, seg } from "./api";

const BASE = "/api/diagnostics";

export function listDiagReports(): Promise<DiagReport[]> {
  return api<DiagReport[]>("GET", BASE);
}

export function getDiagReport(id: string): Promise<{ report: DiagReport; attempts: DiagAttempt[] }> {
  return api("GET", `${BASE}/${seg(id)}`);
}

export async function putDiagReport(id: string, report: DiagReport): Promise<void> {
  await api("PUT", `${BASE}/${seg(id)}`, report);
}

export async function putDiagAttempt(id: string, attempt: DiagAttempt): Promise<void> {
  await api("PUT", `${BASE}/${seg(id)}/attempts/${attempt.n}`, attempt);
}

export async function deleteDiagReport(id: string): Promise<void> {
  await api("DELETE", `${BASE}/${seg(id)}`);
}

/** Upload one JPEG (raw body, not JSON). */
export async function putDiagFrame(id: string, frameId: string, jpeg: Uint8Array): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${seg(id)}/frames/${seg(frameId)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "image/jpeg", "X-Requested-With": REQUESTED_WITH },
      body: new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error && err.message ? `Network error: ${err.message}` : undefined);
  }
  if (!res.ok) throw errorFromResponse(res.status, await res.text());
}

/** Plain-text report (same text as report.txt in the bundle). */
export async function getDiagReportText(id: string): Promise<string> {
  const res = await fetch(`${BASE}/${seg(id)}/report.txt`, { credentials: "same-origin" });
  const text = await res.text();
  if (!res.ok) throw errorFromResponse(res.status, text);
  return text;
}

export function diagFrameUrl(id: string, frameId: string): string {
  return `${BASE}/${seg(id)}/frames/${seg(frameId)}`;
}

export function diagBundleUrl(id: string, attempt?: number): string {
  return `${BASE}/${seg(id)}/bundle.zip${attempt ? `?attempt=${attempt}` : ""}`;
}
