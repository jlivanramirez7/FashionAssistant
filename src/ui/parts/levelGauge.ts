// Live level gauge for "Place the phone" (S4): the bubble sits in the
// centre when tilt is 60-85 deg from flat and |roll| <= 3 deg.
import type { Orientation } from "../../types";
import { placementHint } from "../format";

const TILT_CENTER = 72.5;
const TILT_RANGE = 25; // deg from centre to the gauge edge
const ROLL_RANGE = 12;

export interface LevelGauge {
  el: HTMLElement;
  update(o: Orientation | null, inRange: boolean): void;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function createLevelGauge(): LevelGauge {
  const el = document.createElement("div");
  el.className = "level-gauge";
  const track = document.createElement("div");
  track.className = "level-track";
  const target = document.createElement("div");
  target.className = "level-target";
  const bubble = document.createElement("div");
  bubble.className = "level-bubble";
  track.append(target, bubble);
  const readout = document.createElement("div");
  readout.className = "level-readout";
  const hint = document.createElement("div");
  hint.className = "level-hint";
  el.append(hint, track, readout);

  function update(o: Orientation | null, inRange: boolean): void {
    const p = placementHint(o);
    hint.textContent = p.text;
    if (!o) {
      readout.textContent = "Tilt: --   Roll: --";
      bubble.style.left = "50%";
      bubble.style.top = "50%";
      el.classList.remove("ok");
      return;
    }
    // x: roll (bubble drifts to the low side); y: tilt away from the band centre.
    const x = clamp(o.rollDeg / ROLL_RANGE, -1, 1) * 50;
    const y = clamp((TILT_CENTER - o.tiltDeg) / TILT_RANGE, -1, 1) * 50;
    bubble.style.left = `${50 + x * 0.8}%`;
    bubble.style.top = `${50 + y * 0.8}%`;
    readout.textContent = `Tilt: ${p.tiltOk ? "OK" : `${Math.round(o.tiltDeg)}°`}   Roll: ${p.rollOk ? "OK" : `${Math.round(o.rollDeg)}°`}`;
    el.classList.toggle("ok", inRange);
  }
  update(null, false);
  return { el, update };
}
