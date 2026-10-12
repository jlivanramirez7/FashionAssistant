import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { diagReportText, isJpeg, localTime, parseAttemptNumber, validateDiagAttempt, validateDiagReport } from "../../server/diagnostics.ts";
import type { DiagAttempt, DiagReport } from "../../src/types.ts";
import { sampleDevice, startHarness } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

function report(overrides: Partial<DiagReport> = {}): DiagReport {
  return {
    createdAt: Date.UTC(2026, 9, 11),
    updatedAt: Date.UTC(2026, 9, 11),
    appVersion: "0.1.0",
    userAgent: "test-agent",
    inputs: { heightCm: 178, bodyType: "male", subjectLabel: "me" },
    profile: sampleDevice("dev-1"),
    outcome: "retake",
    attempts: 1,
    summary: "retake: front blurry",
    sensorLog: [{ tiltDeg: 75, rollDeg: 0.5 }],
    ...overrides,
  };
}

function attempt(n: number, overrides: Partial<DiagAttempt> = {}): DiagAttempt {
  return {
    n,
    createdAt: Date.UTC(2026, 9, 11, 0, n),
    outcome: "retake",
    frames: [
      { id: "front-1", view: "front", index: 0, timestampMs: 10, width: 720, height: 1280, orientation: { tiltDeg: 75, rollDeg: 0 } },
      { id: "front-2", view: "front", index: 1, timestampMs: 110, width: 720, height: 1280, orientation: { tiltDeg: 75, rollDeg: 0 } },
    ],
    retakeViews: [{ view: "front", reason: "blurry" }],
    trace: {
      frames: [
        {
          view: "front", index: 0, width: 720, height: 1280, tiltDeg: 75, rollDeg: 0, pose: true, mask: true, maskCoverage: 0.1,
          used: true, distanceCm: 250, scaleAgreementPct: 0.4, quality: { sharpness: 0.1, inFrame: true, score: 0.1, reason: "blurry" },
        },
        { view: "front", index: 1, width: 720, height: 1280, tiltDeg: 75, rollDeg: 0, pose: false, mask: false, used: false, skipped: "no pose found" },
      ],
      views: [{ view: "front", frames: 2, usable: 1, reasons: { blurry: 1, "no-person": 1 }, decision: "blurry" }],
      focalSpecPx: 1000,
      focalOverride: false,
      measurementCount: 0,
      thresholds: { scaleAgreementLimitPct: 2, focalOverrideFrac: 0.05, minVisibility: 0.3 },
    },
    log: [{ t: 1200, msg: "capture front: hint step-back" }],
    ...overrides,
  };
}

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  await h.signIn("good");
});
afterEach(async () => {
  await h.close();
});

function putFrame(id: string, frameId: string, body: Buffer = JPEG, type = "image/jpeg") {
  return h.request(`/api/diagnostics/${id}/frames/${frameId}`, {
    method: "PUT",
    headers: { cookie: h.cookie, "x-requested-with": "fashion-assistant", "content-type": type, "content-length": body.length },
    body,
  });
}

const get = (path: string) => h.request(path, { headers: { cookie: h.cookie } });

