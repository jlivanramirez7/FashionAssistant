// Phone model detection (design doc section 4, step 1).

interface UADataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string; platformVersion?: string }>;
}

/** PURE: iPhone/iPad detection from UA + platform (iPadOS reports "MacIntel" with touch). */
export function isIOSUserAgent(userAgent: string, platform = "", maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return platform === "MacIntel" && maxTouchPoints > 1;
}

export async function detectModelInfo(): Promise<{
  uaModel?: string;
  screenWidth: number;
  screenHeight: number;
  dpr: number;
  isIOS: boolean;
  userAgent: string;
}> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const userAgent = nav?.userAgent ?? "";
  const isIOS = isIOSUserAgent(userAgent, nav?.platform ?? "", nav?.maxTouchPoints ?? 0);

  let uaModel: string | undefined;
  try {
    const uad = (nav as unknown as { userAgentData?: UADataLike } | undefined)?.userAgentData;
    if (uad?.getHighEntropyValues) {
      const v = await uad.getHighEntropyValues(["model", "platformVersion"]);
      if (v.model && v.model.trim()) uaModel = v.model.trim();
    }
  } catch {
    // Client hints unavailable or rejected: fall through to screen matching.
  }

  const sw = typeof screen !== "undefined" ? screen.width : 0;
  const sh = typeof screen !== "undefined" ? screen.height : 0;
  return {
    uaModel,
    // Portrait-normalized CSS pixels.
    screenWidth: Math.min(sw, sh),
    screenHeight: Math.max(sw, sh),
    dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    isIOS,
    userAgent,
  };
}
