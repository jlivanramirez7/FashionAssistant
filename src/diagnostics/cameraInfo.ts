// Camera capability lines for troubleshooting reports: what the selfie
// camera offers (sizes, aspect ratios, zoom) and what Chrome actually picked,
// so a wider / uncropped stream can be requested where the phone supports it.
import { diagLog } from "./log";

type Range = { min?: number; max?: number; step?: number };
type Bag = Record<string, unknown>;

const n = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? String(Math.round(x * 1000) / 1000) : "?");

function range(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const { min, max, step } = r as Range;
  if (min === undefined && max === undefined) return null;
  return `${n(min)}-${n(max)}${step !== undefined ? ` step ${n(step)}` : ""}`;
}

/** PURE: one line summarising MediaStreamTrack.getCapabilities(). */
export function describeCapabilities(caps: Bag): string {
  const parts: string[] = [];
  const w = range(caps.width);
  const h = range(caps.height);
  if (w || h) parts.push(`width ${w ?? "?"}, height ${h ?? "?"}`);
  const ar = range(caps.aspectRatio);
  if (ar) parts.push(`aspect ${ar}`);
  const fr = range(caps.frameRate);
  if (fr) parts.push(`fps ${fr}`);
  const zoom = range(caps.zoom);
  parts.push(zoom ? `zoom ${zoom}` : "zoom not offered");
  if (Array.isArray(caps.resizeMode)) parts.push(`resizeMode ${caps.resizeMode.join("/")}`);
  if (Array.isArray(caps.facingMode)) parts.push(`facing ${caps.facingMode.join("/") || "?"}`);
  return parts.join("; ") || "none reported";
}

/** PURE: the track settings that matter for the field of view. */
export function describeSettings(set: Bag): string {
  const parts = [`${n(set.width)}x${n(set.height)}`];
  if (set.aspectRatio !== undefined) parts.push(`aspect ${n(set.aspectRatio)}`);
  if (set.frameRate !== undefined) parts.push(`${n(set.frameRate)}fps`);
  if (set.zoom !== undefined) parts.push(`zoom ${n(set.zoom)}`);
  if (set.resizeMode !== undefined) parts.push(`resizeMode ${String(set.resizeMode)}`);
  if (set.facingMode !== undefined) parts.push(`facing ${String(set.facingMode)}`);
  return parts.join(", ");
}

/** Logs capabilities, settings and the list of cameras (never throws). */
export async function logCameraDetails(track: MediaStreamTrack | undefined): Promise<void> {
  try {
    if (!track) return;
    const caps = typeof track.getCapabilities === "function" ? (track.getCapabilities() as Bag) : {};
    diagLog(`camera capabilities: ${describeCapabilities(caps)}`);
    diagLog(`camera settings: ${describeSettings(track.getSettings() as Bag)}; label "${track.label}"`);
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    const cams = (devices ?? []).filter((d) => d.kind === "videoinput");
    diagLog(`cameras (${cams.length}): ${cams.map((d) => `"${d.label || "unnamed"}"`).join(", ")}`);
  } catch (e) {
    diagLog(`camera details unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
