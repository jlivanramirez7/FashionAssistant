// One Results row: label, value, +/- uncertainty, confidence dot.
// Tapping it toggles the body diagram + tape tip.
import type { BodyType, MeasurementKey, MeasurementValue, Units } from "../../types";
import { formatLength, formatPlusMinus } from "../../units";
import { confidenceColor, measurementLabel } from "../format";
import { createBodyDiagram } from "./bodyDiagram";

export function createMeasurementRow(args: {
  key: MeasurementKey;
  value: MeasurementValue;
  bodyType: BodyType;
  units: Units;
}): HTMLElement {
  const { key, value, bodyType, units } = args;
  const color = confidenceColor(value.confidence);
  const row = document.createElement("div");
  row.className = "measurement-row";
  row.dataset.key = key;

  const main = document.createElement("button");
  main.type = "button";
  main.className = "measurement-main";
  main.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "m-label";
  label.textContent = measurementLabel(key, bodyType);
  const val = document.createElement("span");
  val.className = "m-value";
  val.textContent = formatLength(value.valueCm, units);
  const unc = document.createElement("span");
  unc.className = "m-unc";
  unc.textContent = key === "height" ? "" : formatPlusMinus(value.uncertaintyCm, units);
  const dot = document.createElement("span");
  dot.className = `dot dot-${color}`;
  dot.title = `Confidence: ${color}`;
  dot.setAttribute("aria-label", `confidence ${color}`);
  main.append(label, val, unc, dot);
  row.appendChild(main);

  let detail: HTMLElement | null = null;
  main.addEventListener("click", () => {
    if (detail) {
      detail.remove();
      detail = null;
      main.setAttribute("aria-expanded", "false");
    } else {
      detail = createBodyDiagram(key);
      row.appendChild(detail);
      main.setAttribute("aria-expanded", "true");
    }
  });
  return row;
}
