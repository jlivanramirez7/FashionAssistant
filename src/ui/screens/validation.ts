// S9 Validation (Results > "Add tape measurements"): subject label + one
// optional tape field per measurement, typed in in or cm, stored in cm.
import { getScan, updateScan } from "../../data/scans";
import type { MeasurementKey, ScanDoc, Units } from "../../types";
import { formatLength, lengthInputValue } from "../../units";
import { errorMessage, type AppContext } from "../context";
import { button, h, screen, setChildren, topBar } from "../dom";
import { buildTapeMeasurements, measurementLabel, TAPE_KEYS, tapeForField, visibleMeasurements } from "../format";
import { createUnitToggle } from "../parts/unitToggle";

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const state = ctx.state;
  if (state.name !== "validation") return () => undefined;
  const scanId = state.scanId;
  const uid = ctx.user?.uid;
  let alive = true;
  let units: Units = ctx.units;
  let scan: ScanDoc | null = ctx.scanCache.get(scanId) ?? null;

  const { root: el, body, actions } = screen("screen-validation");
  const subject = h("input", { type: "text", class: "text", "aria-label": "Subject", maxlength: 40 });
  const table = h("div", { class: "tape-table" }, h("p", { class: "muted" }, "Loading..."));
  const status = h("p", { class: "error", role: "alert" });
  status.hidden = true;
  const inputs = new Map<MeasurementKey, HTMLInputElement>();

  const toggle = createUnitToggle(units, (u) => {
    // Keep what was typed: convert the visible values to the new unit.
    const current = buildTapeMeasurements(readFields(), units);
    units = u;
    ctx.setUnits(u);
    if (scan) draw(scan, current);
  });

  body.append(
    topBar("Tape values", () => ctx.dispatch({ type: "BACK" }), toggle),
    h("section", { class: "card" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Subject"), subject),
      h("p", { class: "hint-text" }, 'All fields are optional. Use "me" for yourself, or e.g. "Person 3" for a test person.'),
    ),
    h("section", { class: "card" }, table),
    status,
  );
  const save = button("Save", onSave, "btn primary");
  actions.append(save);
  root.appendChild(el);

  function readFields(): Partial<Record<MeasurementKey, string>> {
    const out: Partial<Record<MeasurementKey, string>> = {};
    for (const [k, input] of inputs) out[k] = input.value;
    return out;
  }

  function draw(sc: ScanDoc, tape: Partial<Record<MeasurementKey, number>> | undefined): void {
    inputs.clear();
    const shown = visibleMeasurements(sc.measurements);
    const rows = TAPE_KEYS.map((k) => {
      const v = shown[k];
      const input = h("input", {
        type: "number",
        inputmode: "decimal",
        step: units === "in" ? 0.25 : 0.1,
        min: 0,
        class: "num",
        "aria-label": `${measurementLabel(k, sc.bodyType)} tape (${units})`,
      });
      const t = tapeForField(tape, k);
      if (t !== undefined) input.value = lengthInputValue(t, units);
      inputs.set(k, input);
      return h("div", { class: "tape-row" },
        h("span", { class: "m-label" }, measurementLabel(k, sc.bodyType)),
        h("span", { class: "m-value" }, v ? formatLength(v.valueCm, units) : "-"),
        input,
      );
    });
    setChildren(
      table,
      h("div", { class: "tape-row head" }, h("span"), h("span", null, "scan"), h("span", null, `tape (${units})`)),
      rows,
    );
  }

  function show(sc: ScanDoc): void {
    scan = sc;
    subject.value = sc.subjectLabel || "me";
    draw(sc, sc.tapeMeasurements);
  }

  function onSave(): void {
    if (!uid || !scan) return;
    const tapeMeasurements = buildTapeMeasurements(readFields(), units);
    const subjectLabel = subject.value.trim() || "me";
    save.disabled = true;
    save.textContent = "Saving...";
    updateScan(uid, scanId, { tapeMeasurements, subjectLabel })
      .then(() => {
        ctx.scanCache.set(scanId, { ...scan!, tapeMeasurements, subjectLabel });
        if (alive) ctx.dispatch({ type: "VALIDATION_SAVED" });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        save.disabled = false;
        save.textContent = "Save";
        status.textContent = `Could not save: ${errorMessage(e)}`;
        status.hidden = false;
      });
  }

  if (scan) show(scan);
  else if (uid) {
    getScan(uid, scanId)
      .then((sc) => {
        if (!alive) return;
        if (sc) show({ ...sc, id: sc.id ?? scanId });
        else setChildren(table, h("p", { class: "error" }, "This scan was not found."));
      })
      .catch((e: unknown) => {
        if (alive) setChildren(table, h("p", { class: "error" }, `Could not load the scan: ${errorMessage(e)}`));
      });
  }

  return () => {
    alive = false;
  };
}
