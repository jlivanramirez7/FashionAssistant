// S5 Capture (no taps needed): live lite pose every frame -> checkPose ->
// huge hint + spoken sentence + status border. Pose "ok" and still ~1 s
// -> chime -> ~10 full-res frames kept in memory -> next step.
//
// Robustness: brief model glitches don't reset the hold (GLITCH_MS); if the
// user is stuck on "turn around" the orientation test is waived after a few
// seconds (the live model often can't tell a back from a front); and a
// "Timer" button captures after a countdown regardless of the live check.
import { grabFrame } from "../../capture/camera";
import { currentOrientation, orientationSince } from "../../capture/sensors";
import { chime, say } from "../../capture/voice";
import { VIEWS, type CapturedFrame, type Landmark, type Orientation, type PoseHint, type ViewName } from "../../types";
import { checkPose, detectPoseLive, faceVisibility, initVision } from "../../vision";
import {
  createHoldGate,
  createTrustGate,
  GLITCH_MS,
  resetHold,
  TIMER_SECONDS,
  updateHold,
  updateTrust,
} from "../captureLogic";
import { closeFrames, errorMessage, type AppContext } from "../context";
import { button, h } from "../dom";
import { borderFor, hintText, STEP_TEXT } from "../format";
import { createPoseGuide } from "../parts/poseGuide";
import { createStatusBorder } from "../parts/statusBorder";

export const HOLD_STILL_MS = 1000;
export const FRAMES_PER_STEP = 10;
const FRAME_INTERVAL_MS = 100;
/** Landmark history window for stillness (~1 s). */
const HISTORY_MS = 1000;
const HINT_STABLE_MS = 800;
const REPEAT_SPEECH_MS = 8000;
/** Time for the spoken step instruction before hints / the trust timer kick in. */
const INTRO_MS = 4000;
/** Only used when a dev build skipped the level step without sensors. */
const FALLBACK_ORIENTATION: Orientation = { tiltDeg: 75, rollDeg: 0 };

const BORDER_COLORS = { red: "#ff5a5f", amber: "#ffb84d", green: "#34d399" } as const;
const VIEW_LABELS: Record<ViewName, string> = { front: "Front", side: "Side", back: "Back" };

