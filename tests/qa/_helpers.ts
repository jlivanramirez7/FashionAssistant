// QA helpers shared by tests/qa/*.test.ts (not a test file itself).
// Modules are imported dynamically by path so that a module that is not
// built yet produces a clear, per-test failure tagged with the owner team
// instead of crashing the whole run (and `tsc --noEmit` stays green while
// files are missing).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(): string {
  try {
    const u = new URL("../..", import.meta.url);
    if (u.protocol === "file:") return resolve(fileURLToPath(u));
  } catch {
    /* fall through (jsdom environment rewrites import.meta.url) */
  }
  return resolve(process.cwd());
}
export const ROOT = findRoot();

export type Team =
  | "A auth-data"
  | "B device-capture"
  | "C geometry-measure"
  | "D vision"
  | "E ui-flow"
  | "F dev-tools"
  | "S server"
  | "A2 client-data"
  | "E2 ui"
  | "orchestrator";

// Loosely typed module namespace: QA checks shapes at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mod = Record<string, any>;

const BS = String.fromCharCode(92); // backslash

export function repoPath(rel: string): string {
  return join(ROOT, rel);
}

export function exists(rel: string): boolean {
  return existsSync(repoPath(rel));
}

export function readText(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

/** Read a repo file or fail with an owner-tagged message. */
export function readOwned(rel: string, team: Team): string {
  if (!exists(rel)) throw new Error(`[${team}] MISSING FILE ${rel} (not built yet?)`);
  return readText(rel);
}

function resolveModule(rel: string): string | null {
  for (const c of [rel, `${rel}.ts`, `${rel}/index.ts`]) {
    const p = repoPath(c);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * Import a module by repo-relative path (e.g. "src/geometry/camera").
 * Throws an Error naming the owner team when the file is missing or its
 * import throws.
 */
export async function loadModule(rel: string, team: Team): Promise<Mod> {
  const abs = resolveModule(rel);
  if (!abs) throw new Error(`[${team}] MISSING MODULE ${rel}.ts (not built yet)`);
  try {
    const spec = abs.split(BS).join("/");
    return (await import(/* @vite-ignore */ spec)) as Mod;
  } catch (err) {
    const e = err as Error;
    throw new Error(`[${team}] ${rel} FAILED TO IMPORT: ${e?.message ?? String(err)}`);
  }
}

/** Get a named export that must be a function, with an owner-tagged error. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fn(mod: Mod, name: string, team: Team, rel: string): (...args: any[]) => any {
  const f = mod[name];
  if (typeof f !== "function") {
    throw new Error(`[${team}] ${rel} must export function ${name} (found ${f === undefined ? "nothing" : typeof f})`);
  }
  return f;
}

/** All files under a repo dir (recursive), repo-relative with forward slashes. */
export function listFiles(relDir: string, filter: (p: string) => boolean = () => true): string[] {
  const base = repoPath(relDir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const r = relative(ROOT, p).split(BS).join("/");
        if (filter(r)) out.push(r);
      }
    }
  };
  walk(base);
  return out;
}

/**
 * Strip comments so static checks do not trip on prose. Conservative on
 * purpose (globs like "**\/*.js" and regex literals like /^\/__\// must
 * survive): removes block comments that start a line, whole-line //
 * comments, and trailing " // ..." comments preceded by whitespace.
 */
export function stripComments(src: string): string {
  return src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([;,{}()\]])\s+\/\/\s.*$/gm, "$1");
}

/** Approximate equality with a readable message. */
export function near(actual: number, expected: number, tol: number, what: string): void {
  if (typeof actual !== "number" || !Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${what}: expected ${expected} +/- ${tol}, got ${actual}`);
  }
}

export const DEG = Math.PI / 180;
export const ALLOWED_EMAIL = "jlivanramirez7@gmail.com";
export const DB_ID = "fashionassitant-db";
export const PROJECT_ID = "fashionassitant";
export const FIREBASEAPP_HOST = "fashionassitant.firebaseapp.com";
