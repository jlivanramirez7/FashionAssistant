// Dev-only replay harness (entry for replay.html, design doc section 13).
// Pick a debug-capture zip -> decode frames -> run the same pipeline ->
// print measurements + diagnostics. Runs entirely in the browser; the zip
// never leaves this machine.

import type { PipelineResult, ProgressStage } from "../types";
import { MEASUREMENT_SPECS } from "../types";
import { parseDebugZip, type DebugManifest } from "./debugCapture";
import { rebuildCaptures } from "./replayCore";
import { initVision } from "../vision";
import { runPipeline } from "../pipeline/runPipeline";

function decodeJpeg(jpeg: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
}

// ---------------------------------------------------------------- DOM

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  style?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (style) e.style.cssText = style;
  return e;
}

const CELL = "border:1px solid #444;padding:4px 8px;text-align:left;";

function renderTable(headers: string[], rows: string[][]): HTMLTableElement {
  const table = el("table", undefined, "border-collapse:collapse;margin:8px 0;");
  const tr = el("tr");
  for (const h of headers) tr.appendChild(el("th", h, CELL + "background:#222;"));
  table.appendChild(tr);
  for (const r of rows) {
    const row = el("tr");
    for (const c of r) row.appendChild(el("td", c, CELL));
    table.appendChild(row);
  }
  return table;
}

function renderResult(out: HTMLElement, manifest: DebugManifest, result: PipelineResult, ms: number): void {
  out.appendChild(el("h2", "Measurements"));
  const rows: string[][] = [];
  for (const spec of MEASUREMENT_SPECS) {
    const m = result.measurements[spec.key];
    const raw = result.rawMeasurements[spec.key];
    if (!m && raw === undefined) continue;
    rows.push([
      spec.label,
      m ? m.valueCm.toFixed(1) : "-",
      m ? `±${m.uncertaintyCm.toFixed(1)}` : "-",
      m ? m.confidence.toFixed(2) : "-",
      raw !== undefined ? raw.toFixed(1) : "-",
      spec.targetCm !== null ? `±${spec.targetCm}` : "-",
    ]);
  }
  out.appendChild(renderTable(["Measurement", "cm", "uncertainty", "confidence", "raw cm", "target"], rows));

  if (result.retakeViews.length) {
    out.appendChild(el("h2", "Retake views"));
    out.appendChild(renderTable(["View", "Reason"], result.retakeViews.map((r) => [r.view, r.reason])));
  }

  out.appendChild(el("h2", "Diagnostics"));
  const pre = el("pre", undefined, "background:#1a1a1a;padding:8px;overflow:auto;");
  pre.textContent = JSON.stringify(
    {
      replayMs: Math.round(ms),
      solvedFocalLengthPx: result.solvedFocalLengthPx,
      diagnostics: result.diagnostics,
      inputs: manifest.inputs,
      profile: manifest.profile,
    },
    null,
    2,
  );
  out.appendChild(pre);
}

function renderSummary(out: HTMLElement, manifest: DebugManifest): void {
  out.appendChild(el("h2", "Capture"));
  out.appendChild(
    renderTable(
      ["Field", "Value"],
      [
        ["created", new Date(manifest.createdAt).toISOString()],
        ["height (cm)", String(manifest.inputs.heightCm)],
        ["body type", manifest.inputs.bodyType],
        ["subject", manifest.inputs.subjectLabel],
        ["device", `${manifest.profile.deviceModelGuess} (${manifest.profile.modelSource})`],
        ["capture size", `${manifest.profile.captureWidth}x${manifest.profile.captureHeight}`],
        ["sensor samples", String(manifest.sensorLog.length)],
        ...manifest.views.map((v): [string, string] => [`${v.view} frames`, String(v.frames.length)]),
      ],
    ),
  );
}

async function replayFile(file: File, status: HTMLElement, out: HTMLElement): Promise<void> {
  out.replaceChildren();
  const setStatus = (s: string) => (status.textContent = s);
  try {
    setStatus(`Reading ${file.name}...`);
    const { manifest, frames } = await parseDebugZip(new Uint8Array(await file.arrayBuffer()));
    renderSummary(out, manifest);

    setStatus(`Decoding ${frames.length} frames...`);
    const captures = await rebuildCaptures(manifest, frames, decodeJpeg);

    setStatus("Loading vision models...");
    await initVision({ heavy: true, segmenter: true });

    setStatus("Running pipeline...");
    const t0 = performance.now();
    const result = await runPipeline({
      captures,
      profile: manifest.profile,
      inputs: manifest.inputs,
      factors: null,
      onProgress: (stage: ProgressStage, fraction: number) => setStatus(`Running pipeline: ${stage} ${Math.round(fraction * 100)}%`),
    });
    const ms = performance.now() - t0;
    renderResult(out, manifest, result, ms);
    setStatus(`Done in ${(ms / 1000).toFixed(1)} s.`);

    for (const c of captures) for (const f of c.frames) if ("close" in f.image) f.image.close();
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function mount(root: HTMLElement): void {
  document.body.style.cssText = "margin:0;background:#111;color:#eee;font:14px/1.4 system-ui,sans-serif;";
  root.style.cssText = "padding:16px;max-width:1000px;";
  root.appendChild(el("h1", "Fashion Assistant - Replay (dev only)", "font-size:20px;"));
  root.appendChild(
    el("p", "Pick a debug-capture .zip. Everything runs locally; nothing is uploaded.", "color:#aaa;"),
  );
  const input = el("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  const status = el("p", "", "font-weight:bold;");
  const out = el("div");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void replayFile(file, status, out);
  });
  root.append(input, status, out);
}

if (typeof document !== "undefined") {
  const root = document.getElementById("replay");
  if (root) mount(root);
}

