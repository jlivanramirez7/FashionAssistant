// Coloured border around the camera view: red = not ready,
// amber = hold still, green = capturing (section 6 design rules).
import type { BorderStatus } from "../format";

const CLASSES: Record<BorderStatus, string> = {
  red: "status-red",
  amber: "status-amber",
  green: "status-green",
};

export function setStatusBorder(el: HTMLElement, status: BorderStatus): void {
  for (const c of Object.values(CLASSES)) el.classList.toggle(c, c === CLASSES[status]);
  el.dataset.status = status;
}

/** Wraps `content` in a full-screen frame with a status border. */
export function createStatusBorder(initial: BorderStatus = "red"): { el: HTMLElement; set(status: BorderStatus): void } {
  const el = document.createElement("div");
  el.className = "status-border";
  setStatusBorder(el, initial);
  return { el, set: (s) => setStatusBorder(el, s) };
}
