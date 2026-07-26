import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountProfile, CollectorRegistration } from "../../src/core/models.js";
import { ProfileRegistry, type SupportPaths } from "../../src/profiles/registryStore.js";
import { UsageRepository } from "../../src/storage/usageRepository.js";
import { TelemetryCollector } from "../../src/telemetry/telemetryCollector.js";

const METRICS = readFileSync("test/fixtures/otel-metrics.json", "utf8");

function supportPaths(root: string): SupportPaths {
  return {
    root,
    registry: path.join(root, "registry.json"),
    database: path.join(root, "usage.sqlite3"),
    wrapperDirectory: path.join(root, "wrapper"),
    snapshotInbox: path.join(root, "snapshots"),
    handoffs: path.join(root, "handoffs")
  };
}

const profile: AccountProfile = {
  id: "work",
  displayName: "Work",
  marker: "W",
  configDir: "C:\\profiles\\work",
  configDirNormalized: "c:\\profiles\\work",
  vsCodeUserDataDir: "C:\\profiles\\vscode-work",
  telemetryEnabled: true,
  createdAt: new Date().toISOString()
};

describe("loopback telemetry collector", () => {
  let paths: SupportPaths;
  let registry: ProfileRegistry;
  let repository: UsageRepository;
  let collector: TelemetryCollector;
  let registration: CollectorRegistration;
  let dataEvents = 0;

  const post = (
    route: string,
    body: string | Buffer,
    headers: Record<string, string> = {}
  ): Promise<Response> => fetch(`http://127.0.0.1:${registration.port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${registration.token}`,
      ...headers
    },
    body: typeof body === "string" ? body : new Uint8Array(body)
  });

  beforeEach(async () => {
    dataEvents = 0;
    paths = supportPaths(mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-collector-")));
    registry = new ProfileRegistry(paths);
    await registry.initialize();
    await registry.upsertProfile(profile);
    repository = new UsageRepository(paths.database);
    collector = new TelemetryCollector(registry, repository, () => {
      dataEvents += 1;
    });
    registration = await collector.start(profile);
  });

  afterEach(async () => {
    await collector.dispose();
    repository.close();
  });

  it("stores a gzip-compressed OTLP batch", async () => {
    // OTLP requires exporters be able to gzip, and OTEL_EXPORTER_OTLP_COMPRESSION=gzip turns it on.
    // The server never looked at Content-Encoding, so it read the gzip bytes as UTF-8 JSON and
    // rejected every single request as invalid_payload with nothing logged.
    const response = await post("/v1/metrics", gzipSync(Buffer.from(METRICS, "utf8")), {
      "content-encoding": "gzip"
    });
    expect(response.status).toBe(200);
    expect(repository.daily("work", "7d").reduce((sum, row) => sum + row.inputTokens, 0))
      .toBe(1200);
    const health = repository.collectionHealth("work");
    expect(health.phase).toBe("collecting");
    expect(health.requests.stored).toBe(1);
    // The refresh callback fires only for data that was actually stored.
    expect(dataEvents).toBe(1);
  });

  it("does not announce new data for a batch it dropped", async () => {
    await post("/v1/metrics", JSON.stringify({ resourceMetrics: [] }));
    await post("/v1/metrics", JSON.stringify({ hello: "world" }));
    expect(dataEvents).toBe(0);
  });

  it("refuses to be a decompression bomb", async () => {
    // The 3 MiB body cap is meaningless after decompression without an output limit: a few hundred
    // kilobytes of gzip expands until the extension host runs out of memory.
    const response = await post(
      "/v1/metrics",
      gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20)),
      { "content-encoding": "gzip" }
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "decompressed_too_large" });
    expect(repository.collectionHealth("work").requests.rejections).toEqual([
      expect.objectContaining({ reason: "decompressed_too_large", count: 1 })
    ]);
  });

  it("rejects protobuf legibly instead of misparsing it", async () => {
    const response = await post("/v1/metrics", Buffer.from([0x0a, 0x00]), {
      "content-type": "application/x-protobuf"
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: "protobuf_unsupported",
      detail: "application/x-protobuf"
    });
    const health = repository.collectionHealth("work");
    expect(health.phase).toBe("rejecting");
    expect(health.requests.rejections).toEqual([
      expect.objectContaining({ reason: "protobuf_unsupported" })
    ]);
  });

  it("rejects an unsupported content type and an unsupported encoding", async () => {
    expect((await post("/v1/metrics", METRICS, { "content-type": "text/csv" })).status).toBe(415);
    const encoded = await post("/v1/metrics", METRICS, { "content-encoding": "br" });
    expect(encoded.status).toBe(415);
    expect(await encoded.json()).toMatchObject({ error: "unsupported_content_encoding" });
    expect(repository.collectionHealth("work").requests.rejections.map((r) => r.reason).sort())
      .toEqual(["unsupported_content_encoding", "unsupported_content_type"]);
  });

  it("tolerates a genuinely absent content type", async () => {
    // Not every exporter sets one, and refusing those would just be a new silent failure. A Uint8Array
    // body is used deliberately: a string body makes fetch invent `text/plain`, which is correctly
    // rejected as an unsupported type.
    const response = await fetch(`http://127.0.0.1:${registration.port}/v1/metrics`, {
      method: "POST",
      headers: { authorization: `Bearer ${registration.token}` },
      body: new Uint8Array(Buffer.from(METRICS, "utf8"))
    });
    expect(response.status).toBe(200);
    expect(repository.collectionHealth("work").requests.stored).toBe(1);
  });

  it("counts an unauthorized request instead of discarding the fact", async () => {
    const response = await post("/v1/metrics", METRICS, { authorization: "Bearer wrong" });
    expect(response.status).toBe(401);
    expect(repository.collectionHealth("work").requests.rejections).toEqual([
      expect.objectContaining({ reason: "unauthorized", count: 1 })
    ]);
  });

  it("rejects valid JSON that is not an OTLP export request", async () => {
    const response = await post("/v1/metrics", JSON.stringify({ hello: "world" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_envelope" });
  });

  it("distinguishes a batch it stored from one it acknowledged and dropped", async () => {
    // A recognised envelope containing nothing storable used to get a bare 200, permanently
    // acknowledging data that was silently ignored.
    const response = await post("/v1/metrics", JSON.stringify({ resourceMetrics: [] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      partialSuccess: { rejectedDataPoints: "0" }
    });
    const health = repository.collectionHealth("work");
    expect(health.phase).toBe("accepted_empty");
    expect(health.requests.acceptedEmpty).toBe(1);
    expect(health.requests.stored).toBe(0);
  });

  it("does not collect traces, and says so", async () => {
    // Claude Code only emits spans under CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1, which Account Guard
    // will not set on a user's behalf, so the route reports a named refusal rather than a bare 404.
    const response = await post("/v1/traces", readFileSync("test/fixtures/otel-traces.json"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "traces_not_collected" });
    expect(repository.collectionHealth("work").requests.rejections).toEqual([
      expect.objectContaining({ reason: "traces_not_collected" })
    ]);
  });

  it("records normalization fallbacks reported by a stored batch", async () => {
    await post("/v1/metrics", JSON.stringify({
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{
            name: "claude_code.token.usage",
            sum: { dataPoints: [{ timeUnixNano: "bogus", asInt: "5", attributes: [] }] }
          }]
        }]
      }]
    }));
    expect(repository.collectionHealth("work").degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "metric_timestamp_fallback", count: 1 })
    ]));
  });

  it("notes when the envelope does not match the route's signal", async () => {
    await post("/v1/metrics", readFileSync("test/fixtures/otel-logs.json", "utf8"));
    expect(repository.collectionHealth("work").degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "signal_envelope_mismatch" })
    ]));
  });

  it("registers itself and reports a fresh registration", async () => {
    expect((await registry.read()).collectors.work?.port).toBe(registration.port);
    const health = repository.collectionHealth("work");
    expect(health.collector.listening).toBe(true);
    expect(health.collector.port).toBe(registration.port);
    expect(health.collector.registrationStale).toBe(false);
    expect(health.collector.heartbeatFailures).toBe(0);
  });

  it("carries registry contention counters into the usage database", async () => {
    // Lock contention and lost updates happen in another module with no database handle, so the
    // heartbeat is what makes them visible to the diagnostics view instead of absorbing them.
    writeFileSync(
      `${paths.registry}.lock`,
      JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }),
      "utf8"
    );
    await collector["refreshRegistration"]();
    expect(repository.collectionHealth("work").degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "registry_lock_stolen" })
    ]));
    // The heartbeat itself must have succeeded, so the registration stays fresh.
    expect(repository.collectionHealth("work").collector.heartbeatFailures).toBe(0);
  });

  it("persists a failing heartbeat instead of dropping the rejected promise", async () => {
    // The wrapper refuses to inject OTEL once the registration is older than its window, so a
    // heartbeat failing into the void stopped telemetry permanently and invisibly.
    writeFileSync(paths.registry, "{corrupt", "utf8");
    await collector["refreshRegistration"]();
    const health = repository.collectionHealth("work");
    expect(health.collector.heartbeatFailures).toBe(1);
    expect(health.collector.heartbeatFailingSince).toBeDefined();
    expect(health.phase).toBe("registration_stale");
    expect(health.degradations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "heartbeat_failed" })
    ]));
    // The transition must be announced, not left for a refresh that may never come.
    expect(dataEvents).toBe(1);
  });

  it("reports the collector as stopped after disposal", async () => {
    await collector.dispose();
    const health = repository.collectionHealth("work");
    expect(health.phase).toBe("collector_stopped");
    expect(health.collector.listening).toBe(false);
    expect(health.collector.stoppedAt).toBeDefined();
  });
});

