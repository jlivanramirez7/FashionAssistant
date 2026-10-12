// MediaPipe loader (browser only). Kept thin: creates the tasks with a GPU
// delegate and falls back to CPU. The package is imported dynamically so that
// importing src/vision in Node tests never loads the wasm bundle.
//
// API used (@mediapipe/tasks-vision 1.1.0, vision.d.ts):
//   FilesetResolver.forVisionTasks(basePath)
//   PoseLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath, delegate }, runningMode: "IMAGE" | "VIDEO", numPoses })
//   ImageSegmenter.createFromOptions(fileset, { baseOptions, runningMode: "IMAGE", outputConfidenceMasks, outputCategoryMask })

import type { ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";

type Mp = typeof import("@mediapipe/tasks-vision");
type Fileset = Awaited<ReturnType<Mp["FilesetResolver"]["forVisionTasks"]>>;
type Delegate = "GPU" | "CPU";

export const MODEL_FILES = {
  poseLite: "pose_landmarker_lite.task",
  poseHeavy: "pose_landmarker_heavy.task",
  segmenter: "selfie_multiclass_256x256.tflite",
} as const;

export const MODEL_VERSIONS: Record<string, string> = {
  "tasks-vision": "1.1.0",
  poseLive: "pose_landmarker_lite float16/latest",
  poseHeavy: "pose_landmarker_heavy float16/latest",
  segmenter: "selfie_multiclass_256x256 float32/latest",
};

export interface RuntimeConfig {
  wasmBase: string;
  modelBase: string;
}

export const config: RuntimeConfig = { wasmBase: "/wasm", modelBase: "/models" };

let mpPromise: Promise<Mp> | null = null;
let filesetPromise: Promise<Fileset> | null = null;
let filesetBase = "";

export const tasks: {
  live: PoseLandmarker | null;
  heavy: PoseLandmarker | null;
  segmenter: ImageSegmenter | null;
} = { live: null, heavy: null, segmenter: null };

const pending: { live?: Promise<PoseLandmarker>; heavy?: Promise<PoseLandmarker>; segmenter?: Promise<ImageSegmenter> } = {};

/** Which delegate each task ended up on (diagnostics). */
export const delegates: Partial<Record<"live" | "heavy" | "segmenter", Delegate>> = {};

function mp(): Promise<Mp> {
  if (!mpPromise) mpPromise = import("@mediapipe/tasks-vision");
  return mpPromise;
}

async function fileset(): Promise<Fileset> {
  if (!filesetPromise || filesetBase !== config.wasmBase) {
    filesetBase = config.wasmBase;
    const m = await mp();
    filesetPromise = m.FilesetResolver.forVisionTasks(config.wasmBase);
  }
  return filesetPromise;
}

function modelPath(file: string): string {
  return `${config.modelBase.replace(/\/$/, "")}/${file}`;
}

async function withFallback<T>(name: "live" | "heavy" | "segmenter", create: (d: Delegate) => Promise<T>): Promise<T> {
  try {
    const t = await create("GPU");
    delegates[name] = "GPU";
    return t;
  } catch (err) {
    console.warn(`[vision] ${name}: GPU delegate failed, using CPU`, err);
    const t = await create("CPU");
    delegates[name] = "CPU";
    return t;
  }
}

function createPose(name: "live" | "heavy"): Promise<PoseLandmarker> {
  return (async () => {
    const [m, fs] = await Promise.all([mp(), fileset()]);
    return withFallback(name, (delegate) =>
      m.PoseLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: modelPath(name === "live" ? MODEL_FILES.poseLite : MODEL_FILES.poseHeavy), delegate },
        runningMode: name === "live" ? "VIDEO" : "IMAGE",
        numPoses: 1,
        // Heavy: whole-body mask, used to keep the per-region segmentation honest.
        outputSegmentationMasks: name === "heavy",
      }),
    );
  })();
}

function createSegmenter(): Promise<ImageSegmenter> {
  return (async () => {
    const [m, fs] = await Promise.all([mp(), fileset()]);
    return withFallback("segmenter", (delegate) =>
      m.ImageSegmenter.createFromOptions(fs, {
        baseOptions: { modelAssetPath: modelPath(MODEL_FILES.segmenter), delegate },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }),
    );
  })();
}

export async function ensureLive(): Promise<PoseLandmarker> {
  if (tasks.live) return tasks.live;
  pending.live ??= createPose("live").catch((e) => { pending.live = undefined; throw e; });
  tasks.live = await pending.live;
  return tasks.live;
}

export async function ensureHeavy(): Promise<PoseLandmarker> {
  if (tasks.heavy) return tasks.heavy;
  pending.heavy ??= createPose("heavy").catch((e) => { pending.heavy = undefined; throw e; });
  tasks.heavy = await pending.heavy;
  return tasks.heavy;
}

export async function ensureSegmenter(): Promise<ImageSegmenter> {
  if (tasks.segmenter) return tasks.segmenter;
  pending.segmenter ??= createSegmenter().catch((e) => { pending.segmenter = undefined; throw e; });
  tasks.segmenter = await pending.segmenter;
  return tasks.segmenter;
}

/** Frees every loaded task (TaskRunner.close()). */
export function closeAll(): void {
  for (const k of ["live", "heavy", "segmenter"] as const) {
    tasks[k]?.close();
    tasks[k] = null;
    pending[k] = undefined;
  }
}
