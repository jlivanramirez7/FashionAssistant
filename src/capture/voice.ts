// Spoken prompts and the capture chime (design doc sections 2, 5, S5).

let muted = false;
let audioCtx: AudioContext | null = null;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

/** PURE: generous upper bound on how long `text` takes to speak (fallback when "end" never fires). */
export function speechTimeoutMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return 2000 + words * 600;
}

/** Call synchronously from the Start tap: unlocks speechSynthesis (iOS) and WebAudio. */
export function unlockVoice(): void {
  const s = synth();
  if (s) {
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      s.speak(u);
    } catch {
      // ignore
    }
  }
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

/** Speak `text` (interrupting any current prompt). Resolves when done, on error, or when muted. */
export function say(text: string): Promise<void> {
  const s = synth();
  if (muted || !s || !text.trim()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, speechTimeoutMs(text));
    try {
      s.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 1;
      u.onend = finish;
      u.onerror = finish;
      s.speak(u);
    } catch {
      finish();
    }
  });
}

/** Short two-note chime (frames are being kept). */
export function chime(): void {
  if (muted) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime;
    const notes: [number, number][] = [
      [880, 0],
      [1320, 0.12],
    ];
    for (const [freq, at] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.3);
    }
  } catch {
    // ignore audio failures
  }
}

export function setMuted(m: boolean): void {
  muted = m;
  if (m) synth()?.cancel();
}
