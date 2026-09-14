import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev server proxies API + WS traffic to the gacor-router backend, so
// the SPA runs with hot reload on :5173 while talking to the real :7788.
// In production the backend serves dashboard/dist directly — no proxy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:7788",
      "/v1": "http://127.0.0.1:7788",
      "/health": "http://127.0.0.1:7788",
      "/ws": { target: "ws://127.0.0.1:7788", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
