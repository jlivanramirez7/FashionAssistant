// Entry (design doc sections 8 and 10, docs/CONTRACTS-v2.md): check the
// sign-in config, read a redirect sign-in error, flush queued offline scans,
// ask the server for the session user, then drive the screens from the pure
// state machine in src/flow/stateMachine.ts.
import "./ui/styles.css";
import { isAuthConfigured } from "./config";
import { CAPTURE_STATES, INITIAL_STATE, transition, type Event, type State, type StateName } from "./flow/stateMachine";
import type { Units, UserDoc } from "./types";
import { closeFrames, createVideoElement, errorMessage, newSession, type AppContext } from "./ui/context";
import { h } from "./ui/dom";

export const SIGN_IN_FAILED_MESSAGE = "Sign-in did not work. Please try again.";

type Screen = { render(root: HTMLElement, ctx: AppContext): () => void };

/** Screens are loaded lazily (smaller first load; nothing loads when not configured). */
const SCREENS: Record<Exclude<StateName, "boot">, () => Promise<Screen>> = {
  signin: () => import("./ui/screens/signIn"),
  home: () => import("./ui/screens/home"),
  setup: () => import("./ui/screens/setup"),
  place: () => import("./ui/screens/placePhone"),
  capture: () => import("./ui/screens/capture"),
  processing: () => import("./ui/screens/processing"),
  results: () => import("./ui/screens/results"),
  history: () => import("./ui/screens/history"),
  validation: () => import("./ui/screens/validation"),
  validationSummary: () => import("./ui/screens/validationSummary"),
  diagnostics: () => import("./ui/screens/diagnostics"),
};

function renderNotConfigured(root: HTMLElement): void {
  root.replaceChildren(
    h("section", { class: "screen screen-message" },
      h("div", { class: "screen-body" },
        h("h1", null, "Fashion Assistant"),
        h("p", { class: "error" },
          "Sign-in is not configured yet - set VITE_GOOGLE_CLIENT_ID (Google Cloud console > APIs & Services > Credentials > OAuth client ID).",
        ),
        h("p", { class: "muted" }, "Put it in .env.development / .env.production (or .env.local), then restart the dev server or rebuild."),
      ),
    ),
  );
}

function renderBoot(root: HTMLElement, text = "Loading..."): void {
  root.replaceChildren(h("section", { class: "screen screen-message" }, h("div", { class: "screen-body" }, h("p", { class: "muted" }, text))));
}

