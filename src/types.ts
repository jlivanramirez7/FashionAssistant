// Shared types for every module (design doc sections 4, 7, 11).
// Owned by the orchestrator: change only via docs/CONTRACTS.md.

export type BodyType = "male" | "female" | "unspecified";
export type ViewName = "front" | "side" | "back";
export const VIEWS: readonly ViewName[] = ["front", "side", "back"];
export type Units = "in" | "cm";

// ---------------------------------------------------------------- measurements

export const MEASUREMENT_KEYS = [
  "height",
  "neck", "chest", "naturalWaist", "shoulderWidth", "sleeveLength",
  "shirtSleeve", "backLength", "bicep", "wrist",
  "pantWaist", "hips", "inseam", "outseam", "rise", "thigh", "knee", "calf",
  "bust", "underbust", "shoulderToWaist", "torsoLength",
  "footLength",
] as const;
export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export type MeasurementGroup = "general" | "tops" | "bottoms" | "dresses" | "shoes";
export type MeasurementKind = "length" | "circumference";

export interface MeasurementSpec {
  key: MeasurementKey;
  label: string;
  group: MeasurementGroup;
  kind: MeasurementKind;
  /** Accuracy target in cm (section 7); null for the height input. */
  targetCm: number | null;
  /** Shown amber at best (low resolution / experimental). */
  alwaysLowConfidence?: boolean;
}

export const MEASUREMENT_SPECS: readonly MeasurementSpec[] = [
  { key: "height", label: "Height", group: "general", kind: "length", targetCm: null },
  { key: "neck", label: "Neck", group: "tops", kind: "circumference", targetCm: 2 },
  { key: "chest", label: "Chest", group: "tops", kind: "circumference", targetCm: 3 },
  { key: "naturalWaist", label: "Waist", group: "tops", kind: "circumference", targetCm: 3 },
  { key: "shoulderWidth", label: "Shoulder width", group: "tops", kind: "length", targetCm: 1.5 },
  { key: "sleeveLength", label: "Sleeve", group: "tops", kind: "length", targetCm: 1.5 },
  { key: "shirtSleeve", label: "Shirt sleeve", group: "tops", kind: "length", targetCm: 2 },
  { key: "backLength", label: "Back length", group: "tops", kind: "length", targetCm: 2 },
  { key: "bicep", label: "Bicep", group: "tops", kind: "circumference", targetCm: 2 },
  { key: "wrist", label: "Wrist", group: "tops", kind: "circumference", targetCm: 1.5, alwaysLowConfidence: true },
  { key: "pantWaist", label: "Pant waist", group: "bottoms", kind: "circumference", targetCm: 3 },
  { key: "hips", label: "Hips", group: "bottoms", kind: "circumference", targetCm: 3 },
  { key: "inseam", label: "Inseam", group: "bottoms", kind: "length", targetCm: 2 },
  { key: "outseam", label: "Outseam", group: "bottoms", kind: "length", targetCm: 2 },
  { key: "rise", label: "Rise", group: "bottoms", kind: "length", targetCm: 2 },
  { key: "thigh", label: "Thigh", group: "bottoms", kind: "circumference", targetCm: 3 },
  { key: "knee", label: "Knee", group: "bottoms", kind: "circumference", targetCm: 2 },
  { key: "calf", label: "Calf", group: "bottoms", kind: "circumference", targetCm: 2 },
  { key: "bust", label: "Bust", group: "dresses", kind: "circumference", targetCm: 3 },
  { key: "underbust", label: "Underbust", group: "dresses", kind: "circumference", targetCm: 3 },
  { key: "shoulderToWaist", label: "Shoulder to waist", group: "dresses", kind: "length", targetCm: 2 },
  { key: "torsoLength", label: "Torso length", group: "dresses", kind: "length", targetCm: 3 },
  { key: "footLength", label: "Foot length", group: "shoes", kind: "length", targetCm: 1, alwaysLowConfidence: true },
];

