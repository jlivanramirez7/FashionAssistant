// Pure request validation (CONTRACTS-v2 "Server-side validation").
// Each validator returns { ok: true, value } with a cleaned copy or
// { ok: false, message }.
import { MEASUREMENT_KEYS } from "../src/types.ts";
import type {
  BodyType,
  CorrectionFactors,
  DeviceProfile,
  MeasurementKey,
  Measurements,
  RawMeasurements,
  ScanDoc,
  Units,
  ViewName,
} from "../src/types.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_STRING_LENGTH = 10_000;
export const MAX_NUMBER_ARRAY = 10_000;
const MAX_DEPTH = 12;

const BODY_TYPES: readonly BodyType[] = ["male", "female", "unspecified"];
const UNITS: readonly Units[] = ["in", "cm"];
const VIEW_NAMES: readonly ViewName[] = ["front", "side", "back"];
const STATUSES: readonly string[] = ["complete", "partial"];
const SCALE_SOURCES: readonly string[] = ["height", "height+floor", "paper"];
const MODEL_SOURCES: readonly string[] = ["ua-client-hints", "screen-match", "generic"];
const LENS_SOURCES: readonly string[] = ["profile", "paper", "generic"];
const FOCAL_SOURCES: readonly string[] = ["spec", "height-solve", "paper"];
const KEY_SET: ReadonlySet<string> = new Set(MEASUREMENT_KEYS);

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/**
 * Reject anything that looks like image data anywhere in the value:
 * strings over 10 kB, data: URLs, arrays over 10k entries. Also rejects
 * nested arrays (Firestore cannot store them) and very deep nesting.
 * Returns an error message or null.
 */
export function findImageLikeData(value: unknown, where = "body", depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${where}: nested too deeply`;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) return `${where}: string too long (looks like image data)`;
    if (/^\s*data:/i.test(value)) return `${where}: data: URLs are not allowed`;
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_NUMBER_ARRAY) return `${where}: array too long (looks like image data)`;
    for (let i = 0; i < value.length; i++) {
      if (Array.isArray(value[i])) return `${where}[${i}]: nested arrays are not allowed`;
      const err = findImageLikeData(value[i], `${where}[${i}]`, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k.length > 200) return `${where}: key too long`;
      const err = findImageLikeData(v, `${where}.${k}`, depth + 1);
      if (err) return err;
    }
  }
  return null;
}

function unknownKey(obj: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${where}: unknown field "${k}"`;
  return null;
}

/** name -> finite number map, MEASUREMENT_KEYS only. */
export function validateNumberMap(
  v: unknown,
  where: string,
  positive = false,
): Result<Partial<Record<MeasurementKey, number>>> {
  if (!isPlainObject(v)) return fail(`${where} must be an object`);
  const out: Partial<Record<MeasurementKey, number>> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!KEY_SET.has(k)) return fail(`${where}: unknown measurement key "${k}"`);
    if (!isFiniteNum(n) || (positive && n <= 0)) return fail(`${where}.${k} must be a finite number`);
    out[k as MeasurementKey] = n;
  }
  return { ok: true, value: out };
}

