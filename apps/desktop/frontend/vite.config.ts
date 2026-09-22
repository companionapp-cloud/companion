import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Desktop webview frontend: the same react-native-web setup as apps/web, but the
// core runs natively in the Wails Go process, reached over HTTP (createHttpBridge)
// rather than wasm. Built to dist/ and embedded by the Go binary (see main.go).
// base "./" keeps asset URLs relative to whatever origin Wails serves from.
// Two pages: the app (index.html, every app window) and the updater window (updater.html,
// see update_window.go), which only needs the design system and the Wails runtime.
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig(({ mode }) => {
  // Build-time public settings, shared with Expo's EXPO_PUBLIC_* convention so packages/app
  // reads one name on every platform (see packages/app/src/cloud.ts). loadEnv picks them up
  // from .env files next to this config and from the shell (a Docker ARG, say).
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "EXPO_PUBLIC_");
  return {
    base: "./",
    plugins: [react()],
    build: {
      rolldownOptions: {
        input: { main: page("./index.html"), updater: page("./updater.html") },
      },
    },
    resolve: {
      alias: { "react-native": "react-native-web" },
      extensions: [
        ".web.tsx",
        ".web.ts",
        ".tsx",
        ".ts",
        ".web.jsx",
        ".web.js",
        ".jsx",
        ".js",
        ".json",
      ],
    },
    define: {
      global: "globalThis",
      __DEV__: JSON.stringify(mode !== "production"),
      "process.env.NODE_ENV": JSON.stringify(mode),
      "process.env.EXPO_PUBLIC_PORTAL_URL": JSON.stringify(env.EXPO_PUBLIC_PORTAL_URL ?? ""),
    },
    optimizeDeps: {
      exclude: ["@companion/app", "@companion/core-bridge", "@companion/design-system", "@companion/editor"],
    },
    server: { port: 5274 },
  };
});