export interface MeasurementValue {
  valueCm: number;
  uncertaintyCm: number;
  /** 0..1. UI: >= 0.75 green, >= 0.5 amber, else red. */
  confidence: number;
}
export type Measurements = Partial<Record<MeasurementKey, MeasurementValue>>;
export type RawMeasurements = Partial<Record<MeasurementKey, number>>;
export type TapeMeasurements = Partial<Record<MeasurementKey, number>>;

/** k per measurement key, per body type (section 7). Missing key => k = 1.0. */
export interface CorrectionFactors {
  male: Partial<Record<MeasurementKey, number>>;
  female: Partial<Record<MeasurementKey, number>>;
  unspecified: Partial<Record<MeasurementKey, number>>;
  updatedAt?: number; // epoch ms
}

// ---------------------------------------------------------------- device

export type ModelSource = "ua-client-hints" | "screen-match" | "generic";
export type LensOffsetSource = "profile" | "paper" | "generic";
export type FocalLengthSource = "spec" | "height-solve" | "paper";

/** One entry of public/device-profiles.json. */
export interface DeviceSpec {
  /** Exact model ("Pixel 8") or iOS family ("iPhone 14/15 (6.1in)"). */
  model: string;
  /** Android: exact userAgentData model strings that map to this entry. */
  uaModels?: string[];
  /** iOS: CSS-pixel screen size (portrait) + devicePixelRatio. */
  screenMatch?: { width: number; height: number; dpr: number };
  phoneHeightMm: number;
  frontLensFromTopMm: number;
  front35mmEqMm: number;
  frontSensorAspect?: string;
}

export interface DeviceProfile {
  deviceId: string;
  label: string;
  deviceModelGuess: string;
  modelSource: ModelSource;
  screen: { width: number; height: number; devicePixelRatio: number };
  phoneHeightMm?: number;
  lensOffsetCm: number;
  lensOffsetSource: LensOffsetSource;
  front35mmEqMm: number;
  distortionK1?: number;
  /** f_y in pixels at captureWidth x captureHeight. */
  focalLengthPx: number;
  focalLengthSource: FocalLengthSource;
  captureWidth: number;
  captureHeight: number;
  calibrationScans: number;
}

// ---------------------------------------------------------------- sensors & capture

/** Phone tilt from flat (theta, 60-85 allowed) and roll, in degrees. */
export interface Orientation {
  tiltDeg: number;
  rollDeg: number;
}

/** MediaPipe pose landmark, NORMALIZED image coords (0..1), unmirrored frame. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/** A captured full-resolution frame (unmirrored). */
export interface CapturedFrame {
  view: ViewName;
  timestampMs: number;
  image: ImageBitmap | ImageData;
  width: number;
  height: number;
  orientation: Orientation;
  /** Lite-model landmarks seen live when the frame was kept (optional). */
  liveLandmarks?: Landmark[];
}

export interface ViewCapture {
  view: ViewName;
  frames: CapturedFrame[];
}

/** Binary person mask in FULL-FRAME pixel coords: data[y*width+x] = 1 inside the body. */
export interface PersonMask {
  width: number;
  height: number;
  data: Uint8Array;
  /** How the mask was built (troubleshooting reports). */
  info?: { regions: number; regionsDropped: number; bodyMask: boolean };
}

export interface QualityScore {
  /** 0..1, higher is sharper. */
  sharpness: number;
  /** All required landmarks inside the central ~80% of the frame. */
  inFrame: boolean;
  /** 0..1 overall. */
  score: number;
  reason?: RetakeReason;
}

export type RetakeReason = "blurry" | "out-of-frame" | "distance-mismatch" | "pose-mismatch" | "no-person";

/** Live guidance hint for the capture screen. */
export type PoseHint =
  | "ok"
  | "no-person"
  | "step-back"
  | "move-closer"
  | "center"
  | "arms-out"
  | "arms-down"
  | "face-phone"
  | "turn-side"
  | "turn-back"
  | "hold-still";

