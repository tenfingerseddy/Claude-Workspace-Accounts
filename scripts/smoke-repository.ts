import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { workspaceHash } from "../src/core/paths.js";
import { UsageRepository } from "../src/storage/usageRepository.js";
import { normalizeOtlp, normalizeStatusSnapshot } from "../src/telemetry/normalizers.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "claude-workspace-accounts-repository-"));
const databasePath = path.join(directory, "usage.sqlite3");
const repository = new UsageRepository(databasePath);

try {
  const metricsPayload = JSON.parse(
    await readFile("test/fixtures/otel-metrics.json", "utf8")
  ) as unknown;
  const logsPayload = JSON.parse(
    await readFile("test/fixtures/otel-logs.json", "utf8")
  ) as unknown;
  const snapshotPayload = JSON.parse(
    await readFile("test/fixtures/status-snapshot.json", "utf8")
  ) as unknown;
  repository.ingestBatch(
    "work",
    normalizeOtlp(metricsPayload).metrics,
    normalizeOtlp(logsPayload).events
  );
  const snapshot = normalizeStatusSnapshot(snapshotPayload);
  if (!snapshot) {
    throw new Error("The status fixture did not normalize.");
  }
  repository.recordStatusSnapshot(snapshot);

  const daily = repository.daily("work", "7d");
  const inputTokens = daily.reduce((sum, row) => sum + row.inputTokens, 0);
  const cost = daily.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
  const reliability = repository.reliability("work", "7d");
  if (inputTokens !== 1200 || Math.abs(cost - 0.42) > 0.00001) {
    throw new Error("Daily usage reconciliation failed.");
  }
  if (reliability.requests !== 1
    || reliability.errors !== 0
    || reliability.medianRequestMs !== 900) {
    throw new Error("Reliability reconciliation failed.");
  }
  // Anthropic encodes success as the strings "true"/"false". A strict `!== false` test recorded every
  // failed tool result as a success and dropped failed auth events entirely.
  if (reliability.tools.find((tool) => tool.name === "Bash")?.successes !== 0
    || reliability.tools.find((tool) => tool.name === "Read")?.successes !== 1) {
    throw new Error("String-encoded tool failure was recorded as a success.");
  }
  if (reliability.authFailures !== 1 || reliability.mcpFailures !== 1) {
    throw new Error("String-encoded auth or MCP failure was not recorded.");
  }
  if (repository.latestStatusSnapshot("work")?.rateLimits?.sevenDay?.usedPercentage !== 86) {
    throw new Error("Status snapshot persistence failed.");
  }
  const attribution = repository.attribution("work", "7d");
  if (!attribution.some((row) => row.dimension === "workspace"
      && row.label === "client-repo"
      && row.tokens === 1200)
    || !attribution.some((row) => row.dimension === "skill"
      && row.label === "release-check"
      && row.tokens === 1200)
    || !attribution.some((row) => row.dimension === "mcp_tool"
      && row.label === "github / get_pull_request"
      && row.tokens === 1200)) {
    throw new Error("Detailed attribution reconciliation failed.");
  }

  const now = new Date().toISOString();
  const configDir = "c:\\users\\example\\.claude-work";
  const workspacePath = "c:\\repos\\sensitive-client";
  repository.mirrorRegistry({
    schemaVersion: 1,
    revision: 1,
    profiles: [{
      id: "work",
      displayName: "Work",
      marker: "W",
      configDir,
      configDirNormalized: configDir,
      vsCodeUserDataDir: "c:\\guard\\work",
      createdAt: now
    }],
    workspaceLocks: [{
      workspaceUri: "file:///C:/repos/sensitive-client",
      workspacePathNormalized: workspacePath,
      workspaceLabel: "sensitive-client",
      profileId: "work",
      mode: "enforce",
      createdAt: now,
      updatedAt: now
    }],
    collectors: {},
    integration: {},
    updatedAt: now
  });
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const profileHash = (inspection.prepare(
    "SELECT config_dir_hash AS hash FROM profiles WHERE id = 'work'"
  ).get() as { hash: string }).hash;
  const lockMirror = inspection.prepare(
    "SELECT workspace_hash AS hash, workspace_uri AS uri FROM workspace_locks WHERE profile_id = 'work'"
  ).get() as { hash: string; uri: string };
  inspection.close();
  if (profileHash !== workspaceHash(configDir)
    || lockMirror.hash !== workspaceHash(workspacePath)
    || lockMirror.uri !== workspaceHash("file:///C:/repos/sensitive-client")) {
    throw new Error("Registry mirror persisted a path instead of a hash.");
  }

  // MCP attribution must resolve from the documented dotted keys as well as the legacy ones.
  const legacy = new UsageRepository(path.join(directory, "legacy.sqlite3"));
  try {
    legacy.ingestBatch(
      "work",
      normalizeOtlp(JSON.parse(
        await readFile("test/fixtures/otel-metrics-legacy-attributes.json", "utf8")
      ) as unknown).metrics,
      []
    );
    if (!legacy.attribution("work", "7d").some((row) => row.dimension === "mcp_tool"
      && row.label === "github / get_pull_request")) {
      throw new Error("Legacy MCP attribute keys stopped resolving.");
    }
  } finally {
    legacy.close();
  }

  // A second repository over the same file must not have to remigrate, and must not throw: the
  // unconditional pragma and migration used to fail activation when another window held the file.
  const second = new UsageRepository(databasePath);
  try {
    if (second.latestStatusSnapshot("work")?.sessionId !== snapshot.sessionId) {
      throw new Error("A second extension host could not read the existing database.");
    }
    const health = second.collectionHealth("work", {
      telemetryEnabled: true,
      runtimeProfileRegistered: true
    });
    // Data is stored but no collector has registered in this process, so the honest phase is
    // "collector_stopped" — not the single "unavailable" the dashboard used to infer for everything.
    if (health.phase !== "collector_stopped"
      || health.storage.lastSuccessfulWriteAt === undefined
      || health.storage.databaseSizeBytes === undefined) {
      throw new Error(`Collection health misreported a stopped collector: ${health.phase}`);
    }
    if (second.collectionHealth("work", { runtimeProfileRegistered: false }).phase
      !== "no_runtime_profile"
      || second.collectionHealth("work", { telemetryEnabled: false }).phase
      !== "telemetry_disabled") {
      throw new Error("Collection health could not distinguish setup states.");
    }
  } finally {
    second.close();
  }
  console.log("Usage repository smoke test: OK");
} finally {
  repository.close();
  await rm(directory, { recursive: true, force: true });
}
