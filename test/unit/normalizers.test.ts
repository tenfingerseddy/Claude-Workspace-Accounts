import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeOtlp,
  normalizeStatusSnapshot
} from "../../src/telemetry/normalizers.js";

describe("telemetry normalization", () => {
  it("keeps supported metric dimensions and drops identity/content attributes", () => {
    const payload = JSON.parse(readFileSync("test/fixtures/otel-metrics.json", "utf8"));
    const normalized = normalizeOtlp(payload);
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
      server_name: "github",
      tool_name: "get_pull_request"
    });
    expect(JSON.stringify(normalized)).not.toContain("must-not-be-retained");
  });

  it("drops tool input while preserving reliability fields", () => {
    const payload = JSON.parse(readFileSync("test/fixtures/otel-logs.json", "utf8"));
    const normalized = normalizeOtlp(payload);
    expect(normalized.events).toHaveLength(2);
    expect(normalized.events[0]?.attributes).toMatchObject({
      model: "claude-opus-4-8",
      success: true,
      duration_ms: 900,
      ttft_ms: 240
    });
    expect(JSON.stringify(normalized)).not.toContain("must not be retained");
  });

  it("normalizes trace latency while dropping span content and identity", () => {
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
