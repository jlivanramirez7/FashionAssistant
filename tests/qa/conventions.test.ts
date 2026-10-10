// QA: cross-module conventions between B (device-capture) and C (geometry).
// Gravity sign convention assumed: W3C accelerationIncludingGravity, i.e.
// phone upright portrait at rest => (0, +g, 0); flat on its back, screen up
// => (0, 0, +g). Tilt = angle from flat (90 = upright); roll = in-plane
// rotation about the screen normal = atan2(gx, gy).
import { describe, expect, it } from "vitest";
import { DEG, fn, loadModule, near } from "./_helpers";
import { gravityFor, headSilhouetteTopY, lensHeight, makeProfile, project, type SceneCam } from "./_scene";

const SENSORS = "src/capture/sensors";
const PROFILE = "src/device/profile";
const PROFILES = "src/device/profiles";
const CAMERA = "src/geometry/camera";
const PLANE = "src/geometry/plane";
const DIST = "src/geometry/distortion";

const W = 1080, H = 1920;
const CAM: SceneCam = { width: W, height: H, f: 1500, thetaDeg: 75, lensOffsetCm: 14 };

describe("[B device-capture] sensor conventions", () => {
  it("gravityToOrientation: upright = 90, flat on back = 0, leaning theta = theta", async () => {
    const m = await loadModule(SENSORS, "B device-capture");
    const g2o = fn(m, "gravityToOrientation", "B device-capture", SENSORS);
    near(g2o(0, 9.81, 0).tiltDeg, 90, 0.5, "upright tilt");
    near(g2o(0, 0, 9.81).tiltDeg, 0, 0.5, "flat tilt");
    for (const t of [60, 70, 75, 85]) {
      near(g2o(...gravityFor(t)).tiltDeg, t, 0.3, `tilt for theta=${t}`);
      near(g2o(...gravityFor(t, 0, 1)).tiltDeg, t, 0.3, `tilt for theta=${t} (unit gravity, scale invariant)`);
      near(g2o(...gravityFor(t)).rollDeg, 0, 0.3, `roll for theta=${t}`);
    }
  });

  it("gravityToOrientation: roll is in-plane rotation, antisymmetric, independent of tilt", async () => {
    const m = await loadModule(SENSORS, "B device-capture");
    const g2o = fn(m, "gravityToOrientation", "B device-capture", SENSORS);
    for (const r of [2, 3, 5]) {
      const a = g2o(...gravityFor(75, r));
      const b = g2o(...gravityFor(75, -r));
      near(Math.abs(a.rollDeg), r, 0.2, `|roll| for r=${r}`);
      near(a.rollDeg, -b.rollDeg, 1e-6, "roll antisymmetry");
      near(a.tiltDeg, 75, 0.3, `tilt unaffected by roll ${r}`);
    }
  });

  it("placementOk: tilt 60-85 inclusive and |roll| <= 3", async () => {
    const m = await loadModule(SENSORS, "B device-capture");
    const ok = fn(m, "placementOk", "B device-capture", SENSORS);
    const cases: [number, number, boolean][] = [
      [75, 0, true], [60, 0, true], [85, 0, true], [59.5, 0, false], [85.5, 0, false],
      [75, 3, true], [75, -3, true], [75, 3.2, false], [75, -3.2, false], [90, 0, false], [30, 0, false],
    ];
    const bad = cases.filter(([t, r, want]) => ok({ tiltDeg: t, rollDeg: r }) !== want);
    expect(bad, `wrong verdicts (tilt, roll, expected): ${JSON.stringify(bad)}`).toEqual([]);
  });

  it("averageOrientation averages tilt and roll", async () => {
    const m = await loadModule(SENSORS, "B device-capture");
    const avg = fn(m, "averageOrientation", "B device-capture", SENSORS);
    const o = avg([{ tiltDeg: 70, rollDeg: 1 }, { tiltDeg: 80, rollDeg: -1 }]);
    near(o.tiltDeg, 75, 1e-6, "avg tilt");
    near(o.rollDeg, 0, 1e-6, "avg roll");
  });
});

