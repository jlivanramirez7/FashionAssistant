import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import {
  assembleDebugZip,
  buildManifest,
  DEBUG_MANIFEST_VERSION,
  debugZipName,
  framePath,
  hasDebugParam,
  isDevHost,
  parseDebugZip,
  type DebugFrameBytes,
} from "../../src/dev/debugCapture";
import type { DeviceProfile, ScanInputs, ViewCapture, ViewName } from "../../src/types";

const profile: DeviceProfile = {
  deviceId: "dev-1",
  label: "Test phone",
  deviceModelGuess: "Pixel 8",
  modelSource: "ua-client-hints",
  screen: { width: 412, height: 915, devicePixelRatio: 2.625 },
  lensOffsetCm: 1,
  lensOffsetSource: "profile",
  front35mmEqMm: 26,
  focalLengthPx: 1500,
  focalLengthSource: "spec",
  captureWidth: 1080,
  captureHeight: 1920,
  calibrationScans: 0,
};
const inputs: ScanInputs = { heightCm: 178, bodyType: "male", subjectLabel: "me" };

function fakeCaptures(): ViewCapture[] {
  const views: [ViewName, number][] = [["front", 3], ["side", 2], ["back", 1]];
  return views.map(([view, n]) => ({
    view,
    frames: Array.from({ length: n }, (_, i) => ({
      view,
      timestampMs: 1000 * i + 17,
      image: {} as ImageBitmap, // never read by the pure parts
      width: 1080,
      height: 1920,
      orientation: { tiltDeg: 75 + i, rollDeg: -0.5 },
      ...(i === 0 ? { liveLandmarks: [{ x: 0.5, y: 0.1, z: 0, visibility: 0.9 }] } : {}),
    })),
  }));
}

function fakeJpeg(view: ViewName, index: number): Uint8Array {
  // SOI marker, some payload unique per frame, EOI marker.
  const body = Array.from({ length: 64 + index }, (_, k) => (k * 7 + index + view.length) & 0xff);
  return new Uint8Array([0xff, 0xd8, ...body, 0xff, 0xd9]);
}

function fakeFrames(caps: ViewCapture[]): DebugFrameBytes[] {
  return caps.flatMap((c) => c.frames.map((_, index) => ({ view: c.view, index, jpeg: fakeJpeg(c.view, index) })));
}

describe("buildManifest", () => {
  it("records inputs, profile, per-view frame metadata and sensor log", () => {
    const caps = fakeCaptures();
    const sensorLog = [{ tiltDeg: 74, rollDeg: 0.2 }, { tiltDeg: 75, rollDeg: 0.1 }];
    const m = buildManifest({ captures: caps, profile, inputs, sensorLog, createdAt: 123 });
    expect(m.version).toBe(DEBUG_MANIFEST_VERSION);
    expect(m.createdAt).toBe(123);
    expect(m.inputs).toEqual(inputs);
    expect(m.profile).toEqual(profile);
    expect(m.sensorLog).toEqual(sensorLog);
    expect(m.views.map((v) => [v.view, v.frames.length])).toEqual([["front", 3], ["side", 2], ["back", 1]]);
    const f = m.views[0].frames[1];
    expect(f).toEqual({
      index: 1,
      path: "frames/front/1.jpg",
      timestampMs: 1017,
      width: 1080,
      height: 1920,
      orientation: { tiltDeg: 76, rollDeg: -0.5 },
    });
    expect(m.views[0].frames[0].liveLandmarks).toHaveLength(1);
    // JSON-safe (no image objects leak in).
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});

describe("assembleDebugZip / parseDebugZip", () => {
  it("round-trips manifest and frame bytes", async () => {
    const caps = fakeCaptures();
    const manifest = buildManifest({ captures: caps, profile, inputs, sensorLog: [], createdAt: 5 });
    const frames = fakeFrames(caps);
    const zip = assembleDebugZip(manifest, frames);

    const entries = Object.keys(unzipSync(zip)).sort();
    expect(entries).toEqual(
      ["manifest.json", ...frames.map((f) => framePath(f.view, f.index))].sort(),
    );

    const parsed = await parseDebugZip(zip);
    expect(parsed.manifest).toEqual(manifest);
    expect(parsed.frames).toHaveLength(6);
    for (const f of frames) {
      const got = parsed.frames.find((p) => p.view === f.view && p.index === f.index);
      expect(got).toBeDefined();
      expect(Array.from(got!.jpeg)).toEqual(Array.from(f.jpeg));
    }
  });

  it("rejects a zip without manifest.json", async () => {
    const zip = zipSync({ "hello.txt": strToU8("hi") });
    await expect(parseDebugZip(zip)).rejects.toThrow(/manifest/);
  });

  it("rejects a zip whose frame is missing", async () => {
    const caps = fakeCaptures();
    const manifest = buildManifest({ captures: caps, profile, inputs, sensorLog: [] });
    const zip = assembleDebugZip(manifest, fakeFrames(caps).slice(1));
    await expect(parseDebugZip(zip)).rejects.toThrow(/frames\/front\/0\.jpg/);
  });

  it("rejects a newer manifest version", async () => {
    const manifest = { ...buildManifest({ captures: [], profile, inputs, sensorLog: [] }), version: 99 };
    await expect(parseDebugZip(assembleDebugZip(manifest, []))).rejects.toThrow(/version/);
  });
});

describe("isDevHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.23",
    "169.254.10.1",
    "my-pc.local",
    "fd12:3456::1",
    "fe80::1",
  ])("%s is a dev host", (h) => expect(isDevHost(h)).toBe(true));

  it.each([
    "fashion-assistant-abc123-uc.a.run.app",
    "run.app",
    "fashionassitant.firebaseapp.com",
    "example.com",
    "8.8.8.8",
    "172.32.0.1",
    "192.169.1.1",
    "999.168.1.1",
    "2001:4860::8888",
    "",
  ])("%s is not a dev host", (h) => expect(isDevHost(h)).toBe(false));
});

describe("hasDebugParam / debugZipName", () => {
  it("detects ?debug=1 only", () => {
    expect(hasDebugParam("?debug=1")).toBe(true);
    expect(hasDebugParam("?a=b&debug=1")).toBe(true);
    expect(hasDebugParam("?debug=0")).toBe(false);
    expect(hasDebugParam("")).toBe(false);
  });
  it("makes a filesystem-safe name", () => {
    expect(debugZipName(Date.UTC(2026, 9, 10, 12, 30, 5))).toBe("fa-debug-2026-10-10T12-30-05.zip");
  });
});
