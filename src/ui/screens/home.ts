// S2 Home: last scan summary, History, Sign out, New scan.
import { signOutUser } from "../../auth/authGuard";
import { listScans } from "../../data/scans";
import { errorMessage, type AppContext } from "../context";
import { button, h, linkButton, screen, setChildren } from "../dom";
import { formatDate, homeSummary } from "../format";

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const { root: el, body, actions } = screen("screen-home");
  const last = h("div", { class: "card last-scan" }, h("p", { class: "muted" }, "Loading..."));
  body.append(
    h("h1", null, "Fashion Assistant"),
    last,
    h("div", { class: "row-links" },
      linkButton("History >", () => ctx.dispatch({ type: "OPEN_HISTORY" })),
      linkButton("Sign out", () => {
        signOutUser()
          .then(() => {
            ctx.user = null;
            ctx.userDoc = null;
            ctx.authError = null;
            ctx.dispatch({ type: "AUTH_SIGNED_OUT" });
          })
          .catch((e: unknown) => alert(`Could not sign out: ${errorMessage(e)}`));
      }),
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
          setChildren(last, h("p", null, "No scans yet. Tap New scan to measure yourself."));
          return;
        }
        setChildren(
          last,
          h("p", { class: "muted" }, `Last scan: ${formatDate(s.createdAt)}`),
          h("p", { class: "summary" }, homeSummary(s, ctx.units).join("   ")),
          s.id ? linkButton("View all >", () => ctx.dispatch({ type: "OPEN_SCAN", scanId: s.id! })) : null,
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
