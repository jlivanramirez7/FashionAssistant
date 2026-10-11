// Entry point: `node server/index.ts` (Node 24 type stripping).
// Serves dist/ and the JSON API; shuts down gracefully on SIGTERM
// (Cloud Run gives ~10 s before SIGKILL).
import { createServer } from "node:http";
import { createApp, defaultLog } from "./api.ts";
import { createGoogleVerifier } from "./auth.ts";
import { loadConfig } from "./config.ts";
import type { Store } from "./store.ts";
import { MemoryStore } from "./store-memory.ts";

const SHUTDOWN_GRACE_MS = 8000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = defaultLog;

  let store: Store;
  if (config.dataBackend === "firestore") {
    // Loaded lazily so local memory-backend runs never touch GCP.
    const { createFirestoreStore } = await import("./store-firestore.ts");
    store = createFirestoreStore({ projectId: config.googleCloudProject, databaseId: config.firestoreDatabaseId });
  } else {
    store = new MemoryStore();
  }

  if (!config.googleClientId) log("WARNING", "GOOGLE_CLIENT_ID / VITE_GOOGLE_CLIENT_ID is empty: sign-in will fail");
  if (!config.allowedEmail) log("WARNING", "ALLOWED_EMAIL / VITE_ALLOWED_EMAIL is empty: nobody can sign in");
  if (config.dataBackend === "memory" && config.production) log("WARNING", "memory backend in production: data is lost on restart");

  const app = createApp({ config, store, verifyIdToken: createGoogleVerifier(), log });
  const server = createServer(app);
  // Cloud Run's front end keeps connections alive for up to 600 s.
  server.keepAliveTimeout = 620_000;
  server.headersTimeout = 621_000;

  server.listen(config.port, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : config.port;
    log(
      "INFO",
      `listening on :${port} (backend=${config.dataBackend}, db=${config.firestoreDatabaseId}, project=${config.googleCloudProject}, dist=${config.distDir})`,
    );
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("INFO", `${signal} received, shutting down`);
    const force = setTimeout(() => {
      log("WARNING", "forced exit after grace period");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(() => {
      store
        .close()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(force);
          process.exit(0);
        });
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  defaultLog("ERROR", `startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
