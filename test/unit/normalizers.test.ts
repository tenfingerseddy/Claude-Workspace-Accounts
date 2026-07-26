import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalBoolean,
  normalizeOtlp,
  normalizeStatusSnapshot
} from "../../src/telemetry/normalizers.js";

const metrics = () => JSON.parse(readFileSync("test/fixtures/otel-metrics.json", "utf8"));
const legacyMetrics = () => JSON.parse(
  readFileSync("test/fixtures/otel-metrics-legacy-attributes.json", "utf8")
);
const logs = () => JSON.parse(readFileSync("test/fixtures/otel-logs.json", "utf8"));
const boolValueLogs = () => JSON.parse(
  readFileSync("test/fixtures/otel-logs-boolvalue.json", "utf8")
);

describe("telemetry normalization", () => {
  it("keeps supported metric dimensions and drops identity/content attributes", () => {
    const normalized = normalizeOtlp(metrics());
    expect(normalized.metrics).toHaveLength(2);
    expect(normalized.metrics[0]?.attributes).toEqual({
      "claude.account_guard.profile_id": "work",
      "claude.account_guard.workspace_hash": "0123456789abcdef",
      "claude.account_guard.workspace_label": "client-repo",
      type: "input",
      model: "claude-opus-4-8",
      query_source: "repl_main_thread",
      "skill.name": "release-check",
      "plugin.name": "github",
      "agent.name": "reviewer",
      "mcp_server.name": "github",
      "mcp_tool.name": "get_pull_request",
      "marketplace.name": "official",
      speed: "standard",
      effort: "high"
    });
    expect(JSON.stringify(normalized)).not.toContain("must-not-be-retained");
  });

  it("carries the documented dotted MCP attribute keys through normalization", () => {
    // The allowlist recognised only `server_name`, which appears on mcp_server_connection events and
    // only when tool details are enabled. Current metrics use mcp_server.name / mcp_tool.name, so
    // every MCP attribution row was empty.
    const attributes = normalizeOtlp(metrics()).metrics[0]?.attributes ?? {};
    expect(attributes["mcp_server.name"]).toBe("github");
    expect(attributes["mcp_tool.name"]).toBe("get_pull_request");
  });

  it("drops tool input while preserving reliability fields", () => {
    const normalized = normalizeOtlp(logs());
    expect(normalized.events).toHaveLength(5);
    expect(normalized.events[0]?.attributes).toMatchObject({
      model: "claude-opus-4-8",
      success: true,
      duration_ms: 900,
      ttft_ms: 240
    });
    expect(JSON.stringify(normalized)).not.toContain("must not be retained");
  });

  it("reads Anthropic's string-encoded success as a real boolean", () => {
    // Anthropic sends the STRINGS "true"/"false". A strict `!== false` test made every failed tool
    // result look successful, because "false" is a non-empty, truthy string.
    const events = normalizeOtlp(logs()).events;
    const failingTool = events.find((event) => event.attributes.tool_name === "Bash");
    expect(failingTool?.attributes.success).toBe(false);
    const failingAuth = events.find((event) => event.name === "claude_code.auth");
    expect(failingAuth?.attributes.success).toBe(false);
    expect(events[1]?.attributes.success).toBe(true);
  });

  it("normalizes the boolValue and string encodings of success identically", () => {
    const fromStrings = normalizeOtlp(logs()).events.map((event) => event.attributes.success);
    const fromBooleans = normalizeOtlp(boolValueLogs()).events
      .map((event) => event.attributes.success);
    expect(fromStrings).toEqual([true, true, false, false, undefined]);
    expect(fromBooleans).toEqual(fromStrings);
  });

  it("aliases the documented error_type onto error_category and never keeps the raw message", () => {
    const failing = normalizeOtlp(logs()).events
      .find((event) => event.attributes.tool_name === "Bash");
    expect(failing?.attributes.error_type).toBe("ShellError");
    expect(failing?.attributes.error_category).toBe("ShellError");
    // `error` is documented as the full error message and routinely carries paths and command
    // output, so it must never survive normalization.
    expect(failing?.attributes.error).toBeUndefined();
  });

  it("preserves an explicit error_category rather than overwriting it with error_type", () => {
    const normalized = normalizeOtlp({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: "1784782801000000000",
            body: { stringValue: "claude_code.tool_result" },
            attributes: [
              { key: "error_category", value: { stringValue: "explicit" } },
              { key: "error_type", value: { stringValue: "Error:ENOENT" } }
            ]
          }]
        }]
      }]
    });
    expect(normalized.events[0]?.attributes.error_category).toBe("explicit");
    expect(normalized.events[0]?.attributes.error_type).toBe("Error:ENOENT");
  });

  it("keeps the legacy undotted MCP attributes working", () => {
    const attributes = normalizeOtlp(legacyMetrics()).metrics[0]?.attributes ?? {};
    expect(attributes.server_name).toBe("github");
    expect(attributes.tool_name).toBe("get_pull_request");
  });

  it("reports which OTLP envelopes a payload contained", () => {
    // The collector needs this to tell "understood and stored nothing" from "this was never OTLP".
    expect(normalizeOtlp(metrics()).signals).toEqual(["metrics"]);
    expect(normalizeOtlp(logs()).signals).toEqual(["logs"]);
    expect(normalizeOtlp({ hello: "world" }).signals).toEqual([]);
    expect(normalizeOtlp({ resourceMetrics: [], resourceLogs: [] }).signals)
      .toEqual(["metrics", "logs"]);
  });

  it("counts a substituted timestamp instead of silently backdating usage to now", () => {
    const normalized = normalizeOtlp({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: "claude_code.token.usage",
            sum: { dataPoints: [{ timeUnixNano: "not-a-number", asInt: "10", attributes: [] }] }
          }]
        }]
      }]
    });
    expect(normalized.metrics).toHaveLength(1);
    expect(normalized.degradations.metric_timestamp_fallback).toBe(1);
  });

  it("counts an unusable span duration instead of letting it vanish", () => {
    const normalized = normalizeOtlp({
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "claude_code.llm_request",
            startTimeUnixNano: "1784782802000000000",
            endTimeUnixNano: "1784782800000000000",
            attributes: []
          }]
        }]
      }]
    });
    expect(normalized.events[0]?.attributes.duration_ms).toBeUndefined();
    expect(normalized.degradations.span_duration_unusable).toBe(1);
  });

  it("counts dropped points and records rather than reporting a clean empty batch", () => {
    const normalized = normalizeOtlp({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{ name: "claude_code.token.usage", sum: { dataPoints: [{ attributes: [] }] } }]
        }]
      }],
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [] }] }] }]
    });
    expect(normalized.metrics).toHaveLength(0);
    expect(normalized.events).toHaveLength(0);
    expect(normalized.degradations.dropped_metric_point).toBe(1);
    expect(normalized.degradations.dropped_log_record).toBe(1);
  });

  it("normalizes trace latency while dropping span content and identity", () => {
    // Traces are not collected — the endpoint refuses them because spans need a beta telemetry mode
    // Workspace Accounts will not enable — but the parser stays covered so re-enabling is a one-liner.
    const payload = JSON.parse(readFileSync("test/fixtures/otel-traces.json", "utf8"));
    const normalized = normalizeOtlp(payload);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]).toMatchObject({
      name: "claude_code.api_request",
      attributes: {
        model: "claude-opus-4-8",
        query_source: "repl_main_thread",
        success: true,
        ttft_ms: 275,
        duration_ms: 1250,
        "claude.account_guard.workspace_hash": "0123456789abcdef",
        "claude.account_guard.workspace_label": "client-repo"
      }
    });
    expect(JSON.stringify(normalized)).not.toContain("must-not-be-retained");
  });

  it("preserves absent quota fields as absent", () => {
    const snapshot = normalizeStatusSnapshot({
      schemaVersion: 1,
      profileId: "work",
      sessionId: "session",
      contextWindow: {
        usedPercentage: null
      },
      rateLimits: {
        fiveHour: {
          usedPercentage: null
        }
      }
    });
    expect(snapshot?.contextWindow?.usedPercentage).toBeUndefined();
    expect(snapshot?.rateLimits).toBeUndefined();
  });
});

describe("boolean canonicalization", () => {
  it("distinguishes absent from false", () => {
    expect(canonicalBoolean(undefined)).toBeUndefined();
    expect(canonicalBoolean("")).toBeUndefined();
    expect(canonicalBoolean("maybe")).toBeUndefined();
    expect(canonicalBoolean(2)).toBeUndefined();
  });

  it("accepts every encoding seen on the wire", () => {
    for (const truthy of [true, 1, "true", "TRUE", " true ", "1", "yes"]) {
      expect(canonicalBoolean(truthy)).toBe(true);
    }
    for (const falsy of [false, 0, "false", "FALSE", " false ", "0", "no"]) {
      expect(canonicalBoolean(falsy)).toBe(false);
    }
  });
});