describe("[B device-capture] device profile math (section 4)", () => {
  it("GENERIC_SPEC: L_lens 14 cm, 26 mm-eq", async () => {
    const p = await loadModule(PROFILES, "B device-capture");
    const pr = await loadModule(PROFILE, "B device-capture");
    expect(p.GENERIC_SPEC.front35mmEqMm).toBe(26);
    near(fn(pr, "lensOffsetCmFromSpec", "B device-capture", PROFILE)(p.GENERIC_SPEC), 14, 1e-9, "generic L_lens cm");
  });

  it("focalPxFromSpec: 35mm-eq diagonal over the SENSOR (default 4:3 crop)", async () => {
    // Contract update (orchestrator, phase 1): f = f35 * hypot(long, long * aspect) / 43.27,
    // aspect = sensor short/long (default "4:3"). With "16:9" on a 16:9 video this is the
    // design-doc formula f35 * sqrt(W^2 + H^2) / 43.27.
    const pr = await loadModule(PROFILE, "B device-capture");
    const fp = fn(pr, "focalPxFromSpec", "B device-capture", PROFILE);
    near(fp(26, 1080, 1920), (26 * Math.hypot(1920, 1440)) / 43.27, 1e-6, "f_px 1080x1920, default 4:3 sensor");
    near(fp(26, 1080, 1920, "4:3"), (26 * Math.hypot(1920, 1440)) / 43.27, 1e-6, "f_px 1080x1920, 4:3");
    near(fp(26, 1080, 1920, "16:9"), (26 * Math.hypot(1080, 1920)) / 43.27, 1e-6, "16:9 = doc formula");
    near(fp(26, 1920, 1080), fp(26, 1080, 1920), 1e-9, "orientation independent");
    near(fp(26, 720, 1280) / fp(26, 1080, 1920), 1280 / 1920, 1e-9, "scales with the long side");
  });

  it("matchSpec: UA model -> ua-client-hints, iOS screen -> screen-match, unknown -> generic", async () => {
    const p = await loadModule(PROFILES, "B device-capture");
    const match = fn(p, "matchSpec", "B device-capture", PROFILES);
    const pixel = { model: "Pixel 8", uaModels: ["Pixel 8"], phoneHeightMm: 150.5, frontLensFromTopMm: 8, front35mmEqMm: 20 };
    const iphone = { model: "iPhone QA (6.1in)", screenMatch: { width: 390, height: 844, dpr: 3 }, phoneHeightMm: 146.7, frontLensFromTopMm: 9, front35mmEqMm: 23 };
    const specs = [pixel, iphone];
    const a = match(specs, { uaModel: "Pixel 8", screenWidth: 412, screenHeight: 915, dpr: 2.625, isIOS: false });
    expect(a.source).toBe("ua-client-hints");
    expect(a.spec.model).toBe("Pixel 8");
    const b = match(specs, { screenWidth: 390, screenHeight: 844, dpr: 3, isIOS: true });
    expect(b.source).toBe("screen-match");
    expect(b.spec.model).toBe("iPhone QA (6.1in)");
    const b2 = match(specs, { screenWidth: 844, screenHeight: 390, dpr: 3, isIOS: true });
    expect(b2.source, "landscape screen size should still match the portrait key").toBe("screen-match");
    const c = match(specs, { uaModel: "Unknown 9", screenWidth: 400, screenHeight: 800, dpr: 2, isIOS: false });
    expect(c.source).toBe("generic");
    expect(c.spec).toEqual(p.GENERIC_SPEC);
  });

  it("buildProfile: spec values, saved paper/height-solve overrides (A record -> B), focal rescale", async () => {
    const p = await loadModule(PROFILES, "B device-capture");
    const pr = await loadModule(PROFILE, "B device-capture");
    const build = fn(pr, "buildProfile", "B device-capture", PROFILE);
    const base = {
      deviceId: "dev-1", spec: p.GENERIC_SPEC, source: "generic", userAgent: "QA",
      screen: { width: 390, height: 844, devicePixelRatio: 3 }, captureWidth: 1080, captureHeight: 1920,
    };
    const a = build({ ...base, saved: null });
    near(a.lensOffsetCm, 14, 1e-9, "generic lensOffsetCm");
    expect(a.lensOffsetSource).toBe("generic");
    expect(a.focalLengthSource).toBe("spec");
    const fp = fn(pr, "focalPxFromSpec", "B device-capture", PROFILE);
    near(a.focalLengthPx, fp(26, 1080, 1920, p.GENERIC_SPEC.frontSensorAspect ?? "4:3"), 1e-6, "spec focal = focalPxFromSpec(spec)");
    expect(a.captureWidth).toBe(1080);
    expect(a.modelSource).toBe("generic");

    const b = build({ ...base, saved: { lensOffsetCm: 13.2, lensOffsetSource: "paper", focalLengthPx: 1400, focalLengthSource: "height-solve", captureWidth: 1080, captureHeight: 1920, calibrationScans: 3 } });
    near(b.lensOffsetCm, 13.2, 1e-9, "paper lensOffsetCm overrides spec");
    expect(b.lensOffsetSource).toBe("paper");
    near(b.focalLengthPx, 1400, 1e-6, "height-solve focal overrides spec");
    expect(b.focalLengthSource).toBe("height-solve");

    const c = build({ ...base, saved: { focalLengthPx: 1000, focalLengthSource: "height-solve", captureWidth: 720, captureHeight: 1280 } });
    near(c.focalLengthPx, 1500, 1, "saved focal at 720x1280 rescaled to 1080x1920");
  });
});

