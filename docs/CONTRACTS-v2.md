# Contracts v2 - Firestore only, no Firebase (2026-10-10)

The user decided: no Firebase at all. Firestore (`fashionassitant-db`,
project `fashionassitant`) is reached ONLY by a Node server on Cloud Run
using the service account (IAM). Sign-in is Google Identity Services
(GIS). This file overrides docs/CONTRACTS.md for team A (auth-data), the
sign-in parts of team E, and adds team S (server). Teams B, C, D, F are
unchanged. Ground rules from CONTRACTS.md still apply (ownership, no edits
to package.json / tsconfig* / vite.config.ts / src/types.ts / Dockerfile,
report needed changes instead, tests under tests/<area>/).

Installed now: @google-cloud/firestore 9.x, google-auth-library 11.x,
@types/node (server); firebase and firebase-tools are REMOVED. Check the
real APIs in node_modules type definitions before use.

## Architecture

```
Phone (PWA) --HTTPS--> Cloud Run: node server/index.ts
                          |- serves dist/ (static, SPA fallback)
                          |- /api/*  (JSON, session cookie)
                          '- @google-cloud/firestore (service account)
                                 -> Firestore fashionassitant-db
Sign-in: GIS button (redirect ux_mode) -> POST /api/auth/google
```

- Runtime: Node 24 runs `server/index.ts` directly via type stripping.
  Server code must be erasable TypeScript only (no enums, namespaces,
  parameter properties) and use explicit `.ts` extensions in relative
  imports. It may import `../src/types.ts` (type-only imports or the
  plain consts there). No new dependencies: use node:http, node:fs,
  node:crypto, node:path, node:zlib only, plus the two Google libraries.
- Typecheck: `npx tsc --noEmit -p tsconfig.server.json` (covers server/,
  tests/server/, src/types.ts). Client: `npx tsc --noEmit`.

## Configuration (server/config.ts, team S)

Read `process.env` first; fall back to values parsed from `.env.production`
(when NODE_ENV=production) or `.env.development` (otherwise) in the app
root, so Cloud Run works without setting service env vars.
- `GOOGLE_CLIENT_ID` (fallback: VITE_GOOGLE_CLIENT_ID from the env file)
- `ALLOWED_EMAIL` (fallback: VITE_ALLOWED_EMAIL), lowercased; empty => nobody can sign in
- `FIRESTORE_DATABASE_ID` (default "fashionassitant-db")
- `GOOGLE_CLOUD_PROJECT` (default "fashionassitant")
- `DATA_BACKEND` = "firestore" | "memory" (default: firestore when NODE_ENV=production, else memory)
- `PORT` (default 8080), `DIST_DIR` (default "<root>/dist")
- `COOKIE_SECURE` (default true when NODE_ENV=production)

## Auth (team S server side)

- Client loads GIS (`https://accounts.google.com/gsi/client`) and renders
  the official button with `ux_mode: "redirect"` and
  `login_uri: <origin>/api/auth/google`. Google POSTs
  `application/x-www-form-urlencoded` with `credential` (ID token) and
  `g_csrf_token`; Google also sets a `g_csrf_token` cookie. Server checks
  the double-submit CSRF (cookie == body), verifies the ID token with
  google-auth-library `OAuth2Client.verifyIdToken({ idToken, audience:
  GOOGLE_CLIENT_ID })`, requires `email_verified` and
  `email.toLowerCase() === ALLOWED_EMAIL`.
  - success: create a session and 303-redirect to `/`.
  - not allowed: 303-redirect to `/?auth_error=private` (no session).
  - bad token/CSRF: 303 to `/?auth_error=failed`.
- Sessions: random 32-byte id (base64url) in cookie `fa_session`
  (HttpOnly, Secure per config, SameSite=Lax, Path=/, Max-Age 30 days).
  Stored server-side as `sessions/{sha256(id) hex}` = { uid, email,
  createdAt, expiresAt } (memory backend: a Map). uid = Google `sub`.
  Expired or unknown => 401.
- Every `/api/*` route except `/api/auth/google` and `/api/health`
  requires a valid session; additionally re-check the session email
  against ALLOWED_EMAIL on each request (so changing the allowlist logs
  people out).
- State-changing API requests (POST/PUT/PATCH/DELETE other than
  /api/auth/google) must carry header `X-Requested-With: fashion-assistant`
  (cheap CSRF guard with SameSite=Lax); reject otherwise with 403.

## HTTP API (server implements; client src/data calls)

All JSON; errors are `{ "error": "<code>", "message": "<text>" }`.
Timestamps are epoch ms numbers in JSON (server stores Firestore
Timestamps for createdAt/updatedAt/expiresAt).

| Method | Path | Body / response |
|---|---|---|
| GET | /api/health | `{ ok: true }` (no auth) |
| POST | /api/auth/google | GIS redirect target (form), see Auth |
| GET | /api/me | `{ uid, email }` or 401 |
| POST | /api/logout | deletes session, clears cookie, `{ ok: true }` |
| GET | /api/user | `UserDoc` or `null` |
| PATCH | /api/user | body `Partial<UserDoc>` (merge; first write fills email from session, createdAt, units "in", bodyType "unspecified"; `heightCm: null` deletes it) -> `UserDoc` |
| GET | /api/scans | `ScanDoc[]` newest first (with `id`) |
| POST | /api/scans | body `ScanDoc & { clientId?: string }` -> `{ id }`; when clientId is valid it becomes the doc id and a repeat POST with the same clientId is idempotent (returns the same id, no duplicate) |
| GET | /api/scans/:id | `ScanDoc` or 404 |
| PATCH | /api/scans/:id | body `Partial<ScanDoc>` (`tapeMeasurements: null` deletes it) -> `{ ok: true }` |
| DELETE | /api/scans/:id | `{ ok: true }` |
| GET | /api/devices/:deviceId | `Partial<DeviceProfile>` or `null` |
| PUT | /api/devices/:deviceId | body `DeviceProfile` -> `{ ok: true }` |
| GET | /api/settings/correctionFactors | `CorrectionFactors` or `null` |
| PUT | /api/settings/correctionFactors | body `CorrectionFactors` -> `{ ok: true }` |
| DELETE | /api/me/data | deletes users/{uid} and all subcollections + all of this uid's sessions; clears cookie -> `{ ok: true }` |

