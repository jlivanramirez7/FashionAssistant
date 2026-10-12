// Feedback log for troubleshooting reports: what the app told the user and
// what it decided, timestamped from the scan start. Always kept in memory
// (cheap); only uploaded when "Save troubleshooting data" is on.
import type { DiagLogEntry } from "../types";

export const MAX_LOG_ENTRIES = 1500;
const MAX_MSG = 300;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

let t0 = now();
let entries: DiagLogEntry[] = [];
let dropped = 0;

/** Start a fresh log (Start tap). */
export function resetDiagLog(): void {
  t0 = now();
  entries = [];
  dropped = 0;
}

export function diagLog(msg: string): void {
  if (entries.length >= MAX_LOG_ENTRIES) {
    dropped++;
    return;
  }
  entries.push({ t: Math.round(now() - t0), msg: msg.length > MAX_MSG ? `${msg.slice(0, MAX_MSG)}...` : msg });
}

/** Entries since the last take (each processing run gets its own slice). */
export function takeDiagLog(): DiagLogEntry[] {
  const out = entries;
  if (dropped) out.push({ t: Math.round(now() - t0), msg: `(${dropped} log lines dropped)` });
  entries = [];
  dropped = 0;
  return out;
}
