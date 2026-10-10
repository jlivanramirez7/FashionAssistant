// Keep the screen on during setup and capture (Screen Wake Lock API). No-op when unsupported.

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

let sentinel: WakeLockSentinelLike | null = null;
let wanted = false;
let listening = false;

function api(): WakeLockLike | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock ?? null;
}

async function request(): Promise<void> {
  const wl = api();
  if (!wl || (sentinel && !sentinel.released)) return;
  try {
    sentinel = await wl.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
  } catch {
    sentinel = null; // e.g. page hidden or battery saver: ignore
  }
}

// The browser drops the lock when the page is hidden; take it again on return.
function onVisibility(): void {
  if (wanted && document.visibilityState === "visible") void request();
}

export async function acquireWakeLock(): Promise<void> {
  wanted = true;
  if (!api()) return;
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    listening = true;
  }
  await request();
}

export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  if (listening && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
    listening = false;
  }
  const s = sentinel;
  sentinel = null;
  if (s && !s.released) {
    try {
      await s.release();
    } catch {
      // ignore
    }
  }
}
