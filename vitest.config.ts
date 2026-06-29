import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Nx runs `vitest run` from each package's own directory, so these globs
    // are resolved per-package (relative to the project root), not workspace-wide.
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
