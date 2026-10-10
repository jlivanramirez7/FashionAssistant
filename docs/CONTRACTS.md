# Module contracts (build phase 1)

Every builder implements ITS modules exactly as listed here and imports
other modules ONLY through these exports. Shared types live in
`src/types.ts` (orchestrator-owned; do not edit it - if you need a change,
say so in your final report). The design is `designdoc.txt` (read the
sections named for your area).

## Ground rules for all agents

- Edit only the paths your team owns (table below). Do not edit
  package.json, tsconfig.json, vite.config.ts, src/types.ts or another
  team's files. Need a dependency or a contract change? Put it in your
  final report; the orchestrator applies it.
- Installed deps: firebase, @mediapipe/tasks-vision, fflate (runtime);
  vite, typescript, vite-plugin-pwa, @vitejs/plugin-basic-ssl, vitest,
  jsdom, firebase-tools (dev). Do NOT run `npm install`.
- TypeScript strict, ES modules, no UI framework. Match the doc's names.
- Tests: Vitest, files under `tests/<your-area>/*.test.ts`, environment
  node by default (add `// @vitest-environment jsdom` at the top of a test
  file that needs DOM). Pure logic must be unit-tested. Browser-only code
  (camera, MediaPipe, Firebase) must be written so its PURE parts are
  separate functions that can be tested without the browser.
- Check your work with `npx tsc --noEmit` (ignore errors in files you do
  not own - others are building in parallel) and
  `npx vitest run tests/<your-area>`.
- Never upload images. Never hard-code secrets. Do not commit.

## Ownership

