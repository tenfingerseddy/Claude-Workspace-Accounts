import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts", "src/auth/authSchema.ts", "src/telemetry/normalizers.ts"]
    }
  }
});
