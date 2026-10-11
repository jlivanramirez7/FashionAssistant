import { describe, expect, it } from "vitest";
import {
  createHoldGate,
  createTrustGate,
  GLITCH_MS,
  orientationHintFor,
  resetHold,
  TRUST_ORIENTATION_MS,
  updateHold,
  updateTrust,
} from "../../src/ui/captureLogic";

describe("hold gate", () => {
  it("measures a continuous hold", () => {
    const g = createHoldGate();
    expect(updateHold(g, false, 0)).toBeNull();
    expect(updateHold(g, true, 100)).toBe(0);
    expect(updateHold(g, true, 600)).toBe(500);
  });

  it("bridges short glitches but resets on a real break", () => {
    const g = createHoldGate();
    updateHold(g, true, 0);
    expect(updateHold(g, false, GLITCH_MS - 50)).toBe(GLITCH_MS - 50);
    expect(updateHold(g, true, 900)).toBe(900);
    expect(updateHold(g, false, 900 + GLITCH_MS + 1)).toBeNull();
    expect(updateHold(g, true, 2000)).toBe(0);
  });

  it("reset clears the hold", () => {
    const g = createHoldGate();
    updateHold(g, true, 0);
    resetHold(g);
    expect(updateHold(g, false, 10)).toBeNull();
  });
});

describe("trust gate", () => {
  it("only applies to side and back", () => {
    expect(orientationHintFor("front")).toBeNull();
    expect(orientationHintFor("side")).toBe("turn-side");
    expect(orientationHintFor("back")).toBe("turn-back");
  });

  it("flips after enough time stuck on the orientation hint", () => {
    const g = createTrustGate();
    let flipped = 0;
    for (let t = 0; t <= TRUST_ORIENTATION_MS + 200; t += 33) {
      if (updateTrust(g, "back", "turn-back", t, true)) flipped++;
    }
    expect(g.trusted).toBe(true);
    expect(flipped).toBe(1);
  });

  it("does not count other hints, time before counting, or long frame gaps", () => {
    const g = createTrustGate();
    for (let t = 0; t < 10_000; t += 33) updateTrust(g, "back", "arms-out", t, true);
    for (let t = 10_000; t < 20_000; t += 33) updateTrust(g, "back", "turn-back", t, false);
    updateTrust(g, "back", "turn-back", 60_000, true);
    expect(g.trusted).toBe(false);
    expect(g.stuckMs).toBeLessThan(300);
  });

  it("never trusts the front step", () => {
    const g = createTrustGate();
    for (let t = 0; t < 20_000; t += 33) updateTrust(g, "front", "face-phone", t, true);
    expect(g.trusted).toBe(false);
  });
});
