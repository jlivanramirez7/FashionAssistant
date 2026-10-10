// PURE part of the replay harness: rebuild ViewCapture[] from a parsed
// debug zip, given an image decoder (createImageBitmap in the browser).

import type { CapturedFrame, ViewCapture } from "../types";
import type { DebugFrameBytes, DebugManifest } from "./debugCapture";

/** Rebuild ViewCapture[] from the manifest + decoded images (PURE given decode). */
export async function rebuildCaptures(
  manifest: DebugManifest,
  frames: DebugFrameBytes[],
  decode: (jpeg: Uint8Array) => Promise<ImageBitmap>,
): Promise<ViewCapture[]> {
  const byKey = new Map<string, Uint8Array>();
  for (const f of frames) byKey.set(`${f.view}/${f.index}`, f.jpeg);
  const out: ViewCapture[] = [];
  for (const v of manifest.views) {
    const captured: CapturedFrame[] = [];
    for (const meta of v.frames) {
      const jpeg = byKey.get(`${v.view}/${meta.index}`);
      if (!jpeg) throw new Error(`Missing frame ${v.view}/${meta.index}`);
      const image = await decode(jpeg);
      const frame: CapturedFrame = {
        view: v.view,
        timestampMs: meta.timestampMs,
        image,
        width: image.width || meta.width,
        height: image.height || meta.height,
        orientation: meta.orientation,
      };
      if (meta.liveLandmarks) frame.liveLandmarks = meta.liveLandmarks;
      captured.push(frame);
    }
    out.push({ view: v.view, frames: captured });
  }
  return out;
}
