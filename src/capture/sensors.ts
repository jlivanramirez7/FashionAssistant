// Phone tilt and roll from the gravity vector (design doc sections 2, 4, S4).
import type { Orientation } from "../types";

const RAD = 180 / Math.PI;

/**
 * PURE: gravity vector -> tilt and roll, in degrees.
 *
 * Input: DeviceMotionEvent.accelerationIncludingGravity in the W3C device frame
 * (x right, y up along the long side, z out of the screen). At rest it is the
 * reaction to gravity, i.e. it points UP: lying flat on its back -> (0, 0, +g);
 * upright portrait -> (0, +g, 0). (Callers must normalize platforms that report
 * the opposite sign - see normalizeGravity.)
 *
 *   tiltDeg (theta) = atan2( sqrt(gx^2 + gy^2), gz )
 *     = angle between the screen normal (+z, the front camera's optical axis) and
 *       vertical. With zero roll this equals the angle of the long axis above the
 *       floor: 90 = upright, 0 = flat on its back, >90 = leaning forward / face down.
 *     The camera pitch is then exactly phi = 90 - theta (optical-axis elevation),
 *     which is what the geometry (team C) uses.
 *
 *   rollDeg = atan2( -gx, gy )
 *     = rotation about the screen normal, 0 = level. Positive = the phone's top
 *       edge is turned toward its +x side (clockwise as seen by the user looking at
 *       the screen). Ill-defined (returned as 0) when the phone lies nearly flat.
 */
export function gravityToOrientation(gx: number, gy: number, gz: number): Orientation {
  const inPlane = Math.hypot(gx, gy);
  const tiltDeg = Math.atan2(inPlane, gz) * RAD;
  const rollDeg = inPlane < 1e-6 ? 0 : Math.atan2(-gx, gy) * RAD;
  return { tiltDeg, rollDeg };
}

/**
 * PURE: some platforms (notably older iOS Safari) report accelerationIncludingGravity
 * with the opposite sign. In our use the phone is always roughly upright in portrait
 * (gy clearly non-zero), so a negative gy means the sign is flipped: negate the vector.
 */
export function normalizeGravity(gx: number, gy: number, gz: number): [number, number, number] {
  return gy < 0 ? [-gx, -gy, -gz] : [gx, gy, gz];
}

/**
 * PURE: DeviceOrientationEvent beta/gamma (degrees) -> "up" vector in the device frame,
 * for the fallback when DeviceMotionEvent gives no gravity data.
 * With R = Rz(alpha) Rx(beta) Ry(gamma): up_device = (-cos b sin g, sin b, cos b cos g).
 */
