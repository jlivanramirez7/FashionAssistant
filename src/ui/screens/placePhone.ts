// S4 Place the phone: live mirrored preview + level gauge. In range for
// 2 s -> green border, spoken prompt, auto-advance.
import { currentOrientation, placementOk } from "../../capture/sensors";
import { say } from "../../capture/voice";
import type { AppContext } from "../context";
import { loadDebug } from "../debug";
import { button, h } from "../dom";
import { createLevelGauge } from "../parts/levelGauge";
import { createStatusBorder } from "../parts/statusBorder";

export const HOLD_MS = 2000;
const NO_SENSOR_MS = 4000;

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const s = ctx.session;
  const border = createStatusBorder("red");
  const gauge = createLevelGauge();
  const note = h("p", { class: "overlay-note" });
  note.hidden = true;
  const skip = button("Continue without level (dev)", () => advance(), "btn small");
  skip.hidden = true;

  const overlay = h("div", { class: "camera-overlay" },
    h("p", { class: "overlay-title" }, "Lean the phone against a wall, screen facing you"),
    h("div", { class: "overlay-spacer" }),
    gauge.el,
    note,
    h("div", { class: "overlay-actions" }, skip, button("Cancel", () => ctx.dispatch({ type: "CANCEL" }), "btn small ghost")),
  );
  const stage = h("div", { class: "camera-stage" }, s.video, overlay);
  border.el.appendChild(stage);
  const el = h("section", { class: "screen screen-camera screen-place" }, border.el);
  root.appendChild(el);
  void s.video.play().catch(() => undefined);

  const t0 = performance.now();
  let okSince: number | null = null;
  let done = false;
  let raf = 0;
  let devSkip = false;
  void loadDebug().then((m) => {
    devSkip = m !== null;
  });

  function advance(): void {
    if (done) return;
    done = true;
    border.set("green");
    void say("Great. Now walk back until I can see all of you.");
    ctx.dispatch({ type: "PLACED" });
  }

  function tick(now: number): void {
    if (done) return;
    const o = currentOrientation();
    const ok = !!o && placementOk(o);
    if (ok) {
      okSince ??= now;
    } else {
      okSince = null;
    }
    const held = okSince !== null && now - okSince >= HOLD_MS;
    gauge.update(o, ok);
    border.set(held ? "green" : ok ? "amber" : "red");
    if (!o && now - t0 > NO_SENSOR_MS) {
      note.textContent = "No motion sensor data. Allow motion access (Settings > Safari > Motion & Orientation) and reload.";
      note.hidden = false;
      skip.hidden = !devSkip;
    } else {
      note.hidden = true;
      skip.hidden = true;
    }
    if (held) {
      advance();
      return;
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  return () => {
    done = true;
    cancelAnimationFrame(raf);
  };
}
