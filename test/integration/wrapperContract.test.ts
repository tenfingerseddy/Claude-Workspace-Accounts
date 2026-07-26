import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("process-wrapper security contract", () => {
  const script = readFileSync("bin/claude-account-guard-wrapper.ps1", "utf8");

  it("verifies auth before forwarding an enforced launch", () => {
    expect(script.indexOf("auth status")).toBeGreaterThan(0);
    expect(script.indexOf("auth status")).toBeLessThan(script.lastIndexOf("Start-Claude $registry"));
    expect(script).toContain("identity_mismatch");
    expect(script).toContain("runtime_profile_mismatch");
  });

  it("does not inspect Claude credential files and disables content telemetry", () => {
    expect(script.toLocaleLowerCase()).not.toContain(".credentials.json");
    expect(script).toContain("$env:OTEL_LOG_USER_PROMPTS = \"0\"");
    expect(script).toContain("$env:OTEL_LOG_TOOL_DETAILS = \"0\"");
    expect(script).toContain("$env:OTEL_LOG_TOOL_CONTENT = \"0\"");
    expect(script).toContain("$env:OTEL_LOG_RAW_API_BODIES = \"0\"");
    expect(script).toContain("$Registry.integration.telemetryEnabled -ne $false");
    expect(script).toContain("$existingExporterConfiguration.Count -eq 0");
  });
});
