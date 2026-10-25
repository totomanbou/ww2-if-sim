import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // One file at a time: determinism.test.ts checks a wall-clock budget proportional to the update count,
    // which other files running in parallel would distort.
    fileParallelism: false,
  },
});
