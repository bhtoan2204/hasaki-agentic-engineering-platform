import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into web/dist and served by the Node server. `npm run dev:web` gives hot reload against a running backend.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:4545", changeOrigin: false } } },
});
