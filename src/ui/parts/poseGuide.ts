// Ghost outline of the target pose + live skeleton drawn over the
// mirrored preview (S5). The <video> is mirrored with CSS; landmarks are
// in the UNMIRRORED frame, so the drawing mirrors x itself (display only).
import { LM, type Landmark, type ViewName } from "../../types";

/** Maps normalized video coords to canvas pixels for object-fit: cover + mirror. */
export interface CoverMap {
  scale: number;
  offsetX: number;
  offsetY: number;
  videoWidth: number;
  videoHeight: number;
}

/** PURE: object-fit: cover mapping of a vw x vh video into a cw x ch box. */
export function coverMap(vw: number, vh: number, cw: number, ch: number): CoverMap {
  const scale = vw > 0 && vh > 0 ? Math.max(cw / vw, ch / vh) : 1;
  return { scale, offsetX: (cw - vw * scale) / 2, offsetY: (ch - vh * scale) / 2, videoWidth: vw, videoHeight: vh };
}

/** PURE: normalized (unmirrored) landmark -> canvas pixel on the mirrored preview. */
export function toCanvas(m: CoverMap, x: number, y: number): [number, number] {
  return [m.offsetX + (1 - x) * m.videoWidth * m.scale, m.offsetY + y * m.videoHeight * m.scale];
}

const BONES: [number, number][] = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow],
  [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow],
  [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee],
  [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee],
  [LM.rightKnee, LM.rightAnkle],
  [LM.leftAnkle, LM.leftHeel],
  [LM.leftHeel, LM.leftFootIndex],
  [LM.rightAnkle, LM.rightHeel],
  [LM.rightHeel, LM.rightFootIndex],
];

type Pt = [number, number];
/** Ghost figures in canvas-normalized coords (0..1), body ~70% of the height. */
const A_POSE: Pt[][] = [
  [[0.5, 0.235], [0.5, 0.28]], // neck
  [[0.4, 0.3], [0.6, 0.3]], // shoulders
  [[0.4, 0.3], [0.33, 0.42], [0.27, 0.53]], // arm
  [[0.6, 0.3], [0.67, 0.42], [0.73, 0.53]], // arm
  [[0.42, 0.3], [0.44, 0.55], [0.56, 0.55], [0.58, 0.3]], // torso
  [[0.45, 0.55], [0.44, 0.7], [0.43, 0.86]], // leg
  [[0.55, 0.55], [0.56, 0.7], [0.57, 0.86]], // leg
];
const SIDE_POSE: Pt[][] = [
  [[0.5, 0.235], [0.5, 0.28]],
  [[0.47, 0.3], [0.46, 0.43], [0.47, 0.55], [0.53, 0.55], [0.54, 0.43], [0.53, 0.3], [0.47, 0.3]], // torso profile
  [[0.5, 0.31], [0.5, 0.43], [0.5, 0.54]], // arm down
  [[0.48, 0.55], [0.49, 0.7], [0.49, 0.86]],
  [[0.52, 0.55], [0.51, 0.7], [0.51, 0.86]],
];
const HEAD: { cx: number; cy: number; r: number } = { cx: 0.5, cy: 0.19, r: 0.045 };

export interface PoseGuide {
  el: HTMLCanvasElement;
  setView(view: ViewName): void;
  draw(landmarks: Landmark[] | null, color: string): void;
}

export function createPoseGuide(video: HTMLVideoElement): PoseGuide {
  const canvas = document.createElement("canvas");
  canvas.className = "pose-guide";
  let view: ViewName = "front";

  function fit(): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const hgt = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    return canvas.getContext("2d");
  }

  function drawGhost(g: CanvasRenderingContext2D, w: number, hgt: number): void {
    const figure = view === "side" ? SIDE_POSE : A_POSE;
    g.save();
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = Math.max(6, w * 0.035);
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const line of figure) {
      g.beginPath();
      line.forEach(([x, y], i) => (i === 0 ? g.moveTo(x * w, y * hgt) : g.lineTo(x * w, y * hgt)));
      g.stroke();
    }
    g.beginPath();
    g.arc(HEAD.cx * w, HEAD.cy * hgt, HEAD.r * hgt, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  function draw(landmarks: Landmark[] | null, color: string): void {
    const g = fit();
    if (!g) return;
    const w = canvas.width;
    const hgt = canvas.height;
    g.clearRect(0, 0, w, hgt);
    drawGhost(g, w, hgt);
    if (!landmarks || !video.videoWidth) return;
    const m = coverMap(video.videoWidth, video.videoHeight, w, hgt);
    g.save();
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineWidth = Math.max(3, w * 0.012);
    g.lineCap = "round";
    for (const [a, b] of BONES) {
      const la = landmarks[a];
      const lb = landmarks[b];
      if (!la || !lb || la.visibility < 0.4 || lb.visibility < 0.4) continue;
      const [x1, y1] = toCanvas(m, la.x, la.y);
      const [x2, y2] = toCanvas(m, lb.x, lb.y);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    const nose = landmarks[LM.nose];
    if (nose && nose.visibility >= 0.4) {
      const [x, y] = toCanvas(m, nose.x, nose.y);
      g.beginPath();
      g.arc(x, y, g.lineWidth * 2, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  return {
    el: canvas,
    setView(v) {
      view = v;
    },
    draw,
  };
}
