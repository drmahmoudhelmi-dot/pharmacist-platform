import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Next.js resolves `server-only` at build time; tests run outside it.
      "server-only": path.resolve(
        import.meta.dirname,
        "tests/stubs/server-only.ts",
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // next-intl imports "next/navigation" without an extension; let Vite
    // resolve it instead of Node's strict ESM loader.
    server: { deps: { inline: ["next-intl"] } },
  },
});
