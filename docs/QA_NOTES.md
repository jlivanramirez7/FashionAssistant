# QA notes - Fashion Assistant (living checklist)

Owner: QA agent. QA owns only `tests/qa/**` and this file. Spec: `designdoc.txt`;
contracts: `docs/CONTRACTS.md`; shared types: `src/types.ts`.

Every verification cycle runs, in this order:

```
npx tsc --noEmit                 # gate 1 - zero errors
npx vitest run                   # gate 2 - all unit tests, all teams + tests/qa
npm run build                    # gate 3 - tsc + vite build (creates dist/)
npx vitest run tests/qa/bundle.test.ts   # gate 4 - bundle checks (skips if no dist/)
```

A failing QA test always names its owner team in brackets, e.g.
`[C geometry-measure] MISSING MODULE src/pipeline/runPipeline.ts`.

---------------------------------------------------------------------------

## (a) Automated gates that must always pass

| # | Gate | Command / file | Pass condition |
|---|------|----------------|----------------|
| G1 | Typecheck | `npx tsc --noEmit` | 0 errors (tests/ included in tsconfig - QA files must compile too) |
| G2 | Unit tests | `npx vitest run` | 0 failures across `tests/**` |
| G3 | Production build | `npm run build` | exits 0; `dist/index.html`, `dist/sw.js`, `*.webmanifest` exist |
| G4 | Bundle checks | `tests/qa/bundle.test.ts` | all pass (see invariants I10-I12) |
| G5 | Contract | `tests/qa/contract.test.ts` | every export in CONTRACTS.md exists with the right kind and arity |
| G6 | Conventions | `tests/qa/conventions.test.ts` | B -> C geometry chain reproduces a known scene |
| G7 | Spec coverage | `tests/qa/spec-coverage.test.ts` | all 23 keys specified, labelled, grouped, mapped, validated |
| G8 | Invariants | `tests/qa/invariants.test.ts` | privacy, dev-code, mirroring, Firebase wiring, auth rules |
| G9 | Pipeline E2E | `tests/qa/pipeline-e2e.test.ts` | synthetic scene measured within targets |
| G10 | Config files | `tests/qa/config-files.test.ts` | rules, firebase.json, nginx, Docker, env, vite, icons, device profiles |

QA test files (`tests/qa/`): `_helpers.ts` (dynamic, owner-tagged module loading),
`_scene.ts` (independent ground-truth pinhole scene + synthetic person),
`contract`, `conventions`, `spec-coverage`, `invariants`, `pipeline-e2e`,
`config-files`, `bundle` (`*.test.ts`).

---------------------------------------------------------------------------

## (b) Cross-module invariants

Each line: invariant - who must keep it - where it is enforced.

