// Per-device random id kept in localStorage (design doc section 11).

const KEY = "fa.deviceId";
let memoryId: string | null = null;

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Fallback for non-secure contexts: RFC 4122 v4.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function getDeviceId(): string {
  const s = storage();
  try {
    const existing = s?.getItem(KEY);
    if (existing) return existing;
  } catch {
    /* storage blocked: fall back to memory */
  }
  if (!memoryId) memoryId = newId();
  try {
    s?.setItem(KEY, memoryId);
  } catch {
    /* keep the in-memory id for this session */
  }
  return memoryId;
}

export function clearDeviceId(): void {
  memoryId = null;
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
