/** @type {import("@stryker-mutator/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.stryker.config.ts" },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  // The Nx daemon's live SQLite files (.nx/workspace-data/*.db-shm|-wal) and
  // build outputs race/ENOENT when copied into the Stryker sandbox. Exclude them.
  ignorePatterns: [".nx", "dist", "coverage", "reports"],
  mutate: [
    "packages/*/src/**/*.ts",
    "!packages/*/src/__tests__/**",
    "!packages/*/src/index.ts",
  ],
  thresholds: { high: 80, low: 70, break: 70 },
  reporters: ["html", "json", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
};