export function eulerToGravity(betaDeg: number, gammaDeg: number): [number, number, number] {
  const b = betaDeg / RAD;
  const g = gammaDeg / RAD;
  return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

/** PURE: mean tilt and roll. Empty input -> NaN values. */
export function averageOrientation(samples: Orientation[]): Orientation {
  if (samples.length === 0) return { tiltDeg: NaN, rollDeg: NaN };
  let t = 0;
  let r = 0;
  for (const s of samples) {
    t += s.tiltDeg;
    r += s.rollDeg;
  }
  return { tiltDeg: t / samples.length, rollDeg: r / samples.length };
}

export const TILT_MIN_DEG = 60;
export const TILT_MAX_DEG = 85;
export const ROLL_MAX_DEG = 3;

/** PURE: placement check (section 4): tilt 60-85 deg, |roll| <= 3 deg. */
export function placementOk(o: Orientation): boolean {
  return (
    Number.isFinite(o.tiltDeg) &&
    Number.isFinite(o.rollDeg) &&
    o.tiltDeg >= TILT_MIN_DEG &&
    o.tiltDeg <= TILT_MAX_DEG &&
    Math.abs(o.rollDeg) <= ROLL_MAX_DEG
  );
}

// ------------------------------------------------------------------ browser side

interface PermissionCtor {
  requestPermission?: () => Promise<"granted" | "denied" | "default">;
}

/**
 * Must be called synchronously from the Start tap (iOS 13+). Both requests are
 * started before any await so they share the user activation. Browsers without
 * requestPermission resolve true when the motion APIs exist.
 */
export async function requestMotionPermission(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const motion = (window as unknown as { DeviceMotionEvent?: PermissionCtor }).DeviceMotionEvent;
  const orient = (window as unknown as { DeviceOrientationEvent?: PermissionCtor }).DeviceOrientationEvent;
  if (!motion && !orient) return false;
  const reqs: Promise<string>[] = [];
  if (typeof motion?.requestPermission === "function") reqs.push(motion.requestPermission().catch(() => "denied"));
  if (typeof orient?.requestPermission === "function") reqs.push(orient.requestPermission().catch(() => "denied"));
  if (reqs.length === 0) return true;
  const results = await Promise.all(reqs);
  return results.some((r) => r === "granted");
}

interface Sample {
  t: number;
  o: Orientation;
}

/** Samples kept for orientationSince (section 4: averaged over each capture hold). */
const BUFFER_MS = 20_000;
/** Exponential smoothing factor per sample (~60 Hz -> ~80 ms time constant). */
const EMA_ALPHA = 0.2;
/** Prefer devicemotion; use deviceorientation only if no motion sample for this long. */
const MOTION_STALE_MS = 500;

let samples: Sample[] = [];
let ema: [number, number, number] | null = null;
let lastMotionT = -Infinity;
let running = false;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function pushGravity(gx: number, gy: number, gz: number): void {
  const [x, y, z] = normalizeGravity(gx, gy, gz);
  const mag = Math.hypot(x, y, z);
  if (!(mag > 0.5)) return; // missing or nonsense data
  const ux = x / mag, uy = y / mag, uz = z / mag;
  const t = now();
  ema = ema
    ? [ema[0] + EMA_ALPHA * (ux - ema[0]), ema[1] + EMA_ALPHA * (uy - ema[1]), ema[2] + EMA_ALPHA * (uz - ema[2])]
    : [ux, uy, uz];
  samples.push({ t, o: gravityToOrientation(ux, uy, uz) });
  const cutoff = t - BUFFER_MS;
  if (samples.length > 0 && samples[0].t < cutoff) {
    let i = 0;
    while (i < samples.length && samples[i].t < cutoff) i++;
    samples = samples.slice(i);
  }
}

function onMotion(e: DeviceMotionEvent): void {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  lastMotionT = now();
  pushGravity(a.x, a.y, a.z);
}

function onOrientation(e: DeviceOrientationEvent): void {
  if (now() - lastMotionT < MOTION_STALE_MS) return;
  if (e.beta == null || e.gamma == null) return;
  const [x, y, z] = eulerToGravity(e.beta, e.gamma);
  pushGravity(x, y, z);
}

/** Start listening (~60 Hz devicemotion, deviceorientation as a fallback). Idempotent. */
export function startSensors(): void {
  if (running || typeof window === "undefined") return;
  running = true;
  samples = [];
  ema = null;
  lastMotionT = -Infinity;
  window.addEventListener("devicemotion", onMotion);
  window.addEventListener("deviceorientation", onOrientation);
}

export function stopSensors(): void {
  if (!running || typeof window === "undefined") return;
  running = false;
  window.removeEventListener("devicemotion", onMotion);
  window.removeEventListener("deviceorientation", onOrientation);
}

/** Smoothed current orientation (EMA of the unit gravity vector); null before the first sample. */
export function currentOrientation(): Orientation | null {
  return ema ? gravityToOrientation(ema[0], ema[1], ema[2]) : null;
}

/** Raw per-sample orientations with timestamp >= tMs (performance.now() clock). */
export function samplesSince(tMs: number): Orientation[] {
  return samples.filter((s) => s.t >= tMs).map((s) => s.o);
}

/**
 * Average of the samples since tMs. tMs is on the performance.now() clock
 * (same as requestAnimationFrame / requestVideoFrameCallback timestamps).
 * null when there are no samples in that window.
 */
export function orientationSince(tMs: number): Orientation | null {
  const s = samplesSince(tMs);
  return s.length ? averageOrientation(s) : null;
}
