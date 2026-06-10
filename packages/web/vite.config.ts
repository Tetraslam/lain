import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  // Inline all JS/CSS into a single self-contained index.html so the built
  // client can be embedded into the compiled `lain` binary as one string.
  // (Affects `vite build` only; `vite dev` / HMR is unchanged.)
  plugins: [react(), viteSingleFile()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