**Geometry and sensors (B <-> C)**
- I1 Gravity convention: input is W3C `accelerationIncludingGravity` (upright portrait at rest = (0,+g,0); flat on its back, screen up = (0,0,+g)). B: `tilt = atan2(sqrt(gx^2+gy^2), gz)` (90 = upright, 0 = flat), `roll = atan2(-gx, gy)` (in-plane, 0 = level). The tilt is scale-invariant and independent of roll; roll is antisymmetric. iOS sign flip is handled by B's `normalizeGravity` (gy < 0 means negate). - B, C - conventions.test.ts. **Manual: M-B3.**
- I2 Placement window: tilt 60-85 inclusive, |roll| <= 3. B `placementOk` and E `placementHint` must agree at every boundary. - B, E - conventions + spec-coverage.
- I3 Sensor timestamps use `performance.now()` (B). Anything that correlates sensor samples with frames (`orientationSince`) must use the same clock. - B, E - manual review.
- I4 Lens height `h = L_lens * sin(theta)`; generic L_lens = 14 cm, 26 mm-eq. - B, C - conventions.
- I5 Focal length: `f_px = f35 * hypot(long, long * sensorAspect) / 43.27`, with the default sensor "4:3" (orchestrator contract update; it replaces the doc's video-diagonal formula, which is the "16:9" case). Rescaled by the ratio of the long sides when the capture size changes (B `buildProfile`, C `buildCamera`). Saved `paper`/`height-solve` values override the spec. - B, C - conventions.
- I6 Floor distance `alpha = atan((v-cy)/fy) - phi`, `d = h/tan(alpha)`, accurate to < 0.05 cm on an exact scene; returns a non-positive value when undeterminable (C returns 0, never NaN/Infinity, so callers must treat `<= 0` as invalid). - C - conventions.
- I7 Head row = silhouette top of a 3D head, not the crown. C applies a "crown excess" `sqrt(c^2 + T^2 b^2) - c` (head 0.066H x 0.057H front/back, 0.043H side). QA's `_scene.ts` computes the same tangent numerically and agrees. Heights, `heightScale` and `scaleAgreementPct` depend on this. - C - conventions.
- I8 Height solve: `solveFocalLength` recovers the true f within 1% when the spec is 10% off. Above a 5% difference the solved value wins (`solvedFocalLengthPx`). - C - conventions + pipeline-e2e.

**Coordinates and frames (B, D, C)**
- I9 Landmarks from D (`detectPoseHeavy`, `detectPoseLive`) are NORMALIZED 0..1 in the UNMIRRORED frame. C's `FrameData.landmarksPx` is in PIXELS, so the pipeline converts. `segmentPerson` and `regionCrops` take normalized landmarks; masks are full-frame pixels. - C, D - pipeline-e2e (fake vision returns normalized), invariants (regionCrops).
- I9b Frames are never mirrored in capture/vision/geometry/measure/pipeline. Only the `<video>` preview is mirrored, with CSS `transform: scaleX(-1)`. - B, D, C, E - invariants.
- I9c Framing (D): the central 80% window applies to nose, shoulders, hips and ankles. Wrists only need to be inside the frame (in the A-pose at 70% height they sit at x ~0.08/0.92). frameQuality has 3% extra slack.

**Measurements (C, E, A)**
- I10a MEASUREMENT_KEYS coverage: all 23 keys have one spec matching the section 7 table (group, kind, target). The Results screen groups list every key (Tops, Bottoms, Dresses & one-pieces, Shoes, General). Every key has a label, `KEY_VIEWS` entry, Firestore round trip (measurements, raw, tape) and a validationStats row (keys with a target). - orchestrator, E, A - spec-coverage.
- I10b bust = chest: same spec kind and target; the pipeline must output `bust.valueCm === chest.valueCm`. - C - pipeline-e2e.
- I10c Chest label: "Bust" (female), "Chest" (male), "Chest / bust" (unspecified). - E - spec-coverage.
- I10d Confidence colours: >= 0.75 green, >= 0.5 amber, else red (NaN = red). `alwaysLowConfidence` keys (wrist, footLength) have confidence <= 0.7. - E, C - spec-coverage, pipeline-e2e.
- I10e k defaults to 1.0: null factors or a missing key means measurements equal raw. Factors apply per bodyType to `measurements` only; `rawMeasurements` stay uncorrected. `computeCorrectionFactors` uses tape/RAW (not corrected values), circumferences only, and needs >= minScans samples. - C, A - pipeline-e2e, spec-coverage.
- I10f Uncertainty > 0 for every measured key when the device has no `distortionK1` (distortion term), even if frames agree exactly. - C - pipeline-e2e.
- I10g Units: 2.54 cm per inch exactly; inches rounded to the nearest 0.25". - E - spec-coverage.

**Privacy and data (A, all)**
- I11a No image ever leaves the device: no `firebase/storage`, no sendBeacon/XHR/WebSocket/POST, `fetch` only for static assets (device-profiles.json, MediaPipe), and no image types in `src/data/**`. The serialized scan contains only numbers, strings and timestamps. - all, A - invariants, spec-coverage.
- I11b Named database: `initializeFirestore(app, {localCache: persistentLocalCache(...)}, FIRESTORE_DATABASE_ID)` and never `getFirestore()`. The default id is `fashionassitant-db`. It is in firebase.json, all .env files and the built bundle. - A - invariants, config-files, bundle.
- I11c Allowlist: `ALLOWED_EMAIL` lowercased; `isAllowed` requires a verified, case-insensitive exact match; an empty allowlist fails closed. login_hint; redirect iff `authDomain === location.host`, else popup; "This app is private." - A - invariants.
- I11d Firebase init is lazy (importing never initialises); not configured means the UI shows a setup message. main.ts calls `finishRedirect()` before `watchAuth()`. - A, E - invariants.
- I11e Delete all: batches <= 500, scans/devices/settings plus users/{uid}, then `terminate` + `clearIndexedDbPersistence`, then clear `fa.deviceId`. - A - invariants. **Manual: M-M5c.**
- I11f deviceId: a v4 UUID in localStorage `fa.deviceId`, stable until cleared. - A - invariants.

**Rules and deployment files (orchestrator)**
- I12a firestore.rules: rules_version '2'; a single `allow read, write` on `/users/{uid}/{document=**}` gated on `isAllowedUser() && request.auth.uid == uid`; email == jlivanramirez7@gmail.com, email_verified == true, sign_in_provider == 'google.com'; no other email, no `if true`, no time-based rule. - config-files.
- I12b nginx: listen 8080; SPA fallback; sw.js no-cache; `/__/auth/` and `/__/firebase/` proxy_pass to https://fashionassitant.firebaseapp.com with proxy_ssl_server_name on and Host header; NO Cross-Origin-Opener-Policy. - config-files.
- I12c Dockerfile: node:22 build (scripts copied before npm ci), then nginx serving dist on 8080. - config-files.
- I12d vite.config: `navigateFallbackDenylist: [/^\/__\//]`; build input index.html only; manifest standalone + portrait + 3 icons (maskable); MediaPipe /models/ and /wasm/ CacheFirst, not in globPatterns; basicSsl dev only. - config-files.
- I12e Env files: all 7 VITE_* keys, db id, project, allowed email. Dev auth domain = fashionassitant.firebaseapp.com. **Prod auth domain must be changed to the run.app host after the first deploy (M0 manual step M-M0b); QA does not fail on it before then.**

**Dev-only code (E, F)**
- I13a No static import of `src/dev/**` or `fflate` outside src/dev. The only dynamic import (`src/ui/debug.ts`) is guarded by `import.meta.env.DEV || ?debug=1`, and `debugEnabled()` also checks the host. - invariants.
- I13b Bundle: replay.html and replay code are never in dist. debugCapture/fflate may exist ONLY in a lazily loaded chunk, never in the entry chunk or its static imports. sw.js contains the /__/ denylist and does not precache models; bundle contains the db id + email, no emulator wiring; entry static graph < 1.5 MiB (MediaPipe lazy-loaded; D's `src/vision/index.ts` loads tasks-vision lazily). - bundle.test.ts.
- I13c Spoken and on-screen text never says "turn left/right" (it names the body part facing the phone). - invariants.

---------------------------------------------------------------------------

## (c) Manual device tests (human, on a phone)

Record the result of each run in the regression log (d). "Pass" means every expected result happened.

### M0 - scaffolding, sign-in, deploy
- **M-M0a Deploy and helper.** `npm run deploy`; open `https://<run.app host>/__/auth/handler`. Expected: the Firebase auth handler page, NOT the app.
- **M-M0b Second-pass config.** Set `VITE_FIREBASE_AUTH_DOMAIN=<run.app host>` in .env.production, add the OAuth redirect URI `https://<host>/__/auth/handler` and the authorized domain, then redeploy. Expected: the bundle contains the run.app host.
- **M-M0c iOS installed PWA sign-in.** iPhone Safari: open the URL, Share > Add to Home Screen, open the icon, then Sign in with Google (jlivanramirez7@gmail.com). Expected: the redirect returns to the installed app signed in, showing Home. Sign out, then sign in again: same result.
- **M-M0d Android Chrome sign-in.** Same as M-M0c in Chrome. Expected: signed in, Home shown.
- **M-M0e Refusal.** Sign in with another Google account. Expected: "This app is private.", signed out, no Firestore data visible. In the Firestore console no new users/{uid} doc for that account is written.
- **M-M0f Firestore round trip.** Run a scan (or save a test scan). Expected: a doc appears under `users/{uid}/scans` in database **fashionassitant-db** (not "(default)"), and reopening the app reads it.
- **M-M0g Budget alert** exists in Billing > Budgets (10 USD, 50%/100%).
- **M-M0h Not configured.** Run a build with an empty API key. Expected: a clear setup message, no crash.
- **M-M0i Rules emulator.** `firebase emulators:start` (or a rules unit test). Expected: the allowed account can read/write its own subtree; another uid, another email, an unverified email and anonymous requests are denied.

### M1 - capture skeleton
- **M-B1 Permissions on one tap.** Fill in Setup, then tap Start. Expected: camera + motion prompts (iOS) from that one tap; voice speaks afterwards; no further prompts.
- **M-B2 Front camera + mirror.** Expected: the selfie camera; the preview behaves like a mirror (raise your right hand and the on-screen hand is on the right). The debug-zip frames are NOT mirrored (in replay, the user's right hand appears on the image left).
- **M-B3 Gravity sign + level gauge (iOS AND Android).** Lean the phone against a wall at about 75 deg. Expected: tilt reads 70-80 on both platforms, roll about 0. Rotate the phone clockwise in its plane by about 5 deg: roll leaves the green zone, and the direction shown matches the physical rotation on both iOS and Android (catches a gravity sign flip). Lay it flat: tilt reads about 0 (gauge red). Upright: tilt about 90 (red).
- **M-B4 Placement hold.** Gauge green for 2 s. Expected: "Great. Now walk back until I can see all of you." and auto-advance.
- **M-B5 Device profile.** Android: diagnostics.modelSource = "ua-client-hints" with the right model. iPhone: "screen-match" with the right family. Unknown phone: "generic" (lower confidence).
- **M-B6 Track settings.** diagnostics.videoWidth/Height = the real track size (1080x1920 or the 720x1280 fallback).
- **M-B7 Wake lock.** The screen does not dim during setup/capture for > 2 min.
- **M-B8 Background.** Switch apps mid-capture and come back. Expected: no crash; capture resumes from the last completed pose or restarts cleanly.
- **M-E1 Three steps, hands-free.** Front A-pose, then side (right shoulder), then back A-pose, each auto-captured after holding about 1 s with a chime. Expected: no taps needed; huge text (>= 48 px, about 6 words); border red/amber/green; never says "turn left/right".
- **M-E2 Live guidance.** Stand too close: "Step back". Stand too far or off-centre: the corresponding hint. Face the wrong way on the side step: the turn hint.
- **M-D1 Back-view detection.** On step 3 the back view is detected via face-landmark visibility. Expected: facing the phone on step 3 is NOT accepted as "back"; a real back view is accepted within about 3 s.
- **M-D2 Blur false positives.** With plain fitted clothes against a plain wall in good light, no "blurry" retake should trigger (SHARPNESS_HALF_VARIANCE=100 is uncalibrated). Repeat in dim light and record the sharpness scores from diagnostics/replay.
- **M-D3 Framing.** A-pose at about 70% of frame height with wrists near the edges is accepted (wrists only need to be inside the frame).
- **M-F1 Debug zip + replay.** On the dev server (or ?debug=1 on a dev host) turn on Debug capture and run a scan. Expected: a .zip downloads (frames JPEG + sensors + inputs) and nothing is uploaded (check the DevTools network tab). On the PC, `https://localhost:5173/replay.html` + the zip prints measurements + diagnostics.
- **M-F2 Production has no debug.** On the production URL with `?debug=1`: no Debug capture toggle and no zip.
- **M-M1 Exit.** One full 3-step scan on one iPhone AND one Android, each saving `diagnostics`; both zips replay on desktop.

### M2 - lengths and validation
- **M-M2a** Tape-measure 3 people (height, shoulder width, sleeve, inseam, outseam). Scan each with their own height and subjectLabel ("Person N"). Enter tape values in S9 (try both in and cm). Expected: tape stored in cm; values within +/-2 cm.
- **M-M2b** Typed height off by 5%. Expected: "retake or confirm height" prompt (scaleAgreementPct > 2%).

### M3 - circumferences
- **M-M3a** Tape-measure chest, waist and hips on 5 people. Expected: within +/-4 cm.
- **M-M3b** Recompute k in the Validation summary. Expected: `users/{uid}/settings/correctionFactors` has per-bodyType maps of circumference keys only; a later scan's measurements change, rawMeasurements do not.
- **M-M3c** Loose clothing vs fitted on the same person. Expected: loose reads larger (documented risk); a warning if implemented.

### M4 - calibration and quality
- **M-M4a** Out-of-frame or blurry step. Expected: only that step is re-captured.
- **M-M4b** Uncertainty: every row shows +/- > 0; wrist and foot length are never green.
- **M-M4c** Validation summary over 10-20 people. Expected: MAE and % within target; success criteria (lengths +/-1.5 cm and circumferences +/-3 cm for 80%) met.
- **M-M4d** A full scan takes < 3 min from Start; processing takes about 5-15 s on a mid-range phone (processingMs); fewer than 1 in 5 scans need a retake.

### M5 - results and history
- **M-M5a** Results: every measurement grouped (Tops, Bottoms, Dresses & one-pieces, Shoes, General); chest label by body type; in/cm toggle saved per user; Copy all pastes a readable list; tapping a row shows the body diagram; "Retake amber/red" retakes only the needed steps.
- **M-M5b** History: newest first with subject label; tapping reopens Results; swipe to delete one scan.
- **M-M5c** "Delete all my data": a confirm dialog with the exact text appears, then the Firestore console shows `users/{uid}` empty (no scans/devices/settings docs), reload shows no cached history, and `fa.deviceId` is gone from localStorage.
- **M-M5d Offline.** Airplane mode after capture. Expected: the scan saves locally and syncs when back online (persistent cache); the app shell loads offline (service worker).

---------------------------------------------------------------------------

## (d) Regression log

| Date | Check | Status | Owner | Notes |
|------|-------|--------|-------|-------|
| 2026-10-10 | G1 tsc --noEmit | FAIL (2) | C | src/ui/screens/processing.ts and src/dev/replay.ts import `pipeline/runPipeline`, which does not exist yet. Clears when C lands it. tests/qa compiles clean. |
| 2026-10-10 | G2 vitest run (all) | 376 pass / 9 fail / 7 skip | C | All 9 failures are tests/qa checks waiting on C's `measure/compute.ts` + `pipeline/runPipeline.ts`. All team suites pass. |
| 2026-10-10 | G5 contract | 52/54 pass | C | Missing C exports: measure/compute.ts and pipeline/runPipeline.ts (levels.ts landed during this cycle). |
| 2026-10-10 | G6 conventions | 17/17 pass | B, C | First run failed makeViewPlane (heightScale 1.0097): root cause was QA's flat-head scene. C's crown-excess model is correct; QA scene updated to a 3D head and now agrees to < 0.2%. |
| 2026-10-10 | G7 spec coverage | 11/11 pass | A, E | |
| 2026-10-10 | G8 invariants | 22/22 pass | all | |
| 2026-10-10 | G9 pipeline E2E | 1/7 pass | C | Scene self-check passes; 6 wait on runPipeline. |
| 2026-10-10 | G10 config files | 33/33 pass | B, E, orch. | Front 35mm-eq lower bound relaxed to 15 mm (Pixel 9 Pro is 17.2 mm). |
| 2026-10-10 | G3 build / G4 bundle | NOT RUN | - | Blocked by G1; bundle tests skip without dist/. |

---------------------------------------------------------------------------

## (e) Per-team feedback

**A auth-data** - all QA checks pass. Notes: ALLOWED_EMAIL fails closed when empty (good). `src/data/convert.ts` round-trips all 23 keys and carries no binary data.

**B device-capture** - all QA checks pass. Notes:
- The focal formula now uses a 4:3 sensor crop (orchestrator-approved). It differs from designdoc section 4 (video diagonal), so the doc should be updated. The height solve corrects either way.
- iOS gravity sign: `normalizeGravity` flips when gy < 0. This must be verified on a real iPhone (M-B3), since a wrong flip silently inverts roll.
- Roll sign is `atan2(-gx, gy)`. QA checks only |roll| and antisymmetry, so the level gauge direction must be checked manually (M-B3).

**C geometry-measure** - geometry passes. Outstanding: `src/measure/levels.ts`, `src/measure/compute.ts`, `src/pipeline/runPipeline.ts` (these also block tsc for E and F). When landing them, run `npx vitest run tests/qa/pipeline-e2e.test.ts`, which checks:
- runPipeline accepts `ImageData` frames + an injected `vision` in Node (no ImageBitmap/canvas needed).
- segmentPerson receives NORMALIZED landmarks.
- `diagnostics.distanceM` is in metres.
- chest/waist/hips are within 3 cm of a 34x24 cm ellipse (91.8 cm), with bust === chest.
- k defaults to 1, uncertainty > 0, alwaysLowConfidence <= 0.7.
- a view with no person is retaken.
- a 5% height error is noticed.

Notes:
- `distanceFromFeet` returns 0 (not NaN) when undeterminable; callers must treat <= 0 as invalid.
- `makeViewPlane` / `solveFocalLength` accept extra optional args (fine; arity unchanged).
- The crown-excess model is not in the design doc; the doc should get a line in section 4.

**D vision** - all QA checks pass (regionCrops returns pixel boxes from normalized landmarks). Manual follow-ups: M-D1 (back-view detection), M-D2 (blur threshold calibration), M-D3 (wrist framing).

**E ui-flow** - all QA checks pass except processing.ts, which is blocked by C. Points for the orchestrator:
- MEASUREMENT_SPECS contains both `chest` (Tops, labelled by body type) and `bust` (Dresses, fixed label "Bust"). A female user sees two "Bust" rows; a male user sees "Chest" plus "Bust". Decide whether the Dresses `bust` row should be hidden for male users, or whether the chest row should keep the rule and `bust` be dropped from Results.
- `src/ui/debug.ts` dynamically imports the dev chunk on any host with `?debug=1` (allowed: lazy chunk, and `debugEnabled()` returns false on production hosts so no UI shows). M-F2 verifies.

**F dev-tools** - all QA checks pass. The bundle check fingerprints F's error strings ("Not a debug capture zip", ...) and replay text ("Replay (dev only)", ...). If they are renamed, tell QA.

### Checks re-run every cycle
G1 tsc, G2 all tests, G3 build, G4 bundle; within G2: contract, conventions, spec-coverage, invariants, pipeline-e2e, config-files. Any new export or contract change must be added to `tests/qa/contract.test.ts` and this file.
