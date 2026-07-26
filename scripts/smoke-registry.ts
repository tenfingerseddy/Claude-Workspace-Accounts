import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProfileRegistry, type SupportPaths } from "../src/profiles/registryStore.js";

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

const root = await mkdtemp(path.join(os.tmpdir(), "claude-account-guard-registry-"));
const paths = supportPaths(root);

try {
  const registry = new ProfileRegistry(paths);
  await registry.initialize();
  const now = new Date().toISOString();
  const duplicateDirectoryProfiles = [
    {
      id: "work",
      displayName: "Work",
      marker: "W",
      configDir: "C:\\profiles\\work",
      configDirNormalized: "c:\\profiles\\work",
      vsCodeUserDataDir: "C:\\guard\\work",
      createdAt: now
    },
    {
      id: "personal",
      displayName: "Personal",
      marker: "P",
      configDir: "C:\\profiles\\work",
      configDirNormalized: "c:\\profiles\\work",
      vsCodeUserDataDir: "C:\\guard\\personal",
      createdAt: now
    }
  ];
  let duplicateRejected = false;
  try {
    await registry.upsertProfiles(duplicateDirectoryProfiles);
  } catch {
    duplicateRejected = true;
  }
  if (!duplicateRejected || (await registry.listProfiles()).length !== 0) {
    throw new Error("Duplicate profile isolation paths were not rejected atomically.");
  }

  await writeFile(paths.registry, "{corrupt", "utf8");
  const reopening = new ProfileRegistry(paths);
  let corruptRejected = false;
  try {
    await reopening.initialize();
  } catch {
    corruptRejected = true;
  }
  if (!corruptRejected || await readFile(paths.registry, "utf8") !== "{corrupt") {
    throw new Error("A corrupt registry was replaced instead of preserved fail-closed.");
  }

  // Two ProfileRegistry instances stand in for two extension hosts: they share no in-process queue,
  // so without cross-process coordination one of these writes is lost and the wrapper finds either no
  // collector or a stale one.
  const concurrentRoot = await mkdtemp(path.join(os.tmpdir(), "claude-account-guard-registry-"));
  const concurrentPaths = supportPaths(concurrentRoot);
  const hostA = new ProfileRegistry(concurrentPaths);
  await hostA.initialize();
  const hostB = new ProfileRegistry(concurrentPaths);
  await Promise.all([
    hostA.upsertProfile({
      id: "work",
      displayName: "Work",
      marker: "W",
      configDir: "C:\\profiles\\work",
      configDirNormalized: "c:\\profiles\\work",
      vsCodeUserDataDir: "C:\\guard\\work",
      createdAt: now
    }),
    hostB.upsertProfile({
      id: "personal",
      displayName: "Personal",
      marker: "P",
      configDir: "C:\\profiles\\personal",
      configDirNormalized: "c:\\profiles\\personal",
      vsCodeUserDataDir: "C:\\guard\\personal",
      createdAt: now
    })
  ]);
  await Promise.all([
    hostA.registerCollector({
      profileId: "work",
      port: 5101,
      token: "a".repeat(48),
      pid: 1,
      updatedAt: now
    }),
    hostB.registerCollector({
      profileId: "personal",
      port: 5102,
      token: "b".repeat(48),
      pid: 2,
      updatedAt: now
    })
  ]);
  const shared = await hostA.read();
  if (shared.profiles.length !== 2
    || shared.collectors.work?.port !== 5101
    || shared.collectors.personal?.port !== 5102) {
    throw new Error("A concurrent cross-process registry write was lost.");
  }
  await rm(concurrentRoot, { recursive: true, force: true });
  console.log("Shared registry integrity smoke test: OK");
} finally {
  await rm(root, { recursive: true, force: true });
}
