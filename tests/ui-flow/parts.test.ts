// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { MEASUREMENT_KEYS } from "../../src/types";
import { inToCm } from "../../src/units";
import { createBodyDiagram, TAPE_TIPS } from "../../src/ui/parts/bodyDiagram";
import { createMeasurementRow } from "../../src/ui/parts/measurementRow";
import { createStatusBorder } from "../../src/ui/parts/statusBorder";
import { createUnitToggle } from "../../src/ui/parts/unitToggle";

describe("measurementRow", () => {
  it("shows label, value, uncertainty and a confidence dot; tap toggles the diagram", () => {
    const row = createMeasurementRow({
      key: "chest",
      value: { valueCm: inToCm(38.5), uncertaintyCm: 2.54, confidence: 0.6 },
      bodyType: "female",
      units: "in",
    });
    expect(row.querySelector(".m-label")?.textContent).toBe("Bust");
    expect(row.querySelector(".m-value")?.textContent).toBe('38.5"');
    expect(row.querySelector(".m-unc")?.textContent).toBe('±1.0"');
    expect(row.querySelector(".dot")?.classList.contains("dot-amber")).toBe(true);
    const btn = row.querySelector("button")!;
    btn.click();
    expect(row.querySelector(".body-diagram")).not.toBeNull();
    btn.click();
    expect(row.querySelector(".body-diagram")).toBeNull();
  });
});

describe("unitToggle", () => {
  it("fires onChange only on a change", () => {
    const onChange = vi.fn();
    const el = createUnitToggle("in", onChange);
    const [inBtn, cmBtn] = Array.from(el.querySelectorAll("button"));
    inBtn.click();
    expect(onChange).not.toHaveBeenCalled();
    cmBtn.click();
    expect(onChange).toHaveBeenCalledWith("cm");
    expect(cmBtn.classList.contains("active")).toBe(true);
  });
});

describe("statusBorder", () => {
  it("switches colour classes", () => {
    const b = createStatusBorder();
    expect(b.el.classList.contains("status-red")).toBe(true);
    b.set("green");
    expect(b.el.classList.contains("status-green")).toBe(true);
    expect(b.el.classList.contains("status-red")).toBe(false);
  });
});

describe("bodyDiagram", () => {
  it("has a diagram and tape tip for every key", () => {
    for (const k of MEASUREMENT_KEYS) {
      expect(TAPE_TIPS[k].length).toBeGreaterThan(10);
      const d = createBodyDiagram(k);
      expect(d.querySelector("svg .mark")).not.toBeNull();
    }
  });
});
