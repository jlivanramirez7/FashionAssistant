// S6 Processing: heavy pose + crop segmentation on the kept frames
// (runPipeline), retake only failing steps, then save the scan + device
// record and open Results.
import { APP_VERSION } from "../../config";
import { saveDeviceRecord } from "../../data/devices";
import { getDeviceId } from "../../data/deviceId";
import { saveScan, updateScan } from "../../data/scans";
import { samplesSince } from "../../capture/sensors";
import { runPipeline } from "../../pipeline/runPipeline";
import { VIEWS, type ProgressStage, type ViewCapture } from "../../types";
import { initVision } from "../../vision";
import { closeFrames, errorMessage, type AppContext } from "../context";
import { buildScanDoc, overallProgress, planRetakes, STAGE_TEXT, updatedProfile } from "../processingLogic";
import { loadDebug } from "../debug";
import { button, h, setChildren } from "../dom";

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const state = ctx.state;
  if (state.name !== "processing") return () => undefined;
  const s = ctx.session;
  let alive = true;

  const bar = h("div", { class: "progress-fill" });
  const stageEl = h("p", { class: "stage" }, "Getting ready");
  const box = h("div", { class: "processing-box" },
    h("h1", null, "Calculating your measurements..."),
    h("div", { class: "progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, bar),
    stageEl,
    h("p", { class: "muted" }, "This takes about 5-15 seconds. Everything stays on your phone."),
  );
  const actions = h("div", { class: "screen-actions" });
  root.appendChild(h("section", { class: "screen screen-processing" }, h("div", { class: "screen-body" }, box), actions));

  let shown = 0;
  function progress(stage: ProgressStage, fraction: number): void {
    if (!alive) return;
    shown = Math.max(shown, overallProgress(stage, fraction));
    bar.style.width = `${Math.round(shown * 100)}%`;
    bar.parentElement?.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
    stageEl.textContent = STAGE_TEXT[stage] ?? "";
  }

  async function run(): Promise<void> {
    setChildren(actions);
    if (!s.inputs || !s.profile) throw new Error("The scan was not set up. Start a new scan.");
    const captures: ViewCapture[] = VIEWS.filter((v) => s.captures[v]?.length).map((v) => ({ view: v, frames: s.captures[v]! }));

    const dbg = s.debugCapture ? await loadDebug() : null;
    if (dbg) {
      stageEl.textContent = "Saving debug capture";
      try {
        const sensorLog = samplesSince(s.scanStartMs);
        const zip = await dbg.buildDebugZip({ captures, profile: s.profile, inputs: s.inputs, sensorLog });
        dbg.downloadBlob(zip, dbg.debugZipName());
      } catch (e) {
        console.warn("Debug capture failed", e);
      }
    }

    stageEl.textContent = "Loading the measuring models";
    await initVision({ heavy: true, segmenter: true });
    if (!alive) return;

    const result = await runPipeline({
      captures,
      profile: s.profile,
      inputs: s.inputs,
      factors: s.factors,
      onProgress: progress,
    });
    if (!alive) return;

    const plan = planRetakes(result.retakeViews, s.retakeCount);
    if (plan.retake.length > 0) {
      for (const r of plan.retake) {
        s.retakes.push({ step: r.view, reason: r.reason });
        s.retakeCount[r.view] = (s.retakeCount[r.view] ?? 0) + 1;
      }
      closeFrames(s, plan.retake.map((r) => r.view));
      ctx.dispatch({ type: "PROCESSING_RETAKE", views: plan.retake.map((r) => r.view) });
      return;
    }
    s.unresolved = plan.unresolved;

    stageEl.textContent = "Saving";
    const uid = ctx.user?.uid;
    if (!uid) throw new Error("You are signed out.");
    const scan = buildScanDoc({
      session: s,
      result,
      deviceId: getDeviceId(),
      appVersion: APP_VERSION,
      userAgent: navigator.userAgent,
      now: Date.now(),
    });

    const target = state.name === "processing" ? state.target : null;
    let id: string;
    if (target) {
      const prev = ctx.scanCache.get(target);
      const { createdAt: _createdAt, subjectLabel: _label, ...patch } = scan;
      void _createdAt;
      void _label;
      await updateScan(uid, target, patch);
      id = target;
      ctx.scanCache.set(id, { ...(prev ?? scan), ...patch, id });
    } else {
      id = await saveScan(uid, scan);
      ctx.scanCache.set(id, { ...scan, id });
    }
    s.scanId = id;

    s.profile = updatedProfile(s.profile, result.solvedFocalLengthPx);
    void saveDeviceRecord(uid, s.profile).catch((e: unknown) => console.warn("Device record not saved", e));

    if (alive) {
      progress("measure", 1);
      ctx.dispatch({ type: "RESULTS_READY", scanId: id });
    }
  }

  function start(): void {
    run().catch((e: unknown) => {
      if (!alive) return;
      console.error(e);
      stageEl.textContent = `Something went wrong: ${errorMessage(e)}`;
      stageEl.classList.add("error");
      setChildren(
        actions,
        button("Try again", () => {
          stageEl.classList.remove("error");
          start();
        }, "btn primary"),
        button("Cancel", () => ctx.dispatch({ type: "CANCEL" }), "btn ghost"),
      );
    });
  }
  start();

  return () => {
    alive = false;
  };
}
