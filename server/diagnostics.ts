// Troubleshooting reports (opt-in "Save troubleshooting data"): request
// validation, the plain-text report and the replay-compatible .zip bundle.
// All pure; the routes live in api.ts.
import { strToU8, zipSync, type Zippable } from "fflate";
import type { DiagAttempt, DiagOutcome, DiagReport, FrameTrace, ViewName } from "../src/types.ts";
import { findImageLikeData, isPlainObject, isValidId, type Result } from "./validate.ts";

/** One stored JPEG (Firestore documents max out at 1 MiB). */
export const MAX_FRAME_BYTES = 1_000_000;
/** Attempt / report JSON bodies (a little under the Firestore document limit). */
export const MAX_DIAG_JSON = 950_000;

const OUTCOMES: readonly DiagOutcome[] = ["in-progress", "results", "retake", "error"];
const VIEWS: readonly ViewName[] = ["front", "side", "back"];
const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------- validation

export function validateDiagReport(body: unknown, now: number): Result<DiagReport> {
  if (!isPlainObject(body)) return fail("body must be an object");
  const bad = findImageLikeData(body);
  if (bad) return fail(bad);
  if (!num(body.createdAt)) return fail("createdAt must be a number");
  if (typeof body.appVersion !== "string") return fail("appVersion must be a string");
  if (typeof body.userAgent !== "string") return fail("userAgent must be a string");
  if (!isPlainObject(body.inputs)) return fail("inputs must be an object");
  if (!isPlainObject(body.profile)) return fail("profile must be an object");
  if (!OUTCOMES.includes(body.outcome as DiagOutcome)) return fail("outcome is invalid");
  if (!num(body.attempts)) return fail("attempts must be a number");
  if (typeof body.summary !== "string" || body.summary.length > 500) return fail("summary must be a short string");
  if (body.sensorLog !== undefined && !Array.isArray(body.sensorLog)) return fail("sensorLog must be an array");
  const { id: _id, ...rest } = body;
  void _id;
  return { ok: true, value: { ...(rest as unknown as DiagReport), updatedAt: now } };
}

export function validateDiagAttempt(body: unknown, n: number): Result<DiagAttempt> {
  if (!isPlainObject(body)) return fail("body must be an object");
  const bad = findImageLikeData(body);
  if (bad) return fail(bad);
  if (body.n !== n) return fail("n must match the URL");
  if (!num(body.createdAt)) return fail("createdAt must be a number");
  if (!OUTCOMES.includes(body.outcome as DiagOutcome) || body.outcome === "in-progress") return fail("outcome is invalid");
  if (!Array.isArray(body.frames)) return fail("frames must be an array");
  for (const f of body.frames) {
    if (!isPlainObject(f) || !isValidId(f.id) || !VIEWS.includes(f.view as ViewName)) return fail("frames[] is invalid");
  }
  if (!Array.isArray(body.log)) return fail("log must be an array");
  return { ok: true, value: body as unknown as DiagAttempt };
}

/** Attempt number from the URL: 1..999. */
export function parseAttemptNumber(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,2}$/.test(raw)) return null;
  return Number(raw);
}

/** JPEG files start with FF D8 FF. */
export function isJpeg(buf: Uint8Array): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

// ---------------------------------------------------------------- text report

const iso = (ms: number | undefined) => (num(ms) ? new Date(ms).toISOString() : "?");
const f1 = (x: number | undefined) => (num(x) ? (Math.round(x * 10) / 10).toString() : "-");
const f2 = (x: number | undefined) => (num(x) ? x.toFixed(2) : "-");
const secs = (ms: number) => `+${(ms / 1000).toFixed(1)}s`;

const REASON_TEXT: Record<string, string> = {
  "no-person": "no usable person found in any frame (pose, outline, feet or head missing)",
  blurry: "most frames too blurry",
  "out-of-frame": "body (often feet or head) too close to the frame edge in most frames",
  "distance-mismatch": "height from the floor geometry disagrees with your typed height",
  "pose-mismatch": "pose did not match the step",
};

