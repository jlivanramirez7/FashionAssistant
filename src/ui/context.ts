// Shared app context handed to every screen's render(root, ctx).
import type { DiagRecorder } from "../diagnostics/recorder";
import type { Event, State } from "../flow/stateMachine";
import type {
  CapturedFrame,
  CorrectionFactors,
  DeviceProfile,
  RetakeReason,
  ScanDoc,
  ScanInputs,
  Units,
  UserDoc,
  ViewName,
} from "../types";

/** Everything kept in memory for one scan (frames never leave the phone). */
export interface ScanSession {
  inputs: ScanInputs | null;
  /** Preview element shared by Place phone and Capture (mirrored with CSS only). */
  video: HTMLVideoElement;
  stream: MediaStream | null;
  camera: { width: number; height: number; frameRate: number } | null;
  profile: DeviceProfile | null;
  /** Saved device record (users/{uid}/devices/{deviceId}), prefetched on Setup. */
  savedDevice: Partial<DeviceProfile> | null;
  factors: CorrectionFactors | null;
  captures: Partial<Record<ViewName, CapturedFrame[]>>;
  /** performance.now() at the Start tap; the debug zip uses samplesSince(scanStartMs). */
  scanStartMs: number;
  retakes: { step: ViewName; reason: RetakeReason }[];
  /** Retake count per view during this scan (guards against endless retakes). */
  retakeCount: Partial<Record<ViewName, number>>;
  /** Views the pipeline still flagged after the retake limit. */
  unresolved: ViewName[];
  debugCapture: boolean;
  /** "Save troubleshooting data" recorder for this scan (null when the toggle is off). */
  diag: DiagRecorder | null;
  /** Scan id once saved (the retake-from-Results flow updates it). */
  scanId: string | null;
  /** initVision({ live: true }) started at the Start tap. */
  visionLive: Promise<void> | null;
}

export interface AppContext {
  readonly state: State;
  dispatch(event: Event): void;
  user: { uid: string; email: string } | null;
  /** Last sign-in error (e.g. "This app is private."), shown on the Sign in screen. */
  authError: string | null;
  userDoc: UserDoc | null;
  units: Units;
  /** Change display units and save them to UserDoc.units. */
  setUnits(units: Units): void;
  session: ScanSession;
  /** Throw away the current scan session (closes frames, keeps the video element). */
  resetSession(): void;
  /** Scans fetched or saved this run, by id. */
  scanCache: Map<string, ScanDoc>;
}

export function createVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "preview";
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  return video;
}

export function newSession(video: HTMLVideoElement): ScanSession {
  return {
    inputs: null,
    video,
    stream: null,
    camera: null,
    profile: null,
    savedDevice: null,
    factors: null,
    captures: {},
    scanStartMs: 0,
    retakes: [],
    retakeCount: {},
    unresolved: [],
    debugCapture: false,
    diag: null,
    scanId: null,
    visionLive: null,
  };
}

/** Release the ImageBitmaps of the given views (or all). */
export function closeFrames(session: ScanSession, views?: ViewName[]): void {
  for (const [view, frames] of Object.entries(session.captures) as [ViewName, CapturedFrame[]][]) {
    if (views && !views.includes(view)) continue;
    for (const f of frames) {
      const img = f.image as ImageBitmap;
      if (typeof img.close === "function") img.close();
    }
    delete session.captures[view];
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
