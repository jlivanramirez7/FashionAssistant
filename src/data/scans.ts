// Scans via the server API (docs/CONTRACTS-v2.md). `uid` params are kept
// for compatibility and ignored: the server uses the session.
// Scans saved offline live in the outbox until flushed; the functions here
// treat outbox scans like stored ones.

import type { ScanDoc } from "../types";
import { api, ApiError, isOffline, NetworkError, seg } from "./api";
import { applyScanPatch, scanPatchBody, sortScansNewestFirst } from "./serialize";
import {
  enqueueScan,
  findOutboxScan,
  newClientId,
  readOutbox,
  removeOutboxScan,
  replaceOutboxScan,
} from "./outbox";

export { flushOutbox } from "./outbox";

/**
 * Saves a new scan and returns its id. Never loses the scan: offline or on a
 * network error it is queued in the outbox (id = clientId) and synced later.
 */
export async function saveScan(_uid: string, scan: ScanDoc): Promise<string> {
  const clientId = newClientId();
  const { id: _id, ...body } = scan;
  if (isOffline()) return enqueueScan(scan, clientId);
  try {
    const res = await api<{ id: string }>("POST", "/api/scans", { ...body, clientId });
    return res.id;
  } catch (err) {
    if (err instanceof NetworkError) return enqueueScan(scan, clientId);
    throw err;
  }
}

export async function updateScan(_uid: string, id: string, patch: Partial<ScanDoc>): Promise<void> {
  const queued = findOutboxScan(id);
  if (queued && replaceOutboxScan(id, applyScanPatch(queued, patch))) return;
  const body = scanPatchBody(patch);
  if (Object.keys(body).length === 0) return;
  await api("PATCH", `/api/scans/${seg(id)}`, body);
}

export async function getScan(_uid: string, id: string): Promise<ScanDoc | null> {
  const queued = findOutboxScan(id);
  if (queued) return queued;
  try {
    return await api<ScanDoc>("GET", `/api/scans/${seg(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** All scans newest first, including scans still waiting in the outbox. */
export async function listScans(_uid: string): Promise<ScanDoc[]> {
  const server = (await api<ScanDoc[]>("GET", "/api/scans")) ?? [];
  const ids = new Set(server.map((s) => s.id));
  const pending = readOutbox()
    .filter((e) => !ids.has(e.clientId))
    .map((e) => ({ ...e.scan, id: e.clientId }));
  return sortScansNewestFirst([...server, ...pending]);
}

export async function deleteScan(_uid: string, id: string): Promise<void> {
  if (removeOutboxScan(id)) return;
  await api("DELETE", `/api/scans/${seg(id)}`);
}