function frameLine(t: FrameTrace): string {
  const parts = [
    `#${t.index}`,
    `tilt ${f1(t.tiltDeg)} roll ${f1(t.rollDeg)}`,
    `pose ${t.pose ? "Y" : "N"}`,
    `mask ${t.mask ? `Y ${f2(t.maskCoverage)}` : "N"}`,
  ];
  if (t.maskInfo) {
    parts.push(`regions ${t.maskInfo.regions - t.maskInfo.regionsDropped}/${t.maskInfo.regions} body-mask ${t.maskInfo.bodyMask ? "Y" : "N"}`);
  }
  if (num(t.shoulderRatio)) parts.push(`shoulder/height ${f2(t.shoulderRatio)}`);
  if (t.quality) {
    parts.push(`sharp ${f2(t.quality.sharpness)} inFrame ${t.quality.inFrame ? "Y" : "N"}${t.quality.reason ? ` [${t.quality.reason}]` : ""}`);
  }
  if (t.feet) parts.push(`feet(${Math.round(t.feet.u)},${Math.round(t.feet.v)})`);
  if (t.head) parts.push(`head(${Math.round(t.head.u)},${Math.round(t.head.v)})`);
  if (num(t.focalSolvedPx)) parts.push(`f ${Math.round(t.focalSolvedPx)}`);
  if (num(t.distanceCm)) parts.push(`dist ${f1(t.distanceCm)}cm agree ${f2(t.scaleAgreementPct)}%`);
  parts.push(t.used ? "USED" : `SKIPPED: ${t.skipped ?? "?"}`);
  if (t.keyVisibility) {
    const low = Object.entries(t.keyVisibility).filter(([, v]) => v < 0.5).map(([k, v]) => `${k} ${f2(v)}`);
    if (low.length) parts.push(`low-vis: ${low.join(", ")}`);
  }
  return parts.join(" | ");
}

function attemptLines(a: DiagAttempt): string[] {
  const out: string[] = [];
  const head = `Attempt ${a.n} (${iso(a.createdAt)}) -> ${a.outcome.toUpperCase()}`;
  out.push(head, "-".repeat(head.length));
  if (a.error) out.push(`Error: ${a.error}`);
  if (a.retakeViews?.length) {
    for (const r of a.retakeViews) out.push(`Retake ${r.view}: ${r.reason} - ${REASON_TEXT[r.reason] ?? ""}`);
  }
  if (a.unresolved?.length) out.push(`Still failing after retakes (saved as partial): ${a.unresolved.join(", ")}`);
  if (a.scanId) out.push(`Saved scan id: ${a.scanId}`);
  const byView = new Map<string, number>();
  for (const f of a.frames) byView.set(f.view, (byView.get(f.view) ?? 0) + 1);
  out.push(`Frames: ${[...byView].map(([v, n]) => `${v} ${n}`).join(", ") || "none"}`);
  const d = a.diagnostics;
  if (d) {
    out.push(
      `Video ${d.videoWidth}x${d.videoHeight}; focal spec ${f1(d.focalLengthPxSpec)}px solved ${f1(d.focalLengthPxSolved)}px; ` +
        `lens height ${f1(d.lensHeightCm)}cm; tilt ${f1(d.tiltDeg)} roll ${f1(d.rollDeg)}; processing ${Math.round(d.processingMs)}ms`,
    );
  }
  const t = a.trace;
  if (t) {
    out.push(
      `Focal: spec ${f1(t.focalSpecPx)}px, solved ${f1(t.focalSolvedPx)}px, override ${t.focalOverride ? "yes" : "no"}; ` +
        `measurements computed: ${t.measurementCount}; scale-agreement limit ${t.thresholds.scaleAgreementLimitPct}%`,
    );
    for (const v of t.views) {
      const reasons = Object.entries(v.reasons).map(([k, n]) => `${k} x${n}`).join(", ") || "none";
      out.push(
        `View ${v.view}: ${v.usable}/${v.frames} usable; quality median ${f2(v.qualityMedian)}; ` +
          `agreement median ${f2(v.agreementMedianPct)}%; distance median ${f1(v.distanceMedianCm)}cm; ` +
          `quality fails: ${reasons} => ${v.decision}`,
      );
      for (const fr of t.frames.filter((x) => x.view === v.view)) out.push(`  ${frameLine(fr)}`);
    }
  } else {
    out.push("(no pipeline trace)");
  }
  const m = a.measurements ?? {};
  const keys = Object.keys(m) as (keyof typeof m)[];
  if (keys.length) {
    out.push(
      `Measurements (cm): ${keys
        .map((k) => `${k} ${f1(m[k]!.valueCm)}±${f1(m[k]!.uncertaintyCm)} (${f2(m[k]!.confidence)})`)
        .join("; ")}`,
    );
  }
  if (a.log.length) {
    out.push("Feedback log:");
    for (const e of a.log) out.push(`  ${secs(e.t)} ${e.msg}`);
  }
  return out;
}