// ---------------------------------------------------------------- geometry

/** Pinhole camera for one frame (section 4). Angles in radians, lengths in cm. */
export interface CameraModel {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** Tilt from flat (theta) and pitch phi = 90deg - theta. */
  thetaRad: number;
  phiRad: number;
  rollRad: number;
  /** Lens height above the floor h = L_lens * sin(theta). */
  lensHeightCm: number;
  k1: number;
}

/** Vertical metric plane through the user for one view (section 4). */
export interface ViewPlane {
  view: ViewName;
  /** Distance camera -> user plane from the feet row. */
  distanceCm: number;
  /** Multiplier that makes head-to-heel equal the typed height. */
  heightScale: number;
  /** |geometric height - typed height| / typed height * 100. */
  scaleAgreementPct: number;
  /** Pixel (u, v) -> metric (xCm horizontal, yCm above floor), height-scaled. */
  toMetric(u: number, v: number): { xCm: number; yCm: number };
  /** Image row v whose ray hits the plane at yCm above the floor (column = cx). */
  rowForHeight(yCm: number): number;
}

// ---------------------------------------------------------------- scans & storage

export interface ScanInputs {
  heightCm: number;
  bodyType: BodyType;
  subjectLabel: string;
}

export interface Diagnostics {
  userAgent: string;
  deviceModelGuess: string;
  modelSource: ModelSource;
  videoWidth: number;
  videoHeight: number;
  focalLengthPxSpec: number;
  focalLengthPxSolved?: number;
  lensOffsetCm: number;
  lensHeightCm: number;
  tiltDeg: number;
  rollDeg: number;
  distanceM: Partial<Record<ViewName, number>>;
  scaleAgreementPct: number;
  qualityScores: Partial<Record<ViewName, number>>;
  retakes: { step: ViewName; reason: RetakeReason }[];
  processingMs: number;
  modelVersions: Record<string, string>;
}

export type ScanStatus = "complete" | "partial";
export type ScaleSource = "height" | "height+floor" | "paper";

/** users/{uid}/scans/{scanId} (section 11). Timestamps as epoch ms in the app. */
export interface ScanDoc {
  id?: string;
  createdAt: number;
  status: ScanStatus;
  heightCm: number;
  bodyType: BodyType;
  subjectLabel: string;
  scaleSource: ScaleSource;
  deviceId: string;
  appVersion: string;
  viewsCaptured: ViewName[];
  measurements: Measurements;
  rawMeasurements: RawMeasurements;
  tapeMeasurements?: TapeMeasurements;
  diagnostics: Diagnostics;
}

/** users/{uid} */
export interface UserDoc {
  email: string;
  createdAt: number;
  heightCm?: number;
  units: Units;
  bodyType: BodyType;
}

/** Output of the processing pipeline (src/pipeline). */
export interface PipelineResult {
  measurements: Measurements;
  rawMeasurements: RawMeasurements;
  diagnostics: Omit<Diagnostics, "userAgent" | "deviceModelGuess" | "modelSource" | "retakes">;
  /** Views whose quality failed and must be retaken (empty = all good). */
  retakeViews: { view: ViewName; reason: RetakeReason }[];
  /** New focal length if the height solve overrode the spec (> 5% off). */
  solvedFocalLengthPx?: number;
  /** Per-frame / per-view trace (only when runPipeline is called with trace: true). */
  trace?: PipelineTrace;
}

// ---------------------------------------------------------------- troubleshooting trace