describe("/api/diagnostics", () => {
  it("stores a report, attempts and frames; lists, reads, renders text, zips, deletes", async () => {
    expect((await h.api("PUT", "/api/diagnostics/r1", report())).status).toBe(200);
    expect((await h.api("PUT", "/api/diagnostics/r1/attempts/1", attempt(1))).status).toBe(200);
    expect((await h.api("PUT", "/api/diagnostics/r1/attempts/2", attempt(2, { outcome: "results" }))).status).toBe(200);
    expect((await putFrame("r1", "front-1")).status).toBe(200);

    const list = (await h.api("GET", "/api/diagnostics")).json() as DiagReport[];
    expect(list.map((r) => r.id)).toEqual(["r1"]);

    const full = (await h.api("GET", "/api/diagnostics/r1")).json() as { report: DiagReport; attempts: DiagAttempt[] };
    expect(full.report.summary).toBe("retake: front blurry");
    expect(full.attempts.map((a) => a.n)).toEqual([1, 2]);

    const frame = await get("/api/diagnostics/r1/frames/front-1");
    expect(frame.status).toBe(200);
    expect(frame.headers["content-type"]).toBe("image/jpeg");
    expect(frame.body.equals(JPEG)).toBe(true);

    const txt = await get("/api/diagnostics/r1/report.txt");
    expect(txt.status).toBe(200);
    expect(txt.text).toContain("TROUBLESHOOTING REPORT");
    expect(txt.text).toContain("Retake front: blurry");
    expect(txt.text).toContain("SKIPPED: no pose found");
    expect(txt.text).toContain("capture front: hint step-back");

    const zipRes = await get("/api/diagnostics/r1/bundle.zip?attempt=1");
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers["content-disposition"]).toContain("fa-report-r1-attempt1.zip");
    const files = unzipSync(new Uint8Array(zipRes.body));
    expect(Object.keys(files).sort()).toEqual(
      ["attempt-1.json", "attempt-2.json", "frames/front/0.jpg", "manifest.json", "report.json", "report.txt"].sort(),
    );
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.version).toBe(1);
    expect(manifest.views[0].frames).toHaveLength(1);
    expect(manifest.missingFrames).toEqual(["front-2"]);

    expect((await h.api("DELETE", "/api/diagnostics/r1")).status).toBe(200);
    expect((await h.api("GET", "/api/diagnostics/r1")).status).toBe(404);
    expect((await get("/api/diagnostics/r1/frames/front-1")).status).toBe(404);
  });

  it("requires sign-in and the X-Requested-With header", async () => {
    expect((await h.api("PUT", "/api/diagnostics/r1", report(), { "X-Requested-With": "XMLHttpRequest" })).status).toBe(403);
    h.cookie = "";
    expect((await h.api("GET", "/api/diagnostics")).status).toBe(401);
  });

  it("rejects bad frames, bad ids and mismatched attempt numbers", async () => {
    expect((await putFrame("r1", "f1", Buffer.from("not a jpeg"))).status).toBe(400);
    expect((await putFrame("r1", "f1", JPEG, "image/png")).status).toBe(415);
    // The server may close the socket before the client finishes sending.
    const big = await putFrame("r1", "f1", Buffer.concat([JPEG, Buffer.alloc(1_000_001)])).catch(() => null);
    if (big) expect(big.status).toBe(413);
    expect((await h.store.getDiagFrame("uid-1", "r1", "f1"))).toBeNull();
    expect((await h.api("PUT", "/api/diagnostics/bad.id", report())).status).toBe(400);
    expect((await h.api("PUT", "/api/diagnostics/r1/attempts/2", attempt(1))).status).toBe(400);
    expect((await h.api("PUT", "/api/diagnostics/r1/attempts/0", attempt(0))).status).toBe(400);
  });

  it("delete all my data removes troubleshooting reports too", async () => {
    await h.api("PUT", "/api/diagnostics/r1", report());
    expect((await h.api("DELETE", "/api/me/data")).status).toBe(200);
    await h.signIn("good");
    expect((await h.api("GET", "/api/diagnostics")).json()).toEqual([]);
  });
});

describe("diagnostics helpers", () => {
  it("validates reports and attempts", () => {
    expect(validateDiagReport(report(), 5).ok).toBe(true);
    const r = validateDiagReport({ ...report(), id: "x" }, 5);
    expect(r.ok && r.value.updatedAt === 5 && !("id" in r.value)).toBe(true);
    expect(validateDiagReport({ ...report(), outcome: "nope" }, 5).ok).toBe(false);
    expect(validateDiagReport({ ...report(), summary: "data:image/png;base64,AA" }, 5).ok).toBe(false);
    expect(validateDiagAttempt(attempt(3), 3).ok).toBe(true);
    expect(validateDiagAttempt({ ...attempt(3), outcome: "in-progress" }, 3).ok).toBe(false);
    expect(validateDiagAttempt({ ...attempt(3), frames: [{ id: "../x", view: "front" }] }, 3).ok).toBe(false);
  });

  it("parses attempt numbers and sniffs JPEGs", () => {
    expect(parseAttemptNumber("1")).toBe(1);
    expect(parseAttemptNumber("999")).toBe(999);
    for (const bad of [undefined, "", "0", "01", "1000", "x"]) expect(parseAttemptNumber(bad)).toBeNull();
    expect(isJpeg(JPEG)).toBe(true);
    expect(isJpeg(Buffer.from("GIF89a"))).toBe(false);
  });

  it("report text survives a missing trace or no attempts", () => {
    expect(diagReportText(report({ id: "r9" }), [])).toContain("(no processing runs recorded)");
    expect(diagReportText(report(), [attempt(1, { trace: undefined, error: "boom" })])).toContain("Error: boom");
  });
});

describe("report times", () => {
  it("shows the scan time in the phone's time zone, with the app version first", () => {
    const text = diagReportText(report({ id: "r1", appVersion: "0.4.0 (build x)", timeZone: "America/New_York", createdAt: Date.UTC(2026, 9, 12, 11, 56, 50) }), []);
    const lines = text.split("\n");
    expect(lines[1]).toBe("App version: 0.4.0 (build x)");
    expect(lines[2]).toBe("Scan time: 2026-10-12 07:56:50 America/New_York (2026-10-12T11:56:50.000Z)");
    expect(localTime(Date.UTC(2026, 0, 1), "Not/AZone")).toContain("UTC");
    expect(localTime(Date.UTC(2026, 0, 1, 5))).toBe("2026-01-01 05:00:00 UTC");
  });
});
