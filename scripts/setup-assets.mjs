// Copies the MediaPipe wasm runtime into public/wasm and downloads the
// models into public/models (design doc section 12). Never fails the
// install: a missing model only prints a warning.
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = join(root, "public", "wasm");
const modelDir = join(root, "public", "models");

const MODELS = {
  "pose_landmarker_lite.task":
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
  "pose_landmarker_heavy.task":
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task",
  "selfie_multiclass_256x256.tflite":
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
};

async function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn("[setup-assets] @mediapipe/tasks-vision not installed yet; skipping wasm copy");
    return;
  }
  await mkdir(wasmDst, { recursive: true });
  await cp(wasmSrc, wasmDst, { recursive: true });
  console.log("[setup-assets] copied MediaPipe wasm -> public/wasm");
}

async function download(name, url) {
  const dst = join(modelDir, name);
  if (existsSync(dst) && (await stat(dst)).size > 0) {
    console.log(`[setup-assets] ${name} already present`);
    return;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(dst, Buffer.from(await res.arrayBuffer()));
    console.log(`[setup-assets] downloaded ${name}`);
  } catch (err) {
    console.warn(`[setup-assets] could not download ${name}: ${err.message}`);
  }
}

await copyWasm();
await mkdir(modelDir, { recursive: true });
for (const [name, url] of Object.entries(MODELS)) await download(name, url);
