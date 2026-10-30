import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./tests/globalSetup.js"],
    setupFiles: ["./tests/setupEnv.js"],
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run downloads the MongoDB binary
  },
});
