import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// react-native-web setup (mirrors apps/web): alias react-native -> react-native-web and
// put .web.* platform extensions first so shared code resolves web variants. The dev
// server proxies /api to the cloud binary (:8080) so the portal can call the sync/billing
// API cross-process during development.
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
  server: {
    port: 5274,
    proxy: { "/api": "http://localhost:8080" },
  },
}));
