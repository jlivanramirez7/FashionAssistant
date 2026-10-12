/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json" with { type: "json" };

// Design doc section 12. replay.html is served by the dev server only;
// the production build input is index.html alone.
export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === "serve" ? [basicSsl()] : []),
    VitePWA({
      // "prompt": a new version waits until src/main.ts applies it on a safe
      // screen (never mid-scan) instead of only on a later cold start.
      registerType: "prompt",
      manifest: {
        name: "Fashion Assistant",
        short_name: "Fashion Asst",
        description: "Measure your body for clothing, hands-free.",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#0d0d10",
        background_color: "#0d0d10",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,json,png,svg}"],
        // Dev-only debug chunks never run in production; wasm loaders
        // are cached on first use by the runtime rule below.
        globIgnores: ["**/debugCapture-*.js", "**/debug-*.js", "**/wasm/**"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/models/") || url.pathname.startsWith("/wasm/"),
            handler: "CacheFirst",
            options: { cacheName: "mediapipe-assets", expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
  // Version (package.json, bumped with every release) and build stamp,
  // shown on Home and in troubleshooting reports.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  server: { host: true, proxy: { "/api": "http://localhost:8080" } },
  build: {
    rollupOptions: { input: "index.html" },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
}));
