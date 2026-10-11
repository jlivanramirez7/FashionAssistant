// PURE request-body helpers. JSON drops undefined, so fields the app clears
// with `undefined` are sent as null (the server deletes them).

import type { ScanDoc, UserDoc } from "../types";

/** PATCH /api/scans/:id body: id removed, tapeMeasurements undefined -> null. */
export function scanPatchBody(patch: Partial<ScanDoc>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    if (v === undefined) {
      if (k === "tapeMeasurements") out[k] = null;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** PATCH /api/user body: heightCm undefined -> null. */
export function userPatchBody(patch: Partial<UserDoc>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      if (k === "heightCm") out[k] = null;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Applies a scan patch locally (outbox entries): undefined/null tapeMeasurements removes it. */
export function applyScanPatch(scan: ScanDoc, patch: Partial<ScanDoc>): ScanDoc {
  const out: ScanDoc = { ...scan };
  for (const [k, v] of Object.entries(patch) as [keyof ScanDoc, unknown][]) {
    if (k === "id") continue;
    if (v === undefined || v === null) {
      if (k === "tapeMeasurements") delete out.tapeMeasurements;
      continue;
    }
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Newest first; ties broken by id for a stable order. */
export function sortScansNewestFirst(scans: ScanDoc[]): ScanDoc[] {
  return [...scans].sort((a, b) => b.createdAt - a.createdAt || (a.id ?? "").localeCompare(b.id ?? ""));
}
