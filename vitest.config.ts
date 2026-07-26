import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Point %LOCALAPPDATA% at a throwaway directory for the whole suite.
 *
 * Support paths are derived from %LOCALAPPDATA%, so a test that builds them without an explicit
 * override resolves to the developer's own installation. That is not hypothetical: a test which
 * passed a temporary root to `resolveSupportPaths` — whose fallback argument was silently discarded
 * whenever %LOCALAPPDATA% was set — patched and then corrupted a real `registry.json`, the only
 * copy of a user's workspace bindings.
 *
 * `resolveSupportPaths` now requires the override to be named, which fixes that specific mistake.
 * This exists so the next variation of it cannot reach anything that matters either.
 */
const isolatedLocalAppData = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-vitest-"));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: {
      LOCALAPPDATA: isolatedLocalAppData
    },
    coverage: {
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts", "src/auth/authSchema.ts", "src/telemetry/normalizers.ts"]
    }
  }
});
