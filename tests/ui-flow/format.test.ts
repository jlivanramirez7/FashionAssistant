import { describe, expect, it } from "vitest";
import { MEASUREMENT_KEYS, type Measurements, type PoseHint } from "../../src/types";
import { inToCm } from "../../src/units";
import {
  borderFor,
  buildTapeMeasurements,
  chestLabel,
  confidenceColor,
  copyAllText,
  formatDate,
  groupMeasurements,
  hintText,
  homeSummary,
  KEY_VIEWS,
  lowConfidenceKeys,
  measurementLabel,
  placementHint,
  retakeViewsFor,
  STEP_TEXT,
  TAPE_KEYS,
} from "../../src/ui/format";
import { coverMap, toCanvas } from "../../src/ui/parts/poseGuide";

const mv = (valueCm: number, confidence = 0.9, uncertaintyCm = 1) => ({ valueCm, confidence, uncertaintyCm });

describe("confidenceColor", () => {
  it(">= 0.75 green, >= 0.5 amber, else red", () => {
    expect(confidenceColor(1)).toBe("green");
    expect(confidenceColor(0.75)).toBe("green");
    expect(confidenceColor(0.7499)).toBe("amber");
    expect(confidenceColor(0.5)).toBe("amber");
    expect(confidenceColor(0.4999)).toBe("red");
    expect(confidenceColor(0)).toBe("red");
    expect(confidenceColor(NaN)).toBe("red");
  });
});

describe("chest label", () => {
  it("Bust / Chest / Chest / bust by body type", () => {
    expect(chestLabel("female")).toBe("Bust");
    expect(chestLabel("male")).toBe("Chest");
    expect(chestLabel("unspecified")).toBe("Chest / bust");
  });
  it("measurementLabel only relabels chest", () => {
    expect(measurementLabel("chest", "female")).toBe("Bust");
    expect(measurementLabel("naturalWaist", "female")).toBe("Waist");
    expect(measurementLabel("bust", "male")).toBe("Bust");
  });
});

describe("grouping", () => {
  it("orders Tops, Bottoms, Dresses, Shoes, General and drops empty groups", () => {
    const m: Measurements = { height: mv(178), inseam: mv(80), chest: mv(98), neck: mv(38), footLength: mv(27) };
    const g = groupMeasurements(m);
    expect(g.map((x) => x.title)).toEqual(["Tops", "Bottoms", "Shoes", "General"]);
    expect(g[0].keys).toEqual(["neck", "chest"]);
  });
});

describe("retake planning", () => {
  it("every key maps to at least one view", () => {
    for (const k of MEASUREMENT_KEYS) expect(KEY_VIEWS[k].length).toBeGreaterThan(0);
  });
  it("only non-green, non-experimental keys trigger a retake", () => {
    const m: Measurements = {
      height: mv(178, 0.1),
      chest: mv(98, 0.9),
      wrist: mv(16, 0.4), // alwaysLowConfidence: ignored
      footLength: mv(27, 0.3), // alwaysLowConfidence: ignored
      shoulderWidth: mv(45, 0.6),
    };
    expect(lowConfidenceKeys(m)).toEqual(["shoulderWidth"]);
    expect(retakeViewsFor(m)).toEqual(["front", "back"]);
  });
  it("no retake when all green", () => {
    expect(retakeViewsFor({ chest: mv(98, 0.8), inseam: mv(80, 0.95) })).toEqual([]);
  });
  it("orders views front > side > back", () => {
    expect(retakeViewsFor({ backLength: mv(45, 0.2), inseam: mv(80, 0.2) })).toEqual(["front", "side", "back"]);
  });
});

