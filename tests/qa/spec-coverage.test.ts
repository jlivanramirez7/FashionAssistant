// QA: every MeasurementKey is specified, labelled, grouped and carried end to
// end (types -> UI -> validation -> Firestore mapping). Design doc sections 6, 7, 11.
import { describe, expect, it } from "vitest";
import {
  MEASUREMENT_KEYS, MEASUREMENT_SPECS, type MeasurementKey, type Measurements, type ScanDoc,
} from "../../src/types";
import { fn, loadModule, near } from "./_helpers";

// Section 7 table: key -> [group, kind, target cm]
const DOC_TABLE: Record<MeasurementKey, [string, string, number | null]> = {
  height: ["general", "length", null],
  neck: ["tops", "circumference", 2],
  chest: ["tops", "circumference", 3],
  naturalWaist: ["tops", "circumference", 3],
  shoulderWidth: ["tops", "length", 1.5],
  sleeveLength: ["tops", "length", 1.5],
  shirtSleeve: ["tops", "length", 2],
  backLength: ["tops", "length", 2],
  bicep: ["tops", "circumference", 2],
  wrist: ["tops", "circumference", 1.5],
  pantWaist: ["bottoms", "circumference", 3],
  hips: ["bottoms", "circumference", 3],
  inseam: ["bottoms", "length", 2],
  outseam: ["bottoms", "length", 2],
  rise: ["bottoms", "length", 2],
  thigh: ["bottoms", "circumference", 3],
  knee: ["bottoms", "circumference", 2],
  calf: ["bottoms", "circumference", 2],
  bust: ["dresses", "circumference", 3],
  underbust: ["dresses", "circumference", 3],
  shoulderToWaist: ["dresses", "length", 2],
  torsoLength: ["dresses", "length", 3],
  footLength: ["shoes", "length", 1],
};

describe("[orchestrator] src/types.ts measurement spec", () => {
  it("23 unique keys, each with exactly one spec, matching the section 7 table", () => {
    expect(new Set(MEASUREMENT_KEYS).size).toBe(MEASUREMENT_KEYS.length);
    expect([...MEASUREMENT_KEYS].sort()).toEqual(Object.keys(DOC_TABLE).sort());
    for (const k of MEASUREMENT_KEYS) {
      const specs = MEASUREMENT_SPECS.filter((s) => s.key === k);
      expect(specs.length, `spec count for ${k}`).toBe(1);
      const [group, kind, target] = DOC_TABLE[k];
      expect([specs[0].group, specs[0].kind, specs[0].targetCm], k).toEqual([group, kind, target]);
      expect(specs[0].label.trim().length, `label for ${k}`).toBeGreaterThan(0);
    }
    expect(new Set(MEASUREMENT_SPECS.map((s) => s.label)).size).toBe(MEASUREMENT_SPECS.length);
  });
  it("bust = chest: same kind and target; wrist and footLength always low confidence", () => {
    const by = (k: MeasurementKey) => MEASUREMENT_SPECS.find((s) => s.key === k)!;
    expect(by("bust").kind).toBe(by("chest").kind);
    expect(by("bust").targetCm).toBe(by("chest").targetCm);
    expect(MEASUREMENT_SPECS.filter((s) => s.alwaysLowConfidence).map((s) => s.key).sort()).toEqual(["footLength", "wrist"]);
  });
});

function fullMeasurements(): Measurements {
  const m: Measurements = {};
  MEASUREMENT_KEYS.forEach((k, i) => (m[k] = { valueCm: 20 + i, uncertaintyCm: 1, confidence: 0.8 }));
  return m;
}