/** What the pipeline saw in one frame (troubleshooting reports). */
export interface FrameTrace {
  view: ViewName;
  index: number;
  width: number;
  height: number;
  tiltDeg: number;
  rollDeg: number;
  /** Heavy pose found a person. */
  pose: boolean;
  /** Visibility (0..1) of the landmarks the geometry depends on. */
  keyVisibility?: Record<string, number>;
  /** Normalized heavy-pose landmarks, rounded (x, y, visibility). */
  landmarks?: { x: number; y: number; v: number }[];
  mask: boolean;
  /** Share of the frame covered by the person mask (0..1). */
  maskCoverage?: number;
  /** Region crops used / dropped for filling their box; whole-body mask used. */
  maskInfo?: { regions: number; regionsDropped: number; bodyMask: boolean };
  /** Shoulder-to-shoulder px / head-to-feet px (about 0.2-0.3 for a real body). */
  shoulderRatio?: number;
  quality?: QualityScore;
  /** Pixel points used for scale: floor contact under the feet, top of the head. */
  feet?: { u: number; v: number };
  head?: { u: number; v: number };
  /** Focal length this frame alone implies (profile resolution), from height + floor. */
  focalSolvedPx?: number;
  distanceCm?: number;
  heightScale?: number;
  scaleAgreementPct?: number;
  /** Fed into the measurements. */
  used: boolean;
  /** Why the frame was not used. */
  skipped?: string;
}

export interface ViewTrace {
  view: ViewName;
  frames: number;
  usable: number;
  qualityMedian?: number;
  agreementMedianPct?: number;
  distanceMedianCm?: number;
  /** Quality-check failures by reason. */
  reasons: Partial<Record<RetakeReason, number>>;
  decision: "ok" | RetakeReason;
}

export interface PipelineTrace {
  frames: FrameTrace[];
  views: ViewTrace[];
  focalSpecPx: number;
  focalSolvedPx?: number;
  focalOverride: boolean;
  measurementCount: number;
  thresholds: { scaleAgreementLimitPct: number; focalOverrideFrac: number; minVisibility: number };
}

// ---------------------------------------------------------------- troubleshooting reports
// Opt-in ("Save troubleshooting data"). users/{uid}/diagnostics/{id} with
// subcollections attempts/{n} (one per processing run) and frames/{frameId}
// (one JPEG per captured frame).

export type DiagOutcome = "in-progress" | "results" | "retake" | "error";

/** One feedback-log line; t = ms since the scan started. */
export interface DiagLogEntry {
  t: number;
  msg: string;
}

/** A captured frame stored with the report (bytes live in frames/{id}). */
export interface DiagFrameRef {
  id: string;
  view: ViewName;
  index: number;
  timestampMs: number;
  width: number;
  height: number;
  orientation: Orientation;
}

/** users/{uid}/diagnostics/{id}/attempts/{n}: one processing run. */
export interface DiagAttempt {
  n: number;
  createdAt: number;
  outcome: Exclude<DiagOutcome, "in-progress">;
  /** Frames fed to this run, in pipeline order. */
  frames: DiagFrameRef[];
  retakeViews?: { view: ViewName; reason: RetakeReason }[];
  /** Views still failing after the retake limit (scan saved as partial). */
  unresolved?: ViewName[];
  error?: string;
  scanId?: string;
  measurements?: Measurements;
  rawMeasurements?: RawMeasurements;
  diagnostics?: PipelineResult["diagnostics"];
  trace?: PipelineTrace;
  /** Feedback log since the previous attempt. */
  log: DiagLogEntry[];
}

/** users/{uid}/diagnostics/{id}: one scan session. */
export interface DiagReport {
  id?: string;
  createdAt: number;
  updatedAt: number;
  appVersion: string;
  userAgent: string;
  inputs: ScanInputs;
  profile: DeviceProfile;
  outcome: DiagOutcome;
  attempts: number;
  /** One line, e.g. "retake: front blurry". */
  summary: string;
  /** Phone time zone (IANA), so the report shows local times. */
  timeZone?: string;
  /** Phone orientation samples over the scan (downsampled). */
  sensorLog?: Orientation[];
}

export type ProgressStage = "pose" | "outline" | "front" | "side" | "back" | "measure";
export type ProgressFn = (stage: ProgressStage, fraction: number) => void;

// ---------------------------------------------------------------- pose landmark indices

export const LM = {
  nose: 0,
  leftEar: 7, rightEar: 8,
  mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
} as const;
