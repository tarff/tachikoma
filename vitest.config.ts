import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    // Each test's limit, unless it sets its own: 15 s, not Vitest's 5 s. Measured on CI's Windows machine (eight runs,
    // 2026-11-07 to 2026-11-10): a test's slowest passing run took up to 3.07 times its usual one, and failing runs went
    // past 5 s from about 3.4 times a usual 1.6 s; the tests that failed so usually take at most about 3.2 s. 15 s is
    // the limit the tests that start processes already use, and covers 3.4 times any test that usually takes under
    // 4.4 s.
    testTimeout: 15_000,
  },
});
