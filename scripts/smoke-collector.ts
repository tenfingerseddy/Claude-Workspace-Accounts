import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AccountProfile } from "../src/core/models.js";
import {
  ProfileRegistry,
  type SupportPaths
} from "../src/profiles/registryStore.js";
import { UsageRepository } from "../src/storage/usageRepository.js";
import { TelemetryCollector } from "../src/telemetry/telemetryCollector.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "claude-account-guard-collector-"));
const paths: SupportPaths = {
  root: directory,
  registry: path.join(directory, "registry.json"),
  database: path.join(directory, "usage.sqlite3"),
  wrapperDirectory: path.join(directory, "wrapper"),
  snapshotInbox: path.join(directory, "snapshots"),
  handoffs: path.join(directory, "handoffs")
};
const registry = new ProfileRegistry(paths);
await registry.initialize();
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
await registry.upsertProfile(profile);
const repository = new UsageRepository(paths.database);
const collector = new TelemetryCollector(registry, repository, () => undefined);

// A malformed snapshot must be preserved for inspection, not destroyed. `start` drains the inbox
// once, so seed it first.
await writeFile(path.join(paths.snapshotInbox, "1784782800000-bad.json"), "{not json", "utf8");

try {
  const registration = await collector.start(profile);
  const endpoint = `http://127.0.0.1:${registration.port}/v1/metrics`;
  const payload = await readFile("test/fixtures/otel-metrics.json", "utf8");
  const rejected = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer incorrect"
    },
    body: payload
  });
  if (rejected.status !== 401) {
    throw new Error("The loopback collector accepted an invalid bearer token.");
  }
  const protobuf = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-protobuf",
      authorization: `Bearer ${registration.token}`
    },
    body: Buffer.from([0x0a, 0x00])
  });
  if (protobuf.status !== 415) {
    throw new Error(`Protobuf was not refused legibly: ${protobuf.status}`);
  }

  const traces = await fetch(`http://127.0.0.1:${registration.port}/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${registration.token}`
    },
    body: await readFile("test/fixtures/otel-traces.json", "utf8")
  });
  if (traces.status !== 404) {
    throw new Error(
      `Trace collection is not claimed and must be refused, got ${traces.status}.`
    );
  }

  // The successful batches come last on purpose: the health phase must recover to "collecting" once
  // real data lands, rather than staying stuck on the last thing that went wrong.
  const accepted = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${registration.token}`
    },
    body: payload
  });
  if (!accepted.ok) {
    throw new Error(`The loopback collector rejected valid OTLP: ${accepted.status}`);
  }
  const inputTokens = repository.daily("work", "7d")
    .reduce((sum, row) => sum + row.inputTokens, 0);
  if (inputTokens !== 1200) {
    throw new Error("The loopback collector did not persist normalized metrics.");
  }

  // OTLP requires exporters be able to gzip, and OTEL_EXPORTER_OTLP_COMPRESSION=gzip turns it on.
  const compressed = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      authorization: `Bearer ${registration.token}`
    },
    body: gzipSync(Buffer.from(payload, "utf8"))
  });
  if (!compressed.ok) {
    throw new Error(`The loopback collector could not read a gzip body: ${compressed.status}`);
  }
  if (repository.daily("work", "7d").reduce((sum, row) => sum + row.inputTokens, 0) !== 2400) {
    throw new Error("The gzip batch was acknowledged without being stored.");
  }

  const health = repository.collectionHealth("work", {
    telemetryEnabled: true,
    runtimeProfileRegistered: true
  });
  if (health.phase !== "collecting"
    || health.collector.listening !== true
    || health.collector.port !== registration.port
    || health.collector.registrationStale !== false
    || health.requests.stored !== 2) {
    throw new Error(`Collection health did not describe a healthy collector: ${health.phase}`);
  }
  const reasons = health.requests.rejections.map((counter) => counter.reason).sort();
  if (reasons.join(",") !== "protobuf_unsupported,traces_not_collected,unauthorized") {
    throw new Error(`Rejections were not recorded with reasons: ${reasons.join(",")}`);
  }

  const quarantine = await readdir(path.join(paths.snapshotInbox, "quarantine"));
  if (!quarantine.includes("1784782800000-bad.json")
    || health.inbox.quarantined !== 1
    || health.inbox.quarantines[0]?.reason !== "malformed_json") {
    throw new Error("A malformed snapshot was destroyed instead of quarantined with a reason.");
  }
  console.log("Loopback collector executable smoke test: OK");
} finally {
  await collector.dispose();
  repository.close();
  await rm(directory, { recursive: true, force: true });
}
