import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  normalizeViews,
  stepNumber,
  transition,
  type Event,
  type State,
} from "../../src/flow/stateMachine";

function run(state: State, ...events: Event[]): State {
  return events.reduce(transition, state);
}

const HOME: State = { name: "home" };

describe("auth", () => {
  it("boot -> home on sign in, boot -> signin on sign out", () => {
    expect(transition(INITIAL_STATE, { type: "AUTH_SIGNED_IN" })).toEqual(HOME);
    expect(transition(INITIAL_STATE, { type: "AUTH_SIGNED_OUT" })).toEqual({ name: "signin" });
  });
  it("carries the private-app error to the sign-in screen", () => {
    expect(transition(INITIAL_STATE, { type: "AUTH_SIGNED_OUT", error: "This app is private." })).toEqual({
      name: "signin",
      error: "This app is private.",
    });
  });
  it("signin -> home", () => {
    expect(transition({ name: "signin" }, { type: "AUTH_SIGNED_IN" })).toEqual(HOME);
  });
  it("sign out from any screen goes to signin", () => {
    const states: State[] = [
      HOME,
      { name: "setup" },
      { name: "capture", view: "side", remaining: ["back"], retake: false, target: null },
      { name: "results", scanId: "a", from: "scan" },
      { name: "history" },
    ];
    for (const s of states) expect(transition(s, { type: "AUTH_SIGNED_OUT" })).toEqual({ name: "signin" });
  });
  it("a repeated sign-in (token refresh) does not leave the current screen", () => {
    const s: State = { name: "setup" };
    expect(transition(s, { type: "AUTH_SIGNED_IN" })).toBe(s);
  });
});

describe("scan flow", () => {
  it("home > setup > place > front > side > back > processing > results", () => {
    let s = run(HOME, { type: "NEW_SCAN" });
    expect(s).toEqual({ name: "setup" });
    s = transition(s, { type: "START" });
    expect(s).toEqual({ name: "place", queue: ["front", "side", "back"], target: null });
    s = transition(s, { type: "PLACED" });
    expect(s).toEqual({ name: "capture", view: "front", remaining: ["side", "back"], retake: false, target: null });
    s = transition(s, { type: "STEP_CAPTURED", view: "front" });
    expect(s).toEqual({ name: "capture", view: "side", remaining: ["back"], retake: false, target: null });
    s = transition(s, { type: "STEP_CAPTURED", view: "side" });
    expect(s).toEqual({ name: "capture", view: "back", remaining: [], retake: false, target: null });
    s = transition(s, { type: "STEP_CAPTURED", view: "back" });
    expect(s).toEqual({ name: "processing", target: null });
    s = transition(s, { type: "RESULTS_READY", scanId: "scan1" });
    expect(s).toEqual({ name: "results", scanId: "scan1", from: "scan" });
    expect(transition(s, { type: "DONE" })).toEqual(HOME);
  });

  it("ignores a STEP_CAPTURED for a different view", () => {
    const s: State = { name: "capture", view: "side", remaining: ["back"], retake: false, target: null };
    expect(transition(s, { type: "STEP_CAPTURED", view: "front" })).toBe(s);
  });

  it("setup back/cancel go home", () => {
    expect(transition({ name: "setup" }, { type: "BACK" })).toEqual(HOME);
    expect(transition({ name: "setup" }, { type: "CANCEL" })).toEqual(HOME);
  });

  it("cancel from place, capture and processing goes home", () => {
    expect(transition({ name: "place", queue: ["front"], target: null }, { type: "CANCEL" })).toEqual(HOME);
    expect(
      transition({ name: "capture", view: "front", remaining: [], retake: false, target: null }, { type: "CANCEL" }),
    ).toEqual(HOME);
    expect(transition({ name: "processing", target: null }, { type: "CANCEL" })).toEqual(HOME);
  });

  it("place with an empty queue goes straight to processing", () => {
    expect(transition({ name: "place", queue: [], target: "x" }, { type: "PLACED" })).toEqual({
      name: "processing",
      target: "x",
    });
  });
});

