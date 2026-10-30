import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // vue: specs/web/config.test.ts loads the widget registry
  plugins: [tsconfigPaths(), vue()],
  test: {
    includeSource: ["src/**/*.{js,ts}"],
    globals: true,
    setupFiles: ["./specs/vitest.setup.ts"],
    coverage: {
      exclude: ["*.vue"],
    },
  },
  define: {
    "import.meta.vitest": "undefined",
  },
  resolve: {
    alias: {
      "@/assets/data/en": "./src/parser/en",
    },
  },
});
