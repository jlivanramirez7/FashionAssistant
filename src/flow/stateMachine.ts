// Pure app-flow reducer (design doc sections 5 and 6).
//
//   signin > home > setup > place > capture(front, side, back) > processing
//   processing > (retake failing step(s)) > processing > results
//   results > place > capture(low-confidence steps) > processing > results
//   home/history > results > validation; history > validationSummary
//   home > diagnostics (troubleshooting reports)
//
// Unknown events leave the state unchanged (the SAME object is returned,
// so the shell can skip re-rendering).
import { VIEWS, type ViewName } from "../types";

/** Where Results was opened from (decides where Back/Done go). */
export type ResultsFrom = "scan" | "home" | "history";

export type State =
  | { name: "boot" }
  | { name: "signin"; error?: string }
  | { name: "home" }
  | { name: "setup" }
  /** queue = steps to capture; target = existing scan id to update (retake from Results). */
  | { name: "place"; queue: ViewName[]; target: string | null }
  | { name: "capture"; view: ViewName; remaining: ViewName[]; retake: boolean; target: string | null }
  | { name: "processing"; target: string | null }
  | { name: "results"; scanId: string; from: ResultsFrom }
  | { name: "history" }
  | { name: "validation"; scanId: string; from: ResultsFrom }
  | { name: "validationSummary" }
  | { name: "diagnostics" };

export type StateName = State["name"];

export type Event =
  | { type: "AUTH_SIGNED_IN" }
  | { type: "AUTH_SIGNED_OUT"; error?: string }
  | { type: "NEW_SCAN" }
  | { type: "START" }
  | { type: "PLACED" }
  | { type: "STEP_CAPTURED"; view: ViewName }
  | { type: "PROCESSING_RETAKE"; views: ViewName[] }
  | { type: "RESULTS_READY"; scanId: string }
  | { type: "RETAKE_LOW_CONFIDENCE"; views: ViewName[] }
  | { type: "CANCEL" }
  | { type: "OPEN_HISTORY" }
  | { type: "OPEN_SCAN"; scanId: string }
  | { type: "ADD_TAPE" }
  | { type: "VALIDATION_SAVED" }
  | { type: "OPEN_VALIDATION_SUMMARY" }
  | { type: "OPEN_DIAGNOSTICS" }
  | { type: "BACK" }
  | { type: "DONE" }
  | { type: "DATA_DELETED" };

export const INITIAL_STATE: State = { name: "boot" };

/** States in which the camera / sensors / wake lock are in use. */
export const CAPTURE_STATES: readonly StateName[] = ["place", "capture", "processing"];

/** Keep known views, drop duplicates, order front > side > back. */
export function normalizeViews(views: readonly ViewName[]): ViewName[] {
  return VIEWS.filter((v) => views.includes(v));
}

/** Step number shown as "Step N of 3" (1-based, by view). */
export function stepNumber(view: ViewName): number {
  return VIEWS.indexOf(view) + 1;
}

function startCapture(queue: ViewName[], retake: boolean, target: string | null): State {
  const [view, ...remaining] = queue;
  return { name: "capture", view, remaining, retake, target };
}

export function transition(state: State, event: Event): State {
  // Global events.
  if (event.type === "AUTH_SIGNED_OUT") {
    return event.error ? { name: "signin", error: event.error } : { name: "signin" };
  }
  if (event.type === "AUTH_SIGNED_IN") {
    return state.name === "boot" || state.name === "signin" ? { name: "home" } : state;
  }

  switch (state.name) {
    case "boot":
    case "signin":
      return state;

    case "home":
      switch (event.type) {
        case "NEW_SCAN":
          return { name: "setup" };
        case "OPEN_HISTORY":
          return { name: "history" };
        case "OPEN_SCAN":
          return { name: "results", scanId: event.scanId, from: "home" };
        case "OPEN_DIAGNOSTICS":
          return { name: "diagnostics" };
        default:
          return state;
      }

    case "setup":
      switch (event.type) {
        case "START":
          return { name: "place", queue: [...VIEWS], target: null };
        case "CANCEL":
        case "BACK":
          return { name: "home" };
        default:
          return state;
      }

    case "place":
      switch (event.type) {
        case "PLACED":
          if (state.queue.length === 0) return { name: "processing", target: state.target };
          return startCapture(state.queue, state.target !== null, state.target);
        case "CANCEL":
          return { name: "home" };
        default:
          return state;
      }

    case "capture":
      switch (event.type) {
        case "STEP_CAPTURED":
          if (event.view !== state.view) return state;
          if (state.remaining.length > 0) return startCapture(state.remaining, state.retake, state.target);
          return { name: "processing", target: state.target };
        case "CANCEL":
          return { name: "home" };
        default:
          return state;
      }

    case "processing":
      switch (event.type) {
        case "PROCESSING_RETAKE": {
          const views = normalizeViews(event.views);
          if (views.length === 0) return state;
          return startCapture(views, true, state.target);
        }
        case "RESULTS_READY":
          return { name: "results", scanId: event.scanId, from: "scan" };
        case "CANCEL":
          return { name: "home" };
        default:
          return state;
      }

    case "results":
      switch (event.type) {
        case "RETAKE_LOW_CONFIDENCE": {
          const views = normalizeViews(event.views);
          if (views.length === 0) return state;
          return { name: "place", queue: views, target: state.scanId };
        }
        case "ADD_TAPE":
          return { name: "validation", scanId: state.scanId, from: state.from };
        case "BACK":
        case "DONE":
          return state.from === "history" ? { name: "history" } : { name: "home" };
        default:
          return state;
      }

    case "history":
      switch (event.type) {
        case "OPEN_SCAN":
          return { name: "results", scanId: event.scanId, from: "history" };
        case "OPEN_VALIDATION_SUMMARY":
          return { name: "validationSummary" };
        case "BACK":
        case "DATA_DELETED":
          return { name: "home" };
        default:
          return state;
      }

    case "validation":
      switch (event.type) {
        case "VALIDATION_SAVED":
        case "BACK":
          return { name: "results", scanId: state.scanId, from: state.from };
        default:
          return state;
      }

    case "validationSummary":
      return event.type === "BACK" ? { name: "history" } : state;

    case "diagnostics":
      return event.type === "BACK" ? { name: "home" } : state;
  }
}
