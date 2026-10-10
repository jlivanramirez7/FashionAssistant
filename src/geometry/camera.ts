// Pinhole camera per frame (design doc section 4).
//
// Conventions (shared with team B, src/capture/sensors.ts):
// - Orientation.tiltDeg = theta = angle of the phone's long axis above the floor
//   (90 upright, 0 flat on its back). phi = 90deg - theta = elevation of the optical
//   axis above horizontal.
// - Orientation.rollDeg: 0 = level, positive = the phone's top edge turned toward its
//   +x side (clockwise as the user looks at the screen).
// - Lens height above the floor h = lensOffsetCm * sin(theta).
// - Frames are unmirrored; image u grows right, v grows down; c = (W/2, H/2);
//   fx = fy = profile.focalLengthPx rescaled from the profile's capture size to this
//   frame by the ratio of the long sides (same rule as src/device/profile.ts).
import type { CameraModel, DeviceProfile, Orientation } from "../types";

const DEG = Math.PI / 180;

/** Focal length (px) of the profile rescaled to a frame of width x height. */
export function focalForFrame(profile: DeviceProfile, width: number, height: number): number {
  const refLong = Math.max(profile.captureWidth || 0, profile.captureHeight || 0);
  const long = Math.max(width, height);
  const scale = refLong > 0 && long > 0 ? long / refLong : 1;
  return profile.focalLengthPx * scale;
}

export function buildCamera(profile: DeviceProfile, o: Orientation, width: number, height: number): CameraModel {
  const f = focalForFrame(profile, width, height);
  const tilt = Number.isFinite(o.tiltDeg) ? o.tiltDeg : 90;
  const roll = Number.isFinite(o.rollDeg) ? o.rollDeg : 0;
  const thetaRad = tilt * DEG;
  const k1 = profile.distortionK1;
  return {
    width,
    height,
    fx: f,
    fy: f,
    cx: width / 2,
    cy: height / 2,
    thetaRad,
    phiRad: Math.PI / 2 - thetaRad,
    rollRad: roll * DEG,
    lensHeightCm: profile.lensOffsetCm * Math.sin(thetaRad),
    k1: typeof k1 === "number" && Number.isFinite(k1) ? k1 : 0,
  };
}

/** Copy of a camera with a different focal length (fx = fy = f). */
export function withFocalLength(cam: CameraModel, f: number): CameraModel {
  return { ...cam, fx: f, fy: f };
}