describe("capture text", () => {
  const hints: PoseHint[] = [
    "ok", "no-person", "step-back", "move-closer", "center", "arms-out", "arms-down",
    "face-phone", "turn-side", "turn-back", "hold-still",
  ];
  it("never says turn left/right, and screen text stays short", () => {
    const texts = [...hints.map((h) => hintText(h)), ...Object.values(STEP_TEXT)];
    for (const t of texts) {
      expect(t.title.split(/\s+/).length).toBeLessThanOrEqual(6);
      expect(`${t.title} ${t.sentence}`.toLowerCase()).not.toMatch(/\b(left|right)\b(?! shoulder)/);
      expect(t.sentence.length).toBeGreaterThan(0);
    }
  });
  it("step texts match the design doc", () => {
    expect(STEP_TEXT.front.title).toBe("FRONT, ARMS OUT");
    expect(STEP_TEXT.side.title).toBe("RIGHT SHOULDER TO PHONE");
    expect(STEP_TEXT.side.sentence).toContain("right shoulder faces the phone");
    expect(STEP_TEXT.back.title).toBe("BACK TO PHONE, ARMS OUT");
  });
  it("border: red not ready, amber hold still, green capturing", () => {
    expect(borderFor(null, false)).toBe("red");
    expect(borderFor("step-back", false)).toBe("red");
    expect(borderFor("hold-still", false)).toBe("amber");
    expect(borderFor("ok", false)).toBe("amber");
    expect(borderFor("ok", true)).toBe("green");
  });
});

describe("placement hint", () => {
  it("guides tilt and roll", () => {
    expect(placementHint(null).text).toMatch(/Waiting/);
    expect(placementHint({ tiltDeg: 89, rollDeg: 0 })).toMatchObject({ tiltOk: false, text: "Tilt it back a bit" });
    expect(placementHint({ tiltDeg: 50, rollDeg: 0 }).text).toBe("Stand it up a bit more");
    expect(placementHint({ tiltDeg: 75, rollDeg: 5 })).toMatchObject({ tiltOk: true, rollOk: false });
    expect(placementHint({ tiltDeg: 75, rollDeg: -2 })).toMatchObject({ tiltOk: true, rollOk: true });
  });
});

describe("dates and copy", () => {
  it("formats dates like the mockups", () => {
    expect(formatDate(new Date(2026, 9, 10, 12).getTime())).toBe("Oct 10, 2026");
    expect(formatDate(new Date(2026, 9, 2, 12).getTime())).toBe("Oct 02, 2026");
  });
  it("copy all lists grouped values with the body-type chest label", () => {
    const text = copyAllText(
      { createdAt: new Date(2026, 9, 10).getTime(), bodyType: "female", measurements: { chest: mv(inToCm(38.5), 0.9, 2.54), inseam: mv(inToCm(30.5)) } },
      "in",
    );
    expect(text).toContain("Tops");
    expect(text).toContain('Bust: 38.5" (±1.0")');
    expect(text).toContain("Bottoms");
    expect(text).toContain('Inseam: 30.5"');
    expect(text).not.toMatch(/size/i);
  });
  it("home summary", () => {
    expect(homeSummary({ bodyType: "male", measurements: { chest: mv(inToCm(38.5)), inseam: mv(inToCm(30.5)) } }, "in")).toEqual([
      'Chest 38.5"',
      'Inseam 30.5"',
    ]);
  });
});

describe("tape measurements", () => {
  it("has a field for every key except height", () => {
    expect(TAPE_KEYS).not.toContain("height");
    expect(TAPE_KEYS.length).toBe(MEASUREMENT_KEYS.length - 1);
  });
  it("converts typed values to cm and drops blanks", () => {
    expect(buildTapeMeasurements({ chest: "38.5", inseam: "", neck: "abc" }, "in")).toEqual({ chest: 97.79 });
    expect(buildTapeMeasurements({ chest: "98.4" }, "cm")).toEqual({ chest: 98.4 });
  });
});

describe("pose guide mapping", () => {
  it("object-fit cover + mirror", () => {
    const m = coverMap(1080, 1920, 540, 960);
    expect(m.scale).toBeCloseTo(0.5);
    expect(toCanvas(m, 0, 0)).toEqual([540, 0]);
    expect(toCanvas(m, 1, 1)).toEqual([0, 960]);
    const wide = coverMap(1080, 1920, 1000, 1000); // crops top/bottom
    expect(wide.offsetY).toBeLessThan(0);
    expect(toCanvas(wide, 0.5, 0.5)).toEqual([500, 500]);
  });
});
