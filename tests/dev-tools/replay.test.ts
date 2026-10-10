import { describe, expect, it, vi } from "vitest";

import { rebuildCaptures } from "../../src/dev/replayCore";
import type { DebugManifest } from "../../src/dev/debugCapture";

describe("rebuildCaptures", () => {
  it("restores ViewCapture[] with metadata and decoded images", async () => {
    const manifest = {
      version: 1,
      createdAt: 0,
      inputs: { heightCm: 170, bodyType: "female", subjectLabel: "me" },
      profile: {} as DebugManifest["profile"],
      views: [
        {
          view: "front",
          frames: [
            { index: 0, path: "frames/front/0.jpg", timestampMs: 10, width: 4, height: 8, orientation: { tiltDeg: 70, rollDeg: 1 } },
            { index: 1, path: "frames/front/1.jpg", timestampMs: 20, width: 4, height: 8, orientation: { tiltDeg: 71, rollDeg: 0 } },
          ],
        },
        { view: "side", frames: [] },
      ],
      sensorLog: [],
    } satisfies DebugManifest;
    const frames = [
      { view: "front" as const, index: 1, jpeg: new Uint8Array([2]) },
      { view: "front" as const, index: 0, jpeg: new Uint8Array([1]) },
    ];
    const decode = vi.fn(async (j: Uint8Array) => ({ width: 4, height: 8, tag: j[0] }) as unknown as ImageBitmap);
    const caps = await rebuildCaptures(manifest, frames, decode);
    expect(caps.map((c) => c.view)).toEqual(["front", "side"]);
    expect(caps[0].frames.map((f) => (f.image as unknown as { tag: number }).tag)).toEqual([1, 2]);
    expect(caps[0].frames[1]).toMatchObject({ view: "front", timestampMs: 20, width: 4, height: 8, orientation: { tiltDeg: 71, rollDeg: 0 } });
    expect(caps[1].frames).toEqual([]);
  });
});
