// [in|cm] segmented toggle (section 6; saved per user by the caller).
import type { Units } from "../../types";

export function createUnitToggle(initial: Units, onChange: (u: Units) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "unit-toggle";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Units");
  let current = initial;
  const buttons = (["in", "cm"] as const).map((u) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = u;
    b.addEventListener("click", () => {
      if (u === current) return;
      current = u;
      sync();
      onChange(u);
    });
    wrap.appendChild(b);
    return { u, b };
  });
  function sync(): void {
    for (const { u, b } of buttons) {
      b.classList.toggle("active", u === current);
      b.setAttribute("aria-pressed", String(u === current));
    }
  }
  sync();
  return wrap;
}
