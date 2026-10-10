// Validation summary (from History): MAE and % within target per
// measurement over scans with tape values; recompute correction factors k.
import { listScans } from "../../data/scans";
import { saveCorrectionFactors } from "../../data/settings";
import { computeCorrectionFactors, tapeScanCount, validationStats } from "../../data/validation";
import type { BodyType, ScanDoc } from "../../types";
import { formatSmallLength } from "../../units";
import { errorMessage, type AppContext } from "../context";
import { button, h, linkButton, screen, setChildren } from "../dom";
import { isVisibleKey, measurementLabel } from "../format";
import { createUnitToggle } from "../parts/unitToggle";

/** PURE: how many k values were computed, per body type. */
export function factorCounts(f: { male: object; female: object; unspecified: object }): Record<BodyType, number> {
  return {
    male: Object.keys(f.male).length,
    female: Object.keys(f.female).length,
    unspecified: Object.keys(f.unspecified).length,
  };
}

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const uid = ctx.user?.uid;
  let scans: ScanDoc[] | null = null;
  const { root: el, body, actions } = screen("screen-summary");
  const countEl = h("p", { class: "muted" }, "Loading...");
  const table = h("div", { class: "summary-table" });
  const status = h("p", { class: "notice", role: "status" });
  status.hidden = true;
  const toggle = createUnitToggle(ctx.units, (u) => {
    ctx.setUnits(u);
    draw();
  });
  body.append(
    h("div", { class: "title-row" }, h("h1", null, "Validation summary"), toggle),
    countEl,
    table,
    status,
    linkButton("< Back", () => ctx.dispatch({ type: "BACK" })),
  );

  const recompute = button("Recompute correction k", () => {
    if (!uid || !scans) return;
    const f = computeCorrectionFactors(scans);
    f.updatedAt = Date.now();
    recompute.disabled = true;
    saveCorrectionFactors(uid, f)
      .then(() => {
        ctx.session.factors = f;
        const c = factorCounts(f);
        status.textContent = `Saved correction factors (male ${c.male}, female ${c.female}, unspecified ${c.unspecified} measurements; needs 3+ scans each). New scans use them.`;
      })
      .catch((e: unknown) => {
        status.textContent = `Could not save: ${errorMessage(e)}`;
      })
      .finally(() => {
        status.hidden = false;
        recompute.disabled = false;
      });
  }, "btn primary");
  recompute.disabled = true;
  actions.append(recompute);
  root.appendChild(el);

  function draw(): void {
    if (!scans) return;
    const n = tapeScanCount(scans);
    countEl.textContent = `${n} scan${n === 1 ? "" : "s"} with tape values`;
    const rows = validationStats(scans).filter((r) => r.n > 0 && isVisibleKey(r.key));
    recompute.disabled = n === 0;
    if (rows.length === 0) {
      setChildren(table, h("p", null, 'No tape measurements yet. Open a scan and tap "Add tape measurements".'));
      return;
    }
    setChildren(
      table,
      h("div", { class: "summary-row head" }, h("span"), h("span", null, "MAE"), h("span", null, "in target"), h("span", null, "n")),
      rows.map((r) =>
        h("div", { class: "summary-row" },
          h("span", { class: "m-label" }, measurementLabel(r.key, "unspecified")),
          h("span", null, formatSmallLength(r.maeCm, ctx.units)),
          h("span", null, `${Math.round(r.pctWithinTarget)}%`),
          h("span", { class: "muted" }, String(r.n)),
        ),
      ),
    );
  }

  if (uid) {
    listScans(uid)
      .then((s) => {
        if (!alive) return;
        scans = s;
        draw();
      })
      .catch((e: unknown) => {
        if (alive) countEl.textContent = `Could not load scans: ${errorMessage(e)}`;
      });
  }
  return () => {
    alive = false;
  };
}
