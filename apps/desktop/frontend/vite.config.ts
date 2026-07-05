import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Desktop webview frontend: the same react-native-web setup as apps/web, but the
// core runs natively in the Wails Go process, reached over HTTP (createHttpBridge)
// rather than wasm. Built to dist/ and embedded by the Go binary (see main.go).
// base "./" keeps asset URLs relative to whatever origin Wails serves from.
export default defineConfig(({ mode }) => ({
  base: "./",
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
    exclude: ["@companion/app", "@companion/core-bridge", "@companion/design-system", "@companion/editor"],
  },
  server: { port: 5274 },
}));
