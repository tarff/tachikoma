import { defineConfig } from "vitest/config";

// The fixtures tests/helpers.test.ts runs as child Vitest runs (cleanup plan, step 4). Their names end in .fixture.ts,
// so the ordinary run's tests/**/*.test.{ts,tsx} never picks them up; this config is the only one that does.
export default defineConfig({
  test: {
    include: ["tests/fixtures/*.fixture.ts"],
  },
});
