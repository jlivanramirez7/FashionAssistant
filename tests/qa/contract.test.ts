// @vitest-environment jsdom
// QA: every module exports what docs/CONTRACTS.md promises (names, kinds,
// arity = Function.length range). A missing module fails ONLY its own
// tests, with the owner team in the message.
import { describe, expect, it } from "vitest";
import { exists, loadModule, type Team } from "./_helpers";

type ExportSpec =
  | { name: string; kind: "function"; arity: [number, number] }
  | { name: string; kind: "string" | "object" | "number" };

interface ModuleSpec {
  team: Team;
  file: string; // repo-relative, without .ts
  exports: ExportSpec[];
}

const f = (name: string, min: number, max = min): ExportSpec => ({ name, kind: "function", arity: [min, max] });
const v = (name: string, kind: "string" | "object" | "number"): ExportSpec => ({ name, kind });

const CONTRACT: ModuleSpec[] = [
  // ---------------------------------------------------------------- A
  { team: "A auth-data", file: "src/config", exports: [
    v("firebaseConfig", "object"), v("FIRESTORE_DATABASE_ID", "string"), v("ALLOWED_EMAIL", "string"),
    v("APP_VERSION", "string"), f("isFirebaseConfigured", 0),
  ] },
  { team: "A auth-data", file: "src/auth/firebase", exports: [f("getFirebase", 0)] },
  { team: "A auth-data", file: "src/auth/authGuard", exports: [
    f("isAllowed", 1), f("finishRedirect", 0), f("signIn", 0), f("signOutUser", 0), f("watchAuth", 1),
  ] },
  { team: "A auth-data", file: "src/data/deviceId", exports: [f("getDeviceId", 0), f("clearDeviceId", 0)] },
  { team: "A auth-data", file: "src/data/user", exports: [f("getUserDoc", 1), f("saveUserDoc", 2)] },
  { team: "A auth-data", file: "src/data/scans", exports: [
    f("saveScan", 2), f("updateScan", 3), f("getScan", 2), f("listScans", 1), f("deleteScan", 2),
  ] },
  { team: "A auth-data", file: "src/data/devices", exports: [f("getDeviceRecord", 2), f("saveDeviceRecord", 2)] },
  { team: "A auth-data", file: "src/data/settings", exports: [f("getCorrectionFactors", 1), f("saveCorrectionFactors", 2)] },
  { team: "A auth-data", file: "src/data/validation", exports: [f("validationStats", 1), f("computeCorrectionFactors", 1, 2)] },
  { team: "A auth-data", file: "src/data/deleteAll", exports: [f("deleteAllMyData", 1)] },
  // ---------------------------------------------------------------- B
  { team: "B device-capture", file: "src/device/profiles", exports: [
    v("GENERIC_SPEC", "object"), f("loadDeviceSpecs", 0), f("matchSpec", 2),
  ] },
  { team: "B device-capture", file: "src/device/detectModel", exports: [f("detectModelInfo", 0)] },
  { team: "B device-capture", file: "src/device/profile", exports: [
    f("focalPxFromSpec", 3, 4), f("lensOffsetCmFromSpec", 1), f("buildProfile", 1), f("buildDeviceProfile", 2, 3),
  ] },
  { team: "B device-capture", file: "src/capture/camera", exports: [f("startFrontCamera", 1), f("grabFrame", 1), f("stopCamera", 1)] },
  { team: "B device-capture", file: "src/capture/sensors", exports: [
    f("gravityToOrientation", 3), f("averageOrientation", 1), f("placementOk", 1), f("requestMotionPermission", 0),
    f("startSensors", 0), f("stopSensors", 0), f("currentOrientation", 0), f("orientationSince", 1),
  ] },
  { team: "B device-capture", file: "src/capture/voice", exports: [f("unlockVoice", 0), f("say", 1, 2), f("chime", 0), f("setMuted", 1)] },
  { team: "B device-capture", file: "src/wakeLock", exports: [f("acquireWakeLock", 0), f("releaseWakeLock", 0)] },
  // ---------------------------------------------------------------- C
  { team: "C geometry-measure", file: "src/geometry/camera", exports: [f("buildCamera", 4)] },
  { team: "C geometry-measure", file: "src/geometry/distortion", exports: [f("undistort", 3)] },
  { team: "C geometry-measure", file: "src/geometry/plane", exports: [
    f("distanceFromFeet", 2), f("makeViewPlane", 5), f("solveFocalLength", 4),
  ] },
  { team: "C geometry-measure", file: "src/measure/ellipse", exports: [f("ellipseCircumference", 2)] },
  { team: "C geometry-measure", file: "src/measure/silhouette", exports: [f("spanAtRow", 3)] },
  { team: "C geometry-measure", file: "src/measure/levels", exports: [f("findLevels", 1)] },
  { team: "C geometry-measure", file: "src/measure/compute", exports: [f("computeMeasurements", 3)] },
  { team: "C geometry-measure", file: "src/pipeline/runPipeline", exports: [f("runPipeline", 1)] },
  // ---------------------------------------------------------------- D
  { team: "D vision", file: "src/vision/index", exports: [
    f("initVision", 0, 1), f("detectPoseLive", 2), f("detectPoseHeavy", 1), f("segmentPerson", 2),
    f("frameQuality", 2), f("checkPose", 2, 3), v("MODEL_VERSIONS", "object"),
  ] },
  { team: "D vision", file: "src/vision/crops", exports: [f("regionCrops", 3)] },
  { team: "D vision", file: "src/vision/edgeRefine", exports: [] },
  { team: "D vision", file: "src/vision/compose", exports: [] },
  { team: "D vision", file: "src/vision/quality", exports: [] },
  { team: "D vision", file: "src/vision/poseCheck", exports: [] },
  // ---------------------------------------------------------------- E
  { team: "E ui-flow", file: "src/flow/stateMachine", exports: [f("transition", 2)] },
  { team: "E ui-flow", file: "src/units", exports: [f("cmToIn", 1), f("inToCm", 1), f("formatLength", 2), f("parseHeight", 1, 3)] },
  { team: "E ui-flow", file: "src/ui/context", exports: [] },
  // ---------------------------------------------------------------- F
  { team: "F dev-tools", file: "src/dev/debugCapture", exports: [
    f("debugEnabled", 0), f("buildDebugZip", 1), f("downloadBlob", 2), f("parseDebugZip", 1),
  ] },
];