describe("[C geometry-measure] camera + floor geometry (section 4)", () => {
  it("buildCamera: intrinsics, theta/phi, h = L_lens * sin(theta), k1 default 0", async () => {
    const m = await loadModule(CAMERA, "C geometry-measure");
    const cam = fn(m, "buildCamera", "C geometry-measure", CAMERA)(makeProfile(CAM), { tiltDeg: 75, rollDeg: 0 }, W, H);
    expect(cam.width).toBe(W);
    expect(cam.height).toBe(H);
    near(cam.fy, 1500, 1e-6, "fy");
    near(cam.fx, 1500, 1e-6, "fx (square pixels)");
    near(cam.cx, W / 2, 0.5, "cx");
    near(cam.cy, H / 2, 0.5, "cy");
    near(cam.thetaRad, 75 * DEG, 1e-9, "thetaRad");
    near(cam.phiRad, 15 * DEG, 1e-9, "phiRad = 90 - theta");
    near(cam.lensHeightCm, 14 * Math.sin(75 * DEG), 1e-6, "lensHeightCm (doc example 13.5)");
    near(cam.rollRad, 0, 1e-9, "rollRad");
    expect(cam.k1).toBe(0);
  });

  it("buildCamera rescales focal length when the frame size differs from captureWidth/Height", async () => {
    const m = await loadModule(CAMERA, "C geometry-measure");
    const cam = fn(m, "buildCamera", "C geometry-measure", CAMERA)(makeProfile(CAM), { tiltDeg: 75, rollDeg: 0 }, 720, 1280);
    near(cam.fy, 1000, 1, "fy at 720x1280 (profile 1500 @ 1080x1920)");
  });

  it("undistort is the identity when k1 = 0", async () => {
    const c = await loadModule(CAMERA, "C geometry-measure");
    const d = await loadModule(DIST, "C geometry-measure");
    const cam = fn(c, "buildCamera", "C geometry-measure", CAMERA)(makeProfile(CAM), { tiltDeg: 75, rollDeg: 0 }, W, H);
    const [u, v] = fn(d, "undistort", "C geometry-measure", DIST)(cam, 100, 1800);
    near(u, 100, 1e-9, "u");
    near(v, 1800, 1e-9, "v");
  });

  it("distanceFromFeet recovers the true distance of a synthetic scene", async () => {
    const c = await loadModule(CAMERA, "C geometry-measure");
    const p = await loadModule(PLANE, "C geometry-measure");
    const cam = fn(c, "buildCamera", "C geometry-measure", CAMERA)(makeProfile(CAM), { tiltDeg: 75, rollDeg: 0 }, W, H);
    const dist = fn(p, "distanceFromFeet", "C geometry-measure", PLANE);
    for (const d of [150, 200, 250, 300, 350]) near(dist(cam, project(CAM, 0, 0, d).v), d, 0.05, `distance d=${d}`);
  });

  it("distanceFromFeet is guarded (no throw, no positive finite answer) above the horizon", async () => {
    const c = await loadModule(CAMERA, "C geometry-measure");
    const p = await loadModule(PLANE, "C geometry-measure");
    const cam = fn(c, "buildCamera", "C geometry-measure", CAMERA)(makeProfile(CAM), { tiltDeg: 75, rollDeg: 0 }, W, H);
    const dist = fn(p, "distanceFromFeet", "C geometry-measure", PLANE);
    for (const v of [H / 2, 0, H / 2 + 1500 * Math.tan(15 * DEG)]) {
      const r = dist(cam, v);
      expect(Number.isFinite(r) && r > 0 && r < 1e5, `v=${v} gave ${r}`).toBe(false);
    }
  });

  it("CHAIN B -> C: gravity -> orientation -> generic profile -> camera -> distance", async () => {
    const s = await loadModule(SENSORS, "B device-capture");
    const p = await loadModule(PROFILES, "B device-capture");
    const pr = await loadModule(PROFILE, "B device-capture");
    const c = await loadModule(CAMERA, "C geometry-measure");
    const pl = await loadModule(PLANE, "C geometry-measure");
    const o = fn(s, "gravityToOrientation", "B device-capture", SENSORS)(...gravityFor(72, 1));
    const profile = fn(pr, "buildProfile", "B device-capture", PROFILE)({
      deviceId: "d", spec: p.GENERIC_SPEC, source: "generic", userAgent: "QA",
      screen: { width: 390, height: 844, devicePixelRatio: 3 }, captureWidth: W, captureHeight: H, saved: null,
    });
    const scene: SceneCam = { width: W, height: H, f: profile.focalLengthPx, thetaDeg: 72, lensOffsetCm: 14 };
    const cam = fn(c, "buildCamera", "C geometry-measure", CAMERA)(profile, o, W, H);
    near(cam.lensHeightCm, lensHeight(scene), 0.05, "lens height via chain");
    near(fn(pl, "distanceFromFeet", "C geometry-measure", PLANE)(cam, project(scene, 0, 0, 260).v), 260, 1, "distance via chain");
  });
});

