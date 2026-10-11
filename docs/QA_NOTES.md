# QA notes - Fashion Assistant (living checklist)

Owner: QA agent. QA owns only `tests/qa/**` and this file. Spec: `designdoc.txt`;
contracts: `docs/CONTRACTS-v2.md` (binding; v2 = no Firebase, Node server is the
only Firestore client) on top of `docs/CONTRACTS.md` (teams B, C, D, F unchanged);
shared types: `src/types.ts`.

Every verification cycle runs, in this order (build BEFORE the full test run,
because `vitest run` includes the bundle checks whenever dist/ exists, and a
stale dist/ gives false failures):

```
npm run typecheck                # G1 - client tsc + server tsc (tsconfig.server.json), zero errors
npm run build                    # G3 - typecheck + vite build (creates dist/)
npx vitest run                   # G2 - all unit tests, all teams + tests/qa (incl. G4 bundle)
npx vitest run tests/qa/bundle.test.ts   # G4 - bundle checks on the fresh dist/
```

A failing QA test always names its owner team in brackets, e.g.
`[C geometry-measure] MISSING MODULE src/pipeline/runPipeline.ts`.

---------------------------------------------------------------------------

## (a) Automated gates that must always pass

| # | Gate | Command / file | Pass condition |
|---|------|----------------|----------------|
| G1 | Typecheck | `npm run typecheck` | 0 errors in both tsconfigs (tests/ is in the client tsconfig - QA files must compile too) |
| G2 | Unit tests | `npx vitest run` | 0 failures across `tests/**` |
| G3 | Production build | `npm run build` | exits 0; `dist/index.html`, `dist/sw.js`, `*.webmanifest` exist |
| G4 | Bundle checks | `tests/qa/bundle.test.ts` | all pass (invariants I13) |
| G5 | Contract | `tests/qa/contract.test.ts` | every export in CONTRACTS(-v2).md exists with the right kind and arity; removed v1 exports are gone |
| G6 | Conventions | `tests/qa/conventions.test.ts` | B -> C geometry chain reproduces a known scene |
| G7 | Spec coverage | `tests/qa/spec-coverage.test.ts` | all 23 keys specified, labelled, grouped, mapped (server Firestore mapping), validated |
| G8 | Invariants | `tests/qa/invariants.test.ts` | privacy, dev code, mirroring, GIS + /api client wiring, server static rules |
| G9 | Pipeline E2E | `tests/qa/pipeline-e2e.test.ts` | synthetic scene measured within targets |
| G10 | Config files | `tests/qa/config-files.test.ts` | no Firebase, deny-all rules, Dockerfile (Node 24), env, scripts, tsconfigs, vite, icons, device profiles |
| G11 | Server API | `tests/qa/server-api.test.ts` | real HTTP against `createApp` (memory store, fake verifier): auth, CSRF, cookie, routes, idempotency, validation, static, security headers |
| G12 | Client x server | `tests/qa/client-server.test.ts` | CLIENT src/data + src/auth driven against the real routes via a fetch shim; outbox end to end |

QA test files (`tests/qa/`): `_helpers.ts` (dynamic, owner-tagged module loading),
`_scene.ts` (independent ground-truth pinhole scene + synthetic person),
`_server.ts` (starts server `createApp` with the memory store + fake GIS verifier,
raw HTTP client, cookie-jar fetch shim with an offline switch, CONTRACTS-v2 route
table), and `contract`, `conventions`, `spec-coverage`, `invariants`,
`pipeline-e2e`, `config-files`, `server-api`, `client-server`, `bundle` (`*.test.ts`).

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
- I6b Feet convention (orchestrator, approved): heel and foot-index landmarks are FLOOR-CONTACT points (flat-footed). The feet row's absolute height comes from the mask's bottom edge near the feet; landmarks only give the heel->toe offset (read as foot depth; floor point under the ankle = heel + 0.2 x (toe - heel)). Side view: the lowest mask point is the near foot's outer edge, assumed 0.025 x H nearer than the body plane. Gain: 1 cm of feet-row height error is about 18 cm of distance, so never take the feet row from landmark heights. QA scene: heel/toe Y = 0; the pipeline gives front/back within 2 cm and side within 5 cm. - C - pipeline-e2e.
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
- I10c2 One chest/bust row (orchestrator decision): `isVisibleKey` hides ONLY `bust`. Results, Home, Copy all and the S9 fields show one `chest` row labelled by bodyType, and chest falls back to a stored bust value. `bust` is still computed and stored in Firestore. S9 saves the chest tape value under BOTH `chest` and `bust`; with no chest value there is no bust value. `TAPE_KEYS` excludes bust and height. - E - spec-coverage.
- I10d Confidence colours: >= 0.75 green, >= 0.5 amber, else red (NaN = red). `alwaysLowConfidence` keys (wrist, footLength) have confidence <= 0.7. - E, C - spec-coverage, pipeline-e2e.
- I10e k defaults to 1.0: null factors or a missing key means measurements equal raw. Factors apply per bodyType to `measurements` only; `rawMeasurements` stay uncorrected. `computeCorrectionFactors` uses tape/RAW (not corrected values), circumferences only, and needs >= minScans samples. - C, A - pipeline-e2e, spec-coverage.
- I10f Uncertainty > 0 for every measured key when the device has no `distortionK1` (distortion term), even if frames agree exactly. - C - pipeline-e2e.
- I10g Units: 2.54 cm per inch exactly; inches rounded to the nearest 0.25". - E - spec-coverage.

