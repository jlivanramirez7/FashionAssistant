import { describe, expect, it } from "vitest";
import { diagLog, MAX_LOG_ENTRIES, resetDiagLog, takeDiagLog } from "../../src/diagnostics/log";
import { downsampleSensors, newReportId, summarize } from "../../src/diagnostics/recorder";
import { transition } from "../../src/flow/stateMachine";
import { formatDate, formatDateTime } from "../../src/ui/format";

describe("troubleshooting recorder helpers", () => {
  it("report ids are valid API ids", () => {
    const id = newReportId(Date.UTC(2026, 9, 11), () => 0.5);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(newReportId(1, () => 0)).not.toBe(newReportId(1, () => 0.9));
  });

  it("summaries name the outcome and failing views", () => {
    expect(summarize({ outcome: "retake", retakeViews: [{ view: "front", reason: "blurry" }, { view: "back", reason: "no-person" }] }))
      .toBe("retake: front blurry, back no-person");
    expect(summarize({ outcome: "results", measurementCount: 20 })).toBe("results: 20 measurements");
    expect(summarize({ outcome: "results", measurementCount: 12, unresolved: ["side"] })).toContain("still failing: side");
    expect(summarize({ outcome: "error", error: "boom" })).toBe("error: boom");
  });

  it("downsamples and rounds sensor samples", () => {
    const samples = Array.from({ length: 5000 }, (_, i) => ({ tiltDeg: 75.123 + i * 0.001, rollDeg: -0.456 }));
    const out = downsampleSensors(samples, 600);
    expect(out).toHaveLength(600);
    expect(out[0]).toEqual({ tiltDeg: 75.1, rollDeg: -0.5 });
    expect(downsampleSensors(samples.slice(0, 3))).toHaveLength(3);
  });
});

describe("feedback log", () => {
  it("collects entries per take and caps the size", () => {
    resetDiagLog();
    diagLog("a");
    diagLog("x".repeat(400));
    const first = takeDiagLog();
    expect(first.map((e) => e.msg.length)).toEqual([1, 303]);
    expect(takeDiagLog()).toEqual([]);
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) diagLog(`m${i}`);
    const capped = takeDiagLog();
    expect(capped).toHaveLength(MAX_LOG_ENTRIES + 1);
    expect(capped[capped.length - 1].msg).toBe("(5 log lines dropped)");
  });
});

describe("state machine: troubleshooting screen", () => {
  it("home > diagnostics > back to home", () => {
    const d = transition({ name: "home" }, { type: "OPEN_DIAGNOSTICS" });
    expect(d).toEqual({ name: "diagnostics" });
    expect(transition(d, { type: "BACK" })).toEqual({ name: "home" });
    expect(transition(d, { type: "DONE" })).toBe(d);
    expect(transition({ name: "history" }, { type: "OPEN_DIAGNOSTICS" })).toEqual({ name: "history" });
  });
});

describe("formatDateTime", () => {
  it("date, 12-hour time with seconds (local time)", () => {
    const ms = new Date(2026, 9, 12, 7, 5, 9).getTime();
    expect(formatDateTime(ms)).toBe(`${formatDate(ms)}, 7:05:09 AM`);
    expect(formatDateTime(new Date(2026, 9, 12, 0, 0, 0).getTime())).toMatch(/, 12:00:00 AM$/);
    expect(formatDateTime(new Date(2026, 9, 12, 13, 30, 0).getTime())).toMatch(/, 1:30:00 PM$/);
    expect(formatDateTime(NaN)).toBe("");
  });
});
