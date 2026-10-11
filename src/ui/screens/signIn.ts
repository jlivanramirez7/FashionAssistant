// S1 Sign in (section 10, docs/CONTRACTS-v2.md): the official Google
// Identity Services button (redirect mode) - no button of our own. Other
// accounts come back with ?auth_error=private -> "This app is private."
import { renderSignInButton } from "../../auth/authGuard";
import { errorMessage, type AppContext } from "../context";
import { h, screen } from "../dom";

export function render(root: HTMLElement, ctx: AppContext): () => void {
  let alive = true;
  const { root: el, body, actions } = screen("screen-signin");
  const error = (ctx.state.name === "signin" ? ctx.state.error : undefined) ?? ctx.authError ?? undefined;
  const msg = h("p", { class: "error", role: "alert" }, error ?? "");
  msg.hidden = !error;
  body.append(
    h("div", { class: "hero" },
      h("img", { class: "brand-mark", src: "/icons/icon-192.png", alt: "", width: 88, height: 88 }),
      h("h1", null, "Fashion Assistant"),
      h("p", { class: "lead" }, "Measure yourself for clothes with just your phone."),
      h("ul", { class: "hero-points" },
        h("li", null, "Three quick poses, hands-free"),
        h("li", null, "20+ tailoring measurements"),
        h("li", null, "Photos never leave your phone"),
      ),
    ),
    msg,
  );
  const container = h("div", { class: "gis-button" });
  const loading = h("p", { class: "muted center" }, "Loading sign-in...");
  actions.append(container, loading);
  root.appendChild(el);

  renderSignInButton(container)
    .then(() => {
      if (alive) loading.remove();
    })
    .catch((e: unknown) => {
      if (!alive) return;
      loading.remove();
      msg.textContent = `Could not load Google sign-in: ${errorMessage(e)}. Check your connection and reload.`;
      msg.hidden = false;
    });

  return () => {
    alive = false;
  };
}
