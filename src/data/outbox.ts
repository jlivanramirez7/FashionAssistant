// Offline outbox for new scans (docs/CONTRACTS-v2.md). A scan saved while
// offline (or when the request fails with a network error) is kept in
// localStorage "fa.outbox" under a client id and POSTed later with that
// clientId; the server uses it as the doc id, so retries are idempotent.

import type { ScanDoc } from "../types";
import { api, ApiError, NetworkError } from "./api";

export const OUTBOX_KEY = "fa.outbox";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface OutboxEntry {
  clientId: string;
  queuedAt: number;
  scan: ScanDoc;
}

export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isValidClientId(id: string): boolean {
  return ID_RE.test(id);
}

export function readOutbox(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is OutboxEntry =>
        !!e && typeof e === "object" && typeof (e as OutboxEntry).clientId === "string" &&
        isValidClientId((e as OutboxEntry).clientId) && !!(e as OutboxEntry).scan &&
        typeof (e as OutboxEntry).scan === "object",
    );
  } catch {
    return [];
  }
}

/** Throws if storage is unavailable/full - the caller must not pretend the scan was saved. */
function writeOutbox(entries: OutboxEntry[]): void {
  if (entries.length === 0) localStorage.removeItem(OUTBOX_KEY);
  else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries));
}

export function clearOutbox(): void {
  try {
    localStorage.removeItem(OUTBOX_KEY);
  } catch {
    /* ignore */
  }
}

/** Queue a scan; returns its client id (also its future server id). */
export function enqueueScan(scan: ScanDoc, clientId: string = newClientId()): string {
  const { id: _id, ...rest } = scan;
  const entries = readOutbox().filter((e) => e.clientId !== clientId);
  entries.push({ clientId, queuedAt: Date.now(), scan: rest });
  writeOutbox(entries);
  ensureOnlineListener();
  return clientId;
}

export function findOutboxScan(id: string): ScanDoc | null {
  const e = readOutbox().find((x) => x.clientId === id);
  return e ? { ...e.scan, id: e.clientId } : null;
}

/** Replace a queued scan in place; false if it is no longer queued. */
export function replaceOutboxScan(id: string, scan: ScanDoc): boolean {
  const entries = readOutbox();
  const e = entries.find((x) => x.clientId === id);
  if (!e) return false;
  const { id: _id, ...rest } = scan;
  e.scan = rest;
  writeOutbox(entries);
  return true;
}

export function removeOutboxScan(id: string): boolean {
  const entries = readOutbox();
  const kept = entries.filter((x) => x.clientId !== id);
  if (kept.length === entries.length) return false;
  writeOutbox(kept);
  return true;
}

/** Statuses meaning "this body will never be accepted": drop it instead of retrying forever. */
function isPermanentRejection(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 400 || err.status === 413 || err.status === 422);
}

let flushing: Promise<number> | null = null;

/**
 * POST every queued scan (with its clientId). Stops at the first network
 * error or auth/server error and keeps the rest for later. Returns how many
 * were sent. Concurrent calls share one run. Call at app start; also runs on
 * `online` events.
 */
export function flushOutbox(): Promise<number> {
  ensureOnlineListener();
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const entry of readOutbox()) {
      try {
        await api<{ id: string }>("POST", "/api/scans", { ...entry.scan, clientId: entry.clientId });
        removeOutboxScan(entry.clientId);
        sent++;
      } catch (err) {
        if (isPermanentRejection(err)) {
          console.error("Outbox scan rejected by the server; dropping it", entry.clientId, err);
          removeOutboxScan(entry.clientId);
          continue;
        }
        if (!(err instanceof NetworkError)) console.warn("Outbox flush paused", err);
        break;
      }
    }
    return sent;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

let listening = false;
function ensureOnlineListener(): void {
  if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  listening = true;
  window.addEventListener("online", () => {
    flushOutbox().catch((err) => console.warn("Outbox flush failed", err));
  });
}