function scanWith(over: Partial<ScanDoc> = {}): ScanDoc {
  const raw: Partial<Record<MeasurementKey, number>> = {};
  MEASUREMENT_KEYS.forEach((k, i) => (raw[k] = 20 + i));
  return {
    createdAt: 1_760_000_000_000,
    status: "complete",
    heightCm: 175,
    bodyType: "unspecified",
    subjectLabel: "me",
    scaleSource: "height",
    deviceId: "dev-1",
    appVersion: "0.1.0",
    viewsCaptured: ["front", "side", "back"],
    measurements: fullMeasurements(),
    rawMeasurements: raw,
    diagnostics: {
      userAgent: "QA", deviceModelGuess: "QA", modelSource: "generic", videoWidth: 1080, videoHeight: 1920,
      focalLengthPxSpec: 1442, lensOffsetCm: 14, lensHeightCm: 13.5, tiltDeg: 75, rollDeg: 0,
      distanceM: { front: 2.5, side: 2.5, back: 2.5 }, scaleAgreementPct: 0.5, qualityScores: { front: 0.9 },
      retakes: [], processingMs: 8000, modelVersions: { pose: "heavy" },
    },
    ...over,
  };
}

describe("[S server] Firestore mapping (server/store-firestore.ts) keeps every key and never stores images", () => {
  const CONVERT = "server/store-firestore";
  it("scanToFirestore -> scanFromFirestore round-trips all 23 keys (measurements, raw, tape)", async () => {
    const c = await loadModule(CONVERT, "S server");
    const to = fn(c, "scanToFirestore", "S server", CONVERT);
    const from = fn(c, "scanFromFirestore", "S server", CONVERT);
    const scan = scanWith({ tapeMeasurements: { ...scanWith().rawMeasurements } });
    const data = to(scan, { toTimestamp: (ms: number) => ({ toMillis: () => ms }) });
    const back: ScanDoc = from("id1", data);
    for (const k of MEASUREMENT_KEYS) {
      expect(back.measurements[k], `measurements.${k}`).toEqual(scan.measurements[k]);
      expect(back.rawMeasurements[k], `rawMeasurements.${k}`).toBe(scan.rawMeasurements[k]);
      expect(back.tapeMeasurements?.[k], `tapeMeasurements.${k}`).toBe(scan.tapeMeasurements?.[k]);
    }
    expect(back.createdAt).toBe(scan.createdAt);
  });
  it("serialized scan contains only plain JSON-like data (no Blob/ImageData/typed arrays/data: URLs)", async () => {
    const c = await loadModule(CONVERT, "S server");
    const to = fn(c, "scanToFirestore", "S server", CONVERT);
    const data = to(scanWith(), { toTimestamp: (ms: number) => ({ toMillis: () => ms }) });
    const offenders: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
        if (typeof v === "string" && /^data:|base64,/.test(v)) offenders.push(`${path} (data URL)`);
        return;
      }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return void offenders.push(`${path} (binary)`);
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (typeof v === "object") {
        const name = (v as object).constructor?.name ?? "";
        if (/Blob|File|Image|Bitmap|Canvas/i.test(name)) return void offenders.push(`${path} (${name})`);
        for (const [k, x] of Object.entries(v as object)) {
          if (typeof x === "function") continue; // Timestamp helper methods
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(data, "scan");
    expect(offenders).toEqual([]);
    expect(JSON.stringify(data).length, "scan doc should be small (numbers only)").toBeLessThan(20_000);
  });
});

describe("[A auth-data] validation stats and correction factors (S9 / summary)", () => {
  const VAL = "src/data/validation";
  it("validationStats covers every key with a target and uses measurements (corrected) vs tape", async () => {
    const v = await loadModule(VAL, "A auth-data");
    const stats = fn(v, "validationStats", "A auth-data", VAL);
    const tape: Partial<Record<MeasurementKey, number>> = {};
    MEASUREMENT_KEYS.forEach((k, i) => (tape[k] = 20 + i + 1)); // every key off by +1 cm
    const rows = stats([scanWith({ tapeMeasurements: tape }), scanWith(), scanWith({ tapeMeasurements: tape })]);
    const keys = rows.map((r: { key: string }) => r.key);
    const expected = MEASUREMENT_SPECS.filter((s) => s.targetCm !== null).map((s) => s.key);
    expect([...keys].sort()).toEqual([...expected].sort());
    for (const r of rows) {
      expect(r.n, r.key).toBe(2);
      near(r.maeCm, 1, 1e-9, `mae ${r.key}`);
      const target = MEASUREMENT_SPECS.find((s) => s.key === r.key)!.targetCm!;
      expect(r.pctWithinTarget, r.key).toBe(target >= 1 ? 100 : 0);
    }
  });
  it("computeCorrectionFactors: k = mean(tape/RAW), circumferences only, per bodyType, >= minScans; default k absent", async () => {
    const v = await loadModule(VAL, "A auth-data");
    const ccf = fn(v, "computeCorrectionFactors", "A auth-data", VAL);
    const mk = (bodyType: ScanDoc["bodyType"], rawChest: number, tapeChest: number) => {
      const s = scanWith({ bodyType });
      s.rawMeasurements = { ...s.rawMeasurements, chest: rawChest, inseam: 70 };
      s.measurements = { ...s.measurements, chest: { valueCm: 999, uncertaintyCm: 1, confidence: 0.9 } }; // must NOT be used
      s.tapeMeasurements = { chest: tapeChest, inseam: 77 };
      return s;
    };
    const scans = [mk("male", 100, 105), mk("male", 100, 103), mk("male", 100, 104), mk("female", 90, 99), mk("female", 90, 99)];
    const f = ccf(scans, 3);
    near(f.male.chest, 1.04, 1e-9, "male chest k");
    expect(f.male.inseam, "lengths never get k").toBeUndefined();
    expect(f.female.chest, "female has only 2 scans < minScans").toBeUndefined();
    expect(Object.keys(f.unspecified)).toEqual([]);
    const circ = new Set(MEASUREMENT_SPECS.filter((s) => s.kind === "circumference").map((s) => s.key));
    for (const bt of ["male", "female", "unspecified"] as const) {
      for (const k of Object.keys(f[bt])) expect(circ.has(k as MeasurementKey), `${bt}.${k} is not a circumference`).toBe(true);
    }
  });
});

describe("[E ui-flow] labels, groups, colours and units", () => {
  const FORMAT = "src/ui/format";
  it("chest label rule: Bust (female), Chest (male), Chest / bust (unspecified)", async () => {
    const m = await loadModule(FORMAT, "E ui-flow");
    const label = fn(m, "measurementLabel", "E ui-flow", FORMAT);
    expect(label("chest", "female")).toBe("Bust");
    expect(label("chest", "male")).toBe("Chest");
    expect(label("chest", "unspecified")).toBe("Chest / bust");
  });
  it("every key has a label, a Results group, and the views it depends on", async () => {
    const m = await loadModule(FORMAT, "E ui-flow");
    const label = fn(m, "measurementLabel", "E ui-flow", FORMAT);
    const groups = fn(m, "groupMeasurements", "E ui-flow", FORMAT)(fullMeasurements());
    const shown = groups.flatMap((g: { keys: string[] }) => g.keys);
    const expectedShown = MEASUREMENT_KEYS.filter((k) => k !== "bust"); // bust = chest, one row
    expect([...shown].sort(), "Results must list every measurement (M5 exit), bust folded into chest").toEqual([...expectedShown].sort());
    expect(groups.map((g: { title: string }) => g.title)).toEqual(["Tops", "Bottoms", "Dresses & one-pieces", "Shoes", "General"]);
    for (const k of MEASUREMENT_KEYS) {
      for (const bt of ["male", "female", "unspecified"]) expect(label(k, bt).length, `${k}/${bt}`).toBeGreaterThan(0);
      if (m.KEY_VIEWS) expect(m.KEY_VIEWS[k]?.length, `KEY_VIEWS.${k}`).toBeGreaterThan(0);
    }
    if (m.KEY_VIEWS) {
      expect(m.KEY_VIEWS.shoulderWidth).toContain("back");
      expect(m.KEY_VIEWS.backLength).toContain("back");
      expect(m.KEY_VIEWS.footLength).toContain("side");
    }
  });
  it("chest/bust: one UI row (chest), bust hidden but every other key visible (orchestrator decision)", async () => {
    const m = await loadModule(FORMAT, "E ui-flow");
    const visible = fn(m, "isVisibleKey", "E ui-flow", FORMAT);
    const hidden = MEASUREMENT_KEYS.filter((k) => !visible(k));
    expect(hidden, "only bust is hidden").toEqual(["bust"]);
    const vm = fn(m, "visibleMeasurements", "E ui-flow", FORMAT);
    const full = fullMeasurements();
    const shown = vm(full);
    expect(shown.bust).toBeUndefined();
    expect(shown.chest).toEqual(full.chest);
    expect(full.bust, "visibleMeasurements must not mutate its input").toBeDefined();
    const onlyBust = vm({ bust: full.bust });
    expect(onlyBust.chest, "chest falls back to a stored bust value").toEqual(full.bust);
    if (m.TAPE_KEYS) {
      expect(m.TAPE_KEYS).not.toContain("bust");
      expect(m.TAPE_KEYS).not.toContain("height");
      expect(m.TAPE_KEYS).toContain("chest");
    }
  });
  it("S9: the chest tape value is saved under BOTH chest and bust (cm)", async () => {
    const m = await loadModule(FORMAT, "E ui-flow");
    const build = fn(m, "buildTapeMeasurements", "E ui-flow", FORMAT);
    const t = build({ chest: "38.5", inseam: "30" }, "in");
    near(t.chest, 97.79, 0.01, "chest cm");
    expect(t.bust, "bust must mirror chest").toBe(t.chest);
    near(t.inseam, 76.2, 0.01, "inseam cm");
    const none = build({ inseam: "30", bust: "40" }, "in");
    expect(none.bust, "no chest value => no bust value").toBeUndefined();
  });
  it("confidence colours: >= 0.75 green, >= 0.5 amber, else red", async () => {
    const m = await loadModule(FORMAT, "E ui-flow");
    const col = fn(m, "confidenceColor", "E ui-flow", FORMAT);
    expect([0.75, 0.9, 1].map(col)).toEqual(["green", "green", "green"]);
    expect([0.5, 0.7499].map(col)).toEqual(["amber", "amber"]);
    expect([0, 0.4999, NaN].map(col)).toEqual(["red", "red", "red"]);
  });
  it("placement hint (E) agrees with placementOk (B) on the 60-85 / +/-3 boundaries", async () => {
    const e = await loadModule(FORMAT, "E ui-flow");
    const b = await loadModule("src/capture/sensors", "B device-capture");
    const hint = fn(e, "placementHint", "E ui-flow", FORMAT);
    const ok = fn(b, "placementOk", "B device-capture", "src/capture/sensors");
    for (const tilt of [55, 59.9, 60, 72, 85, 85.1, 90]) {
      for (const roll of [-3.1, -3, 0, 3, 3.1]) {
        const h = hint({ tiltDeg: tilt, rollDeg: roll });
        expect(h.tiltOk && h.rollOk, `tilt ${tilt} roll ${roll}`).toBe(ok({ tiltDeg: tilt, rollDeg: roll }));
      }
    }
  });
  it("units: cm<->in exact, inches to nearest 0.25\"", async () => {
    const u = await loadModule("src/units", "E ui-flow");
    near(fn(u, "cmToIn", "E ui-flow", "src/units")(2.54), 1, 1e-12, "cmToIn");
    near(fn(u, "inToCm", "E ui-flow", "src/units")(1), 2.54, 1e-12, "inToCm");
    const fmt = fn(u, "formatLength", "E ui-flow", "src/units");
    expect(fmt(97.79, "in")).toContain("38.5"); // 38.5"
    expect(fmt(97.0, "in")).toContain("38.25"); // 38.19" -> 38.25
    expect(fmt(100, "cm")).toContain("100");
  });
});
