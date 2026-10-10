// Small body diagram showing where a measurement is taken, plus how to
// check it with a tape (S7: tapping a row).
import type { MeasurementKey } from "../../types";

const SVG_NS = "http://www.w3.org/2000/svg";

/** How to check each measurement with a tape measure. */
export const TAPE_TIPS: Record<MeasurementKey, string> = {
  height: "Stand against a wall without shoes, mark the top of your head with a book, measure floor to mark.",
  neck: "Wrap the tape around the base of the neck, where a shirt collar sits. Keep one finger under the tape.",
  chest: "Around the fullest part of the chest / bust, under the arms, tape level all the way round.",
  naturalWaist: "Around the narrowest part of the torso, usually just above the belly button. Breathe out normally.",
  shoulderWidth: "Across the back from one shoulder point (the bony tip) to the other.",
  sleeveLength: "From the shoulder point over a slightly bent elbow down to the wrist bone.",
  shirtSleeve: "From the centre back of the neck, over the shoulder and bent elbow, down to the wrist bone.",
  backLength: "From the bony bump at the base of the neck straight down the spine to the natural waist.",
  bicep: "Around the widest part of the upper arm, arm relaxed.",
  wrist: "Around the wrist just above the wrist bone.",
  pantWaist: "Around where your trousers' waistband sits (belt line).",
  hips: "Around the fullest part of the seat, feet together, tape level.",
  inseam: "From the crotch straight down the inside of the leg to the ankle bone.",
  outseam: "From the belt line straight down the outside of the leg to the ankle bone.",
  rise: "Outseam minus inseam: belt line down to the crotch level.",
  thigh: "Around the thigh about 5 cm (2\") below the crotch.",
  knee: "Around the middle of the knee, leg straight.",
  calf: "Around the widest part of the calf.",
  bust: "Around the fullest part of the bust, tape level across the back.",
  underbust: "Around the rib cage directly under the bust.",
  shoulderToWaist: "From the shoulder point straight down the front to the natural waist.",
  torsoLength: "From the shoulder, down the front, through the crotch and up the back to the same shoulder.",
  footLength: "Stand on paper, mark heel and longest toe, measure between the marks (experimental).",
};

type Mark =
  | { kind: "ring"; y: number; x1: number; x2: number }
  | { kind: "path"; d: string };

/** Marks on a 100 x 200 front-view figure. */
const MARKS: Record<MeasurementKey, Mark> = {
  height: { kind: "path", d: "M86 6 V194" },
  neck: { kind: "ring", y: 31, x1: 44, x2: 56 },
  chest: { kind: "ring", y: 52, x1: 33, x2: 67 },
  bust: { kind: "ring", y: 52, x1: 33, x2: 67 },
  underbust: { kind: "ring", y: 60, x1: 35, x2: 65 },
  naturalWaist: { kind: "ring", y: 74, x1: 37, x2: 63 },
  pantWaist: { kind: "ring", y: 84, x1: 36, x2: 64 },
  hips: { kind: "ring", y: 96, x1: 33, x2: 67 },
  thigh: { kind: "ring", y: 114, x1: 36, x2: 50 },
  knee: { kind: "ring", y: 142, x1: 38, x2: 49 },
  calf: { kind: "ring", y: 158, x1: 39, x2: 48 },
  bicep: { kind: "ring", y: 55, x1: 22, x2: 31 },
  wrist: { kind: "ring", y: 101, x1: 13, x2: 20 },
  shoulderWidth: { kind: "path", d: "M31 38 H69" },
  sleeveLength: { kind: "path", d: "M31 38 L24 70 L17 100" },
  shirtSleeve: { kind: "path", d: "M50 33 L31 38 L24 70 L17 100" },
  backLength: { kind: "path", d: "M50 33 V74" },
  shoulderToWaist: { kind: "path", d: "M60 38 V74" },
  torsoLength: { kind: "path", d: "M58 38 V106 L50 108" },
  inseam: { kind: "path", d: "M50 106 L45 186" },
  outseam: { kind: "path", d: "M64 84 L60 186" },
  rise: { kind: "path", d: "M66 84 V106" },
  footLength: { kind: "path", d: "M30 196 H44" },
};

const FIGURE =
  "M50 8 a10 10 0 1 0 0.01 0 Z " + // head
  "M45 28 V34 L31 38 L24 70 L17 100 M55 28 V34 L69 38 L76 70 L83 100 " + // neck + arms
  "M33 40 L37 74 L33 96 L37 186 L30 194 M67 40 L63 74 L67 96 L63 186 L70 194 " + // torso + outer legs
  "M50 106 L45 186 M50 106 L55 186"; // inner legs

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function createBodyDiagram(key: MeasurementKey): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "body-diagram";
  const s = svg("svg", { viewBox: "0 0 100 200", width: 100, height: 200, role: "img", "aria-label": "Where to measure" });
  s.appendChild(svg("path", { d: FIGURE, class: "figure", fill: "none" }));
  const m = MARKS[key];
  if (m.kind === "ring") {
    s.appendChild(svg("ellipse", { cx: (m.x1 + m.x2) / 2, cy: m.y, rx: (m.x2 - m.x1) / 2, ry: 2.5, class: "mark", fill: "none" }));
  } else {
    s.appendChild(svg("path", { d: m.d, class: "mark", fill: "none" }));
  }
  const tip = document.createElement("p");
  tip.className = "tape-tip";
  tip.textContent = TAPE_TIPS[key];
  wrap.append(s, tip);
  return wrap;
}
