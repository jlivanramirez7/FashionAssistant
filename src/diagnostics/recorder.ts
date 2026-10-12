// Troubleshooting recorder (opt-in "Save troubleshooting data"). After each
// processing run it JPEG-encodes the frames not uploaded yet (before they
// are closed for a retake), then uploads the report, the attempt (pipeline
// trace + feedback log) and the frames in the background.
import { APP_VERSION, BUILD_ID } from "../config";
import { putDiagAttempt, putDiagFrame, putDiagReport } from "../data/diagnostics";
import type {
  CapturedFrame,
  DeviceProfile,
  DiagAttempt,
  DiagFrameRef,
  DiagReport,
  Orientation,
  PipelineResult,
  RetakeReason,
  ScanInputs,
  ViewCapture,
  ViewName,
} from "../types";
import { diagLog, takeDiagLog } from "./log";

/** JPEG quality ladder; the server stores at most ~1 MB per frame. */
const JPEG_QUALITIES = [0.85, 0.7, 0.55, 0.4];
export const MAX_FRAME_BYTES = 950_000;
const MAX_SENSOR_SAMPLES = 600;
const UPLOAD_CONCURRENCY = 3;

/** Frames waiting to upload across all recorders (outlives the scan session). */
let inFlightFrames = 0;
export function pendingFrameUploads(): number {
  return inFlightFrames;
}

export interface DiagRecorder {
  id: string;
  createdAt: number;
  attempts: number;
  /** Frames already encoded / uploaded -> frame id. */
  frameIds: WeakMap<CapturedFrame, string>;
  seq: number;
  /** Background uploads, chained so attempts land in order. */
  pending: Promise<void>;
  /** Frames still to upload (for the UI). */
  queued: number;
  failed: number;
}

/** PURE. Report id: time + random, matches ^[A-Za-z0-9_-]{1,64}$. */
export function newReportId(now = Date.now(), rand = Math.random): string {
  return `${now.toString(36)}-${Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0")}`;
}

export function createRecorder(now = Date.now()): DiagRecorder {
  return { id: newReportId(now), createdAt: now, attempts: 0, frameIds: new WeakMap(), seq: 0, pending: Promise.resolve(), queued: 0, failed: 0 };
}

/** PURE. Evenly downsample + round orientation samples. */
export function downsampleSensors(samples: Orientation[], max = MAX_SENSOR_SAMPLES): Orientation[] {
  const step = Math.max(1, samples.length / max);
  const out: Orientation[] = [];
  for (let i = 0; i < samples.length && out.length < max; i += step) {
    const o = samples[Math.floor(i)];
    out.push({ tiltDeg: Math.round(o.tiltDeg * 10) / 10, rollDeg: Math.round(o.rollDeg * 10) / 10 });
  }
  return out;
}

/** PURE. One-line summary shown in the report list. */
export function summarize(args: {
  outcome: DiagAttempt["outcome"];
  retakeViews?: { view: ViewName; reason: RetakeReason }[];
  unresolved?: ViewName[];
  measurementCount?: number;
  error?: string;
}): string {
  if (args.outcome === "error") return `error: ${args.error ?? "unknown"}`.slice(0, 300);
  if (args.outcome === "retake") {
    return `retake: ${(args.retakeViews ?? []).map((r) => `${r.view} ${r.reason}`).join(", ") || "?"}`;
  }
  const partial = args.unresolved?.length ? ` (partial, still failing: ${args.unresolved.join(", ")})` : "";
  return `results: ${args.measurementCount ?? 0} measurements${partial}`;
}

async function encodeJpeg(image: CapturedFrame["image"]): Promise<Uint8Array> {
  const { width, height } = image;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  if ("data" in image) ctx.putImageData(image, 0, 0);
  else ctx.drawImage(image, 0, 0);
  let bytes = new Uint8Array(0);
  for (const quality of JPEG_QUALITIES) {
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length <= MAX_FRAME_BYTES) return bytes;
  }
  throw new Error(`frame too large even at low quality (${bytes.length} bytes)`);
}

function frameRef(id: string, f: CapturedFrame, index: number): DiagFrameRef {
  return {
    id,
    view: f.view,
    index,
    timestampMs: Math.round(f.timestampMs),
    width: f.width,
    height: f.height,
    orientation: { tiltDeg: f.orientation.tiltDeg, rollDeg: f.orientation.rollDeg },
  };
}

/**
 * Record one processing run. Resolves once the new frames are encoded (so
 * the caller may close them); the uploads continue in rec.pending.
 */
export async function recordAttempt(
  rec: DiagRecorder,
  args: {
    captures: ViewCapture[];
    inputs: ScanInputs;
    profile: DeviceProfile;
    sensorLog: Orientation[];
    outcome: DiagAttempt["outcome"];
    result?: PipelineResult;
    retakeViews?: { view: ViewName; reason: RetakeReason }[];
    unresolved?: ViewName[];
    scanId?: string;
    error?: string;
  },
): Promise<void> {
  const n = ++rec.attempts;
  const refs: DiagFrameRef[] = [];
  const toUpload: { id: string; jpeg: Uint8Array }[] = [];
  for (const c of args.captures) {
    for (let i = 0; i < c.frames.length; i++) {
      const f = c.frames[i];
      let id = rec.frameIds.get(f);
      if (!id) {
        id = `${f.view}-${++rec.seq}`;
        try {
          toUpload.push({ id, jpeg: await encodeJpeg(f.image) });
          rec.frameIds.set(f, id);
        } catch (e) {
          diagLog(`frame ${id} not saved: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      refs.push(frameRef(id, f, i));
    }
  }

  const r = args.result;
  const attempt: DiagAttempt = {
    n,
    createdAt: Date.now(),
    outcome: args.outcome,
    frames: refs,
    log: takeDiagLog(),
  };
  if (args.retakeViews?.length) attempt.retakeViews = args.retakeViews;
  if (args.unresolved?.length) attempt.unresolved = args.unresolved;
  if (args.error) attempt.error = args.error.slice(0, 2000);
  if (args.scanId) attempt.scanId = args.scanId;
  if (r) {
    attempt.measurements = r.measurements;
    attempt.rawMeasurements = r.rawMeasurements;
    attempt.diagnostics = r.diagnostics;
    if (r.trace) attempt.trace = r.trace;
  }
  const report: DiagReport = {
    createdAt: rec.createdAt,
    updatedAt: Date.now(),
    appVersion: `${APP_VERSION} (build ${BUILD_ID})`,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    inputs: args.inputs,
    profile: args.profile,
    outcome: args.outcome,
    attempts: n,
    summary: summarize({ ...args, measurementCount: r ? Object.keys(r.measurements).length : 0 }),
    sensorLog: downsampleSensors(args.sensorLog),
  };
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) report.timeZone = tz;
  } catch {
    /* UTC only */
  }

  rec.queued += toUpload.length;
  inFlightFrames += toUpload.length;
  const id = rec.id;
  rec.pending = rec.pending.then(async () => {
    try {
      await putDiagReport(id, report);
      await putDiagAttempt(id, attempt);
    } catch (e) {
      rec.failed++;
      console.warn("Troubleshooting report not saved", e);
    }
    const queue = [...toUpload];
    const worker = async (): Promise<void> => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          await putDiagFrame(id, job.id, job.jpeg);
        } catch (e) {
          rec.failed++;
          console.warn(`Troubleshooting frame ${job.id} not saved`, e);
        } finally {
          rec.queued--;
          inFlightFrames--;
        }
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  });
}
