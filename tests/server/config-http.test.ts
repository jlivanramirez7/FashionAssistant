import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROOT, loadConfig, parseEnvFile } from "../../server/config.ts";
import { matchPath, parseCookies, serializeCookie, splitUrl } from "../../server/http.ts";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE, comments, quotes", () => {
    const env = parseEnvFile(
      "# comment\nA=1\n B = two \nC=\"quoted # not comment\"\nD='single'\nE=val # trailing\nEMPTY=\nbad line\r\n",
    );
    expect(env).toEqual({ A: "1", B: "two", C: "quoted # not comment", D: "single", E: "val", EMPTY: "" });
  });
});

describe("loadConfig", () => {
  const file = {
    VITE_GOOGLE_CLIENT_ID: "file-client",
    VITE_ALLOWED_EMAIL: "Owner@Example.com",
    FIRESTORE_DATABASE_ID: "file-db",
    GOOGLE_CLOUD_PROJECT: "file-project",
  };

  it("falls back to the env file and defaults", () => {
    const c = loadConfig({}, "/app", file);
    expect(c.googleClientId).toBe("file-client");
    expect(c.allowedEmail).toBe("owner@example.com");
    expect(c.firestoreDatabaseId).toBe("file-db");
    expect(c.googleCloudProject).toBe("file-project");
    expect(c.dataBackend).toBe("memory");
    expect(c.port).toBe(8080);
    expect(c.distDir).toBe(path.join("/app", "dist"));
    expect(c.cookieSecure).toBe(false);
    expect(c.production).toBe(false);
  });

  it("production defaults: firestore backend, secure cookies", () => {
    const c = loadConfig({ NODE_ENV: "production" }, "/app", {});
    expect(c.dataBackend).toBe("firestore");
    expect(c.cookieSecure).toBe(true);
    expect(c.firestoreDatabaseId).toBe("fashionassitant-db");
    expect(c.googleCloudProject).toBe("fashionassitant");
    expect(c.allowedEmail).toBe("");
  });

  it("process env wins over the file", () => {
    const c = loadConfig(
      {
        GOOGLE_CLIENT_ID: "env-client",
        ALLOWED_EMAIL: "X@Y.com",
        DATA_BACKEND: "memory",
        NODE_ENV: "production",
        PORT: "9090",
        DIST_DIR: "public",
        COOKIE_SECURE: "false",
      },
      "/app",
      file,
    );
    expect(c.googleClientId).toBe("env-client");
    expect(c.allowedEmail).toBe("x@y.com");
    expect(c.dataBackend).toBe("memory");
    expect(c.port).toBe(9090);
    expect(c.distDir).toBe(path.resolve("/app", "public"));
    expect(c.cookieSecure).toBe(false);
  });

  it("reads the real .env.development from the app root", () => {
    const c = loadConfig({}, APP_ROOT);
    expect(c.firestoreDatabaseId).toBe("fashionassitant-db");
    expect(c.dataBackend).toBe("memory");
  });
});

describe("http helpers", () => {
  it("parseCookies", () => {
    expect(parseCookies("a=1; b=x%20y; c=\"q\"; a=2; bad")).toEqual({ a: "1", b: "x y", c: "q" });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("a=%E0%A4%A")).toEqual({ a: "%E0%A4%A" });
  });

  it("serializeCookie", () => {
    expect(serializeCookie("s", "v", { httpOnly: true, secure: true, sameSite: "Lax", maxAgeSec: 60 })).toBe(
      "s=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("matchPath / splitUrl", () => {
    expect(matchPath("/api/scans/:id", "/api/scans/abc")).toEqual({ id: "abc" });
    expect(matchPath("/api/scans/:id", "/api/scans/")).toBeNull();
    expect(matchPath("/api/scans/:id", "/api/scans/a/b")).toBeNull();
    expect(matchPath("/api/me", "/api/me")).toEqual({});
    expect(splitUrl("/a/b?x=1")).toEqual({ pathname: "/a/b", query: "x=1" });
    expect(splitUrl(undefined)).toEqual({ pathname: "/", query: "" });
  });
});
