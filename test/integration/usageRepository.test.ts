import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceHash } from "../../src/core/paths.js";
import {
  classifyStorageFailure,
  REGISTRATION_STALE_AFTER_MS,
  StorageWriteError,
  UsageRepository
} from "../../src/storage/usageRepository.js";
import { normalizeOtlp, normalizeStatusSnapshot } from "../../src/telemetry/normalizers.js";

const repositories: UsageRepository[] = [];

function openRepository(): UsageRepository {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
  const repository = new UsageRepository(path.join(directory, "usage.sqlite3"));
  repositories.push(repository);
  return repository;
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join("test/fixtures", name), "utf8"));
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
});

describe("SQLite usage repository", () => {
  it("reconciles normalized metrics, events, and status snapshots", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const repository = new UsageRepository(path.join(directory, "usage.sqlite3"));
    repositories.push(repository);
    const metricPayload = JSON.parse(readFileSync("test/fixtures/otel-metrics.json", "utf8"));
    const logPayload = JSON.parse(readFileSync("test/fixtures/otel-logs.json", "utf8"));
    const normalized = {
      metrics: normalizeOtlp(metricPayload).metrics,
      events: normalizeOtlp(logPayload).events
    };
    repository.ingestBatch("work", normalized.metrics, normalized.events);
    const snapshot = normalizeStatusSnapshot(
      JSON.parse(readFileSync("test/fixtures/status-snapshot.json", "utf8"))
    );
    expect(snapshot).toBeDefined();
    repository.recordStatusSnapshot(snapshot!);

    const daily = repository.daily("work", "7d");
    expect(daily.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(1200);
    expect(daily.reduce((sum, row) => sum + row.estimatedCostUsd, 0)).toBeCloseTo(0.42);
    expect(repository.reliability("work", "7d")).toMatchObject({
      requests: 1,
      errors: 0,
      medianRequestMs: 900,
      medianTtftMs: 240
    });
    expect(repository.collectorHealth("work").lastEventAt).toBeDefined();
    expect(repository.latestStatusSnapshot("work")?.rateLimits?.sevenDay?.usedPercentage)
      .toBe(86);
    expect(repository.daily("work", "custom", {
      from: "2026-07-23",
      to: "2026-07-23"
    })).not.toHaveLength(0);
    expect(repository.daily("work", "custom", {
      from: "2026-07-01",
      to: "2026-07-02"
    })).toHaveLength(0);
    expect(repository.attribution("work", "7d")).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "model", label: "claude-opus-4-8", tokens: 1200 }),
      expect.objectContaining({ dimension: "workspace", label: "client-repo", tokens: 1200 }),
      expect.objectContaining({ dimension: "skill", label: "release-check", tokens: 1200 }),
      expect.objectContaining({ dimension: "plugin", label: "github", tokens: 1200 }),
      expect.objectContaining({ dimension: "agent", label: "reviewer", tokens: 1200 }),
      expect.objectContaining({
        dimension: "mcp_tool",
        label: "github / get_pull_request",
        tokens: 1200
      })
    ]));
  });

  it("records a failed tool result as a failure, not a success", () => {
    // Anthropic encodes success as the string "false". `attributes.success === false` was never true
    // for it, so every failed Bash call was stored with success = 1 and the reliability panel
    // reported a 100% tool success rate no matter what actually happened.
    const repository = openRepository();
    repository.ingestBatch(
      "work",
      [],
      normalizeOtlp(readFixture("otel-logs.json")).events
    );
    const tools = repository.reliability("work", "7d").tools;
    const bash = tools.find((tool) => tool.name === "Bash");
    const read = tools.find((tool) => tool.name === "Read");
    expect(bash).toMatchObject({ requests: 1, successes: 0 });
    expect(read).toMatchObject({ requests: 1, successes: 1 });
  });

  it("records a failed auth event as a security event", () => {
    // Same root cause: `success === false` never matched "false", so auth failures were dropped.
    const repository = openRepository();
    repository.ingestBatch("work", [], normalizeOtlp(readFixture("otel-logs.json")).events);
    expect(repository.reliability("work", "7d").authFailures).toBe(1);
    expect(repository.reliability("work", "7d").mcpFailures).toBe(1);
  });

  it("reaches the same tool and auth verdicts from the boolValue encoding", () => {
    const repository = openRepository();
    repository.ingestBatch(
      "work",
      [],
      normalizeOtlp(readFixture("otel-logs-boolvalue.json")).events
    );
    const summary = repository.reliability("work", "7d");
    expect(summary.authFailures).toBe(1);
    expect(summary.mcpFailures).toBe(1);
    expect(summary.tools.find((tool) => tool.name === "Bash")).toMatchObject({ successes: 0 });
  });

  it("attributes MCP usage from the dotted keys and the legacy keys alike", () => {
    const dotted = openRepository();
    dotted.ingestBatch("work", normalizeOtlp(readFixture("otel-metrics.json")).metrics, []);
    const legacy = openRepository();
    legacy.ingestBatch(
      "work",
      normalizeOtlp(readFixture("otel-metrics-legacy-attributes.json")).metrics,
      []
    );
    for (const repository of [dotted, legacy]) {
      expect(repository.attribution("work", "7d")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          dimension: "mcp_tool",
          label: "github / get_pull_request",
          tokens: 1200
        })
      ]));
    }
  });

  it("classifies a transient storage failure as retryable rather than as bad client data", () => {
    // The collector answered 400 for every ingest error, and Claude's exporter treats 400 as
    // non-retryable — so a five-second busy timeout permanently destroyed real usage.
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const repository = new UsageRepository(
      path.join(directory, "usage.sqlite3"),
      { busyTimeoutMs: 150 }
    );
    repositories.push(repository);
    const holder = new DatabaseSync(repository.databasePath, { timeout: 50 });
    holder.exec("PRAGMA busy_timeout = 50");
    holder.exec("BEGIN EXCLUSIVE");
    let caught: unknown;
    try {
      repository.ingestBatch("work", normalizeOtlp(readFixture("otel-metrics.json")).metrics, []);
    } catch (error) {
      caught = error;
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(caught).toBeInstanceOf(StorageWriteError);
    expect((caught as StorageWriteError).transient).toBe(true);
    expect(["busy", "locked"]).toContain((caught as StorageWriteError).category);
    const health = repository.collectionHealth("work");
    expect(health.storage.lastFailureCategory).toBe((caught as StorageWriteError).category);
    expect(health.storage.lastFailureAt).toBeDefined();
  });

  it("classifies SQLite result codes without guessing", () => {
    expect(classifyStorageFailure({ errcode: 5 })).toBe("busy");
    expect(classifyStorageFailure({ errcode: 6 })).toBe("locked");
    expect(classifyStorageFailure({ errcode: 13 })).toBe("disk_full");
    expect(classifyStorageFailure({ errcode: 11 })).toBe("corrupt");
    expect(classifyStorageFailure({ errcode: 19 })).toBe("constraint");
    // Extended result codes carry the primary code in the low byte (SQLITE_BUSY_SNAPSHOT = 5 | 2<<8).
    expect(classifyStorageFailure({ errcode: 517 })).toBe("busy");
    expect(classifyStorageFailure(new Error("database is locked"))).toBe("locked");
    expect(classifyStorageFailure(new Error("no such table: usage_daily"))).toBe("schema");
    expect(classifyStorageFailure(new Error("something else"))).toBe("unknown");
  });

  it("writes a status snapshot atomically", () => {
    // Three autocommit writes meant a failure between them left a snapshot row with no session, and
    // the caller deleted the only copy of the file regardless.
    const repository = openRepository();
    const snapshot = normalizeStatusSnapshot(readFixture("status-snapshot.json"))!;
    const inspection = new DatabaseSync(repository.databasePath, { readOnly: true });
    repository.recordStatusSnapshot(snapshot);
    const counts = () => ({
      snapshots: (inspection.prepare(
        "SELECT COUNT(*) AS count FROM status_snapshots WHERE profile_id = 'work'"
      ).get() as { count: number }).count,
      sessions: (inspection.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE profile_id = 'work'"
      ).get() as { count: number }).count,
      health: (inspection.prepare(
        "SELECT COUNT(*) AS count FROM collector_health WHERE profile_id = 'work'"
      ).get() as { count: number }).count
    });
    expect(counts()).toEqual({ snapshots: 1, sessions: 1, health: 1 });
    inspection.close();
  });

  it("distinguishes a corrupt stored snapshot from having no snapshot", () => {
    const repository = openRepository();
    const snapshot = normalizeStatusSnapshot(readFixture("status-snapshot.json"))!;
    repository.recordStatusSnapshot(snapshot);
    const corrupter = new DatabaseSync(repository.databasePath);
    corrupter.exec("UPDATE status_snapshots SET payload_json = '{not json'");
    corrupter.close();

    expect(repository.latestStatusSnapshot("work")).toBeUndefined();
    expect(repository.collectionHealth("work").degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "snapshot_payload_corrupt", count: 1 })
    ]));
  });

  it("reports an unreadable database size as absent rather than as zero bytes", () => {
    // A failed stat used to return 0, which reads as a plausible empty database — so "we could not
    // measure it" and "there is nothing in it" looked identical in the diagnostics report.
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const repository = new UsageRepository(path.join(directory, "usage.sqlite3"));
    expect(repository.collectionHealth(undefined).storage.databaseSizeBytes).toBeGreaterThan(0);
    repository.close();
    rmSync(directory, { recursive: true, force: true });

    // Reading health must survive the database being gone. This is the one call the dashboard,
    // diagnostics view and status bar all rely on to explain a failure, so it can never be the
    // failure.
    const health = repository.collectionHealth("work");
    expect(health.storage.databaseSizeBytes).toBeUndefined();
    expect(health.storage.databaseSizeError).toBe("ENOENT");
    expect(health.phase).toBe("collector_stopped");
    expect(repository.databaseSize()).toBe(0);
  });

  it("survives an existing database created by another window without remigrating", () => {
    // PRAGMA journal_mode and the migration used to run unconditionally with a 5 s busy timeout and
    // no retry, and the throw happened before any telemetry service existed, so activation failed.
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const databasePath = path.join(directory, "usage.sqlite3");
    const first = new UsageRepository(databasePath);
    repositories.push(first);
    const snapshot = normalizeStatusSnapshot(readFixture("status-snapshot.json"))!;
    first.recordStatusSnapshot(snapshot);

    const second = new UsageRepository(databasePath);
    repositories.push(second);
    expect(second.latestStatusSnapshot("work")?.sessionId).toBe(snapshot.sessionId);
    // A second host must not report a migration retry: the schema was already current, so it never
    // needed to write at all.
    expect(second.collectionHealth(undefined).degradations
      .filter((counter) => counter.reason === "database_open_retried")).toHaveLength(0);
  });

  it("deletes local usage without deleting registry metadata tables", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const repository = new UsageRepository(path.join(directory, "usage.sqlite3"));
    repositories.push(repository);
    const snapshot = normalizeStatusSnapshot(
      JSON.parse(readFileSync("test/fixtures/status-snapshot.json", "utf8"))
    )!;
    repository.recordStatusSnapshot(snapshot);
    repository.deleteUsageData();
    expect(repository.latestStatusSnapshot("work")).toBeUndefined();
  });

  it("deletes personal verification metadata separately from pseudonymous usage", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const databasePath = path.join(directory, "usage.sqlite3");
    const repository = new UsageRepository(databasePath);
    repositories.push(repository);
    repository.recordAuthVerification("work", {
      state: "signed_in",
      checkedAt: new Date().toISOString(),
      email: "work@example.com",
      accountId: "acct-work"
    });
    const snapshot = normalizeStatusSnapshot(
      JSON.parse(readFileSync("test/fixtures/status-snapshot.json", "utf8"))
    )!;
    repository.recordStatusSnapshot(snapshot);

    repository.deleteProfileMetadata("work");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect((inspection.prepare(
      "SELECT COUNT(*) AS count FROM auth_verifications WHERE profile_id = 'work'"
    ).get() as { count: number }).count).toBe(0);
    expect((inspection.prepare(
      "SELECT COUNT(*) AS count FROM status_snapshots WHERE profile_id = 'work'"
    ).get() as { count: number }).count).toBe(1);
    inspection.close();
  });

  it("mirrors only hashes for profile and workspace paths", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const databasePath = path.join(directory, "usage.sqlite3");
    const repository = new UsageRepository(databasePath);
    repositories.push(repository);
    const configDir = "c:\\users\\example\\.claude-work";
    const workspacePath = "c:\\repos\\sensitive-client";
    const now = new Date().toISOString();

    repository.mirrorRegistry({
      schemaVersion: 1,
      revision: 1,
      updatedAt: now,
      integration: {},
      collectors: {},
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
      }]
    });

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const profile = inspection.prepare(
      "SELECT config_dir_hash AS hash FROM profiles WHERE id = 'work'"
    ).get() as { hash: string };
    const lock = inspection.prepare(
      "SELECT workspace_hash AS hash, workspace_uri AS uri FROM workspace_locks WHERE profile_id = 'work'"
    ).get() as { hash: string; uri: string };
    inspection.close();

    expect(profile.hash).toBe(workspaceHash(configDir));
    expect(lock.hash).toBe(workspaceHash(workspacePath));
    expect(lock.uri).toBe(workspaceHash("file:///C:/repos/sensitive-client"));
    expect(profile.hash).not.toContain("users");
    expect(lock.hash).not.toContain("repos");

    repository.mirrorRegistry({
      schemaVersion: 1,
      revision: 2,
      updatedAt: now,
      integration: {},
      collectors: {},
      profiles: [],
      workspaceLocks: []
    });
    const afterDelete = new DatabaseSync(databasePath, { readOnly: true });
    expect((afterDelete.prepare("SELECT COUNT(*) AS count FROM profiles").get() as {
      count: number;
    }).count).toBe(0);
    expect((afterDelete.prepare("SELECT COUNT(*) AS count FROM workspace_locks").get() as {
      count: number;
    }).count).toBe(0);
    afterDelete.close();
  });

  it("distinguishes every collection failure mode instead of one 'unavailable'", () => {
    // The whole point of the health state: these all used to render identically, because
    // collector_health is only written after data has already been stored successfully.
    const repository = openRepository();
    expect(repository.collectionHealth("work").phase).toBe("collector_stopped");
    expect(repository.collectionHealth("work", { runtimeProfileRegistered: false }).phase)
      .toBe("no_runtime_profile");
    expect(repository.collectionHealth("work", { telemetryEnabled: false }).phase)
      .toBe("telemetry_disabled");

    repository.recordCollectorLifecycle({
      profileId: "work",
      listening: false,
      bindError: "EADDRINUSE"
    });
    expect(repository.collectionHealth("work").phase).toBe("port_bind_failed");
    expect(repository.collectionHealth("work").collector.bindError).toBe("EADDRINUSE");

    const now = new Date().toISOString();
    repository.recordCollectorLifecycle({
      profileId: "work",
      listening: true,
      port: 51234,
      startedAt: now,
      registrationUpdatedAt: now,
      heartbeatHealthy: true
    });
    const listening = repository.collectionHealth("work");
    expect(listening.phase).toBe("awaiting_data");
    expect(listening.collector).toMatchObject({ listening: true, port: 51234 });
    // A successful bind must clear the stale bind error, not keep blaming a resolved port conflict.
    expect(listening.collector.bindError).toBeUndefined();
    expect(listening.collector.registrationAgeMs).toBeLessThan(REGISTRATION_STALE_AFTER_MS);
    expect(listening.collector.registrationStale).toBe(false);

    repository.recordRequestRejected("work", "protobuf_unsupported", "application/x-protobuf");
    const rejecting = repository.collectionHealth("work");
    expect(rejecting.phase).toBe("rejecting");
    expect(rejecting.requests.rejections).toEqual([expect.objectContaining({
      reason: "protobuf_unsupported",
      count: 1,
      lastDetail: "application/x-protobuf"
    })]);

    repository.recordBatchAcceptedEmpty("work", "metrics");
    expect(repository.collectionHealth("work").phase).toBe("accepted_empty");

    repository.recordStatusSnapshot(normalizeStatusSnapshot(readFixture("status-snapshot.json"))!);
    repository.recordRequestStored("work");
    const collecting = repository.collectionHealth("work");
    expect(collecting.phase).toBe("collecting");
    expect(collecting.requests.stored).toBe(1);
    expect(collecting.storage.lastSuccessfulWriteAt).toBeDefined();
  });

  it("exposes the registration age and a failing heartbeat", () => {
    // The wrapper refuses to inject OTEL once the registration is older than its window, so a
    // heartbeat rejecting into the void stopped telemetry forever with nothing to show for it.
    const repository = openRepository();
    const stale = new Date(Date.now() - REGISTRATION_STALE_AFTER_MS - 5_000).toISOString();
    repository.recordCollectorLifecycle({
      profileId: "work",
      listening: true,
      port: 51234,
      registrationUpdatedAt: stale,
      heartbeatHealthy: true
    });
    const health = repository.collectionHealth("work");
    expect(health.phase).toBe("registration_stale");
    expect(health.collector.registrationStale).toBe(true);
    expect(health.collector.registrationAgeMs).toBeGreaterThan(REGISTRATION_STALE_AFTER_MS);
    expect(health.collector.registrationStaleAfterMs).toBe(REGISTRATION_STALE_AFTER_MS);

    repository.recordCollectorLifecycle({
      profileId: "work",
      heartbeatHealthy: false,
      heartbeatError: "EPERM"
    });
    repository.recordCollectorLifecycle({
      profileId: "work",
      heartbeatHealthy: false,
      heartbeatError: "EPERM"
    });
    const failing = repository.collectionHealth("work");
    expect(failing.collector.heartbeatFailures).toBe(2);
    expect(failing.collector.heartbeatError).toBe("EPERM");
    expect(failing.collector.heartbeatFailingSince).toBeDefined();

    repository.recordCollectorLifecycle({
      profileId: "work",
      registrationUpdatedAt: new Date().toISOString(),
      heartbeatHealthy: true
    });
    const recovered = repository.collectionHealth("work");
    expect(recovered.collector.heartbeatFailures).toBe(0);
    expect(recovered.collector.heartbeatError).toBeUndefined();
    expect(recovered.collector.heartbeatFailingSince).toBeUndefined();
  });

  it("counts quarantined inbox files and normalization fallbacks", () => {
    const repository = openRepository();
    repository.recordInboxQuarantined("work", "malformed_json", "1784-abc.json");
    repository.recordInboxQuarantined("work", "malformed_json", "1784-def.json");
    repository.recordInboxQuarantined("work", "unknown_profile", "1784-ghi.json");
    repository.recordDegradations("work", {
      metric_timestamp_fallback: 3,
      span_duration_unusable: 1
    });
    const health = repository.collectionHealth("work");
    expect(health.inbox.quarantined).toBe(3);
    expect(health.inbox.quarantines).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "malformed_json", count: 2, lastDetail: "1784-def.json" }),
      expect.objectContaining({ reason: "unknown_profile", count: 1 })
    ]));
    expect(health.degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "metric_timestamp_fallback", count: 3 }),
      expect.objectContaining({ reason: "span_duration_unusable", count: 1 })
    ]));
  });

  it("clears collection health when the user deletes their local data", () => {
    const repository = openRepository();
    repository.recordRequestRejected("work", "unauthorized");
    expect(repository.collectionHealth("work").requests.rejected).toBe(1);
    repository.deleteUsageData();
    const cleared = repository.collectionHealth("work");
    expect(cleared.requests.rejected).toBe(0);
    expect(cleared.requests.rejections).toHaveLength(0);
  });

  it("migrates the pre-thread-scope attribution schema without losing rows", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-"));
    const databasePath = path.join(directory, "usage.sqlite3");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE attribution_daily (
        day TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        label TEXT NOT NULL,
        tokens REAL NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        requests REAL NOT NULL DEFAULT 0,
        active_seconds REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(day, profile_id, dimension, label)
      );
      INSERT INTO attribution_daily
        (day, profile_id, dimension, label, tokens)
      VALUES
        (date('now'), 'work', 'skill', 'release-check', 25);
    `);
    legacy.close();

    const repository = new UsageRepository(databasePath);
    repositories.push(repository);
    expect(repository.attribution("work", "7d")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dimension: "skill",
        label: "release-check",
        tokens: 25
      })
    ]));
  });
});