describe("[C geometry-measure] view plane + height solve", () => {
  async function setup(f = 1500) {
    const c = await loadModule(CAMERA, "C geometry-measure");
    const p = await loadModule(PLANE, "C geometry-measure");
    const cam = fn(c, "buildCamera", "C geometry-measure", CAMERA)(makeProfile({ ...CAM, f }), { tiltDeg: 75, rollDeg: 0 }, W, H);
    return { cam, p };
  }
  const d = 250;
  const vFeet = project(CAM, 0, 0, d).v;
  // Head row = silhouette top of a REAL 3D head (tangent over the skull), not the crown:
  // team C models this "crown excess" (src/geometry/plane.ts crownExcessCm).
  const vHead = project(CAM, 0, headSilhouetteTopY(CAM, "front", d), d).v;
  const vHeadSide = project(CAM, 0, headSilhouetteTopY(CAM, "side", d), d).v;
  const vCrown = project(CAM, 0, 175, d).v;

  it("makeViewPlane: exact scene -> heightScale 1, agreement ~0%, metric round trip", async () => {
    const { cam, p } = await setup();
    const plane = fn(p, "makeViewPlane", "C geometry-measure", PLANE)(cam, "front", vFeet, vHead, 175);
    expect(plane.view).toBe("front");
    near(plane.distanceCm, d, 0.1, "plane.distanceCm");
    near(plane.heightScale, 1, 0.002, "heightScale");
    near(plane.scaleAgreementPct, 0, 0.2, "scaleAgreementPct");
    near(plane.toMetric(W / 2, vFeet).yCm, 0, 0.3, "feet yCm");
    near(plane.toMetric(W / 2, vCrown).yCm, 175, 0.3, "true crown yCm");
    const pt = project(CAM, 30, 100, d);
    const m = plane.toMetric(pt.u, pt.v);
    near(Math.abs(m.xCm), 30, 0.3, "|xCm| of a point 30 cm off-centre at 100 cm");
    near(m.yCm, 100, 0.3, "yCm of that point");
    near(plane.rowForHeight(100), project(CAM, 0, 100, d).v, 1, "rowForHeight(100)");
    near(plane.rowForHeight(0), vFeet, 1, "rowForHeight(0)");
  });

  it("makeViewPlane: typed height 180 vs true 175 -> heightScale 180/175, agreement 2.78%", async () => {
    const { cam, p } = await setup();
    const plane = fn(p, "makeViewPlane", "C geometry-measure", PLANE)(cam, "side", vFeet, vHeadSide, 180);
    near(plane.heightScale, 180 / 175, 0.003, "heightScale");
    near(plane.scaleAgreementPct, (5 / 180) * 100, 0.2, "scaleAgreementPct");
    near(plane.toMetric(W / 2, vCrown).yCm, 180, 0.5, "true crown scaled to typed height");
  });

  it("solveFocalLength recovers the true focal length when the spec is 10% off", async () => {
    const { cam, p } = await setup(1500 * 0.9);
    const solved = fn(p, "solveFocalLength", "C geometry-measure", PLANE)(cam, vFeet, vHead, 175);
    expect(solved, "solveFocalLength returned null for a valid scene").not.toBeNull();
    near(solved, 1500, 15, "solved f_y");
  });
});
