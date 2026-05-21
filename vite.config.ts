import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Read the version once at build time so the UI's title-bar version
// chip is always synced to package.json. Avoids the "v2.1 hardcoded
// from an early mockup" trap.
const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Inject the package.json version as a compile-time constant so the
  // UI can show it without bundling all of package.json.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Build-time chunking. Splitting React + Tauri SDKs into separate
  // vendor chunks does two things:
  //   1. The main app chunk shrinks and re-parses faster on cold start
  //      (matters on weak CPUs — V8 parse cost is roughly linear in bytes).
  //   2. Edits to App.tsx invalidate only the app chunk, so when running
  //      under `tauri dev` the browser keeps the parsed vendor chunks
  //      cached and HMR is snappier.
  // Defined inline (not as a function) so Rollup tree-shakes properly.
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react/jsx-runtime"],
          "vendor-tauri": [
            "@tauri-apps/api/core",
            "@tauri-apps/api/event",
            "@tauri-apps/api/window",
            "@tauri-apps/plugin-dialog",
            "@tauri-apps/plugin-opener",
          ],
        },
      },
    },
  },
}));
