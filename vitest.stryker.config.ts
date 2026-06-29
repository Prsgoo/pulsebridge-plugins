import { defineConfig } from "vitest/config";

// Stryker runs vitest from the workspace root (not per-package like Nx), so the
// test glob must reach into every package. Coverage thresholds are irrelevant
// here — mutation score is what gates this run.
export default defineConfig({
  test: {
    include: ["packages/*/src/__tests__/**/*.test.ts"],
  },
});
