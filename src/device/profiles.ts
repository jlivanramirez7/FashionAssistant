// Device spec table (design doc section 4, "Device profile (auto-detected)").
import type { DeviceSpec, ModelSource } from "../types";

/** Generic fallback: L_lens = 150 - 10 mm = 14 cm, 35 mm-eq 26 mm. */
export const GENERIC_SPEC: DeviceSpec = {
  model: "Generic phone",
  phoneHeightMm: 150,
  frontLensFromTopMm: 10,
  front35mmEqMm: 26,
  frontSensorAspect: "4:3",
};

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** PURE: keep only well-formed entries of a parsed device-profiles.json. */
export function sanitizeSpecs(raw: unknown): DeviceSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is DeviceSpec => {
    if (!s || typeof s !== "object") return false;
    const o = s as Record<string, unknown>;
    return (
      typeof o.model === "string" &&
      isFiniteNum(o.phoneHeightMm) && o.phoneHeightMm > 0 &&
      isFiniteNum(o.frontLensFromTopMm) && o.frontLensFromTopMm >= 0 &&
      o.frontLensFromTopMm < o.phoneHeightMm &&
      isFiniteNum(o.front35mmEqMm) && o.front35mmEqMm > 0
    );
  });
}

/** Fetch /device-profiles.json; [] on any failure. */
export async function loadDeviceSpecs(): Promise<DeviceSpec[]> {
  try {
    const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
    const res = await fetch(`${base.replace(/\/?$/, "/")}device-profiles.json`, { cache: "no-cache" });
    if (!res.ok) return [];
    return sanitizeSpecs(await res.json());
  } catch {
    return [];
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * uaModels entry match. An entry is an exact model string (case-insensitive),
 * or a prefix pattern ending in "*" (e.g. "SM-S911*" matches the regional
 * variants SM-S911B, SM-S911U1, ...).
 */
function uaModelMatches(pattern: string, uaModel: string): boolean {
  const p = norm(pattern);
  const m = norm(uaModel);
  if (p.endsWith("*")) {
    const prefix = p.slice(0, -1);
    return prefix.length > 0 && m.startsWith(prefix);
  }
  return p === m;
}

/**
 * PURE: pick the spec for this device.
 * 1. uaModel (Android userAgentData "model"): exact entries first, then "*" prefix entries.
 * 2. iOS: screenMatch on portrait CSS width/height and devicePixelRatio.
 * 3. GENERIC_SPEC.
 */
export function matchSpec(
  specs: DeviceSpec[],
  info: { uaModel?: string; screenWidth: number; screenHeight: number; dpr: number; isIOS: boolean },
): { spec: DeviceSpec; source: ModelSource } {
  const ua = info.uaModel?.trim();
  if (ua) {
    const exact = specs.find((s) => s.uaModels?.some((p) => !p.endsWith("*") && uaModelMatches(p, ua)));
    if (exact) return { spec: exact, source: "ua-client-hints" };
    // Longest prefix wins so "SM-S911*" beats a hypothetical "SM-S9*".
    let best: { spec: DeviceSpec; len: number } | null = null;
    for (const s of specs) {
      for (const p of s.uaModels ?? []) {
        if (p.endsWith("*") && uaModelMatches(p, ua) && (!best || p.length > best.len)) {
          best = { spec: s, len: p.length };
        }
      }
    }
    if (best) return { spec: best.spec, source: "ua-client-hints" };
  }
  if (info.isIOS) {
    const w = Math.min(info.screenWidth, info.screenHeight);
    const h = Math.max(info.screenWidth, info.screenHeight);
    const hit = specs.find((s) => {
      const m = s.screenMatch;
      if (!m) return false;
      const mw = Math.min(m.width, m.height);
      const mh = Math.max(m.width, m.height);
      return Math.abs(mw - w) <= 1 && Math.abs(mh - h) <= 1 && Math.abs(m.dpr - info.dpr) < 0.05;
    });
    if (hit) return { spec: hit, source: "screen-match" };
  }
  return { spec: GENERIC_SPEC, source: "generic" };
}
