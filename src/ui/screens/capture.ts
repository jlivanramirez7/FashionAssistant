// S5 Capture (no taps needed): live lite pose every frame -> checkPose ->
// huge hint + spoken sentence + status border. Pose "ok" and still ~1 s
// -> chime -> ~10 full-res frames kept in memory -> next step.
import { grabFrame } from "../../capture/camera";
import { currentOrientation, orientationSince } from "../../capture/sensors";
import { chime, say } from "../../capture/voice";
import { stepNumber } from "../../flow/stateMachine";
import { VIEWS, type CapturedFrame, type Landmark, type Orientation, type PoseHint, type ViewName } from "../../types";
import { checkPose, detectPoseLive, initVision } from "../../vision";
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
/** Only used when a dev build skipped the level step without sensors. */
const FALLBACK_ORIENTATION: Orientation = { tiltDeg: 75, rollDeg: 0 };

const BORDER_COLORS = { red: "#ff4d4d", amber: "#ffb020", green: "#2fd36b" } as const;

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const state = ctx.state;
  if (state.name !== "capture") return () => undefined;
  const view: ViewName = state.view;
  const s = ctx.session;

  const border = createStatusBorder("red");
  const guide = createPoseGuide(s.video);
  guide.setView(view);
  const hintEl = h("p", { class: "capture-hint", "aria-live": "polite" }, "LOADING...");
  const dots = h("div", { class: "step-dots" },
    VIEWS.map((v) => h("span", { class: `step-dot${v === view ? " current" : ""}${s.captures[v] && v !== view ? " done" : ""}` })),
  );
  const stepLabel = h("p", { class: "step-label" }, `${state.retake ? "Retake - " : ""}Step ${stepNumber(view)} of 3`);
  const errorEl = h("p", { class: "overlay-note error" });
  errorEl.hidden = true;

  const overlay = h("div", { class: "camera-overlay" },
    hintEl,
    h("div", { class: "overlay-spacer" }),
    errorEl,
    h("div", { class: "capture-footer" },
      h("div", null, dots, stepLabel),
      button("Cancel", () => ctx.dispatch({ type: "CANCEL" }), "btn small ghost"),
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
  let okSince: number | null = null;
  let hint: PoseHint | null = null;
  let hintSince = 0;
  let lastSpoken: { hint: PoseHint | null; at: number } = { hint: null, at: 0 };
  let latestLandmarks: Landmark[] | null = null;
  const history: { t: number; lm: Landmark[] }[] = [];

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
      errorEl.textContent = `Could not load the pose model: ${errorMessage(e)}`;
      errorEl.hidden = false;
    });

  function speakHint(h: PoseHint, now: number): void {
    if (h === "ok") return;
    if (now - introAt < 4000) return; // let the step instruction finish
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
    const next = checkPose(
      view,
      lm,
      history.map((x) => x.lm),
      Number.isFinite(aspect) && aspect > 0 ? { aspect } : undefined,
    );
    if (next !== hint) {
      hint = next;
      hintSince = now;
    }

    if (phase === "waiting") {
      if (hint === "ok") {
        okSince ??= now;
        if (now - okSince >= HOLD_STILL_MS) void grab(okSince);
      } else {
        okSince = null;
      }
      hintEl.textContent = hint === "ok" ? "HOLD STILL" : hintText(hint).title;
      speakHint(hint, now);
    }
    const status = borderFor(hint, phase === "grabbing");
    border.set(status);
    guide.draw(lm, BORDER_COLORS[status]);
  }

  async function grab(holdStartMs: number): Promise<void> {
    if (phase !== "waiting") return;
    phase = "grabbing";
    chime();
    hintEl.textContent = "HOLD STILL";
    const frames: CapturedFrame[] = [];
    const discard = (): void => {
      for (const f of frames) (f.image as ImageBitmap).close?.();
    };
    try {
      while (frames.length < FRAMES_PER_STEP) {
        if (!alive) {
          discard();
          return;
        }
        if (hint !== "ok" && hint !== "hold-still") {
          // Pose broke while capturing: start the hold again.
          discard();
          phase = "waiting";
          okSince = null;
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
      phase = "waiting";
      okSince = null;
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
    hintEl.textContent = "GOT IT";
    ctx.dispatch({ type: "STEP_CAPTURED", view });
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
  };
}
