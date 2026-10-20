import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // Container start-up and image pulls can be slow on first run.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
