import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// react-native-web setup (PLAN §2): alias react-native -> react-native-web and put
// .web.* platform extensions first so shared code resolves web variants. Workspace
// source packages are excluded from prebundling so Vite transpiles their TS/TSX.
export default defineConfig(({ mode }) => ({
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
  },
  optimizeDeps: {
    // Source-only workspace packages must be transpiled by Vite, not prebundled.
    // wa-sqlite loads its .wasm via new URL(import.meta.url); prebundling breaks that.
    exclude: ["@companion/app", "@companion/core-bridge", "@companion/design-system", "@companion/editor", "wa-sqlite"],
  },
  server: { port: 5273 },
}));