async function boot(root: HTMLElement): Promise<void> {
  renderBoot(root);
  const [{ getCurrentUser, readAuthError, PRIVATE_MESSAGE }, { getUserDoc, saveUserDoc }, { flushOutbox }, hardware] =
    await Promise.all([import("./auth/authGuard"), import("./data/user"), import("./data/scans"), import("./ui/hardware")]);

  let state: State = INITIAL_STATE;
  let cleanup: () => void = () => undefined;
  let renderSeq = 0;
  const video = createVideoElement();

  const ctx: AppContext = {
    get state() {
      return state;
    },
    dispatch,
    user: null,
    authError: null,
    userDoc: null,
    units: "in",
    setUnits(u: Units) {
      ctx.units = u;
      if (ctx.userDoc) ctx.userDoc.units = u;
      if (ctx.user) void saveUserDoc(ctx.user.uid, { units: u }).catch((e: unknown) => console.warn("units not saved", e));
    },
    session: newSession(video),
    resetSession() {
      closeFrames(ctx.session);
      const factors = ctx.session.factors;
      ctx.session = newSession(video);
      ctx.session.factors = factors;
    },
    scanCache: new Map(),
  };

  function leaveCaptureFlow(): void {
    hardware.stopHardware(ctx);
    if (ctx.session.visionLive) {
      ctx.session.visionLive = null;
      void import("./vision").then((v) => v.closeVision()).catch(() => undefined);
    }
  }

  // App updates (service worker, registerType "prompt"): a new version is
  // applied (page reload) as soon as we are on a screen where nothing is lost.
  const UPDATE_SAFE: readonly StateName[] = ["boot", "signin", "home"];
  let applyUpdate: (() => void) | null = null;
  const maybeUpdate = (): void => {
    if (applyUpdate && UPDATE_SAFE.includes(state.name)) applyUpdate();
  };
  if (!import.meta.env.DEV && "serviceWorker" in navigator) {
    void import("virtual:pwa-register")
      .then(({ registerSW }) => {
        const updateSW = registerSW({
          immediate: true,
          onNeedRefresh() {
            applyUpdate = () => {
              applyUpdate = null;
              void updateSW(true);
            };
            maybeUpdate();
          },
          onRegisteredSW(_url, reg) {
            // Long-lived PWA sessions: look for a new version every 30 minutes.
            if (reg) setInterval(() => void reg.update().catch(() => undefined), 30 * 60_000);
          },
        });
      })
      .catch((e: unknown) => console.warn("service worker not registered", e));
  }

  function show(next: State): void {
    const prevName = state.name;
    state = next;
    maybeUpdate();
    cleanup();
    cleanup = () => undefined;
    const wasCapturing = CAPTURE_STATES.includes(prevName);
    const capturing = CAPTURE_STATES.includes(next.name);
    if (wasCapturing && !capturing) leaveCaptureFlow();
    // A new scan starts clean; leaving Results/Home drops kept frames.
    if (next.name === "setup" || next.name === "home") ctx.resetSession();
    if (next.name === "boot") {
      renderBoot(root);
      return;
    }
    const seq = ++renderSeq;
    SCREENS[next.name]()
      .then((mod) => {
        if (seq !== renderSeq) return;
        root.replaceChildren();
        window.scrollTo(0, 0);
        cleanup = mod.render(root, ctx);
      })
      .catch((e: unknown) => {
        if (seq === renderSeq) renderBoot(root, `Could not load this screen: ${errorMessage(e)}. Check your connection and reload.`);
      });
  }

  function dispatch(event: Event): void {
    const next = transition(state, event);
    if (next !== state) show(next);
  }

  // Queued offline scans go up on start and whenever we come back online.
  const flush = (): void => {
    void Promise.resolve()
      .then(() => flushOutbox())
      .catch((e: unknown) => console.warn("outbox not flushed", e));
  };
  flush();
  window.addEventListener("online", flush);

  const authError = readAuthError();
  if (authError === "private") ctx.authError = PRIVATE_MESSAGE;
  else if (authError === "failed") ctx.authError = SIGN_IN_FAILED_MESSAGE;

  let user: { uid: string; email: string } | null = null;
  try {
    user = await getCurrentUser();
  } catch (e) {
    console.warn("session check failed", e);
    ctx.authError ??= `Could not reach the server: ${errorMessage(e)}. Check your connection and reload.`;
  }
  if (!user) {
    dispatch({ type: "AUTH_SIGNED_OUT", error: ctx.authError ?? undefined });
    return;
  }
  ctx.user = user;
  ctx.authError = null;
  try {
    let userDoc: UserDoc | null = await getUserDoc(user.uid);
    if (!userDoc) {
      userDoc = { email: user.email, createdAt: Date.now(), units: "in", bodyType: "unspecified" };
      await saveUserDoc(user.uid, userDoc).catch((e: unknown) => console.warn("user doc not created", e));
    }
    ctx.userDoc = userDoc;
    ctx.units = userDoc.units === "cm" ? "cm" : "in";
  } catch (e) {
    console.warn("user doc not loaded", e);
  }
  dispatch({ type: "AUTH_SIGNED_IN" });
}

const root = document.getElementById("app");
if (root) {
  if (!isAuthConfigured()) renderNotConfigured(root);
  else
    boot(root).catch((e: unknown) => {
      console.error(e);
      renderBoot(root, `Something went wrong while starting: ${errorMessage(e)}`);
    });
}
