import { describe, expect, it } from "vitest";
import {
  detectForeignOtelConfiguration,
  FORBIDDEN_BETA_VARIABLES,
  FORCED_PRIVACY_VARIABLES,
  FOREIGN_OTEL_VARIABLES,
  REQUIRED_COLLECTOR_VARIABLES
} from "../../src/telemetry/otelEnvironment.js";

describe("OTEL environment contract", () => {
  it("detects the signal-specific overrides that used to slip through", () => {
    // Conflict detection checked four variables. A signal-specific protocol beats the general one, so
    // OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf survived injection and then every request the
    // collector received was unreadable — rejected as invalid_payload with nothing logged.
    for (const variable of [
      "OTEL_EXPORTER_OTLP_COMPRESSION",
      "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION",
      "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
      "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
      "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
      "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
      "OTEL_EXPORTER_OTLP_PROTOCOL",
      "OTEL_EXPORTER_OTLP_CLIENT_KEY"
    ]) {
      expect(FOREIGN_OTEL_VARIABLES).toContain(variable);
      const detected = detectForeignOtelConfiguration({ [variable]: "gzip" });
      expect(detected.present).toBe(true);
      expect(detected.variables).toEqual([variable]);
    }
  });

  it("treats an empty or whitespace-only value as unset", () => {
    expect(detectForeignOtelConfiguration({}).present).toBe(false);
    expect(detectForeignOtelConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }).present).toBe(false);
    expect(detectForeignOtelConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " }).present)
      .toBe(false);
  });

  it("captures variable names only, never values", () => {
    const detected = detectForeignOtelConfiguration({
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer a-users-real-secret"
    });
    expect(JSON.stringify(detected)).not.toContain("a-users-real-secret");
  });

  it("requires the wire format the loopback collector can actually read", () => {
    expect(REQUIRED_COLLECTOR_VARIABLES.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    // Spans need a beta telemetry mode Account Guard will not enable, so traces are turned off
    // explicitly rather than left to inherit `otlp` from the user's shell.
    expect(REQUIRED_COLLECTOR_VARIABLES.OTEL_TRACES_EXPORTER).toBe("none");
    expect(REQUIRED_COLLECTOR_VARIABLES.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(REQUIRED_COLLECTOR_VARIABLES.OTEL_LOGS_EXPORTER).toBe("otlp");
  });

  it("never enables a beta telemetry mode and never relaxes a content gate", () => {
    expect(FORBIDDEN_BETA_VARIABLES).toContain("CLAUDE_CODE_ENHANCED_TELEMETRY_BETA");
    expect(Object.values(FORCED_PRIVACY_VARIABLES).every((value) => value === "0")).toBe(true);
    expect(Object.keys(FORCED_PRIVACY_VARIABLES).sort()).toEqual([
      "OTEL_LOG_ASSISTANT_RESPONSES",
      "OTEL_LOG_RAW_API_BODIES",
      "OTEL_LOG_TOOL_CONTENT",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_USER_PROMPTS"
    ]);
  });

  it("never lists a forced or forbidden variable as a reason to refuse injection", () => {
    // Otherwise the wrapper's own injected values would look like a user's foreign configuration.
    for (const name of Object.keys(FORCED_PRIVACY_VARIABLES)) {
      expect(FOREIGN_OTEL_VARIABLES).not.toContain(name);
    }
    for (const name of FORBIDDEN_BETA_VARIABLES) {
      expect(FOREIGN_OTEL_VARIABLES).not.toContain(name);
    }
  });
});