const SCREENS = ["signIn", "home", "setup", "placePhone", "capture", "processing", "results", "history", "validation", "validationSummary"];
const PARTS = ["levelGauge", "poseGuide", "statusBorder", "measurementRow", "bodyDiagram", "unitToggle"];

function checkExport(mod: Record<string, unknown>, spec: ExportSpec, team: Team, file: string): string | null {
  const val = mod[spec.name];
  if (val === undefined) return `[${team}] ${file}.ts: missing export ${spec.name}`;
  if (spec.kind === "function") {
    if (typeof val !== "function") return `[${team}] ${file}.ts: ${spec.name} should be a function, is ${typeof val}`;
    const n = (val as (...a: unknown[]) => unknown).length;
    const [lo, hi] = spec.arity;
    if (n < lo || n > hi) {
      return `[${team}] ${file}.ts: ${spec.name} takes ${n} declared params, contract says ${lo === hi ? lo : `${lo}-${hi}`}`;
    }
    return null;
  }
  if (spec.kind === "object") {
    return typeof val === "object" && val !== null ? null : `[${team}] ${file}.ts: ${spec.name} should be an object`;
  }
  return typeof val === spec.kind ? null : `[${team}] ${file}.ts: ${spec.name} should be a ${spec.kind}, is ${typeof val}`;
}

describe("module contract (docs/CONTRACTS.md)", () => {
  for (const m of CONTRACT) {
    it(`[${m.team}] ${m.file}.ts exports ${m.exports.map((e) => e.name).join(", ") || "(module imports)"}`, async () => {
      const mod = await loadModule(m.file, m.team);
      const problems = m.exports.map((e) => checkExport(mod, e, m.team, m.file)).filter((p): p is string => !!p);
      expect(problems, problems.join("\n")).toEqual([]);
    }, 60_000);
  }

  for (const s of SCREENS) {
    it(`[E ui-flow] src/ui/screens/${s}.ts exports render(root, ctx)`, async () => {
      const mod = await loadModule(`src/ui/screens/${s}`, "E ui-flow");
      const problem = checkExport(mod, f("render", 2), "E ui-flow", `src/ui/screens/${s}`);
      expect(problem, problem ?? "").toBeNull();
    }, 60_000);
  }

  for (const p of PARTS) {
    it(`[E ui-flow] src/ui/parts/${p}.ts exists and imports`, async () => {
      await loadModule(`src/ui/parts/${p}`, "E ui-flow");
    }, 60_000);
  }

  it("[E ui-flow] src/main.ts and src/ui/styles.css exist", () => {
    const missing = ["src/main.ts", "src/ui/styles.css"].filter((p) => !exists(p));
    expect(missing, `[E ui-flow] missing ${missing.join(", ")}`).toEqual([]);
  });

  it("[F dev-tools] src/dev/replay.ts exists (not imported: it runs on load)", () => {
    expect(exists("src/dev/replay.ts"), "[F dev-tools] missing src/dev/replay.ts").toBe(true);
  });

  it("[orchestrator] src/types.ts runtime exports", async () => {
    const t = await loadModule("src/types", "orchestrator");
    expect(Array.isArray(t.MEASUREMENT_KEYS)).toBe(true);
    expect(Array.isArray(t.MEASUREMENT_SPECS)).toBe(true);
    expect(t.VIEWS).toEqual(["front", "side", "back"]);
    expect(t.LM.leftShoulder).toBe(11);
  });
});
