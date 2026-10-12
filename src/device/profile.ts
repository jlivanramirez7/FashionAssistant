// Device profile assembly (design doc section 4, "Device profile (auto-detected)").
import type { DeviceProfile, DeviceSpec, ModelSource } from "../types";
import { detectModelInfo } from "./detectModel";
import { loadDeviceSpecs, matchSpec } from "./profiles";

/** Diagonal of a 36 x 24 mm frame, the reference for 35 mm-equivalent focal lengths. */
export const FULL_FRAME_DIAGONAL_MM = 43.27;

/**
 * PURE: sensor aspect "a:b" (either order, also "a/b" or "a x b") -> short/long ratio in (0, 1].
 * Anything unparseable gives 4:3 (0.75).
 */
export function parseAspectRatio(aspect: string | undefined | null): number {
  const m = typeof aspect === "string" ? aspect.trim().match(/^(\d+(?:\.\d+)?)\s*[:/xX]\s*(\d+(?:\.\d+)?)$/) : null;
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)) return Math.min(a, b) / Math.max(a, b);
  }
  return 3 / 4;
}

/**
 * PURE: focal length in pixels from the 35 mm-equivalent spec.
 * 35 mm-eq is defined on the full sensor diagonal; the video is assumed to span the
 * sensor's long side and crop the short side. So:
 *   long = max(W, H); shortSensor = long * (aspect short/long);
 *   f = f35 * sqrt(long^2 + shortSensor^2) / 43.27
 * Passing the video's own aspect (e.g. "16:9" for 1080x1920) reproduces the old
 * full-video-diagonal formula f35 * sqrt(W^2 + H^2) / 43.27.
 */
export function focalPxFromSpec(front35mmEqMm: number, width: number, height: number, sensorAspect = "4:3"): number {
  const long = Math.max(width, height);
  const shortSensor = long * parseAspectRatio(sensorAspect);
  return (front35mmEqMm * Math.hypot(long, shortSensor)) / FULL_FRAME_DIAGONAL_MM;
}

/** PURE: L_lens in cm = (phoneHeightMm - frontLensFromTopMm) / 10. */
export function lensOffsetCmFromSpec(spec: DeviceSpec): number {
  return (spec.phoneHeightMm - spec.frontLensFromTopMm) / 10;
}

const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * PURE: combine the matched spec with the device's saved record.
 * Override rules:
 * - lensOffsetCm: saved value wins when its source is "paper"; otherwise from the spec
 *   (source "profile", or "generic" when no model matched).
 * - focalLengthPx: saved value wins when its source is "height-solve" or "paper"; it is
 *   rescaled by the ratio of the video long sides when the capture size changed (or used as-is
 *   when the saved record has no capture size). Otherwise computed from the spec.
 * - distortionK1, calibrationScans, label: carried over from the saved record.
 */
export function buildProfile(args: {
  deviceId: string;
  spec: DeviceSpec;
  source: ModelSource;
  userAgent: string;
  screen: { width: number; height: number; devicePixelRatio: number };
  captureWidth: number;
  captureHeight: number;
  saved?: Partial<DeviceProfile> | null;
}): DeviceProfile {
  const { spec, source, saved, captureWidth, captureHeight } = args;

  let lensOffsetCm = lensOffsetCmFromSpec(spec);
  let lensOffsetSource: DeviceProfile["lensOffsetSource"] = source === "generic" ? "generic" : "profile";
  if (saved?.lensOffsetSource === "paper" && finitePos(saved.lensOffsetCm)) {
    lensOffsetCm = saved.lensOffsetCm;
    lensOffsetSource = "paper";
  }

  let focalLengthPx = focalPxFromSpec(spec.front35mmEqMm, captureWidth, captureHeight, spec.frontSensorAspect ?? "4:3");
  // The app runs in portrait; a LANDSCAPE frame (some Android Chrome builds)
  // is a 16:9 window across the portrait field, so its long side spans the
  // sensor's SHORT side and the focal length in px is larger by long/short.
  if (captureWidth > captureHeight) focalLengthPx /= parseAspectRatio(spec.frontSensorAspect ?? "4:3");
  let focalLengthSource: DeviceProfile["focalLengthSource"] = "spec";
  if (
    (saved?.focalLengthSource === "height-solve" || saved?.focalLengthSource === "paper") &&
    finitePos(saved.focalLengthPx)
  ) {
    let f = saved.focalLengthPx;
    if (finitePos(saved.captureWidth) && finitePos(saved.captureHeight)) {
      // The video spans the sensor's long side, so pixels scale with the long side.
      const oldLong = Math.max(saved.captureWidth, saved.captureHeight);
      const newLong = Math.max(captureWidth, captureHeight);
      if (Math.abs(oldLong - newLong) > 1e-9) f *= newLong / oldLong;
    }
    focalLengthPx = f;
    focalLengthSource = saved.focalLengthSource;
  }

  const profile: DeviceProfile = {
    deviceId: args.deviceId,
    label: saved?.label && saved.label.trim() ? saved.label : spec.model,
    deviceModelGuess: spec.model,
    modelSource: source,
    screen: { ...args.screen },
    phoneHeightMm: spec.phoneHeightMm,
    lensOffsetCm,
    lensOffsetSource,
    front35mmEqMm: spec.front35mmEqMm,
    focalLengthPx,
    focalLengthSource,
    captureWidth,
    captureHeight,
    calibrationScans: saved?.calibrationScans && saved.calibrationScans > 0 ? saved.calibrationScans : 0,
  };
  if (typeof saved?.distortionK1 === "number" && Number.isFinite(saved.distortionK1)) {
    profile.distortionK1 = saved.distortionK1;
  }
  return profile;
}

/** Browser: detect the model, look up its spec and build the profile for the actual capture size. */
export async function buildDeviceProfile(
  deviceId: string,
  capture: { width: number; height: number },
  saved?: Partial<DeviceProfile> | null,
): Promise<DeviceProfile> {
  const [info, specs] = await Promise.all([detectModelInfo(), loadDeviceSpecs()]);
  const { spec, source } = matchSpec(specs, info);
  return buildProfile({
    deviceId,
    spec,
    source,
    userAgent: info.userAgent,
    screen: { width: info.screenWidth, height: info.screenHeight, devicePixelRatio: info.dpr },
    captureWidth: capture.width,
    captureHeight: capture.height,
    saved,
  });
}
