// Builds full synthetic scans (front/side/back) for compute and pipeline tests.
import type { Landmark, PersonMask, ViewName } from "../../src/types";
import { buildCamera } from "../../src/geometry/camera";
import { makeViewPlane } from "../../src/geometry/plane";
import type { ViewData } from "../../src/measure/compute";
import { feetPoint, feetRowFor, headPoint } from "../../src/pipeline/runPipeline";
import { Body, DEFAULT_CAM, landmarksPx, profileFor, renderMask, rng, type SynthCamera } from "./synthetic";

export const DIST: Record<ViewName, number> = { front: 250, side: 245, back: 255 };

export interface SceneFrame {
  view: ViewName;
  landmarksPx: Landmark[];
  mask: PersonMask;
}

const maskCache = new Map<string, PersonMask>();
export function maskFor(body: Body, cam: SynthCamera, view: ViewName, D: number): PersonMask {
  const key = `${body.H}|${cam.f}|${cam.thetaDeg}|${cam.width}x${cam.height}|${view}|${D}`;
  let m = maskCache.get(key);
  if (!m) {
    m = renderMask(body, cam, view, D);
    maskCache.set(key, m);
  }
  return m;
}

export function sceneFrames(
  body: Body,
  cam: SynthCamera = DEFAULT_CAM,
  nPerView = 3,
  jitterPx = 0.3,
  seed = 1,
): SceneFrame[] {
  const rand = rng(seed);
  const out: SceneFrame[] = [];
  for (const view of ["front", "side", "back"] as ViewName[]) {
    const mask = maskFor(body, cam, view, DIST[view]);
    for (let i = 0; i < nPerView; i++) {
      out.push({ view, mask, landmarksPx: landmarksPx(body, cam, view, DIST[view], jitterPx, rand) });
    }
  }
  return out;
}

/** FrameData per view with planes built the way the pipeline builds them. */
export function viewDataFor(frames: SceneFrame[], body: Body, cam: SynthCamera = DEFAULT_CAM): ViewData[] {
  const profile = profileFor(cam);
  const views: ViewData[] = [];
  for (const view of ["front", "side", "back"] as ViewName[]) {
    const fs = frames.filter((f) => f.view === view);
    if (!fs.length) continue;
    views.push({
      view,
      frames: fs.map((f) => {
        const c = buildCamera(profile, { tiltDeg: cam.thetaDeg, rollDeg: cam.rollDeg }, cam.width, cam.height);
        const feet = feetPoint(f.landmarksPx, f.mask)!;
        const head = headPoint(f.landmarksPx, f.mask)!;
        const plane = makeViewPlane(c, view, feetRowFor(c, view, feet, body.H), head.v, body.H, { uFeet: feet.u, uHead: head.u });
        return { landmarksPx: f.landmarksPx, mask: f.mask, plane };
      }),
    });
  }
  return views;
}