describe("status snapshot inbox", () => {
  let paths: SupportPaths;
  let registry: ProfileRegistry;
  let repository: UsageRepository;
  let collector: TelemetryCollector;

  const inboxJson = async (name: string, content: string): Promise<void> => {
    await mkdir(paths.snapshotInbox, { recursive: true });
    await writeFile(path.join(paths.snapshotInbox, name), content, "utf8");
  };
  const quarantined = (): Promise<string[]> =>
    readdir(path.join(paths.snapshotInbox, "quarantine")).catch(() => []);

  beforeEach(async () => {
    paths = supportPaths(mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-inbox-")));
    registry = new ProfileRegistry(paths);
    await registry.initialize();
    await registry.upsertProfile(profile);
    repository = new UsageRepository(paths.database);
    collector = new TelemetryCollector(registry, repository, () => undefined);
  });

  afterEach(async () => {
    await collector.dispose();
    repository.close();
  });

  it("quarantines a malformed snapshot instead of destroying the only copy", async () => {
    // The claimed file was unlinked in a `finally`, so malformed JSON, an unknown profile, or any
    // SQLite exception deleted the user's only record of that session.
    await inboxJson("1784782800000-a.json", "{not json");
    await collector.start(profile);

    expect(await quarantined()).toEqual(expect.arrayContaining([
      "1784782800000-a.json",
      "1784782800000-a.json.error.json"
    ]));
    const health = repository.collectionHealth("work");
    expect(health.inbox.quarantined).toBe(1);
    expect(health.inbox.quarantines).toEqual([
      expect.objectContaining({ reason: "malformed_json" })
    ]);
    expect(health.inbox.quarantineDirectory).toBeDefined();
  });

  it("quarantines an unknown profile rather than deleting the snapshot", async () => {
    const snapshot = JSON.parse(readFileSync("test/fixtures/status-snapshot.json", "utf8")) as
      Record<string, unknown>;
    await inboxJson(
      "1784782800000-b.json",
      JSON.stringify({ ...snapshot, profileId: "never-registered" })
    );
    await collector.start(profile);

    expect(await quarantined()).toContain("1784782800000-b.json");
    const error = JSON.parse(await readFile(
      path.join(paths.snapshotInbox, "quarantine", "1784782800000-b.json.error.json"),
      "utf8"
    )) as { reason: string };
    expect(error.reason).toBe("unknown_profile");
  });

  it("continues the pass after one bad file", async () => {
    // A single failing file used to abort the whole polling pass, stalling every later snapshot.
    await inboxJson("1784782800000-bad.json", "{not json");
    await inboxJson(
      "1784782800001-good.json",
      readFileSync("test/fixtures/status-snapshot.json", "utf8")
    );
    await collector.start(profile);

    expect(repository.latestStatusSnapshot("work")?.sessionId).toBe("session-123");
    const health = repository.collectionHealth("work");
    expect(health.inbox.processed).toBe(1);
    expect(health.inbox.quarantined).toBe(1);
    // The good file is gone because it committed; the bad one was preserved, not deleted.
    const remaining = (await readdir(paths.snapshotInbox)).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(0);
    expect(await quarantined()).toContain("1784782800000-bad.json");
  });

  it("deletes a snapshot only after it is committed", async () => {
    await inboxJson(
      "1784782800000-c.json",
      readFileSync("test/fixtures/status-snapshot.json", "utf8")
    );
    await collector.start(profile);
    expect(repository.latestStatusSnapshot("work")).toBeDefined();
    expect((await readdir(paths.snapshotInbox)).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    expect(await quarantined()).toHaveLength(0);
  });

  it("reclaims a claim abandoned by a dead extension host", async () => {
    // Otherwise a host that dies mid-pass parks the snapshot under a .processing-<pid> name that
    // nothing will ever look at again.
    const orphan = "1784782800000-d.json.processing-999999";
    await inboxJson(orphan, readFileSync("test/fixtures/status-snapshot.json", "utf8"));
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path.join(paths.snapshotInbox, orphan), old, old);

    await collector.start(profile);
    // First pass renames it back; the next pass ingests it.
    await collector["processSnapshotInbox"]();
    expect(repository.latestStatusSnapshot("work")?.sessionId).toBe("session-123");
  });
});