describe("retakes", () => {
  it("processing retakes only the failing step, then processes again", () => {
    let s: State = { name: "processing", target: null };
    s = transition(s, { type: "PROCESSING_RETAKE", views: ["side"] });
    expect(s).toEqual({ name: "capture", view: "side", remaining: [], retake: true, target: null });
    s = transition(s, { type: "STEP_CAPTURED", view: "side" });
    expect(s).toEqual({ name: "processing", target: null });
  });

  it("several failing steps are retaken in front > side > back order", () => {
    const s = transition({ name: "processing", target: null }, { type: "PROCESSING_RETAKE", views: ["back", "front", "back"] });
    expect(s).toEqual({ name: "capture", view: "front", remaining: ["back"], retake: true, target: null });
  });

  it("an empty retake list is ignored", () => {
    const s: State = { name: "processing", target: null };
    expect(transition(s, { type: "PROCESSING_RETAKE", views: [] })).toBe(s);
  });

  it("results 'Retake amber/red' goes through place with the needed steps and updates that scan", () => {
    let s: State = { name: "results", scanId: "abc", from: "scan" };
    s = transition(s, { type: "RETAKE_LOW_CONFIDENCE", views: ["side", "front"] });
    expect(s).toEqual({ name: "place", queue: ["front", "side"], target: "abc" });
    s = transition(s, { type: "PLACED" });
    expect(s).toEqual({ name: "capture", view: "front", remaining: ["side"], retake: true, target: "abc" });
    s = run(s, { type: "STEP_CAPTURED", view: "front" }, { type: "STEP_CAPTURED", view: "side" });
    expect(s).toEqual({ name: "processing", target: "abc" });
    s = transition(s, { type: "RESULTS_READY", scanId: "abc" });
    expect(s).toEqual({ name: "results", scanId: "abc", from: "scan" });
  });

  it("results retake with no views is ignored", () => {
    const s: State = { name: "results", scanId: "abc", from: "scan" };
    expect(transition(s, { type: "RETAKE_LOW_CONFIDENCE", views: [] })).toBe(s);
  });
});

describe("history, results, validation", () => {
  it("home > history > results > back to history > back home", () => {
    let s = transition(HOME, { type: "OPEN_HISTORY" });
    expect(s).toEqual({ name: "history" });
    s = transition(s, { type: "OPEN_SCAN", scanId: "s1" });
    expect(s).toEqual({ name: "results", scanId: "s1", from: "history" });
    s = transition(s, { type: "BACK" });
    expect(s).toEqual({ name: "history" });
    expect(transition(s, { type: "BACK" })).toEqual(HOME);
  });

  it("home 'View all' opens the last scan; Done returns home", () => {
    const s = transition(HOME, { type: "OPEN_SCAN", scanId: "s9" });
    expect(s).toEqual({ name: "results", scanId: "s9", from: "home" });
    expect(transition(s, { type: "DONE" })).toEqual(HOME);
  });

  it("results > validation > saved > results (keeps where results came from)", () => {
    let s: State = { name: "results", scanId: "s1", from: "history" };
    s = transition(s, { type: "ADD_TAPE" });
    expect(s).toEqual({ name: "validation", scanId: "s1", from: "history" });
    expect(transition(s, { type: "VALIDATION_SAVED" })).toEqual({ name: "results", scanId: "s1", from: "history" });
    expect(transition(s, { type: "BACK" })).toEqual({ name: "results", scanId: "s1", from: "history" });
  });

  it("history > validation summary > back to history", () => {
    let s = transition({ name: "history" }, { type: "OPEN_VALIDATION_SUMMARY" });
    expect(s).toEqual({ name: "validationSummary" });
    s = transition(s, { type: "BACK" });
    expect(s).toEqual({ name: "history" });
  });

  it("delete all my data returns home", () => {
    expect(transition({ name: "history" }, { type: "DATA_DELETED" })).toEqual(HOME);
  });

  it("irrelevant events leave the state untouched (same object)", () => {
    const cases: [State, Event][] = [
      [HOME, { type: "START" }],
      [{ name: "setup" }, { type: "PLACED" }],
      [{ name: "place", queue: ["front"], target: null }, { type: "START" }],
      [{ name: "results", scanId: "a", from: "scan" }, { type: "NEW_SCAN" }],
      [{ name: "validationSummary" }, { type: "DONE" }],
      [{ name: "signin" }, { type: "NEW_SCAN" }],
      [INITIAL_STATE, { type: "OPEN_HISTORY" }],
      [{ name: "validation", scanId: "a", from: "scan" }, { type: "CANCEL" }],
    ];
    for (const [s, e] of cases) expect(transition(s, e)).toBe(s);
  });
});

describe("helpers", () => {
  it("normalizeViews orders and dedupes", () => {
    expect(normalizeViews(["back", "side", "back"])).toEqual(["side", "back"]);
  });
  it("stepNumber is 1-based", () => {
    expect([stepNumber("front"), stepNumber("side"), stepNumber("back")]).toEqual([1, 2, 3]);
  });
});
