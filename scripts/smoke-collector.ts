import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  console.log("Loopback collector executable smoke test: OK");
} finally {
  await collector.dispose();
  repository.close();
  await rm(directory, { recursive: true, force: true });
}
