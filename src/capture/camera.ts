// Front (selfie) camera capture (design doc section 2).

/** PURE: getUserMedia constraint ladder: 1080x1920 portrait ideal, then 720x1280, then any front camera. */
export function cameraConstraintLadder(): MediaStreamConstraints[] {
  return [
    {
      audio: false,
      video: { facingMode: "user", width: { ideal: 1080 }, height: { ideal: 1920 }, frameRate: { ideal: 30 } },
    },
    {
      audio: false,
      video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 1280 } },
    },
    { audio: false, video: { facingMode: "user" } },
  ];
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Camera video failed to load."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", fail);
  });
}

/**
 * Open the front camera into `video` and return the ACTUAL track size.
 * width/height are the displayed (portrait) video dimensions, which is what
 * frames grabbed from the element have; track settings may report landscape.
 */
export async function startFrontCamera(
  video: HTMLVideoElement,
): Promise<{ stream: MediaStream; width: number; height: number; frameRate: number }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera not available (HTTPS and a supported browser are required).");
  }
  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (const c of cameraConstraintLadder()) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (e) {
      lastErr = e;
      const name = (e as { name?: string })?.name;
      // Permission problems will not be fixed by smaller constraints.
      if (name === "NotAllowedError" || name === "SecurityError") throw e;
    }
  }
  if (!stream) throw lastErr ?? new Error("Could not open the front camera.");

  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.srcObject = stream;
  await waitForMetadata(video);
  try {
    await video.play();
  } catch {
    // Autoplay can reject outside a gesture; the muted inline video usually still renders.
  }

  const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
  let width = video.videoWidth || settings.width || 0;
  let height = video.videoHeight || settings.height || 0;
  if (!video.videoWidth && width > height) [width, height] = [height, width]; // portrait app
  return { stream, width, height, frameRate: settings.frameRate ?? 30 };
}

/** Grab the current frame at full resolution, UNMIRRORED (the CSS mirror applies to the preview only). */
export async function grabFrame(video: HTMLVideoElement): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(video);
    } catch {
      // Older Safari cannot create a bitmap from a video element: go through a canvas.
    }
  }
  const w = video.videoWidth;
  const h = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available.");
  ctx.drawImage(video, 0, 0, w, h);
  return createImageBitmap(canvas);
}

export function stopCamera(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}
