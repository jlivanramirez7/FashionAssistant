// Entry (design doc sections 8 and 10): check config, finish a pending
// redirect sign-in, watch auth, then drive the screens from the pure
// state machine in src/flow/stateMachine.ts.
import "./ui/styles.css";
import { isFirebaseConfigured } from "./config";
import { CAPTURE_STATES, INITIAL_STATE, transition, type Event, type State, type StateName } from "./flow/stateMachine";
import type { Units, UserDoc } from "./types";
import { closeFrames, createVideoElement, errorMessage, newSession, type AppContext } from "./ui/context";
import { h } from "./ui/dom";

type Screen = { render(root: HTMLElement, ctx: AppContext): () => void };

/** Screens are loaded lazily, so a missing Firebase config never loads Firebase. */
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
};

function renderNotConfigured(root: HTMLElement): void {
  root.replaceChildren(
    h("section", { class: "screen screen-message" },
      h("div", { class: "screen-body" },
        h("h1", null, "Fashion Assistant"),
        h("p", { class: "error" }, "Firebase is not configured yet - fill VITE_FIREBASE_API_KEY and VITE_FIREBASE_APP_ID."),
        h("p", { class: "muted" },
          "Copy .env.example to .env.local (or fill .env.development / .env.production) with the values from the Firebase console (Project settings > Your apps), then restart the dev server or rebuild.",
        ),
      ),
    ),
  );
}

function renderBoot(root: HTMLElement, text = "Loading..."): void {
  root.replaceChildren(h("section", { class: "screen screen-message" }, h("div", { class: "screen-body" }, h("p", { class: "muted" }, text))));
}

async function boot(root: HTMLElement): Promise<void> {
  renderBoot(root);
  const [{ finishRedirect, watchAuth }, { getUserDoc, saveUserDoc }, hardware] = await Promise.all([
    import("./auth/authGuard"),
    import("./data/user"),
    import("./ui/hardware"),
  ]);

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

  function show(next: State): void {
    const prevName = state.name;
    state = next;
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

  try {
    await finishRedirect();
  } catch (e) {
    ctx.authError = errorMessage(e);
  }

  watchAuth((user) => {
    if (!user) {
      ctx.user = null;
      ctx.userDoc = null;
      dispatch({ type: "AUTH_SIGNED_OUT", error: ctx.authError ?? undefined });
      return;
    }
    const firstSignIn = ctx.user?.uid !== user.uid;
    ctx.user = user;
    ctx.authError = null;
    if (!firstSignIn) return;
    getUserDoc(user.uid)
      .then(async (doc) => {
        let userDoc: UserDoc | null = doc;
        if (!userDoc) {
          userDoc = { email: user.email, createdAt: Date.now(), units: "in", bodyType: "unspecified" };
          await saveUserDoc(user.uid, userDoc).catch((e: unknown) => console.warn("user doc not created", e));
        }
        ctx.userDoc = userDoc;
        ctx.units = userDoc.units === "cm" ? "cm" : "in";
      })
      .catch((e: unknown) => console.warn("user doc not loaded", e))
      .finally(() => {
        if (ctx.user?.uid === user.uid) dispatch({ type: "AUTH_SIGNED_IN" });
      });
  });
}

const root = document.getElementById("app");
if (root) {
  if (!isFirebaseConfigured()) renderNotConfigured(root);
  else
    boot(root).catch((e: unknown) => {
      console.error(e);
      renderBoot(root, `Something went wrong while starting: ${errorMessage(e)}`);
    });
}
