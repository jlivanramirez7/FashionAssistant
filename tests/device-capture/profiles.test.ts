import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GENERIC_SPEC, matchSpec, sanitizeSpecs } from "../../src/device/profiles";
import { isIOSUserAgent } from "../../src/device/detectModel";
import type { DeviceSpec } from "../../src/types";

const specs: DeviceSpec[] = [
  { model: "Pixel 8", uaModels: ["Pixel 8"], phoneHeightMm: 150.5, frontLensFromTopMm: 7, front35mmEqMm: 20 },
  { model: "Pixel 8 Pro", uaModels: ["Pixel 8 Pro"], phoneHeightMm: 162.6, frontLensFromTopMm: 7, front35mmEqMm: 20 },
  { model: "Galaxy S23", uaModels: ["SM-S911*"], phoneHeightMm: 146.3, frontLensFromTopMm: 7, front35mmEqMm: 26 },
  { model: "Galaxy S-wide", uaModels: ["SM-S9*"], phoneHeightMm: 150, frontLensFromTopMm: 7, front35mmEqMm: 26 },
  { model: "iPhone 14 Pro family", screenMatch: { width: 393, height: 852, dpr: 3 }, phoneHeightMm: 147.5, frontLensFromTopMm: 8, front35mmEqMm: 23 },
  { model: "iPhone XR/11", screenMatch: { width: 414, height: 896, dpr: 2 }, phoneHeightMm: 150.9, frontLensFromTopMm: 6, front35mmEqMm: 23 },
  { model: "iPhone XS Max", screenMatch: { width: 414, height: 896, dpr: 3 }, phoneHeightMm: 157.5, frontLensFromTopMm: 6, front35mmEqMm: 23 },
];
const base = { screenWidth: 412, screenHeight: 915, dpr: 2.625, isIOS: false };

describe("matchSpec", () => {
  it("exact UA model (case-insensitive, trimmed)", () => {
    expect(matchSpec(specs, { ...base, uaModel: "Pixel 8" })).toEqual({ spec: specs[0], source: "ua-client-hints" });
    expect(matchSpec(specs, { ...base, uaModel: " pixel 8 pro " }).spec.model).toBe("Pixel 8 Pro");
  });
  it("does not prefix-match exact entries", () => {
    expect(matchSpec(specs, { ...base, uaModel: "Pixel 8a" }).source).toBe("generic");
  });
  it("wildcard entries match regional variants; longest prefix wins", () => {
    expect(matchSpec(specs, { ...base, uaModel: "SM-S911B" }).spec.model).toBe("Galaxy S23");
    expect(matchSpec(specs, { ...base, uaModel: "SM-S911U1" }).spec.model).toBe("Galaxy S23");
    expect(matchSpec(specs, { ...base, uaModel: "SM-S921B" }).spec.model).toBe("Galaxy S-wide");
  });
  it("iOS screen match uses width, height and dpr (orientation-insensitive)", () => {
    const ios = { isIOS: true, screenWidth: 393, screenHeight: 852, dpr: 3 };
    expect(matchSpec(specs, ios)).toEqual({ spec: specs[4], source: "screen-match" });
    expect(matchSpec(specs, { ...ios, screenWidth: 852, screenHeight: 393 }).spec.model).toBe("iPhone 14 Pro family");
    expect(matchSpec(specs, { isIOS: true, screenWidth: 414, screenHeight: 896, dpr: 2 }).spec.model).toBe("iPhone XR/11");
    expect(matchSpec(specs, { isIOS: true, screenWidth: 414, screenHeight: 896, dpr: 3 }).spec.model).toBe("iPhone XS Max");
  });
  it("no screen match on Android", () => {
    expect(matchSpec(specs, { isIOS: false, screenWidth: 393, screenHeight: 852, dpr: 3 }).source).toBe("generic");
  });
  it("falls back to generic", () => {
    expect(matchSpec(specs, { ...base, uaModel: "Unknown 1" })).toEqual({ spec: GENERIC_SPEC, source: "generic" });
    expect(matchSpec([], { isIOS: true, screenWidth: 393, screenHeight: 852, dpr: 3 }).spec).toBe(GENERIC_SPEC);
  });
  it("generic spec gives L_lens 14 cm and 26 mm", () => {
    expect((GENERIC_SPEC.phoneHeightMm - GENERIC_SPEC.frontLensFromTopMm) / 10).toBe(14);
    expect(GENERIC_SPEC.front35mmEqMm).toBe(26);
  });
});

describe("sanitizeSpecs", () => {
  it("drops malformed entries and non-arrays", () => {
    expect(sanitizeSpecs({})).toEqual([]);
    const out = sanitizeSpecs([specs[0], { model: "x" }, null, { ...specs[0], phoneHeightMm: "150" }]);
    expect(out).toEqual([specs[0]]);
  });
});

describe("isIOSUserAgent", () => {
  it("detects iPhone and iPadOS desktop UA", () => {
    expect(isIOSUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
    expect(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 5)).toBe(true);
    expect(isIOSUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 0)).toBe(false);
    expect(isIOSUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe(false);
  });
});

describe("public/device-profiles.json", () => {
  const raw: unknown = JSON.parse(readFileSync(new URL("../../public/device-profiles.json", import.meta.url), "utf8"));
  const list = raw as DeviceSpec[];
  it("is a plain array of valid specs", () => {
    expect(Array.isArray(raw)).toBe(true);
    expect(sanitizeSpecs(raw)).toHaveLength(list.length);
    expect(list.length).toBeGreaterThan(30);
  });
  it("has plausible values", () => {
    for (const s of list) {
      expect(s.phoneHeightMm, s.model).toBeGreaterThan(125);
      expect(s.phoneHeightMm, s.model).toBeLessThan(170);
      expect(s.frontLensFromTopMm, s.model).toBeGreaterThanOrEqual(4);
      expect(s.frontLensFromTopMm, s.model).toBeLessThanOrEqual(12);
      expect(s.front35mmEqMm, s.model).toBeGreaterThanOrEqual(15);
      expect(s.front35mmEqMm, s.model).toBeLessThanOrEqual(32);
      expect(Boolean(s.uaModels?.length) !== Boolean(s.screenMatch), s.model).toBe(true);
    }
  });
  it("has unique keys", () => {
    const ua = list.flatMap((s) => s.uaModels ?? []).map((m) => m.toLowerCase());
    expect(new Set(ua).size).toBe(ua.length);
    const scr = list.filter((s) => s.screenMatch).map((s) => JSON.stringify(s.screenMatch));
    expect(new Set(scr).size).toBe(scr.length);
  });
  it("matches real devices", () => {
    expect(matchSpec(list, { ...base, uaModel: "Pixel 8" }).spec.model).toBe("Pixel 8");
    const p11 = matchSpec(list, { ...base, uaModel: "Pixel 11 Pro" });
    expect(p11).toMatchObject({ source: "ua-client-hints", spec: { model: "Pixel 11 Pro", phoneHeightMm: 152.7 } });
    expect(matchSpec(list, { ...base, uaModel: "SM-S928B" }).spec.model).toBe("Galaxy S24 Ultra");
    expect(matchSpec(list, { isIOS: true, screenWidth: 390, screenHeight: 844, dpr: 3 }).source).toBe("screen-match");
  });
});