Server-side validation (pure, unit-tested): body size limit 1 MB;
reject any field that looks like image data (strings > 10 kB, data: URLs,
arrays of numbers > 10k); measurement maps only contain MEASUREMENT_KEYS
with finite numbers; ids match `^[A-Za-z0-9_-]{1,64}$`. Firestore paths
are exactly as designdoc.txt section 11 (users/{uid}, scans, devices,
settings/correctionFactors), with uid = Google sub.

Static serving: dist/ with correct MIME types (incl. .wasm
application/wasm, .webmanifest, .task/.tflite application/octet-stream),
`Cache-Control: no-cache` for index.html and sw.js, immutable for
/assets/*, gzip for text types when accepted, SPA fallback to index.html
for GET requests that are not /api/* and have no file extension. 404 JSON
for unknown /api routes. Path traversal must be impossible.

Backends: `server/store.ts` defines `interface Store` (getUser, patchUser,
listScans, createScan, getScan, patchScan, deleteScan, getDevice,
putDevice, getFactors, putFactors, deleteAllForUser, createSession,
getSession, deleteSession, deleteSessionsForUid); implementations
`server/store-firestore.ts` and `server/store-memory.ts`. Route handlers
take the Store and an injectable `verifyIdToken` so tests never call
Google or GCP.

## Team S - server (owns server/**, tests/server/**)

Files: server/index.ts (startup: config, store, http server, graceful
SIGTERM), server/config.ts, server/http.ts (router, JSON/body helpers,
cookies), server/static.ts, server/auth.ts, server/api.ts (routes),
server/validate.ts, server/store.ts, server/store-memory.ts,
server/store-firestore.ts. Export `createApp(deps): (req, res) => void`
so tests can drive it with node:http on an ephemeral port.

## Team A2 - client data/auth (owns src/config.ts, src/auth/**, src/data/**, tests/auth-data/**)

Delete the Firebase-based implementation; keep the SAME exported function
names/signatures from CONTRACTS.md for src/data/* (the `uid` parameters
stay for compatibility but are ignored - the server uses the session),
implemented with `fetch("/api/...", { credentials: "same-origin" })` and
the `X-Requested-With` header on writes. Keep `validation.ts` (pure)
and `deviceId.ts` unchanged.
- Offline: `saveScan` must not lose a scan. If offline or the request
  fails with a network error, assign a client id (`crypto.randomUUID()`
  style, matching the id regex), store the scan in a localStorage outbox
  ("fa.outbox"), return the id, and flush the outbox (POST /api/scans with body including `clientId`;
  the server uses it as the doc id, so retries are idempotent) on `online` events and
  app start. Other writes may simply fail with a clear error offline.
- `src/config.ts`: `GOOGLE_CLIENT_ID` (VITE_GOOGLE_CLIENT_ID),
  `ALLOWED_EMAIL`, `APP_VERSION`, `isAuthConfigured(): boolean`
  (client id non-empty). Remove firebaseConfig / FIRESTORE_DATABASE_ID /
  isFirebaseConfigured.
- `src/auth/authGuard.ts` (replaces the Firebase version):
  - `PRIVATE_MESSAGE` = "This app is private."
  - `readAuthError(): "private" | "failed" | null` (from `?auth_error=`, then removes it from the URL with history.replaceState)
  - `renderSignInButton(container: HTMLElement): Promise<void>` (loads GIS script once, `google.accounts.id.initialize({ client_id, ux_mode: "redirect", login_uri: location.origin + "/api/auth/google", auto_select: false })`, `renderButton(container, { theme: "filled_black", size: "large", text: "signin_with", shape: "pill" })`)
  - `getCurrentUser(): Promise<{ uid: string; email: string } | null>` (GET /api/me; 401 => null)
  - `signOutUser(): Promise<void>` (POST /api/logout; then `google.accounts.id.disableAutoSelect()` if loaded)
  - `isAllowed(user)` stays as a pure helper.
  - Remove: finishRedirect, signIn, watchAuth, getFirebase, _forgetFirestore.
- `src/data/deleteAll.ts`: `deleteAllMyData(uid)` -> DELETE /api/me/data, then clear outbox + clearDeviceId(); throws when offline.

## Team E2 - UI changes (owns src/main.ts, src/ui/**, src/flow/**, tests/ui-flow/**)

- main.ts: if `!isAuthConfigured()` show "Sign-in is not configured yet -
  set VITE_GOOGLE_CLIENT_ID (Google Cloud console > APIs & Services >
  Credentials > OAuth client ID)". Else: `readAuthError()` (show
  PRIVATE_MESSAGE for "private", a retry message for "failed"), then
  `getCurrentUser()`; null => Sign-in screen; else Home.
- Sign-in screen: call `renderSignInButton(container)`; no own button.
- Sign out: `signOutUser()` then go to Sign-in.
- Remove every Firebase reference/import. Delete-all: on success reload.
- Keep all other behaviour.