/** Mean face visibility over the front step's live landmarks (baseline for the back view). */
function frontFaceBaseline(frames: CapturedFrame[] | undefined): number | undefined {
  const vals = (frames ?? []).flatMap((f) => (f.liveLandmarks ? [faceVisibility(f.liveLandmarks)] : []));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
}

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const state = ctx.state;
  if (state.name !== "capture") return () => undefined;
  const view: ViewName = state.view;
  const s = ctx.session;

  const border = createStatusBorder("red");
  const guide = createPoseGuide(s.video);
  guide.setView(view);

  const hintEl = h("p", { class: "capture-hint", "aria-live": "polite" }, "Loading...");
  const subEl = h("p", { class: "capture-sub" });
  subEl.hidden = true;
  const holdFill = h("div", { class: "hold-fill" });
  const holdBar = h("div", { class: "hold-bar", "aria-hidden": "true" }, holdFill);
  const errorEl = h("p", { class: "overlay-note error" });
  errorEl.hidden = true;

  const steps = h("ol", { class: "step-chips", "aria-label": "Capture steps" },
    VIEWS.map((v, i) => {
      const done = !!s.captures[v] && v !== view;
      return h("li", { class: `step-chip${v === view ? " current" : ""}${done ? " done" : ""}` },
        h("span", { class: "step-num" }, done ? "✓" : String(i + 1)),
        h("span", { class: "step-name" }, VIEW_LABELS[v]),
      );
    }),
  );
  const cancelBtn = button("✕", () => ctx.dispatch({ type: "CANCEL" }), "icon-btn");
  cancelBtn.setAttribute("aria-label", "Cancel scan");
  const timerBtn = button(`Timer ${TIMER_SECONDS}s`, () => toggleTimer(), "btn pill");

  const overlay = h("div", { class: "camera-overlay" },
    h("div", { class: "capture-top" },
      h("div", { class: "capture-top-row" },
        steps,
        cancelBtn,
      ),
      state.retake ? h("p", { class: "retake-tag" }, "Retake") : null,
      hintEl,
      subEl,
    ),
    h("div", { class: "overlay-spacer" }),
    errorEl,
    h("div", { class: "capture-bottom" },
      holdBar,
      h("div", { class: "capture-actions" },
        h("p", { class: "capture-tip" }, "Stuck? Tap Timer, get in position, and it will capture anyway."),
        timerBtn,
      ),
    ),
  );
  const stage = h("div", { class: "camera-stage" }, s.video, guide.el, overlay);
  border.el.appendChild(stage);
  root.appendChild(h("section", { class: "screen screen-camera screen-capture" }, border.el));
  void s.video.play().catch(() => undefined);

  let alive = true;
  let raf = 0;
  let ready = false;
  let phase: "waiting" | "grabbing" | "done" = "waiting";
  let hint: PoseHint | null = null;
  let hintSince = 0;
  let lastSpoken: { hint: PoseHint | null; at: number } = { hint: null, at: 0 };
  let latestLandmarks: Landmark[] | null = null;
  /** Last time the pose was ok / only needed to hold still (grab abort check). */
  let lastGood = -Infinity;
  /** performance.now() when the timer fires, or null. */
  let timerEnd: number | null = null;
  let timerSpoken = Infinity;
  const hold = createHoldGate();
  const trust = createTrustGate();
  const history: { t: number; lm: Landmark[] }[] = [];
  const frontFace = view === "back" ? frontFaceBaseline(s.captures.front) : undefined;

  const step = STEP_TEXT[view];
  const intro = state.retake ? `Let's redo this step. ${step.sentence}` : step.sentence;
  const introAt = performance.now();
  void say(intro);

  const visionReady = s.visionLive ?? (s.visionLive = initVision({ live: true }));
  visionReady
    .then(() => {
      if (!alive) return;
      ready = true;
      hintEl.textContent = step.title;
      raf = requestAnimationFrame(tick);
    })
    .catch((e: unknown) => {
      if (!alive) return;
      errorEl.textContent = `Could not load the pose model: ${errorMessage(e)}. Use Timer to capture without it.`;
      errorEl.hidden = false;
      // Keep the timer usable without the model.
      ready = true;
      raf = requestAnimationFrame(tick);
    });

  function showSub(text: string | null): void {
    subEl.hidden = !text;
    subEl.textContent = text ?? "";
  }

  function toggleTimer(): void {
    if (phase !== "waiting") return;
    if (timerEnd !== null) {
      timerEnd = null;
      timerBtn.textContent = `Timer ${TIMER_SECONDS}s`;
      timerBtn.classList.remove("active");
      showSub(null);
      void say("Timer cancelled.");
      return;
    }
    timerEnd = performance.now() + TIMER_SECONDS * 1000;
    timerSpoken = Infinity;
    timerBtn.textContent = "Cancel timer";
    timerBtn.classList.add("active");
    void say(`Capturing in ${TIMER_SECONDS} seconds. ${step.sentence}`);
  }

  function speakHint(h: PoseHint, now: number): void {
    if (h === "ok") return;
    if (now - introAt < INTRO_MS) return; // let the step instruction finish
    if (now - hintSince < HINT_STABLE_MS) return;
    const same = lastSpoken.hint === h;
    if (same && now - lastSpoken.at < REPEAT_SPEECH_MS) return;
    if (!same && now - lastSpoken.at < 2500) return;
    lastSpoken = { hint: h, at: now };
    void say(hintText(h).sentence);
  }

  function tick(now: number): void {
    if (!alive || !ready || phase === "done") return;
    raf = requestAnimationFrame(tick);
    if (s.video.readyState < 2) return;

    let lm: Landmark[] | null = null;
    try {
      lm = detectPoseLive(s.video, now);
    } catch {
      lm = null;
    }
    latestLandmarks = lm;
    if (lm) history.push({ t: now, lm });
    while (history.length > 0 && now - history[0].t > HISTORY_MS) history.shift();
    const aspect = s.video.videoWidth / s.video.videoHeight;
    const next = checkPose(view, lm, history.map((x) => x.lm), {
      aspect: Number.isFinite(aspect) && aspect > 0 ? aspect : undefined,
      frontFaceVisibility: frontFace,
      trustOrientation: trust.trusted,
    });
    if (next !== hint) {
      hint = next;
      hintSince = now;
    }
    if (hint === "ok" || hint === "hold-still") lastGood = now;

    if (updateTrust(trust, view, hint, now, now - introAt >= INTRO_MS)) {
      // The live model can't confirm the turn; trust the user from here on.
      lastSpoken = { hint: null, at: now };
      void say("Okay, I'll take your word for it. Hold the pose.");
    }

    if (phase === "waiting") {
      if (timerEnd !== null) {
        const left = Math.ceil((timerEnd - now) / 1000);
        if (left <= 0) {
          void grab(now, true);
          return;
        }
        if (left <= 3 && left < timerSpoken) {
          timerSpoken = left;
          void say(String(left));
        }
        showSub(`Capturing in ${left}`);
      } else {
        showSub(trust.trusted && hint !== "ok" && hint !== "hold-still" ? "Turn check skipped" : null);
      }

      const held = updateHold(hold, hint === "ok", now);
      if (held !== null && hint === "ok" && held >= HOLD_STILL_MS) {
        void grab(hold.okSince ?? now, false);
        return;
      }
      holdFill.style.width = `${held === null ? 0 : Math.min(100, (held / HOLD_STILL_MS) * 100)}%`;
      hintEl.textContent = hint === "ok" ? "Hold still" : hintText(hint).title;
      if (timerEnd === null) speakHint(hint, now);
    }
    const status = borderFor(hint, phase === "grabbing");
    border.set(status);
    guide.draw(lm, BORDER_COLORS[status]);
  }

  async function grab(holdStartMs: number, manual: boolean): Promise<void> {
    if (phase !== "waiting") return;
    phase = "grabbing";
    timerEnd = null;
    timerBtn.disabled = true;
    holdFill.style.width = "100%";
    chime();
    hintEl.textContent = "Hold still";
    showSub("Capturing...");
    const frames: CapturedFrame[] = [];
    const discard = (): void => {
      for (const f of frames) (f.image as ImageBitmap).close?.();
    };
    const backToWaiting = (): void => {
      phase = "waiting";
      resetHold(hold);
      timerBtn.disabled = false;
      timerBtn.textContent = `Timer ${TIMER_SECONDS}s`;
      timerBtn.classList.remove("active");
      showSub(null);
    };
    try {
      while (frames.length < FRAMES_PER_STEP) {
        if (!alive) {
          discard();
          return;
        }
        if (!manual && performance.now() - lastGood > GLITCH_MS) {
          // Pose broke while capturing: start the hold again.
          discard();
          backToWaiting();
          return;
        }
        const t = performance.now();
        const image = await grabFrame(s.video);
        frames.push({
          view,
          timestampMs: t,
          image,
          width: image.width,
          height: image.height,
          orientation: orientationSince(holdStartMs) ?? currentOrientation() ?? FALLBACK_ORIENTATION,
          liveLandmarks: latestLandmarks ?? undefined,
        });
        const wait = FRAME_INTERVAL_MS - (performance.now() - t);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } catch (e) {
      discard();
      backToWaiting();
      errorEl.textContent = `Could not grab a frame: ${errorMessage(e)}`;
      errorEl.hidden = false;
      return;
    }
    if (!alive) {
      discard();
      return;
    }
    phase = "done";
    closeFrames(s, [view]);
    s.captures[view] = frames;
    border.set("green");
    hintEl.textContent = "Got it";
    showSub(null);
    ctx.dispatch({ type: "STEP_CAPTURED", view });
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
  };
}
