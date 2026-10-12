// Full-resolution person mask (design doc section 7, "Segmentation
// resolution"). Browser only; the logic lives in crops.ts, compose.ts and
// edgeRefine.ts.
//
// ImageSegmenter (selfie_multiclass_256x256, IMAGE mode) is called with the
// callback overload segment(image, cb); confidenceMasks (MPMask[], one per
// class) are read with getAsFloat32Array() and copied inside the callback,
// because the masks are only valid until it returns.

import type { Landmark, PersonMask } from "../types";
import { regionCrops, type CropBox } from "./crops";
import { composeMask, personProbFromCategory, personProbFromConfidence, type CropProb } from "./compose";
import { refineEdges } from "./edgeRefine";
import { bodyMaskFor } from "./pose";
import { rgbaToGray } from "./quality";
import { ensureSegmenter } from "./runtime";

/** Crops are downscaled to this longest side before segmentation (the model runs at 256x256 anyway). */
const SEGMENT_INPUT_MAX = 512;

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: AnyCanvas): Ctx2D {
  const ctx = c.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  if (!ctx) throw new Error("2D canvas not available");
  return ctx;
}

/** Draws an ImageBitmap or ImageData onto a new canvas of the same size. */
export function imageToCanvas(image: ImageBitmap | ImageData): { canvas: AnyCanvas; ctx: Ctx2D } {
  const canvas = makeCanvas(image.width, image.height);
  const ctx = ctx2d(canvas);
  if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
  else ctx.drawImage(image, 0, 0);
  return { canvas, ctx };
}

/** RGBA pixels of an ImageBitmap or ImageData. */
export function imageToImageData(image: ImageBitmap | ImageData): ImageData {
  if (image instanceof ImageData) return image;
  const { ctx } = imageToCanvas(image);
  return ctx.getImageData(0, 0, image.width, image.height);
}

async function segmentCrop(src: AnyCanvas, box: CropBox): Promise<CropProb | null> {
  const seg = await ensureSegmenter();
  const s = Math.min(1, SEGMENT_INPUT_MAX / Math.max(box.w, box.h));
  const cw = Math.max(1, Math.round(box.w * s));
  const ch = Math.max(1, Math.round(box.h * s));
  const crop = makeCanvas(cw, ch);
  ctx2d(crop).drawImage(src, box.x, box.y, box.w, box.h, 0, 0, cw, ch);
  let out: CropProb | null = null;
  seg.segment(crop, (result) => {
    const masks = result.confidenceMasks;
    if (masks && masks.length > 0) {
      const arrays = masks.map((m) => m.getAsFloat32Array().slice());
      out = { ...box, maskWidth: masks[0].width, maskHeight: masks[0].height, prob: personProbFromConfidence(arrays) };
    } else if (result.categoryMask) {
      const m = result.categoryMask;
      out = { ...box, maskWidth: m.width, maskHeight: m.height, prob: personProbFromCategory(m.getAsUint8Array()) };
    }
  });
  return out;
}

/**
 * Per-region padded crops at full resolution -> selfie_multiclass per crop
 * (person = every class except background) -> composed full-frame mask,
 * limited to the heavy pose model's whole-body mask when it has one (crops
 * that filled their whole box are dropped) -> edge refinement within +/-3 px.
 */
export async function segmentPerson(image: ImageBitmap | ImageData, landmarks: Landmark[]): Promise<PersonMask> {
  const width = image.width, height = image.height;
  const { canvas, ctx } = imageToCanvas(image);
  const boxes = regionCrops(landmarks, width, height);
  const probs: CropProb[] = [];
  for (const b of boxes) {
    const p = await segmentCrop(canvas, b);
    if (p) probs.push(p);
  }
  const coarse = composeMask(probs, width, height, { body: bodyMaskFor(image) });
  const rgba = image instanceof ImageData ? image.data : ctx.getImageData(0, 0, width, height).data;
  const gray = rgbaToGray(rgba, width, height);
  const data = refineEdges(coarse.data, gray, width, height, { radius: 3 });
  return coarse.info ? { width, height, data, info: coarse.info } : { width, height, data };
}
