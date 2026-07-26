/**
 * The OpenTelemetry environment contract, in one place.
 *
 * Two separate agents need the same list: the wrapper decides what to inject and what to refuse to
 * override, and the diagnostics/dashboard code decides whether the user already has their own
 * exporter. They drifted apart, and the drift is why every export failed silently: the wrapper
 * checked four variables, so `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` or
 * `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf` survived injection and then every request the
 * collector received was unreadable.
 *
 * Verified against https://code.claude.com/docs/en/monitoring-usage (2026-07).
 */

/**
 * Any of these being set means the user has their own OTEL pipeline, or has configured a wire
 * format the loopback collector cannot read. Injection must be refused outright — a partial
 * override produces a collector that is listening and rejecting everything.
 */
export const FOREIGN_OTEL_VARIABLES = [
  // Endpoints, general and per signal.
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  // Protocol, general and per signal. A signal-specific value wins over the general one, so a
  // single `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf` defeats an injected `http/json`.
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  // Compression, general and per signal. The collector handles gzip, but a user-selected codec it
  // does not implement would fail every request, so treat any explicit choice as foreign.
  "OTEL_EXPORTER_OTLP_COMPRESSION",
  "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION",
  "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION",
  "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION",
  // Headers carry the bearer token. A user value here would be replaced, losing their credentials.
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  // Exporter selection. `prometheus` or `console` means the user chose a different sink.
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
  // Client certificates imply mutual TLS against the user's own collector.
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE"
] as const;

/** What the wrapper must set for the loopback collector to be readable. */
export const REQUIRED_COLLECTOR_VARIABLES = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_LOGS_EXPORTER: "otlp",
  /**
   * Spans require `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, which Workspace Accounts will not set on a
   * user's behalf. Set `none` explicitly rather than leaving it unset, so an `otlp` value inherited
   * from the user's shell cannot aim spans at an endpoint that refuses them.
   */
  OTEL_TRACES_EXPORTER: "none",
  /** The collector speaks OTLP/HTTP with JSON bodies only. The OTEL default is grpc. */
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json"
} as const;

/**
 * Content and identity gates. These are the privacy invariants from docs/privacy.md; the wrapper
 * forces every one to "0" on every launch, and must never make them configurable.
 */
export const FORCED_PRIVACY_VARIABLES = {
  OTEL_LOG_USER_PROMPTS: "0",
  OTEL_LOG_ASSISTANT_RESPONSES: "0",
  OTEL_LOG_TOOL_DETAILS: "0",
  OTEL_LOG_TOOL_CONTENT: "0",
  OTEL_LOG_RAW_API_BODIES: "0"
} as const;

/**
 * Beta telemetry modes Workspace Accounts must never enable. Opting a user into a beta collection mode
 * they did not ask for is worse than not collecting the signal at all.
 */
export const FORBIDDEN_BETA_VARIABLES = [
  "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
  "ENABLE_BETA_TRACING_DETAILED",
  "BETA_TRACING_ENDPOINT",
  "CLAUDE_CODE_PROPAGATE_TRACEPARENT"
] as const;

export interface ForeignOtelConfiguration {
  present: boolean;
  /** Variable names only. Values may contain the user's own credentials and are never captured. */
  variables: string[];
}

/**
 * Report which foreign OTEL variables are set, by name only. Empty and whitespace-only values do
 * not count: an exported-but-blank variable is not a configured exporter.
 */
export function detectForeignOtelConfiguration(
  environment: Record<string, string | undefined> = process.env
): ForeignOtelConfiguration {
  const variables = FOREIGN_OTEL_VARIABLES.filter(
    (name) => (environment[name] ?? "").trim().length > 0
  );
  return { present: variables.length > 0, variables: [...variables] };
}