**Privacy and data (v2: A2 client, S server)**
- I11a No image ever leaves the device:
  - Client: no sendBeacon/XHR/WebSocket; no Firebase or server SDKs in the client; `fetch` only in src/data + src/auth (same-origin `/api`) and for static assets (device-profiles.json, MediaPipe); no image types in `src/data/**`; the only external origin in client code is https://accounts.google.com (GIS).
  - Outbox (`fa.outbox`): numbers only.
  - Server: rejects image-like data with 4xx JSON (data: URLs, strings > 10 kB, number arrays > 10k, bodies > 1 MB, unknown measurement keys, non-numeric measurement values, bad ids).
  - Firestore mapping (`server/store-firestore.ts`): plain data only.
  - Enforced by invariants, server-api, spec-coverage, client-server.
- I11b Firestore is reached ONLY by the server:
  - `@google-cloud/firestore` is imported only in `server/store-firestore.ts`, which uses `databaseId` (`fashionassitant-db`, server-only env, never `VITE_`).
  - Paths follow section 11: `users/{uid}/scans|devices|settings/correctionFactors`, plus top-level `sessions/{sha256 hex}`; uid = Google `sub`.
  - The client bundle contains no db id, no Firebase and no server libraries.
  - Enforced by invariants, config-files, bundle.
- I11c Allowlist (server-side is the real check):
  - Server: `verifyIdToken` with audience = GOOGLE_CLIENT_ID; requires `email_verified` and lowercased email === ALLOWED_EMAIL; an empty ALLOWED_EMAIL means nobody can sign in. The email is re-checked on every request.
  - Client `isAllowed`: a pure helper with the same truth table; fails closed.
  - Enforced by server-api, invariants.
- I11d Sign-in flow: GIS button with `ux_mode: "redirect"`, `login_uri: <origin>/api/auth/google`, `auto_select: false`, script `https://accounts.google.com/gsi/client`. The server POST handler responds with a 303 redirect:
  - Allowed account: `/` plus a `fa_session` cookie.
  - Another account: `/?auth_error=private`, no session.
  - Bad token or CSRF (double-submit `g_csrf_token` cookie == body): `/?auth_error=failed`, no session.
  - `readAuthError()` maps `private`/`failed` and strips `auth_error` via `history.replaceState`.
  - main.ts: `isAuthConfigured()` (setup hint naming VITE_GOOGLE_CLIENT_ID), then `readAuthError()`, then `getCurrentUser()`.
  - Enforced by server-api, invariants.
- I11e Session cookie: `fa_session` = 32 random bytes in base64url (43 chars); HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000, Secure in production. Stored server-side by sha256. Logout and delete-all invalidate it server-side; unknown or forged cookies get 401. - server-api, invariants. **Manual: M-M0e, M-M0f.**
- I11f CSRF on the API: every POST/PUT/PATCH/DELETE except `/api/auth/google` needs `X-Requested-With: fashion-assistant` (403 otherwise). The client sends it on every write with `credentials: "same-origin"`. - server-api, client-server, invariants.
- I11g Route contract: every request the client makes matches the CONTRACTS-v2 route table (method + path). All protected routes return 401 without a session; unknown `/api` routes return 404 JSON `{ error, message }`. - client-server, server-api.
- I11h Offline outbox:
  - Offline, `saveScan` returns a client id matching `^[A-Za-z0-9_-]{1,64}$` and stores the scan in `fa.outbox`.
  - On `online` (and at app start) it POSTs `/api/scans` with `clientId`. The server uses clientId as the doc id, so a re-flush creates no duplicate.
  - The outbox is emptied after success.
  - Enforced by client-server, server-api.
