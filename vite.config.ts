/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";

// Design doc section 12. replay.html is served by the dev server only;
// the production build input is index.html alone.
export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === "serve" ? [basicSsl()] : []),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Fashion Assistant",
        short_name: "Fashion Asst",
        description: "Measure your body for clothing, hands-free.",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#111111",
        background_color: "#111111",
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
        navigateFallbackDenylist: [/^\/__\//],
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
  server: { host: true },
  build: {
    rollupOptions: { input: "index.html" },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
}));