| Team | Owns |
|---|---|
| A  auth-data | src/config.ts, src/auth/**, src/data/**, tests/auth-data/** |
| B  device-capture | src/device/**, src/capture/**, src/wakeLock.ts, public/device-profiles.json, tests/device-capture/** |
| C  geometry-measure | src/geometry/**, src/measure/**, src/pipeline/**, tests/geometry-measure/** |
| D  vision | src/vision/**, tests/vision/** |
| E  ui-flow | src/main.ts, src/flow/**, src/ui/**, src/units.ts, public/icons/**, tests/ui-flow/** |
| F  dev-tools | src/dev/**, tests/dev-tools/** (replay.html already exists) |
| QA | tests/qa/**, docs/QA_NOTES.md |

## A - auth-data

`src/config.ts`
- `export const firebaseConfig: { apiKey: string; authDomain: string; projectId: string; appId: string; messagingSenderId: string }` (from VITE_* env)
- `export const FIRESTORE_DATABASE_ID: string` (default "fashionassitant-db")
- `export const ALLOWED_EMAIL: string` (lowercased)
- `export const APP_VERSION: string` ("0.1.0")
- `export function isFirebaseConfigured(): boolean` (false when apiKey/appId are empty - the UI then shows a "not configured" message instead of crashing)

`src/auth/firebase.ts` - `export function getFirebase(): { app, auth, db }` (lazy init; named database; persistentLocalCache)
`src/auth/authGuard.ts`
- `export function isAllowed(user: { email: string | null; emailVerified: boolean } | null): boolean`
- `export async function finishRedirect(): Promise<void>` (throws Error("This app is private.") for other accounts)
- `export async function signIn(): Promise<void>` (redirect when authDomain === location.host, else popup)
- `export async function signOutUser(): Promise<void>`
- `export function watchAuth(cb: (user: { uid: string; email: string } | null) => void): () => void`

`src/data/deviceId.ts` - `export function getDeviceId(): string` (UUID in localStorage "fa.deviceId"), `export function clearDeviceId(): void`
`src/data/user.ts` - `getUserDoc(uid): Promise<UserDoc | null>`, `saveUserDoc(uid, patch: Partial<UserDoc>): Promise<void>`
`src/data/scans.ts` - `saveScan(uid, scan: ScanDoc): Promise<string>` (returns id), `updateScan(uid, id, patch: Partial<ScanDoc>)`, `getScan(uid, id): Promise<ScanDoc | null>`, `listScans(uid): Promise<ScanDoc[]>` (newest first), `deleteScan(uid, id)`
`src/data/devices.ts` - `getDeviceRecord(uid, deviceId): Promise<Partial<DeviceProfile> | null>`, `saveDeviceRecord(uid, profile: DeviceProfile): Promise<void>`
`src/data/settings.ts` - `getCorrectionFactors(uid): Promise<CorrectionFactors | null>`, `saveCorrectionFactors(uid, f: CorrectionFactors)`
`src/data/validation.ts` (PURE, unit-tested)
- `export interface ValidationRow { key: MeasurementKey; n: number; maeCm: number; pctWithinTarget: number }`
- `export function validationStats(scans: ScanDoc[]): ValidationRow[]` (only scans with tapeMeasurements; compares measurements[key].valueCm with tape)
- `export function computeCorrectionFactors(scans: ScanDoc[], minScans = 3): CorrectionFactors` (k = mean(tape / raw) per key per bodyType, circumferences only, only keys with >= minScans samples)
`src/data/deleteAll.ts` - `export async function deleteAllMyData(uid: string): Promise<void>` (section 11; throws when offline)

Additions shipped by team A: `PRIVATE_MESSAGE` (authGuard.ts), `src/auth/allowlist.ts` (pure helpers), `tapeScanCount(scans)` (validation.ts), `_forgetFirestore()` (internal, firebase.ts). Writes resolve within ~8 s offline and sync later. `computeCorrectionFactors` ignores tape/raw ratios outside 0.5-2 as entry mistakes.

## B - device-capture

`src/device/profiles.ts`
- `export const GENERIC_SPEC: DeviceSpec` (L_lens 14 cm => phoneHeightMm 150, frontLensFromTopMm 10; 35mm-eq 26)
- `export async function loadDeviceSpecs(): Promise<DeviceSpec[]>` (fetch /device-profiles.json, [] on failure)
- PURE: `export function matchSpec(specs: DeviceSpec[], info: { uaModel?: string; screenWidth: number; screenHeight: number; dpr: number; isIOS: boolean }): { spec: DeviceSpec; source: ModelSource }`
`src/device/detectModel.ts` - `export async function detectModelInfo(): Promise<{ uaModel?: string; screenWidth: number; screenHeight: number; dpr: number; isIOS: boolean; userAgent: string }>`
`src/device/profile.ts`
- PURE: `export function focalPxFromSpec(front35mmEqMm: number, width: number, height: number, sensorAspect = "4:3"): number` (35mm-eq is defined on the full sensor diagonal; the video is a crop of the sensor's long side: long = max(W,H), sensorShort = long * aspect, f = f35 * sqrt(long^2 + sensorShort^2) / 43.27). Changed 2026-10-10 (was the naive video diagonal, ~9% low for 16:9 video).
- PURE: `export function lensOffsetCmFromSpec(spec: DeviceSpec): number`
- PURE: `export function buildProfile(args: { deviceId: string; spec: DeviceSpec; source: ModelSource; userAgent: string; screen: {width:number;height:number;devicePixelRatio:number}; captureWidth: number; captureHeight: number; saved?: Partial<DeviceProfile> | null }): DeviceProfile` (saved paper/height-solve values override spec values; focal length rescaled if the capture size changed)
- `export async function buildDeviceProfile(deviceId: string, capture: { width: number; height: number }, saved?: Partial<DeviceProfile> | null): Promise<DeviceProfile>`
`public/device-profiles.json` - `DeviceSpec[]`: recent iPhone families (screenMatch) and common Pixel/Samsung models (uaModels). Mark values approximate in a top-level comment-free way (JSON has no comments: add a `"_note"` field only inside a wrapper is NOT allowed - keep it a plain array; put sourcing notes in your report).
`src/capture/camera.ts`
- `export async function startFrontCamera(video: HTMLVideoElement): Promise<{ stream: MediaStream; width: number; height: number; frameRate: number }>` (facingMode "user", ideal 1080x1920 portrait, fallback 720x1280)
- `export async function grabFrame(video: HTMLVideoElement): Promise<ImageBitmap>` (unmirrored)
- `export function stopCamera(stream: MediaStream): void`
`src/capture/sensors.ts`
- PURE: `export function gravityToOrientation(gx: number, gy: number, gz: number): Orientation` (device frame, portrait; tilt 90 = upright, 0 = flat on its back)
- PURE: `export function averageOrientation(samples: Orientation[]): Orientation`
- PURE: `export function placementOk(o: Orientation): boolean` (tilt 60-85, |roll| <= 3)
- `export async function requestMotionPermission(): Promise<boolean>` (iOS requestPermission from the tap)
- `export function startSensors(): void`, `export function stopSensors(): void`
- `export function currentOrientation(): Orientation | null` (smoothed)
- `export function orientationSince(tMs: number): Orientation | null` (average of samples since tMs)
`src/capture/voice.ts` - `unlockVoice(): void` (call from the Start tap), `say(text: string): Promise<void>`, `chime(): void`, `setMuted(m: boolean): void`
`src/wakeLock.ts` - `acquireWakeLock(): Promise<void>`, `releaseWakeLock(): Promise<void>` (no-op when unsupported)

## C - geometry-measure (pure math; heavily unit-tested)

`src/geometry/camera.ts`
- `export function buildCamera(profile: DeviceProfile, o: Orientation, width: number, height: number): CameraModel`
`src/geometry/distortion.ts` - `export function undistort(cam: CameraModel, u: number, v: number): [number, number]` (k1 radial; identity when k1 = 0)
`src/geometry/plane.ts`
- `export function distanceFromFeet(cam: CameraModel, vFeet: number): number` (cm; alpha = atan((v - cy)/fy) - phi; d = h / tan(alpha); NaN/Infinity guarded)
- `export function makeViewPlane(cam: CameraModel, view: ViewName, vFeet: number, vHead: number, heightCm: number): ViewPlane`
- `export function solveFocalLength(cam: CameraModel, vFeet: number, vHead: number, heightCm: number): number | null`
Shipped notes (team C): `distanceFromFeet` returns 0 (never NaN) when undeterminable - callers treat <= 0 as invalid. `makeViewPlane(..., opts?)` subtracts a head-top correction; on floor-geometry failure it uses height only and sets scaleAgreementPct = 100 (forces a retake). `computeMeasurements(..., options?)` also returns `levels`. Roll de-rotation uses team B's sign.

`src/measure/ellipse.ts` - `export function ellipseCircumference(widthCm: number, depthCm: number): number` (Ramanujan)
`src/measure/silhouette.ts` - `export function spanAtRow(mask: PersonMask, v: number, nearU: number): { u0: number; u1: number } | null` (contiguous run containing / nearest to column nearU)
`src/measure/levels.ts` - body level finder (section 7 "Body level definitions"): `export function findLevels(input: LevelInput): BodyLevels` - define `LevelInput`/`BodyLevels` yourself and export them.
`src/measure/compute.ts`
- `export interface FrameData { landmarksPx: Landmark[]; mask: PersonMask; plane: ViewPlane }` (landmarksPx: x,y in PIXELS)
- `export interface ViewData { view: ViewName; frames: FrameData[] }`
- `export function computeMeasurements(views: ViewData[], inputs: ScanInputs, factors: CorrectionFactors | null): { measurements: Measurements; rawMeasurements: RawMeasurements }`
   - bust = chest; uncertainty = frame spread + distortion term; confidence from spread vs target; keys in MEASUREMENT_SPECS with alwaysLowConfidence capped at 0.7.
`src/pipeline/runPipeline.ts` (glue; uses D's vision API)
- `export async function runPipeline(args: { captures: ViewCapture[]; profile: DeviceProfile; inputs: ScanInputs; factors: CorrectionFactors | null; onProgress?: ProgressFn; vision?: VisionApi }): Promise<PipelineResult>`
- `export interface VisionApi { detectPoseHeavy: typeof import("../vision").detectPoseHeavy; segmentPerson: typeof import("../vision").segmentPerson; frameQuality: typeof import("../vision").frameQuality }` - injectable so tests can pass fakes.
- Steps per section 7: heavy pose per frame -> camera + plane per view (feet/head rows from landmarks + mask) -> masks -> computeMeasurements; height-solve focal length; retakeViews from quality and scaleAgreementPct > 2%.

## D - vision (MediaPipe wrappers in the browser)

`src/vision/index.ts` re-exports:
- `export async function initVision(opts?: { wasmBase?: string; modelBase?: string; live?: boolean; heavy?: boolean; segmenter?: boolean }): Promise<void>` (defaults "/wasm", "/models"; GPU delegate with CPU fallback)
- `export function detectPoseLive(video: HTMLVideoElement, timestampMs: number): Landmark[] | null` (lite, VIDEO mode)
- `export async function detectPoseHeavy(image: ImageBitmap | ImageData): Promise<Landmark[] | null>` (heavy, IMAGE mode, normalized coords)
- `export async function segmentPerson(image: ImageBitmap | ImageData, landmarks: Landmark[]): Promise<PersonMask>` (section 7: per-region padded crops at full res -> selfie_multiclass segmenter per crop -> edge refinement within +/-3 px -> composed full-frame mask)
- `export function frameQuality(image: ImageData, landmarks: Landmark[] | null): QualityScore`
- `export function checkPose(view: ViewName, landmarks: Landmark[] | null, history?: Landmark[][]): PoseHint` (live guidance; history for stillness)
- PURE helpers in their own files, unit-tested: `src/vision/crops.ts` (`regionCrops(landmarks, width, height): { name: string; x: number; y: number; w: number; h: number }[]`), `src/vision/edgeRefine.ts` (operates on Uint8Array/Float32Array buffers), `src/vision/compose.ts` (crop masks -> full-frame PersonMask), `src/vision/quality.ts` (sharpness via Laplacian variance on a grayscale buffer, inFrame check), `src/vision/poseCheck.ts` (checkPose logic).
- `export const MODEL_VERSIONS: Record<string, string>`

## E - ui-flow

`src/main.ts` - entry: if !isFirebaseConfigured() show a clear setup message; else `await finishRedirect()` (show private message on error), `watchAuth`, then run the flow.
`src/flow/stateMachine.ts` - PURE reducer: `export type State`, `export type Event`, `export function transition(state: State, event: Event): State` covering signin > home > setup > place > capture(front, side, back) > processing > (retake step) > results, plus history, validation, validationSummary. Unit-tested.
`src/ui/screens/*.ts` - one file per screen S1-S9 + validationSummary (section 6). Each exports `render(root: HTMLElement, ctx: AppContext): () => void` (returns cleanup). Define `AppContext` in `src/ui/context.ts`.
`src/ui/parts/*.ts` - levelGauge, poseGuide, statusBorder, measurementRow, bodyDiagram, unitToggle.
`src/ui/styles.css` - large type, high contrast, mirrored preview (`transform: scaleX(-1)` on the video only).
`src/units.ts` - PURE: `cmToIn`, `inToCm`, `formatLength(cm: number, units: Units): string` (inches to nearest 0.25"), `parseHeight(...)`. Unit-tested.
`public/icons/` - icon-192.png, icon-512.png, icon-512-maskable.png (generate simple solid-colour PNGs with a script in Node using zlib - no new deps).
Confidence colours: >= 0.75 green, >= 0.5 amber, else red. Chest label: "Bust" (female), "Chest" (male), "Chest / bust" (unspecified).

## F - dev-tools

`src/dev/debugCapture.ts` - `export function debugEnabled(): boolean` (import.meta.env.DEV or ?debug=1 on a non-production host); `export async function buildDebugZip(args: { captures: ViewCapture[]; profile: DeviceProfile; inputs: ScanInputs; sensorLog: Orientation[] }): Promise<Blob>` (fflate; frames as JPEG); `export function downloadBlob(blob: Blob, name: string): void`; PURE `export function parseDebugZip(bytes: Uint8Array): Promise<{ manifest: DebugManifest; frames: { view: ViewName; index: number; jpeg: Uint8Array }[] }>` + `export interface DebugManifest`.
`src/dev/replay.ts` - replay.html page: pick a zip, decode frames to ImageBitmap, call `initVision` + `runPipeline`, print measurements + diagnostics as a table and JSON.
