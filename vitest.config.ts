import { defineConfig } from "vitest/config";

export default defineConfig({
  // Work Item 1 has no test files yet; `vitest run` must still succeed in `pnpm run check`.
  test: { passWithNoTests: true },
});
