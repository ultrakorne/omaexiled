import path from "path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
  },
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@ipc": path.resolve(__dirname, "./src/../../ipc"),
      "@specs": path.resolve(__dirname, "./specs"),
    },
    extensions: [".ts", ".js", ".vue", ".json"],
  },
  define: {
    "import.meta.vitest": "undefined",
  },
  server: {
    proxy: {
      "^/(config|proxy)": { target: "http://127.0.0.1:8584" },
      "/events": { ws: true, target: "http://127.0.0.1:8584" },
    },
  },
});
