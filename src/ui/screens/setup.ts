// S3 Setup: height (required), tip, body type, checklist, then ONE Start
// tap that grants camera + motion, unlocks voice and builds the device
// profile (section 5 steps 1-2).
import { getDeviceRecord } from "../../data/devices";
import { getDeviceId } from "../../data/deviceId";
import { getCorrectionFactors } from "../../data/settings";
import { diagLog, resetDiagLog } from "../../diagnostics/log";
import { createRecorder } from "../../diagnostics/recorder";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "../../diagnostics/settings";
import { saveUserDoc } from "../../data/user";
import type { BodyType, Units } from "../../types";
import { cmToFeetInches, parseHeight } from "../../units";
import { errorMessage, type AppContext } from "../context";
import { loadDebug } from "../debug";
import { button, h, screen, setChildren, topBar } from "../dom";
import { startFromTap } from "../hardware";
import { createUnitToggle } from "../parts/unitToggle";

const BODY_TYPES: { value: BodyType; label: string }[] = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "unspecified", label: "Unspecified" },
];

const CHECKLIST = ["Fitted clothes", "Hair up, shoes off", "Plain wall, good light", "~3 m (10 ft) of clear floor"];

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const s = ctx.session;
  const uid = ctx.user?.uid;

  // Prefetch so the Start tap has everything at hand.
  if (uid) {
    getDeviceRecord(uid, getDeviceId())
      .then((r) => {
        if (alive && !s.savedDevice) s.savedDevice = r;
      })
      .catch(() => undefined);
    getCorrectionFactors(uid)
      .then((f) => {
        s.factors = f;
      })
      .catch(() => undefined);
  }

  const { root: el, body, actions } = screen("screen-setup");
  let units: Units = ctx.units;
  const savedHeight = ctx.userDoc?.heightCm ?? s.inputs?.heightCm;

  // --- height fields
  const ft = h("input", { type: "number", inputmode: "numeric", min: 3, max: 8, step: 1, "aria-label": "Feet", class: "num" });
  const inch = h("input", { type: "number", inputmode: "decimal", min: 0, max: 11.75, step: 0.25, "aria-label": "Inches", class: "num" });
  const cm = h("input", { type: "number", inputmode: "decimal", min: 100, max: 250, step: 0.5, "aria-label": "Centimetres", class: "num wide" });
  const heightFields = h("div", { class: "height-fields" });

  function currentCm(): number | null {
    return units === "cm" ? parseHeight("cm", cm.value) : parseHeight("in", ft.value, inch.value);
  }
  function fill(heightCm: number | null | undefined): void {
    if (heightCm && Number.isFinite(heightCm)) {
      const fi = cmToFeetInches(heightCm);
      ft.value = String(fi.feet);
      inch.value = String(fi.inches);
      cm.value = String(Math.round(heightCm * 10) / 10);
    }
  }
  function layoutHeight(): void {
    if (units === "cm") setChildren(heightFields, cm, h("span", { class: "unit" }, "cm"));
    else setChildren(heightFields, ft, h("span", { class: "unit" }, "ft"), inch, h("span", { class: "unit" }, "in"));
  }
  fill(savedHeight);
  layoutHeight();

  const toggle = createUnitToggle(units, (u) => {
    const prev = currentCm();
    units = u;
    ctx.setUnits(u);
    fill(prev);
    layoutHeight();
  });

  // --- body type
  const currentBody: BodyType = s.inputs?.bodyType ?? ctx.userDoc?.bodyType ?? "unspecified";
  const radios = BODY_TYPES.map((b) => {
    const input = h("input", { type: "radio", name: "bodyType", value: b.value });
    input.checked = b.value === currentBody;
    return { b, input, label: h("label", { class: "seg-option" }, input, h("span", null, b.label)) };
  });

  // --- checklist (reminders; they do not block Start)
  const checklist = CHECKLIST.map((text) => {
    const c = h("input", { type: "checkbox" });
    return h("label", { class: "check" }, c, h("span", null, text));
  });

  // --- troubleshooting data (opt-in, remembered on this phone)
  const diagBox = h("input", { type: "checkbox" });
  diagBox.checked = diagnosticsEnabled();
  diagBox.addEventListener("change", () => setDiagnosticsEnabled(diagBox.checked));
  const diagCard = h("section", { class: "card" },
    h("label", { class: "check" }, diagBox, h("span", null, "Save troubleshooting data")),
    h("p", { class: "hint-text" },
      "Uploads this scan’s photos, the pipeline’s per-frame results and the on-screen feedback to your account so a failed scan can be diagnosed. View, copy or delete reports from Home > Troubleshooting.",
    ),
  );

  // --- dev-only debug capture toggle
  let debugBox: HTMLInputElement | null = null;
  const debugSlot = h("div");
  void loadDebug().then((m) => {
    if (!m || !alive) return;
    debugBox = h("input", { type: "checkbox" });
    debugBox.checked = s.debugCapture;
    debugSlot.appendChild(h("label", { class: "check debug" }, debugBox, "Debug capture (saves a local .zip, dev only)"));
  });

  const error = h("p", { class: "error", role: "alert" });
  error.hidden = true;

  body.append(
    topBar("New scan", () => ctx.dispatch({ type: "BACK" }), toggle),
    h("section", { class: "card" },
      h("label", { class: "field-label" }, "Your height"),
      heightFields,
      h("p", { class: "hint-text" }, "Measure against a wall once rather than guessing - every other measurement is scaled from it."),
    ),
    h("section", { class: "card" },
      h("fieldset", { class: "field" },
        h("legend", { class: "field-label" }, "Body type ", h("span", { class: "optional" }, "optional")),
        h("div", { class: "segmented" }, radios.map((r) => r.label)),
      ),
    ),
    h("section", { class: "card" },
      h("p", { class: "field-label" }, "Before you start"),
      h("div", { class: "checklist" }, checklist),
    ),
    diagCard,
    debugSlot,
    error,
  );

  const start = button("Start scan", onStart, "btn primary");
  actions.append(start);
  root.appendChild(el);

  function onStart(): void {
    const heightCm = currentCm();
    if (heightCm === null) {
      error.textContent =
        units === "cm" ? "Enter your height in cm (100-250)." : "Enter your height in feet and inches (e.g. 5 ft 10 in).";
      error.hidden = false;
      return;
    }
    const bodyType = radios.find((r) => r.input.checked)?.b.value ?? "unspecified";
    s.inputs = { heightCm, bodyType, subjectLabel: s.inputs?.subjectLabel ?? "me" };
    s.debugCapture = (debugBox as HTMLInputElement | null)?.checked ?? false;
    s.diag = diagBox.checked ? createRecorder() : null;
    resetDiagLog();
    diagLog(`scan started ${new Date().toLocaleString()}: height ${heightCm.toFixed(1)}cm, body type ${bodyType}, units ${units}`);
    error.hidden = true;
    start.disabled = true;
    start.textContent = "Starting...";

    // Everything permission-related happens synchronously inside this tap.
    const started = startFromTap(ctx);

    if (uid) {
      if (ctx.userDoc) Object.assign(ctx.userDoc, { heightCm, bodyType });
      void saveUserDoc(uid, { heightCm, bodyType }).catch(() => undefined);
    }
    started
      .then(() => {
        if (alive) ctx.dispatch({ type: "START" });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        error.textContent = `Could not start the camera: ${errorMessage(e)}. Allow camera access and try again.`;
        error.hidden = false;
        start.disabled = false;
        start.textContent = "Start scan";
      });
  }

  return () => {
    alive = false;
  };
}
