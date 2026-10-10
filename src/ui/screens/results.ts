// S7 Results: grouped measurements with +/- and confidence dots, unit
// toggle, Copy all, Retake amber/red, Add tape measurements, Done.
// No size recommendation in v1. (The scan is saved by Processing before
// this screen opens.)
import { getScan } from "../../data/scans";
import type { ScanDoc } from "../../types";
import { closeFrames, errorMessage, type AppContext } from "../context";
import { button, h, screen, setChildren } from "../dom";
import { copyAllText, formatDate, groupMeasurements, retakeViewsFor } from "../format";
import { startFromTap } from "../hardware";
import { createMeasurementRow } from "../parts/measurementRow";
import { createUnitToggle } from "../parts/unitToggle";

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const state = ctx.state;
  if (state.name !== "results") return () => undefined;
  let alive = true;
  const { root: el, body, actions } = screen("screen-results");
  const dateEl = h("p", { class: "muted" });
  const list = h("div", { class: "measurements" }, h("p", { class: "muted" }, "Loading..."));
  const notice = h("p", { class: "notice" });
  notice.hidden = true;
  const toggle = createUnitToggle(ctx.units, (u) => {
    ctx.setUnits(u);
    if (scan) draw(scan);
  });
  body.append(h("div", { class: "title-row" }, h("h1", null, "Your measurements"), toggle), dateEl, notice, list);
  root.appendChild(el);

  let scan: ScanDoc | null = null;

  function draw(sc: ScanDoc): void {
    dateEl.textContent = `${formatDate(sc.createdAt)}${sc.subjectLabel && sc.subjectLabel !== "me" ? ` - ${sc.subjectLabel}` : ""}`;
    const groups = groupMeasurements(sc.measurements);
    if (groups.length === 0) {
      setChildren(list, h("p", null, "No measurements were found in this scan."));
    } else {
      setChildren(
        list,
        groups.map((g) =>
          h("div", { class: "group" },
            h("h2", null, g.title),
            g.keys.map((k) => createMeasurementRow({ key: k, value: sc.measurements[k]!, bodyType: sc.bodyType, units: ctx.units })),
          ),
        ),
        h("p", { class: "legend" },
          h("span", { class: "dot dot-green" }), " good  ",
          h("span", { class: "dot dot-amber" }), " fair  ",
          h("span", { class: "dot dot-red" }), " low confidence. Tap a row to see where it is measured.",
        ),
      );
    }

    const s = ctx.session;
    const canRetake =
      state.name === "results" && state.from === "scan" && s.scanId === sc.id && !!s.inputs && !!s.profile;
    const retakeViews = canRetake ? retakeViewsFor(sc.measurements) : [];
    if (sc.status === "partial") {
      notice.textContent = "Some steps could not be captured well, so some values may be off.";
      notice.hidden = false;
    }

    const copyBtn = button("Copy all", () => {
      copyText(copyAllText(sc, ctx.units))
        .then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => (copyBtn.textContent = "Copy all"), 1500);
        })
        .catch((e: unknown) => alert(`Could not copy: ${errorMessage(e)}`));
    }, "btn secondary");
    const retakeBtn =
      retakeViews.length > 0
        ? button("Retake amber/red", () => {
            retakeBtn!.disabled = true;
            // Camera, motion and voice are re-armed inside this tap.
            startFromTap(ctx)
              .then(() => {
                closeFrames(s, retakeViews);
                ctx.dispatch({ type: "RETAKE_LOW_CONFIDENCE", views: retakeViews });
              })
              .catch((e: unknown) => {
                retakeBtn!.disabled = false;
                alert(`Could not start the camera: ${errorMessage(e)}`);
              });
          }, "btn secondary")
        : null;
    setChildren(
      actions,
      h("div", { class: "btn-row" }, copyBtn, retakeBtn),
      button("Add tape measurements", () => ctx.dispatch({ type: "ADD_TAPE" }), "btn secondary"),
      button("Done", () => ctx.dispatch({ type: "DONE" }), "btn primary"),
    );
  }

  const cached = ctx.scanCache.get(state.scanId);
  if (cached) {
    scan = cached;
    draw(cached);
  } else if (ctx.user) {
    getScan(ctx.user.uid, state.scanId)
      .then((sc) => {
        if (!alive) return;
        if (!sc) {
          setChildren(list, h("p", { class: "error" }, "This scan was not found."));
          setChildren(actions, button("Back", () => ctx.dispatch({ type: "BACK" }), "btn primary"));
          return;
        }
        const withId = { ...sc, id: sc.id ?? state.scanId };
        ctx.scanCache.set(state.scanId, withId);
        scan = withId;
        draw(withId);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setChildren(list, h("p", { class: "error" }, `Could not load the scan: ${errorMessage(e)}`));
        setChildren(actions, button("Back", () => ctx.dispatch({ type: "BACK" }), "btn primary"));
      });
  }

  return () => {
    alive = false;
  };
}