- I11i Delete all: `DELETE /api/me/data` removes users/{uid} and all subcollections plus ALL of that uid's sessions (other devices are logged out too). The client then clears the outbox and `fa.deviceId`. Throws when offline. - server-api, client-server. **Manual: M-M5c.**
- I11j deviceId: a v4 UUID in localStorage `fa.deviceId`, stable until cleared. - invariants.
- I11k Server static serving:
  - MIME types: .wasm application/wasm, .webmanifest application/manifest+json, .task/.tflite application/octet-stream.
  - Caching: no-cache for index.html and sw.js; immutable for /assets/*.
  - gzip for text types when accepted.
  - SPA fallback only for extension-less non-/api GETs.
  - Path traversal is impossible (encoded `..`, `%2f`, `%5c` tried).
  - Enforced by server-api.
- I11l Security headers on HTML:
  - Content-Security-Policy with script-src allowing https://accounts.google.com and `'wasm-unsafe-eval'`; frame-src and style-src allowing https://accounts.google.com; connect-src 'self'; no wildcard script source.
  - `X-Content-Type-Options: nosniff`.
  - NO `Cross-Origin-Opener-Policy: same-origin` (breaks GIS).
  - Enforced by server-api.
- I11m Server code runs on Node 24 type stripping: erasable syntax only; relative imports end in `.ts`; it imports only node:* modules, `@google-cloud/firestore`, `google-auth-library`, sibling server files and `src/types.ts`. - invariants, tsconfig.server.json (G1).

**Rules and deployment files (orchestrator)**
- I12a firestore.rules: rules_version '2', one catch-all `match /{document=**} { allow read, write: if false; }`, nothing else. The server's service account bypasses rules via IAM. - config-files. **Manual: M-M0j (rules actually deployed to the named db).**
- I12b Firebase is gone: no firebase.json, .firebaserc, firestore.indexes.json or nginx.conf; no firebase package (package.json or node_modules); no "firebase" in src/ or server/ code. - config-files, bundle.
- I12c Dockerfile:
  - Build stage: two node:24 stages; scripts copied before `npm ci`; `npm run build`; the asset verify step (`test -s` on the 3 models and `dist/wasm/*.wasm`) runs after the build; `npm prune --omit=dev`.
  - Runtime stage: NODE_ENV=production, PORT=8080, EXPOSE 8080, `USER node`; copies dist, server, src/types.ts, .env.production, node_modules and package.json; `CMD ["node","server/index.ts"]`; no nginx.
  - .dockerignore keeps server/src/scripts/.env.production.
  - Enforced by config-files.
- I12d vite.config:
  - `navigateFallbackDenylist: [/^\/api\//]`; dev proxy `/api -> http://localhost:8080`.
  - globIgnores debugCapture/debug/wasm; build input index.html only.
  - Manifest standalone + portrait + maskable icon; models/wasm runtime CacheFirst.
  - Enforced by config-files.
- I12e Env files: VITE_GOOGLE_CLIENT_ID (public; a `*.apps.googleusercontent.com` id when set), VITE_ALLOWED_EMAIL, FIRESTORE_DATABASE_ID and GOOGLE_CLOUD_PROJECT (server-only, never VITE_); no Firebase keys; no secrets (no client_secret/GOCSPX). `.env.development` has `DATA_BACKEND=memory`; production defaults to firestore. - config-files.
- I12f Server config defaults: database `fashionassitant-db`, project `fashionassitant`, PORT 8080, memory backend outside production; falls back to `.env.production`/`.env.development`; ALLOWED_EMAIL lowercased. - invariants.
- I12g Scripts: `typecheck` runs both tsconfigs; `build` = `npm run typecheck && vite build`; `start` = `node server/index.ts`; no `deploy:rules`. - config-files.

**Dev-only code (E, F)**
- I13a No static import of `src/dev/**` or `fflate` outside src/dev. The only dynamic import (`src/ui/debug.ts`) is guarded by `import.meta.env.DEV || ?debug=1`, and `debugEnabled()` also checks the host. - invariants.
- I13b Bundle:
  - replay.html and replay code are never in dist.
  - debugCapture/fflate exist ONLY in a lazily loaded chunk, never reachable statically from the entry chunk.
  - sw.js denies `/api/` navigations and precaches no models, no wasm loaders and no dev chunks.
  - No Firebase, server libraries, db id or client secret; GIS URL, `/api/auth/google` and the allowed email are present.
  - The 3 models and the wasm ship in dist; entry static graph < 1.5 MiB.
  - Enforced by bundle.test.ts.
- I13c Spoken and on-screen text never says "turn left/right" (it names the body part facing the phone). - invariants.

---------------------------------------------------------------------------

## (c) Manual device tests (human, on a phone)

Record the result of each run in the regression log (d). "Pass" means every expected result happened.

### M0 - scaffolding, sign-in, deploy (v2: GIS + Node server, no Firebase)
- **M-M0a OAuth client setup.**
  1. In Google Cloud console > APIs & Services > OAuth consent screen, publishing status "Testing" with test user jlivanramirez7@gmail.com (or In production).
  2. Under Credentials > Create OAuth client ID > Web application, set Authorized JavaScript origins = `https://<run.app host>` and `http://localhost:5173`/`https://localhost:5173` (and the LAN dev host if used). Authorized redirect URIs are NOT needed for the GIS redirect flow, since `login_uri` is checked against the origins; if GIS reports `redirect_uri_mismatch`, add `https://<host>/api/auth/google`.
  3. Put the client id (`...apps.googleusercontent.com`, public) in VITE_GOOGLE_CLIENT_ID in .env.production and .env.development. Never put a client secret anywhere.

  Expected: the app shows the GIS "Sign in with Google" button, not the "not configured" hint.
- **M-M0b Cloud Run service account.**
  1. `gcloud run services describe fashion-assistant --region us-central1 --format='value(spec.template.spec.serviceAccountName)'`.
  2. That account has `roles/datastore.user` on project fashionassitant (`gcloud projects get-iam-policy fashionassitant`).
  3. Prefer a dedicated SA (`--service-account fa-run@...`) over the default compute SA, which is Editor.

  Expected: `/api/health` returns `{ok:true}`; after sign-in, saving a scan writes `users/<sub>/scans/<id>` in database **fashionassitant-db** (not "(default)") and the Cloud Run logs show no PERMISSION_DENIED.
- **M-M0c iOS installed PWA sign-in.**
  1. In iPhone Safari open the URL, then Share > Add to Home Screen.
  2. Open the icon and tap Sign in with Google (jlivanramirez7@gmail.com).

  Expected: Google's page opens and returns to the installed app (not a Safari tab), signed in, showing Home. Sign out, then sign in again: same result. If iOS opens the redirect in Safari instead of the PWA, record it: the cookie then lands in Safari's jar, not the PWA's.
- **M-M0d Android Chrome sign-in.** Same as M-M0c in Chrome, both in a tab and as an installed app. Expected: signed in, Home shown.
- **M-M0e Refuse another account.** Sign in with another Google account. Expected:
  - The app shows "This app is private." (`?auth_error=private`, then the URL is cleaned).
  - No `fa_session` cookie is set (DevTools > Application > Cookies).
  - `curl https://<host>/api/scans` returns 401.
  - Firestore has no users/{sub} doc and no session doc for that account.
- **M-M0f Cookie persistence and logout.** Sign in, close the app/PWA completely, reopen the next day. Expected:
  - Still signed in (30-day `fa_session`, HttpOnly, Secure, SameSite=Lax).
  - Sign out: cookie cleared, the sessions/{hash} doc deleted, reopen shows Sign in.
  - Remove the allowlist email on the server env and redeploy: the existing session gets 401 on the next request.
- **M-M0g Budget alert** exists in Billing > Budgets (10 USD, 50%/100%).
- **M-M0h Not configured.** Build with an empty VITE_GOOGLE_CLIENT_ID. Expected: the "Sign-in is not configured yet - set VITE_GOOGLE_CLIENT_ID ..." message, no crash.
- **M-M0i Security headers in production.** `curl -sI https://<host>/` shows Content-Security-Policy (accounts.google.com in script/frame/style, 'wasm-unsafe-eval'), `X-Content-Type-Options: nosniff`, and no `Cross-Origin-Opener-Policy: same-origin`. In the browser console there are no CSP violations during sign-in or during Processing (MediaPipe wasm + models).
- **M-M0j Deny-all rules deployed.** The Firestore console (database fashionassitant-db) > Rules shows the deny-all rules. The Firebase CLI is gone, so paste them in the console or use the Rules API. A database created with gcloud may have different default rules, so check rather than assume.
- **M-M0k Models served in production.** `curl -sI https://<host>/models/pose_landmarker_heavy.task` returns 200, application/octet-stream, about 30 MB; `/wasm/vision_wasm_internal.wasm` returns application/wasm. The Docker build fails if the models are missing (asset verify step).

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
- **M-M5c** "Delete all my data": a confirm dialog with the exact text appears. Afterwards:
  - The Firestore console shows `users/{sub}` empty (no scans/devices/settings docs) and no `sessions` docs for that sub.
  - The app reloads to Sign in, and a second signed-in device is logged out too.
  - `fa.deviceId` and `fa.outbox` are gone from localStorage.
- **M-M5d Offline.** Turn on airplane mode after capture. Expected:
  - Results show and the scan sits in `fa.outbox` (DevTools > Application > Local Storage); the app shell loads offline (service worker).
  - Back online: the scan appears once in History and once in Firestore (doc id = the client id).
  - Toggle airplane mode twice more: still exactly one copy.

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
| 2026-10-10 (cycle 2) | G1 tsc --noEmit | PASS (0 errors) | all | Re-run at the end after E/C file changes: still 0. |
| 2026-10-10 (cycle 2) | G2 vitest run (all) | PASS 458/458, 32 files | all | First run in this cycle: 2 pipeline-e2e failures (front distance 2.88 m; front flagged for retake). Root cause: QA scene heel Y = 2 cm vs the new floor-contact convention; scene fixed to Y = 0, side tolerance set to 5 cm. |
| 2026-10-10 (cycle 2) | QA suite tests/qa | PASS 155/155 | all | +2 chest/bust tests (isVisibleKey, S9 tape mirror), +2 bundle tests (models shipped, precache report). |
| 2026-10-10 (cycle 2) | G3 npm run build | PASS | - | Built in 2.5 s; Vite warns firebase chunk 635 kB (> 500 kB); 45 precache entries (1.9 MB). |
| 2026-10-10 (cycle 2) | G4 bundle | PASS 9/9 | E, F, orch. | No replay in dist; debugCapture + fflate only in the lazy chunk `debugCapture-*.js`; sw.js has the /__/ denylist; db id + email baked in; models + wasm present. WARN: debugCapture-*.js, debug-*.js and wasm/*.js loaders are in the SW precache. |
| 2026-10-10 (cycle 2) | Smoke: vite preview :4173 (HTTPS via basicSsl) | PASS | - | / 200 text/html; /sw.js 200 text/javascript; /manifest.webmanifest 200 application/manifest+json; /device-profiles.json 200 application/json (9 KB); /wasm/vision_wasm_internal.wasm 200 application/wasm; HEAD /models/pose_landmarker_lite.task 200, 5.78 MB, NO content-type (nginx will send application/octet-stream - fine). /__/auth/handler returns index.html in preview (expected: no proxy; nginx handles it in production, manual test M-M0a). |
| 2026-10-10 (v2 phase 1) | G1 typecheck (client + server tsconfig) | PASS (0 errors) | all | Run while A2/E2/S were still writing. |
| 2026-10-10 (v2 phase 1) | QA suite excl. bundle | PASS 183/183, 8 files | all | New: server-api (live HTTP, memory store + fake GIS verifier), client-server (A2 modules against the real routes, outbox end to end), v2 config-files/contract/invariants. Bundle test NOT run: dist/ is the stale v1 (Firebase) build, so rebuild first (G3). |
| 2026-10-10 (v2 phase 1) | Server API: unauthenticated DELETE with a JSON body | NOTE | S | `DELETE /api/scans/abc` with body `{}` and no session returned 400 (body rejected) before the 401 auth check. Without a body it is 401. Harmless, but auth should run before body validation. |
| 2026-10-10 (v2 cycle 3) | QA harness fix | FIXED | QA | `_server.ts raw()` sent bodies without Content-Length, so Node's parser rejected a DELETE body with 400 before the app ran. That was my bug, not S's. Now sets Content-Length; server-api sends `{}` on every non-GET and confirms 401 comes before body parsing. The v2-phase-1 NOTE above is withdrawn. |
| 2026-10-10 (v2 cycle 3) | G1 npm run typecheck | PASS (0 errors) | all | client + server tsconfig |
| 2026-10-10 (v2 cycle 3) | G3 npm run build | PASS | - | Built in 1.2 s; no chunk-size warning (firebase gone); precache 40 entries / 281 KiB (was 1.9 MB: wasm loaders + dev chunks now excluded); dist 89 MB (models 51 MB + wasm 38 MB). |
| 2026-10-10 (v2 cycle 3) | G2 npx vitest run | PASS 599/599, 40 files | all | QA suite 192/192 (9 files) incl. server-api, client-server, bundle. |
| 2026-10-10 (v2 cycle 3) | G4 bundle | PASS 9/9 | all | No firebase/server libs/db id/secret in dist; GIS URL + /api/auth/google present; sw denies /api/; no dev chunks or wasm precached; models + wasm in dist. |
| 2026-10-10 (v2 cycle 3) | Smoke: `NODE_ENV=production DATA_BACKEND=memory COOKIE_SECURE=false PORT=18431 node server/index.ts` | PASS | S | Starts with an empty VITE_GOOGLE_CLIENT_ID (WARNING logged, no crash). Responses: `/api/health` 200 `{"ok":true}`; `/` 200 text/html no-cache; `/sw.js` 200 no-cache; `/manifest.webmanifest` 200 application/manifest+json; `/device-profiles.json` 200; HEAD models 200 application/octet-stream (5.8 / 30.7 / 16.4 MB); `/wasm/vision_wasm_internal.wasm` 200 application/wasm; `/assets/*.js` gzip + immutable; `/api/me` 401 JSON; `/history` SPA 200; `/../package.json` and `/%2e%2e/package.json` 404. Headers on /: CSP (script-src 'self' 'wasm-unsafe-eval' accounts.google.com; frame/style/connect/form-action allow accounts.google.com; object-src none; frame-ancestors none), nosniff, X-Frame-Options DENY, Referrer-Policy; NO COOP. Unauthenticated `/api/nope` returns 401 (auth runs before routing); with a session it returns 404 JSON. |
| 2026-10-10 (cycle 2) | dist size | 89 MB | orch. | public/ is copied into dist: models 51 MB (3 files), wasm 38 MB (6 files incl. nosimd), assets 974 KB. Models are served in production only if `npm ci` inside Docker downloads them (setup-assets only warns on failure). |

---------------------------------------------------------------------------

## (e) Per-team feedback

**A2 client-data (v2)** - all QA checks pass, including the live round trip against the server (user, scans with all 23 keys + tape, devices, factors, getCurrentUser, signOutUser, deleteAllMyData) and the offline outbox (`fa.outbox`, clientId, flush on `online`, idempotent re-flush, emptied after success). Notes:
- `readAuthError` maps unknown `auth_error` values to "failed" (acceptable).
- Firebase files and exports are removed.

**S server (v2)** - all QA checks pass: auth/CSRF/cookie, 401/403 rules (auth before body parsing, confirmed after the QA harness fix), idempotent clientId, image-data rejection, delete-all incl. sessions, static MIME/cache/gzip/SPA/traversal, CSP + no COOP. The production-mode smoke run passes. Optional: no `Strict-Transport-Security` header; Cloud Run is HTTPS-only, so it is low value.

**A auth-data (v1, superseded by A2)** - ALLOWED_EMAIL fails closed when empty. The Firestore mapping now lives in `server/store-firestore.ts` (round-trips all 23 keys, plain data only).

**B device-capture** - all QA checks pass. Notes:
- The focal formula now uses a 4:3 sensor crop (orchestrator-approved). It differs from designdoc section 4 (video diagonal), so the doc should be updated. The height solve corrects either way.
- iOS gravity sign: `normalizeGravity` flips when gy < 0. This must be verified on a real iPhone (M-B3), since a wrong flip silently inverts roll.
- Roll sign is `atan2(-gx, gy)`. QA checks only |roll| and antisymmetry, so the level gauge direction must be checked manually (M-B3).

**C geometry-measure** - [cycle 2: ALL PASS, including pipeline-e2e on the synthetic scene.] Cycle-1 note kept for history: outstanding were `src/measure/levels.ts`, `src/measure/compute.ts`, `src/pipeline/runPipeline.ts`. pipeline-e2e checks:
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

**E ui-flow** - [cycle 2: ALL PASS; chest/bust duplication resolved per orchestrator decision, invariant I10c2.] Cycle-1 notes:
- MEASUREMENT_SPECS contains both `chest` (Tops, labelled by body type) and `bust` (Dresses, fixed label "Bust"). A female user sees two "Bust" rows; a male user sees "Chest" plus "Bust". Decide whether the Dresses `bust` row should be hidden for male users, or whether the chest row should keep the rule and `bust` be dropped from Results.
- `src/ui/debug.ts` dynamically imports the dev chunk on any host with `?debug=1` (allowed: lazy chunk, and `debugEnabled()` returns false on production hosts so no UI shows). M-F2 verifies.

**F dev-tools** - all QA checks pass. The bundle check fingerprints F's error strings ("Not a debug capture zip", ...) and replay text ("Replay (dev only)", ...). If they are renamed, tell QA.

### Open decisions for the orchestrator (cycle 2)
1. **Models may silently be missing in production.** `scripts/setup-assets.mjs` only warns when a download fails, and .dockerignore excludes public/models, so the Cloud Build image depends on network during `npm ci`. Suggestion: an `npm run verify-assets` step in the Dockerfile after `npm run build` that fails if dist/models/*.task|*.tflite or dist/wasm/*.wasm are missing. The bundle test checks this locally only.
2. **SW precaches dev-only code.** `debugCapture-*.js` (fflate) and `debug-*.js` are downloaded by every production client. They are not executed, so this is not a rule violation. Suggestion (vite.config.ts): `workbox.globIgnores: ["**/debugCapture-*.js", "**/debug-*.js", "wasm/**"]` (the wasm loaders are already runtime-cached CacheFirst). Each manifest icon is also listed twice in the precache; harmless.
3. **Firebase chunk is 635 kB** (Vite > 500 kB warning). Acceptable for v1; it is lazily imported, not in the entry graph.
4. **Side-view foot offset.** C assumes the near-foot edge is 0.025 H (about 4.4 cm) in front of the body plane, which is half a foot width. With the feet together the outer edge is closer to one foot width (about 9-10 cm) from the midline. Impact: about 2% on side-view distance, which affects only `scaleAgreementPct`, not measurements (they are height-scaled). Validate on device or replay (M-M2b).

Status of the cycle-2 decisions under v2:
- 1: done (Dockerfile asset verify).
- 2: done (globIgnores; now a hard bundle check).
- 3: moot (no Firebase).
- 4: still open.

### Open decisions for the orchestrator (v2)
5. **Rules deployment path.** firebase-tools is gone, so nothing in the repo deploys `firestore.rules` to `fashionassitant-db`. Either document a console/REST step (manual test M-M0j) or drop the file. The server's service account bypasses rules anyway; the rules only matter if someone ever ships a client SDK.
6. **Cloud Run service account.** `npm run deploy` does not pass `--service-account`, so Cloud Run uses the default compute SA (project Editor). Suggest a dedicated SA with only `roles/datastore.user` (M-M0b).
7. **iOS installed-PWA redirect.** The GIS redirect is a top-level POST to `/api/auth/google`. On some iOS versions the home-screen app opens Google sign-in in Safari, so the cookie would land in Safari's jar. This must be verified on a device (M-M0c) before M0 exit.

### Checks re-run every cycle
G1 typecheck (both tsconfigs), G3 build, G2 all tests, G4 bundle; within G2: contract, conventions, spec-coverage, invariants, pipeline-e2e, config-files, server-api, client-server. Then a smoke run of `npm start` (or `vite preview`) serving dist. Any new export, route or contract change must be added to `tests/qa/contract.test.ts` / `_server.ts` ROUTES and this file.
