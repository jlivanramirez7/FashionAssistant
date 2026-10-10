// Offline-friendly writes. With the persistent cache a write is applied
// locally at once, but its promise only resolves when the server acknowledges
// it - which never happens while offline. So we wait for the ack only briefly
// (not at all when the browser reports offline) and let the SDK sync later.
// Errors that arrive late are logged.

export const ACK_TIMEOUT_MS = 8000;

export async function commitWrite(
  write: Promise<unknown>,
  opts: { online?: boolean; timeoutMs?: number } = {},
): Promise<"acked" | "pending"> {
  const online = opts.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const logLate = () => {
    write.catch((err) => console.warn("Queued Firestore write failed", err));
  };
  if (!online) {
    logLate();
    return "pending";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), opts.timeoutMs ?? ACK_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([write.then(() => "acked" as const), timeout]);
    if (result === "pending") logLate();
    return result;
  } finally {
    clearTimeout(timer);
  }
}