/** name -> { valueCm, uncertaintyCm, confidence } map. */
export function validateMeasurements(v: unknown, where = "measurements"): Result<Measurements> {
  if (!isPlainObject(v)) return fail(`${where} must be an object`);
  const out: Measurements = {};
  for (const [k, m] of Object.entries(v)) {
    if (!KEY_SET.has(k)) return fail(`${where}: unknown measurement key "${k}"`);
    if (!isPlainObject(m)) return fail(`${where}.${k} must be an object`);
    const bad = unknownKey(m, ["valueCm", "uncertaintyCm", "confidence"], `${where}.${k}`);
    if (bad) return fail(bad);
    const { valueCm, uncertaintyCm, confidence } = m;
    if (!isFiniteNum(valueCm) || !isFiniteNum(uncertaintyCm) || !isFiniteNum(confidence)) {
      return fail(`${where}.${k} needs finite valueCm, uncertaintyCm, confidence`);
    }
    out[k as MeasurementKey] = { valueCm, uncertaintyCm, confidence };
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- user

export interface UserPatch {
  heightCm?: number | null;
  units?: Units;
  bodyType?: BodyType;
}

/** PATCH /api/user. email/createdAt are accepted but ignored (server-owned). */
export function validateUserPatch(body: unknown): Result<UserPatch> {
  if (!isPlainObject(body)) return fail("Body must be an object");
  const img = findImageLikeData(body);
  if (img) return fail(img);
  const bad = unknownKey(body, ["heightCm", "units", "bodyType", "email", "createdAt"], "user");
  if (bad) return fail(bad);
  const out: UserPatch = {};
  if ("heightCm" in body) {
    const h = body.heightCm;
    if (h === null) out.heightCm = null;
    else if (isFiniteNum(h) && h > 0 && h < 300) out.heightCm = h;
    else return fail("heightCm must be a number in (0, 300) or null");
  }
  if ("units" in body) {
    if (!UNITS.includes(body.units as Units)) return fail("units must be in or cm");
    out.units = body.units as Units;
  }
  if ("bodyType" in body) {
    if (!BODY_TYPES.includes(body.bodyType as BodyType)) return fail("bad bodyType");
    out.bodyType = body.bodyType as BodyType;
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- scans

/** Scan fields as stored (no id). `tapeMeasurements: null` = delete (patch only). */
export type ScanPatch = Partial<Omit<ScanDoc, "id" | "tapeMeasurements">> & {
  tapeMeasurements?: ScanDoc["tapeMeasurements"] | null;
};

const SCAN_REQUIRED = [
  "createdAt", "status", "heightCm", "bodyType", "subjectLabel", "scaleSource", "deviceId",
  "appVersion", "viewsCaptured", "measurements", "rawMeasurements", "diagnostics",
];

function validateScanFields(body: Record<string, unknown>, partial: boolean): Result<ScanPatch> {
  const out: ScanPatch = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "id" || k === "clientId") continue; // id comes from the URL / server
    switch (k) {
      case "createdAt":
        if (!isFiniteNum(v) || v < 0) return fail("createdAt must be epoch ms");
        out.createdAt = v;
        break;
      case "status":
        if (typeof v !== "string" || !STATUSES.includes(v)) return fail("bad status");
        out.status = v as ScanDoc["status"];
        break;
      case "heightCm":
        if (!isFiniteNum(v) || v <= 0 || v >= 300) return fail("heightCm must be in (0, 300)");
        out.heightCm = v;
        break;
      case "bodyType":
        if (!BODY_TYPES.includes(v as BodyType)) return fail("bad bodyType");
        out.bodyType = v as BodyType;
        break;
      case "subjectLabel":
      case "deviceId":
      case "appVersion":
        if (typeof v !== "string" || v.length > 200) return fail(`${k} must be a short string`);
        out[k] = v;
        break;
      case "scaleSource":
        if (typeof v !== "string" || !SCALE_SOURCES.includes(v)) return fail("bad scaleSource");
        out.scaleSource = v as ScanDoc["scaleSource"];
        break;
      case "viewsCaptured":
        if (!Array.isArray(v) || v.length > 3 || !v.every((x) => VIEW_NAMES.includes(x as ViewName))) {
          return fail("viewsCaptured must be a list of views");
        }
        out.viewsCaptured = v as ViewName[];
        break;
      case "measurements": {
        const r = validateMeasurements(v);
        if (!r.ok) return r;
        out.measurements = r.value;
        break;
      }
      case "rawMeasurements": {
        const r = validateNumberMap(v, "rawMeasurements");
        if (!r.ok) return r;
        out.rawMeasurements = r.value as RawMeasurements;
        break;
      }
      case "tapeMeasurements": {
        if (v === null) {
          if (!partial) return fail("tapeMeasurements cannot be null here");
          out.tapeMeasurements = null;
          break;
        }
        const r = validateNumberMap(v, "tapeMeasurements", true);
        if (!r.ok) return r;
        out.tapeMeasurements = r.value;
        break;
      }
      case "diagnostics":
        if (!isPlainObject(v)) return fail("diagnostics must be an object");
        out.diagnostics = v as unknown as ScanDoc["diagnostics"];
        break;
      default:
        return fail(`scan: unknown field "${k}"`);
    }
  }
  if (!partial) {
    for (const f of SCAN_REQUIRED) if (!(f in out)) return fail(`scan: missing field "${f}"`);
  }
  return { ok: true, value: out };
}

/** POST /api/scans: full ScanDoc plus optional clientId. */
export function validateNewScan(body: unknown): Result<{ scan: ScanDoc; clientId?: string }> {
  if (!isPlainObject(body)) return fail("Body must be an object");
  const img = findImageLikeData(body);
  if (img) return fail(img);
  let clientId: string | undefined;
  if (body.clientId !== undefined && body.clientId !== null) {
    if (!isValidId(body.clientId)) return fail("clientId must match ^[A-Za-z0-9_-]{1,64}$");
    clientId = body.clientId;
  }
  const r = validateScanFields(body, false);
  if (!r.ok) return r;
  return { ok: true, value: { scan: r.value as ScanDoc, clientId } };
}

/** PATCH /api/scans/:id. */
export function validateScanPatch(body: unknown): Result<ScanPatch> {
  if (!isPlainObject(body)) return fail("Body must be an object");
  const img = findImageLikeData(body);
  if (img) return fail(img);
  if ("clientId" in body) return fail('scan: unknown field "clientId"');
  return validateScanFields(body, true);
}

// ---------------------------------------------------------------- devices

const DEVICE_REQUIRED = [
  "label", "deviceModelGuess", "modelSource", "screen", "lensOffsetCm", "lensOffsetSource",
  "front35mmEqMm", "focalLengthPx", "focalLengthSource", "captureWidth", "captureHeight", "calibrationScans",
];
const DEVICE_FIELDS = [...DEVICE_REQUIRED, "deviceId", "phoneHeightMm", "distortionK1", "updatedAt"];
const DEVICE_NUMBERS = ["lensOffsetCm", "front35mmEqMm", "focalLengthPx", "captureWidth", "captureHeight", "calibrationScans"];

/** PUT /api/devices/:deviceId. The stored deviceId is forced to the path id. */
export function validateDevice(body: unknown, deviceId: string): Result<DeviceProfile> {
  if (!isPlainObject(body)) return fail("Body must be an object");
  const img = findImageLikeData(body);
  if (img) return fail(img);
  const bad = unknownKey(body, DEVICE_FIELDS, "device");
  if (bad) return fail(bad);
  for (const f of DEVICE_REQUIRED) if (!(f in body)) return fail(`device: missing field "${f}"`);
  const shortStr = (k: string): boolean => typeof body[k] === "string" && (body[k] as string).length <= 200;
  if (!shortStr("label") || !shortStr("deviceModelGuess")) return fail("label/deviceModelGuess must be short strings");
  if (body.deviceId !== undefined && body.deviceId !== deviceId) return fail("deviceId does not match the URL");
  if (!MODEL_SOURCES.includes(body.modelSource as string)) return fail("bad modelSource");
  if (!LENS_SOURCES.includes(body.lensOffsetSource as string)) return fail("bad lensOffsetSource");
  if (!FOCAL_SOURCES.includes(body.focalLengthSource as string)) return fail("bad focalLengthSource");
  for (const k of DEVICE_NUMBERS) if (!isFiniteNum(body[k])) return fail(`${k} must be a finite number`);
  for (const k of ["phoneHeightMm", "distortionK1"]) {
    if (body[k] !== undefined && !isFiniteNum(body[k])) return fail(`${k} must be a finite number`);
  }
  const s = body.screen;
  if (
    !isPlainObject(s) ||
    unknownKey(s, ["width", "height", "devicePixelRatio"], "screen") !== null ||
    !isFiniteNum(s.width) || !isFiniteNum(s.height) || !isFiniteNum(s.devicePixelRatio)
  ) {
    return fail("screen must be { width, height, devicePixelRatio }");
  }
  const out: DeviceProfile = {
    deviceId,
    label: body.label as string,
    deviceModelGuess: body.deviceModelGuess as string,
    modelSource: body.modelSource as DeviceProfile["modelSource"],
    screen: { width: s.width, height: s.height, devicePixelRatio: s.devicePixelRatio },
    lensOffsetCm: body.lensOffsetCm as number,
    lensOffsetSource: body.lensOffsetSource as DeviceProfile["lensOffsetSource"],
    front35mmEqMm: body.front35mmEqMm as number,
    focalLengthPx: body.focalLengthPx as number,
    focalLengthSource: body.focalLengthSource as DeviceProfile["focalLengthSource"],
    captureWidth: body.captureWidth as number,
    captureHeight: body.captureHeight as number,
    calibrationScans: body.calibrationScans as number,
  };
  if (body.phoneHeightMm !== undefined) out.phoneHeightMm = body.phoneHeightMm as number;
  if (body.distortionK1 !== undefined) out.distortionK1 = body.distortionK1 as number;
  return { ok: true, value: out };
}

// ---------------------------------------------------------------- correction factors

/** PUT /api/settings/correctionFactors. Missing groups default to {}. */
export function validateFactors(body: unknown): Result<CorrectionFactors> {
  if (!isPlainObject(body)) return fail("Body must be an object");
  const img = findImageLikeData(body);
  if (img) return fail(img);
  const bad = unknownKey(body, ["male", "female", "unspecified", "updatedAt"], "correctionFactors");
  if (bad) return fail(bad);
  const out: CorrectionFactors = { male: {}, female: {}, unspecified: {} };
  for (const g of BODY_TYPES) {
    const r = validateNumberMap(body[g] ?? {}, g, true);
    if (!r.ok) return r;
    out[g] = r.value;
  }
  if (body.updatedAt !== undefined) {
    if (!isFiniteNum(body.updatedAt) || body.updatedAt < 0) return fail("updatedAt must be epoch ms");
    out.updatedAt = body.updatedAt;
  }
  return { ok: true, value: out };
}
