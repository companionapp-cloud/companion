import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// react-native-web setup (PLAN §2): alias react-native -> react-native-web and put
// .web.* platform extensions first so shared code resolves web variants. Workspace
// source packages are excluded from prebundling so Vite transpiles their TS/TSX.
export default defineConfig(({ mode }) => {
  // Build-time public settings, shared with Expo's EXPO_PUBLIC_* convention so packages/app
  // reads one name on every platform (see packages/app/src/cloud.ts). loadEnv picks them up
  // from .env files next to this config and from the shell (a Docker ARG, say).
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "EXPO_PUBLIC_");
  return {
    plugins: [react()],
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
      // Source-only workspace packages must be transpiled by Vite, not prebundled.
      // wa-sqlite loads its .wasm via new URL(import.meta.url); prebundling breaks that.
      exclude: ["@companion/app", "@companion/core-bridge", "@companion/design-system", "@companion/editor", "wa-sqlite"],
    },
    server: { port: 5273 },
  };
});
