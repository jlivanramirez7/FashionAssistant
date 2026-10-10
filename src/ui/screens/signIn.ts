// S1 Sign in (section 10). Any other account sees "This app is private."
import { signIn } from "../../auth/authGuard";
import { errorMessage, type AppContext } from "../context";
import { button, h, screen } from "../dom";

export function render(root: HTMLElement, ctx: AppContext): () => void {
  const { root: el, body, actions } = screen("screen-signin");
  const error = (ctx.state.name === "signin" ? ctx.state.error : undefined) ?? ctx.authError ?? undefined;
  const msg = h("p", { class: "error", role: "alert" }, error ?? "");
  msg.hidden = !error;
  body.append(
    h("div", { class: "hero" },
      h("h1", null, "Fashion Assistant"),
      h("p", { class: "lead" }, "Measure yourself for clothes with your phone"),
    ),
    msg,
  );
  const btn = button("Sign in with Google", () => {
    btn.disabled = true;
    msg.hidden = true;
    signIn()
      .catch((e: unknown) => {
        ctx.authError = errorMessage(e);
        msg.textContent = ctx.authError;
        msg.hidden = false;
      })
      .finally(() => {
        btn.disabled = false;
      });
  }, "btn primary");
  actions.append(btn);
  root.appendChild(el);
  return () => undefined;
}
