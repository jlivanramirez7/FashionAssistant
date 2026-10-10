// Camera / sensors / voice / wake lock lifecycle for one scan.
import { startFrontCamera, stopCamera } from "../capture/camera";
import { requestMotionPermission, startSensors, stopSensors } from "../capture/sensors";
import { unlockVoice } from "../capture/voice";
import { getDeviceRecord } from "../data/devices";
import { getDeviceId } from "../data/deviceId";
import { buildDeviceProfile } from "../device/profile";
import { initVision } from "../vision";
import { acquireWakeLock, releaseWakeLock } from "../wakeLock";
import type { AppContext } from "./context";

export interface StartResult {
  motionGranted: boolean;
}

/**
 * MUST be called synchronously from the Start tap's click handler: voice
 * unlock, motion permission and camera are all requested before the first
 * await so iOS sees them inside the user gesture. Then the device profile
 * is built silently (saved device record merged) and live vision starts
 * loading.
 */
export async function startFromTap(ctx: AppContext): Promise<StartResult> {
  const s = ctx.session;
  unlockVoice();
  if (!s.scanStartMs) s.scanStartMs = performance.now();
  const motionP = requestMotionPermission().catch(() => false);
  const camP = s.stream ? Promise.resolve(null) : startFrontCamera(s.video);
  const wakeP = acquireWakeLock().catch(() => undefined);
  // Device record fetch can run alongside (also prefetched on Setup).
  const savedP: Promise<unknown> =
    s.savedDevice || !ctx.user
      ? Promise.resolve(s.savedDevice)
      : getDeviceRecord(ctx.user.uid, getDeviceId()).catch(() => null);

  const [motionGranted, cam] = await Promise.all([motionP, camP]);
  startSensors();
  if (cam) {
    s.stream = cam.stream;
    s.camera = { width: cam.width, height: cam.height, frameRate: cam.frameRate };
  }
  await wakeP;
  s.savedDevice = ((await savedP) as typeof s.savedDevice) ?? null;

  const cap = s.camera ?? { width: s.video.videoWidth, height: s.video.videoHeight, frameRate: 30 };
  if (!s.profile || s.profile.captureWidth !== cap.width || s.profile.captureHeight !== cap.height) {
    s.profile = await buildDeviceProfile(getDeviceId(), { width: cap.width, height: cap.height }, s.savedDevice);
  }
  if (!s.visionLive) {
    s.visionLive = initVision({ live: true });
    s.visionLive.catch(() => undefined); // surfaced on the Capture screen
  }
  return { motionGranted: motionGranted === true };
}

/** Stop camera + sensors and release the wake lock (leaving the capture flow). */
export function stopHardware(ctx: AppContext): void {
  const s = ctx.session;
  if (s.stream) {
    stopCamera(s.stream);
    s.stream = null;
  }
  s.video.srcObject = null;
  stopSensors();
  void releaseWakeLock().catch(() => undefined);
}
