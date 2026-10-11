// Server configuration (docs/CONTRACTS-v2.md "Configuration").
// process.env wins; otherwise values come from .env.production
// (NODE_ENV=production) or .env.development in the app root, so Cloud Run
// works without service env vars.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DataBackend = "firestore" | "memory";

export interface Config {
  production: boolean;
  googleClientId: string;
  /** Lowercased; empty => nobody can sign in. */
  allowedEmail: string;
  firestoreDatabaseId: string;
  googleCloudProject: string;
  dataBackend: DataBackend;
  port: number;
  distDir: string;
  cookieSecure: boolean;
}

/** App root = parent of server/. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal dotenv parser: KEY=VALUE lines, # comments, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === "") return undefined;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return undefined;
}

/**
 * Build the config. `env` defaults to process.env; `fileEnv` (for tests)
 * replaces reading the .env.* file from `root`.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  root: string = APP_ROOT,
  fileEnv?: Record<string, string>,
): Config {
  const production = env.NODE_ENV === "production";
  const file = fileEnv ?? readEnvFile(path.join(root, production ? ".env.production" : ".env.development"));
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = env[k];
      if (v !== undefined && v !== "") return v;
    }
    for (const k of keys) {
      const v = file[k];
      if (v !== undefined && v !== "") return v;
    }
    return undefined;
  };

  const backendRaw = (get("DATA_BACKEND") ?? "").trim().toLowerCase();
  const dataBackend: DataBackend =
    backendRaw === "firestore" || backendRaw === "memory" ? backendRaw : production ? "firestore" : "memory";

  const portNum = Number(get("PORT") ?? "8080");
  const distRaw = get("DIST_DIR");

  return {
    production,
    googleClientId: (get("GOOGLE_CLIENT_ID", "VITE_GOOGLE_CLIENT_ID") ?? "").trim(),
    allowedEmail: (get("ALLOWED_EMAIL", "VITE_ALLOWED_EMAIL") ?? "").trim().toLowerCase(),
    firestoreDatabaseId: get("FIRESTORE_DATABASE_ID") ?? "fashionassitant-db",
    googleCloudProject: get("GOOGLE_CLOUD_PROJECT") ?? "fashionassitant",
    dataBackend,
    port: Number.isInteger(portNum) && portNum >= 0 && portNum < 65536 ? portNum : 8080,
    distDir: distRaw ? path.resolve(root, distRaw) : path.join(root, "dist"),
    cookieSecure: parseBool(get("COOKIE_SECURE")) ?? production,
  };
}
