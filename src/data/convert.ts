// PURE Firestore <-> app conversions (design doc section 11).
// The app uses epoch ms; Firestore stores Timestamps. The SDK-specific
// pieces (Timestamp factory, deleteField sentinel) are injected so these
// functions can be unit-tested without the SDK.

import type {
  BodyType,
  CorrectionFactors,
  DeviceProfile,
  Diagnostics,
  MeasurementKey,
  ScanDoc,
  ScanStatus,
  ScaleSource,
  Units,
  UserDoc,
  ViewName,
} from "../types";
import { MEASUREMENT_KEYS, VIEWS } from "../types";

export type Data = Record<string, unknown>;
export type ToTimestamp = (ms: number) => unknown;

export interface WriteHelpers {
  toTimestamp: ToTimestamp;
  /** Sentinel written for optional top-level patch fields explicitly set to undefined. */
  deleteField: () => unknown;
}

const BODY_TYPES: readonly BodyType[] = ["male", "female", "unspecified"];
const STATUSES: readonly ScanStatus[] = ["complete", "partial"];
const SCALE_SOURCES: readonly ScaleSource[] = ["height", "height+floor", "paper"];
const UNITS: readonly Units[] = ["in", "cm"];
const KEY_SET = new Set<string>(MEASUREMENT_KEYS);

// ------------------------------------------------------------------ primitives

/** Timestamp-like (toMillis / seconds+nanoseconds), Date or number -> epoch ms. NaN if unknown. */
export function toMillis(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object") {
    const v = value as { toMillis?: unknown; seconds?: unknown; nanoseconds?: unknown };
    if (typeof v.toMillis === "function") return (v.toMillis as () => number).call(value);
    if (typeof v.seconds === "number") {
      const nanos = typeof v.nanoseconds === "number" ? v.nanoseconds : 0;
      return v.seconds * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return NaN;
}

function millisOr(value: unknown, fallback: number): number {
  const ms = toMillis(value);
  return Number.isFinite(ms) ? ms : fallback;
}

function isPlainObject(value: unknown): value is Data {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursively drop undefined values (Firestore rejects them). Non-plain objects (Timestamps etc.) are kept as-is. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== undefined).map((v) => stripUndefined(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Data = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function obj(value: unknown): Data {
  return isPlainObject(value) ? value : {};
}

/** Keep only known measurement keys with numeric values. */
export function keyNumberMap(value: unknown): Partial<Record<MeasurementKey, number>> {
  const out: Partial<Record<MeasurementKey, number>> = {};
  for (const [k, v] of Object.entries(obj(value))) {
    if (KEY_SET.has(k) && typeof v === "number") out[k as MeasurementKey] = v;
  }
  return out;
}

// ------------------------------------------------------------------ scans

export function scanToFirestore(scan: ScanDoc, h: Pick<WriteHelpers, "toTimestamp">): Data {
  const { id: _id, createdAt, ...rest } = scan;
  return stripUndefined({ ...rest, createdAt: h.toTimestamp(createdAt) }) as Data;
}

export function scanPatchToFirestore(patch: Partial<ScanDoc>, h: WriteHelpers): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id") continue;
    if (v === undefined) {
      // Only the optional field may be removed; undefined elsewhere is ignored.
      if (k === "tapeMeasurements") out[k] = h.deleteField();
      continue;
    }
    out[k] = k === "createdAt" ? h.toTimestamp(v as number) : stripUndefined(v);
  }
  return out;
}

export function scanFromFirestore(id: string, data: Data): ScanDoc {
  const measurements: ScanDoc["measurements"] = {};
  for (const [k, v] of Object.entries(obj(data.measurements))) {
    const m = obj(v);
    if (KEY_SET.has(k) && typeof m.valueCm === "number") {
      measurements[k as MeasurementKey] = {
        valueCm: m.valueCm,
        uncertaintyCm: num(m.uncertaintyCm, 0),
        confidence: num(m.confidence, 0),
      };
    }
  }
  const views = Array.isArray(data.viewsCaptured)
    ? data.viewsCaptured.filter((v): v is ViewName => (VIEWS as readonly unknown[]).includes(v))
    : [];
  const scan: ScanDoc = {
    id,
    createdAt: millisOr(data.createdAt, 0),
    status: oneOf(data.status, STATUSES, "complete"),
    heightCm: num(data.heightCm, NaN),
    bodyType: oneOf(data.bodyType, BODY_TYPES, "unspecified"),
    subjectLabel: str(data.subjectLabel, "me"),
    scaleSource: oneOf(data.scaleSource, SCALE_SOURCES, "height"),
    deviceId: str(data.deviceId, ""),
    appVersion: str(data.appVersion, ""),
    viewsCaptured: views,
    measurements,
    rawMeasurements: keyNumberMap(data.rawMeasurements),
    diagnostics: obj(data.diagnostics) as unknown as Diagnostics,
  };
  if (isPlainObject(data.tapeMeasurements)) scan.tapeMeasurements = keyNumberMap(data.tapeMeasurements);
  return scan;
}

/** Newest first; ties broken by id for a stable order. */
export function sortScansNewestFirst(scans: ScanDoc[]): ScanDoc[] {
  return [...scans].sort((a, b) => b.createdAt - a.createdAt || (a.id ?? "").localeCompare(b.id ?? ""));
}

// ------------------------------------------------------------------ users/{uid}

export function userFromFirestore(data: Data): UserDoc {
  const user: UserDoc = {
    email: str(data.email, ""),
    createdAt: millisOr(data.createdAt, 0),
    units: oneOf(data.units, UNITS, "in"),
    bodyType: oneOf(data.bodyType, BODY_TYPES, "unspecified"),
  };
  if (typeof data.heightCm === "number") user.heightCm = data.heightCm;
  return user;
}

/**
 * Patch for setDoc(..., { merge: true }). When the doc does not exist yet
 * (`isNew`), required fields get defaults and createdAt is set to `nowMs`.
 */
export function userPatchToFirestore(
  patch: Partial<UserDoc>,
  h: WriteHelpers,
  opts: { isNew: boolean; nowMs: number; email?: string | null },
): Data {
  const out: Data = {};
  if (opts.isNew) {
    out.email = (opts.email ?? "").toLowerCase();
    out.createdAt = h.toTimestamp(opts.nowMs);
    out.units = "in";
    out.bodyType = "unspecified";
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      if (k === "heightCm") out[k] = h.deleteField();
      continue;
    }
    out[k] = k === "createdAt" ? h.toTimestamp(v as number) : v;
  }
  return out;
}

