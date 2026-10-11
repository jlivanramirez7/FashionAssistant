// S2 Home: last scan summary, History, Sign out, New scan.
import { signOutUser } from "../../auth/authGuard";
import { listScans } from "../../data/scans";
import type { MeasurementKey } from "../../types";
import { formatLength } from "../../units";
import { errorMessage, type AppContext } from "../context";
import { button, h, listRow, screen, setChildren } from "../dom";
import { formatDate, measurementLabel, visibleMeasurements } from "../format";

const SUMMARY_KEYS: MeasurementKey[] = ["chest", "naturalWaist", "inseam"];

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const { root: el, body, actions } = screen("screen-home");
  const last = h("div", { class: "card last-scan" }, h("p", { class: "muted" }, "Loading your last scan..."));
  body.append(
    h("header", { class: "home-head" },
      h("img", { class: "brand-mark small", src: "/icons/icon-192.png", alt: "", width: 40, height: 40 }),
      h("div", null,
        h("p", { class: "eyebrow" }, "Fashion Assistant"),
        h("h1", null, "Welcome back"),
      ),
    ),
    last,
    h("div", { class: "card list" },
      listRow("History", () => ctx.dispatch({ type: "OPEN_HISTORY" }), "Past scans"),
      listRow("Sign out", () => {
        signOutUser()
          .then(() => {
            ctx.user = null;
            ctx.userDoc = null;
            ctx.authError = null;
            ctx.dispatch({ type: "AUTH_SIGNED_OUT" });
          })
          .catch((e: unknown) => alert(`Could not sign out: ${errorMessage(e)}`));
      }, undefined, "subtle"),
    ),
  );
  actions.append(button("New scan", () => ctx.dispatch({ type: "NEW_SCAN" }), "btn primary"));
  root.appendChild(el);

  const uid = ctx.user?.uid;
  if (uid) {
    listScans(uid)
      .then((scans) => {
        if (!alive) return;
        for (const s of scans) if (s.id) ctx.scanCache.set(s.id, s);
        const s = scans[0];
        if (!s) {
          setChildren(last,
            h("p", { class: "card-title" }, "No scans yet"),
            h("p", { class: "muted" }, "Tap New scan below. It takes about two minutes: prop up your phone, step back, and strike three poses."),
          );
          return;
        }
        const m = visibleMeasurements(s.measurements);
        const tiles = SUMMARY_KEYS.filter((k) => m[k]).map((k) =>
          h("div", { class: "stat" },
            h("span", { class: "stat-value" }, formatLength(m[k]!.valueCm, ctx.units)),
            h("span", { class: "stat-label" }, measurementLabel(k, s.bodyType)),
          ),
        );
        setChildren(
          last,
          h("div", { class: "card-head" },
            h("p", { class: "card-title" }, "Last scan"),
            h("span", { class: "muted small" }, formatDate(s.createdAt)),
          ),
          tiles.length ? h("div", { class: "stats" }, tiles) : null,
          s.id ? button("View all measurements", () => ctx.dispatch({ type: "OPEN_SCAN", scanId: s.id! }), "btn secondary") : null,
        );
      })
      .catch((e: unknown) => {
        if (alive) setChildren(last, h("p", { class: "error" }, `Could not load scans: ${errorMessage(e)}`));
      });
  }
  return () => {
    alive = false;
  };
}
