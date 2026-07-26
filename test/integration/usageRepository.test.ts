import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceHash } from "../../src/core/paths.js";
import { UsageRepository } from "../../src/storage/usageRepository.js";
import { normalizeOtlp, normalizeStatusSnapshot } from "../../src/telemetry/normalizers.js";

const repositories: UsageRepository[] = [];

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
