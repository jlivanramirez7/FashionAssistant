// Dev-only debug capture (design doc sections 6 S3, 8, 12, 13).
// Saves captured frames (JPEG) + sensor readings + inputs as a LOCAL .zip
// download for the replay harness (replay.html). Never uploads anything.
// Gated by debugEnabled(): dev builds, or ?debug=1 on a dev host.

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import type {
  DeviceProfile,
  Landmark,
  Orientation,
  ScanInputs,
  ViewCapture,
  ViewName,
} from "../types";
import { VIEWS } from "../types";

export const DEBUG_MANIFEST_VERSION = 1;

export interface DebugFrameMeta {
  index: number;
  /** Path inside the zip, e.g. "frames/front/0.jpg". */
  path: string;
  timestampMs: number;
  width: number;
  height: number;
  orientation: Orientation;
  liveLandmarks?: Landmark[];
}

export interface DebugManifest {
  version: number;
  createdAt: number; // epoch ms
  inputs: ScanInputs;
  profile: DeviceProfile;
  views: { view: ViewName; frames: DebugFrameMeta[] }[];
  sensorLog: Orientation[];
}

export interface DebugFrameBytes {
  view: ViewName;
  index: number;
  jpeg: Uint8Array;
}

// ---------------------------------------------------------------- gating

const DEV_TLDS = [".local", ".localhost", ".lan", ".home.arpa", ".internal"];

/**
 * PURE. True when `hostname` is a development host: localhost, loopback,
 * a private/link-local LAN IP, or a .local/.lan style name. Production
 * hosts (*.run.app, *.web.app, *.firebaseapp.com, any public name/IP)
 * return false.
 */
export function isDevHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return false;
  if (h.endsWith(".run.app") || h === "run.app") return false;
  if (h === "localhost" || h === "::1") return true;
  if (DEV_TLDS.some((t) => h.endsWith(t))) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (h.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return false;
}

/** PURE. ?debug=1 present in a location.search string. */
export function hasDebugParam(search: string): boolean {
  return new URLSearchParams(search).get("debug") === "1";
}

/** True in dev builds, or with ?debug=1 on a development host. */
export function debugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof location === "undefined") return false;
  return hasDebugParam(location.search) && isDevHost(location.hostname);
}

// ---------------------------------------------------------------- pure zip assembly

export function framePath(view: ViewName, index: number): string {
  return `frames/${view}/${index}.jpg`;
}

/** PURE. Manifest from captures (images are not read). */
export function buildManifest(args: {
  captures: ViewCapture[];
  profile: DeviceProfile;
  inputs: ScanInputs;
  sensorLog: Orientation[];
  createdAt?: number;
}): DebugManifest {
  return {
    version: DEBUG_MANIFEST_VERSION,
    createdAt: args.createdAt ?? Date.now(),
    inputs: { ...args.inputs },
    profile: { ...args.profile, screen: { ...args.profile.screen } },
    views: args.captures.map((c) => ({
      view: c.view,
      frames: c.frames.map((f, index) => {
        const meta: DebugFrameMeta = {
          index,
          path: framePath(c.view, index),
          timestampMs: f.timestampMs,
          width: f.width,
          height: f.height,
          orientation: { tiltDeg: f.orientation.tiltDeg, rollDeg: f.orientation.rollDeg },
        };
        if (f.liveLandmarks) meta.liveLandmarks = f.liveLandmarks;
        return meta;
      }),
    })),
    sensorLog: args.sensorLog.map((o) => ({ tiltDeg: o.tiltDeg, rollDeg: o.rollDeg })),
  };
}

/** PURE. manifest.json + frames/<view>/<index>.jpg (JPEGs stored, not deflated). */
export function assembleDebugZip(manifest: DebugManifest, frames: DebugFrameBytes[]): Uint8Array {
  const files: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const f of frames) {
    files[framePath(f.view, f.index)] = [f.jpeg, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

/** PURE (async per contract). Inverse of assembleDebugZip. */
export async function parseDebugZip(
  bytes: Uint8Array,
): Promise<{ manifest: DebugManifest; frames: DebugFrameBytes[] }> {
  const files = unzipSync(bytes);
  const raw = files["manifest.json"];
  if (!raw) throw new Error("Not a debug capture zip: manifest.json missing.");
  const manifest = JSON.parse(strFromU8(raw)) as DebugManifest;
  if (typeof manifest.version !== "number" || manifest.version > DEBUG_MANIFEST_VERSION) {
    throw new Error(`Unsupported debug manifest version: ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.views)) throw new Error("Debug manifest has no views.");

  const frames: DebugFrameBytes[] = [];
  for (const v of manifest.views) {
    if (!VIEWS.includes(v.view)) throw new Error(`Unknown view in manifest: ${String(v.view)}`);
    for (const meta of v.frames) {
      const path = meta.path || framePath(v.view, meta.index);
      const jpeg = files[path];
      if (!jpeg) throw new Error(`Frame missing from zip: ${path}`);
      frames.push({ view: v.view, index: meta.index, jpeg });
    }
  }
  return { manifest, frames };
}

// ---------------------------------------------------------------- browser-only

/** Encode one frame as JPEG (OffscreenCanvas when available, else <canvas>). */
export async function encodeJpeg(image: ImageBitmap | ImageData, quality = 0.92): Promise<Uint8Array> {
  const { width, height } = image;
  let blob: Blob;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
    else ctx.drawImage(image, 0, 0);
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D context unavailable");
    if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
    else ctx.drawImage(image, 0, 0);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))), "image/jpeg", quality),
    );
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** Build the debug capture zip in memory (nothing leaves the device). */
export async function buildDebugZip(args: {
  captures: ViewCapture[];
  profile: DeviceProfile;
  inputs: ScanInputs;
  sensorLog: Orientation[];
}): Promise<Blob> {
  const manifest = buildManifest(args);
  const frames: DebugFrameBytes[] = [];
  for (const c of args.captures) {
    for (let index = 0; index < c.frames.length; index++) {
      frames.push({ view: c.view, index, jpeg: await encodeJpeg(c.frames[index].image) });
    }
  }
  const bytes = assembleDebugZip(manifest, frames);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

/** Trigger a local file download (no network). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Suggested file name, e.g. "fa-debug-2026-10-10T12-30-00.zip". */
export function debugZipName(createdAt = Date.now()): string {
  return `fa-debug-${new Date(createdAt).toISOString().slice(0, 19).replace(/:/g, "-")}.zip`;
}