/** Plain-text report to paste into a chat / bug report. */
export function diagReportText(report: DiagReport, attempts: DiagAttempt[]): string {
  const p = report.profile;
  const lines = [
    "FASHION ASSISTANT - TROUBLESHOOTING REPORT",
    `Report ${report.id ?? "?"} | created ${iso(report.createdAt)} | updated ${iso(report.updatedAt)} | app ${report.appVersion}`,
    `Outcome: ${report.outcome} after ${report.attempts} processing run(s) - ${report.summary}`,
    `Inputs: height ${f1(report.inputs?.heightCm)}cm, body type ${report.inputs?.bodyType}`,
    `Device: ${p?.deviceModelGuess} (${p?.modelSource}); capture ${p?.captureWidth}x${p?.captureHeight}; ` +
      `focal ${f1(p?.focalLengthPx)}px (${p?.focalLengthSource}); lens offset ${f1(p?.lensOffsetCm)}cm (${p?.lensOffsetSource}); ` +
      `35mm-eq ${p?.front35mmEqMm}mm; calibration scans ${p?.calibrationScans}`,
    `User agent: ${report.userAgent}`,
    `Sensor samples: ${report.sensorLog?.length ?? 0}`,
    "",
  ];
  for (const a of attempts) lines.push(...attemptLines(a), "");
  if (!attempts.length) lines.push("(no processing runs recorded)");
  return lines.join("\n");
}

// ---------------------------------------------------------------- zip bundle

/**
 * .zip with report.txt, report.json, attempt-N.json and, for the chosen
 * attempt, manifest.json + frames/<view>/<index>.jpg in the debug-capture
 * format replay.html reads (DEBUG_MANIFEST_VERSION 1).
 */
export function buildDiagBundle(
  report: DiagReport,
  attempts: DiagAttempt[],
  attempt: DiagAttempt | null,
  frames: Map<string, Uint8Array>,
): Uint8Array {
  const files: Zippable = {
    "report.txt": strToU8(diagReportText(report, attempts)),
    "report.json": strToU8(JSON.stringify(report, null, 2)),
  };
  for (const a of attempts) files[`attempt-${a.n}.json`] = strToU8(JSON.stringify(a, null, 2));
  if (attempt) {
    const views: { view: ViewName; frames: unknown[] }[] = [];
    const missing: string[] = [];
    for (const view of VIEWS) {
      const refs = attempt.frames.filter((f) => f.view === view);
      if (!refs.length) continue;
      const metas: unknown[] = [];
      refs.forEach((ref, index) => {
        const jpeg = frames.get(ref.id);
        if (!jpeg) {
          missing.push(ref.id);
          return;
        }
        const path = `frames/${view}/${metas.length}.jpg`;
        files[path] = [jpeg, { level: 0 }];
        metas.push({
          index: metas.length,
          path,
          timestampMs: ref.timestampMs,
          width: ref.width,
          height: ref.height,
          orientation: ref.orientation,
          sourceIndex: index,
        });
      });
      views.push({ view, frames: metas });
    }
    const manifest = {
      version: 1,
      createdAt: report.createdAt,
      inputs: report.inputs,
      profile: report.profile,
      views,
      sensorLog: report.sensorLog ?? [],
      attempt: attempt.n,
      ...(missing.length ? { missingFrames: missing } : {}),
    };
    files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  }
  return zipSync(files, { level: 6 });
}