// ------------------------------------------------------------------ devices

export function deviceToFirestore(profile: DeviceProfile, h: Pick<WriteHelpers, "toTimestamp">, nowMs: number): Data {
  const { deviceId: _deviceId, ...rest } = profile;
  return stripUndefined({ ...rest, updatedAt: h.toTimestamp(nowMs) }) as Data;
}

export function deviceFromFirestore(deviceId: string, data: Data): Partial<DeviceProfile> {
  const { updatedAt: _updatedAt, deviceId: _ignored, ...rest } = data;
  return { ...(rest as Partial<DeviceProfile>), deviceId };
}

// ------------------------------------------------------------------ settings/correctionFactors

export function factorsToFirestore(f: CorrectionFactors, h: Pick<WriteHelpers, "toTimestamp">, nowMs: number): Data {
  return {
    male: keyNumberMap(f.male),
    female: keyNumberMap(f.female),
    unspecified: keyNumberMap(f.unspecified),
    updatedAt: h.toTimestamp(f.updatedAt ?? nowMs),
  };
}

export function factorsFromFirestore(data: Data): CorrectionFactors {
  const f: CorrectionFactors = {
    male: keyNumberMap(data.male),
    female: keyNumberMap(data.female),
    unspecified: keyNumberMap(data.unspecified),
  };
  const ms = toMillis(data.updatedAt);
  if (Number.isFinite(ms)) f.updatedAt = ms;
  return f;
}

// ------------------------------------------------------------------ misc

/** Split into chunks of at most `size` (Firestore batches take <= 500 writes). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!(size >= 1)) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
