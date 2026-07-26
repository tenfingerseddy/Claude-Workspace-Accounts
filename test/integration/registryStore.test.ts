import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-registry-"));
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
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-registry-"));
    const paths = supportPaths(root);
    writeFileSync(paths.registry, "{corrupt", "utf8");
    const registry = new ProfileRegistry(paths);

    await expect(registry.initialize()).rejects.toBeDefined();
    expect(readFileSync(paths.registry, "utf8")).toBe("{corrupt");
  });

  it("rejects duplicate profile isolation paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-registry-"));
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
