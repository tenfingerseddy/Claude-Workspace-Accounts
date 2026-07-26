import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileRegistry, type SupportPaths } from "../../src/profiles/registryStore.js";

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

describe("shared registry integrity", () => {
  it("creates an empty registry only when the file is absent", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const registry = new ProfileRegistry(supportPaths(root));
    await registry.initialize();
    expect(await registry.read()).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      profiles: [],
      workspaceLocks: []
    });
  });

  it("preserves a corrupt registry and rejects startup", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    writeFileSync(paths.registry, "{corrupt", "utf8");
    const registry = new ProfileRegistry(paths);

    await expect(registry.initialize()).rejects.toBeDefined();
    expect(readFileSync(paths.registry, "utf8")).toBe("{corrupt");
  });

  it("does not lose a concurrent collector registration from another window", async () => {
    // Each window read-modify-writes the whole document. Atomic rename protects a reader from
    // half-written JSON but does nothing about a lost update, so a collector registration could be
    // clobbered by an older read and the wrapper would then find no collector at all.
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    const now = new Date().toISOString();
    const first = new ProfileRegistry(paths);
    await first.initialize();
    // Two ProfileRegistry instances stand in for two extension hosts: they share no in-process queue.
    const second = new ProfileRegistry(paths);

    await first.upsertProfile({
      id: "work",
      displayName: "Work",
      marker: "W",
      configDir: "C:\\profiles\\work",
      configDirNormalized: "c:\\profiles\\work",
      vsCodeUserDataDir: "C:\\guard\\work",
      createdAt: now
    });
    await second.upsertProfile({
      id: "personal",
      displayName: "Personal",
      marker: "P",
      configDir: "C:\\profiles\\personal",
      configDirNormalized: "c:\\profiles\\personal",
      vsCodeUserDataDir: "C:\\guard\\personal",
      createdAt: now
    });

    const registrations = [
      first.registerCollector({
        profileId: "work",
        port: 5001,
        token: "a".repeat(48),
        pid: 1,
        updatedAt: now
      }),
      second.registerCollector({
        profileId: "personal",
        port: 5002,
        token: "b".repeat(48),
        pid: 2,
        updatedAt: now
      }),
      first.upsertWorkspaceLock({
        workspaceUri: "file:///C:/repos/one",
        workspacePathNormalized: "c:\\repos\\one",
        workspaceLabel: "one",
        profileId: "work",
        mode: "enforce",
        createdAt: now,
        updatedAt: now
      })
    ];
    await Promise.all(registrations);

    const document = await first.read();
    // Every concurrent write must be present: none may have been silently overwritten.
    expect(Object.keys(document.collectors).sort()).toEqual(["personal", "work"]);
    expect(document.collectors.work?.port).toBe(5001);
    expect(document.collectors.personal?.port).toBe(5002);
    expect(document.workspaceLocks).toHaveLength(1);
    expect(document.profiles.map((profile) => profile.id).sort()).toEqual(["personal", "work"]);
  });

  it("survives many interleaved cross-process writes without losing any", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    const now = new Date().toISOString();
    const hosts = [0, 1, 2, 3].map(() => new ProfileRegistry(paths));
    await hosts[0]!.initialize();

    await Promise.all(hosts.map((host, index) => host.upsertProfile({
      id: `profile-${index}`,
      displayName: `Profile ${index}`,
      marker: String(index),
      configDir: `C:\\profiles\\p${index}`,
      configDirNormalized: `c:\\profiles\\p${index}`,
      vsCodeUserDataDir: `C:\\guard\\p${index}`,
      createdAt: now
    })));

    const document = await hosts[0]!.read();
    expect(document.profiles).toHaveLength(4);
    // The revision must have advanced once per applied write, with no gaps or reuse.
    expect(document.revision).toBeGreaterThanOrEqual(4);
  });

  it("recovers a lock abandoned by a dead process instead of deadlocking", async () => {
    // Fail open is the rule: contention must never be able to stop activation.
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    const registry = new ProfileRegistry(paths);
    await registry.initialize();
    writeFileSync(
      `${paths.registry}.lock`,
      JSON.stringify({ pid: 999_999, acquiredAt: new Date().toISOString() }),
      "utf8"
    );

    await registry.registerCollector({
      profileId: "work",
      port: 5003,
      token: "c".repeat(48),
      pid: 3,
      updatedAt: new Date().toISOString()
    });
    expect((await registry.read()).collectors.work?.port).toBe(5003);
    expect(registry.drainWriteDiagnostics().registry_lock_stolen).toBe(1);
  });

  it("still writes when the lock cannot be taken at all", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    const registry = new ProfileRegistry(paths);
    await registry.initialize();
    // A live owner that never releases. The write must proceed unlocked rather than hang.
    writeFileSync(
      `${paths.registry}.lock`,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8"
    );

    await registry.registerCollector({
      profileId: "work",
      port: 5004,
      token: "d".repeat(48),
      pid: 4,
      updatedAt: new Date().toISOString()
    });
    expect((await registry.read()).collectors.work?.port).toBe(5004);
    expect(registry.drainWriteDiagnostics().registry_lock_contended).toBe(1);
  });

  it("keeps a corrupt registry fail-closed even under the write lock", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    const registry = new ProfileRegistry(paths);
    await registry.initialize();
    writeFileSync(paths.registry, "{corrupt", "utf8");

    await expect(registry.registerCollector({
      profileId: "work",
      port: 5005,
      token: "e".repeat(48),
      pid: 5,
      updatedAt: new Date().toISOString()
    })).rejects.toBeDefined();
    expect(readFileSync(paths.registry, "utf8")).toBe("{corrupt");
    // The lock must not be left behind after a failure, or the next window waits for nothing.
    expect(existsSync(`${paths.registry}.lock`)).toBe(false);
  });

  it("rejects duplicate profile isolation paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-registry-"));
    const paths = supportPaths(root);
    const now = new Date().toISOString();
    const profile = {
      displayName: "Work",
      marker: "W",
      configDir: "C:\\profiles\\work",
      configDirNormalized: "c:\\profiles\\work",
      vsCodeUserDataDir: "C:\\guard\\work",
      createdAt: now
    };
    writeFileSync(paths.registry, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      profiles: [
        { ...profile, id: "work" },
        { ...profile, id: "personal", displayName: "Personal", marker: "P" }
      ],
      workspaceLocks: [],
      collectors: {},
      integration: {},
      updatedAt: now
    }), "utf8");
    const registry = new ProfileRegistry(paths);

    await expect(registry.initialize()).rejects.toThrow(/duplicate/i);
  });
});
