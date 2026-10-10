import { describe, expect, it } from "vitest";
import {
  cmToFeetInches,
  cmToIn,
  formatLength,
  formatPlusMinus,
  formatSmallLength,
  inToCm,
  lengthInputValue,
  parseHeight,
  parseLength,
  roundQuarter,
} from "../../src/units";

describe("conversions", () => {
  it("cm <-> in round-trips", () => {
    expect(cmToIn(2.54)).toBeCloseTo(1);
    expect(inToCm(10)).toBeCloseTo(25.4);
    expect(inToCm(cmToIn(98.4))).toBeCloseTo(98.4);
  });
  it("roundQuarter", () => {
    expect(roundQuarter(38.1)).toBe(38);
    expect(roundQuarter(38.13)).toBe(38.25);
    expect(roundQuarter(38.4)).toBe(38.5);
  });
});

describe("formatLength", () => {
  it("inches to nearest 0.25 with an inch mark", () => {
    expect(formatLength(inToCm(38.5), "in")).toBe('38.5"');
    expect(formatLength(inToCm(32), "in")).toBe('32.0"');
    expect(formatLength(inToCm(38.26), "in")).toBe('38.25"');
    expect(formatLength(inToCm(30.74), "in")).toBe('30.75"');
    expect(formatLength(inToCm(15.6), "in")).toBe('15.5"');
  });
  it("cm with one decimal", () => {
    expect(formatLength(98.44, "cm")).toBe("98.4 cm");
    expect(formatLength(100, "cm")).toBe("100.0 cm");
  });
  it("non-finite values show a dash", () => {
    expect(formatLength(NaN, "in")).toBe("-");
    expect(formatLength(Infinity, "cm")).toBe("-");
  });
  it("plus/minus and small lengths", () => {
    expect(formatPlusMinus(2.54, "in")).toBe('±1.0"');
    expect(formatPlusMinus(2.6, "cm")).toBe("±2.6 cm");
    expect(formatPlusMinus(NaN, "cm")).toBe("");
    expect(formatSmallLength(1.524, "in")).toBe('0.6"');
    expect(formatSmallLength(1.5, "cm")).toBe("1.5 cm");
  });
});

describe("parseHeight", () => {
  it("feet + inches", () => {
    expect(parseHeight("in", "5", "10")).toBeCloseTo(177.8, 1);
    expect(parseHeight("in", 6, 0)).toBeCloseTo(182.9, 1);
    expect(parseHeight("in", "5", "")).toBeCloseTo(152.4, 1);
    expect(parseHeight("in", "5", "10.5")).toBeCloseTo(179.1, 1);
  });
  it("cm, accepting a decimal comma", () => {
    expect(parseHeight("cm", "178")).toBe(178);
    expect(parseHeight("cm", "178,5")).toBe(178.5);
    expect(parseHeight("cm", 165.25)).toBe(165.3);
  });
  it("rejects empty, invalid and out-of-range values", () => {
    expect(parseHeight("cm", "")).toBeNull();
    expect(parseHeight("cm", "abc")).toBeNull();
    expect(parseHeight("cm", "50")).toBeNull();
    expect(parseHeight("cm", "300")).toBeNull();
    expect(parseHeight("in", "", "")).toBeNull();
    expect(parseHeight("in", "5", "12")).toBeNull();
    expect(parseHeight("in", "5.5", "0")).toBeNull();
    expect(parseHeight("in", "-5", "0")).toBeNull();
    expect(parseHeight("in", "2", "0")).toBeNull();
  });
});

describe("cmToFeetInches / input values / parseLength", () => {
  it("splits a height for pre-filling", () => {
    expect(cmToFeetInches(177.8)).toEqual({ feet: 5, inches: 10 });
    expect(cmToFeetInches(inToCm(71.9))).toEqual({ feet: 6, inches: 0 });
  });
  it("round-trips through parseHeight", () => {
    const { feet, inches } = cmToFeetInches(180);
    expect(parseHeight("in", feet, inches)).toBeCloseTo(180, 0);
  });
  it("lengthInputValue", () => {
    expect(lengthInputValue(inToCm(38.3), "in")).toBe("38.25");
    expect(lengthInputValue(98.44, "cm")).toBe("98.4");
    expect(lengthInputValue(NaN, "cm")).toBe("");
  });
  it("parseLength", () => {
    expect(parseLength("10", "in")).toBeCloseTo(25.4);
    expect(parseLength("98.4", "cm")).toBeCloseTo(98.4);
    expect(parseLength("", "cm")).toBeNull();
    expect(parseLength("0", "cm")).toBeNull();
    expect(parseLength("-3", "in")).toBeNull();
  });
});
