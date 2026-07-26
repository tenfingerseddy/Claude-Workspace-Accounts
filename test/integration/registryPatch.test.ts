import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../../src/core/models.js";
import { normalizeWindowsPath } from "../../src/core/paths.js";
import { ProfileRegistry, type SupportPaths } from "../../src/profiles/registryStore.js";

/**
 * Paths are built explicitly rather than through `resolveSupportPaths`, which ignores its
 * argument whenever `LOCALAPPDATA` is set and would therefore point these tests at the
 * developer's real account registry.
 */
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

async function registry(): Promise<ProfileRegistry> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-account-guard-patch-"));
  const store = new ProfileRegistry(supportPaths(root));
  await store.initialize();
  return store;
}

function profile(id: string, configDir: string): AccountProfile {
  return {
    id,
    displayName: id,
    marker: id.slice(0, 1).toUpperCase(),
    configDir,
    configDirNormalized: normalizeWindowsPath(configDir),
    // Deliberately not nested inside configDir: the registry validator rejects that.
    vsCodeUserDataDir: `${configDir}-vscode`,
    createdAt: new Date().toISOString()
  };
}

describe("registry field patches", () => {
  it("refuses a second account for the same configuration directory", async () => {
    const store = await registry();
    expect(await store.createProfile(profile("work", "C:\\Users\\dev\\.claude"))).toBe("created");
    // The same directory under a different name is the collision two windows can race into.
    expect(await store.createProfile(profile("default", "C:\\Users\\dev\\.claude")))
      .toBe("duplicate_config_dir");
    expect(await store.createProfile(profile("work", "C:\\Users\\dev\\.claude-other")))
      .toBe("duplicate_id");
    expect((await store.listProfiles()).map((entry) => entry.id)).toEqual(["work"]);
  });

  it("keeps concurrent field writes from erasing each other", async () => {
    const store = await registry();
    await store.createProfile(profile("work", "C:\\Users\\dev\\.claude-work"));
    // Two windows: one confirms an identity, the other turns on usage collection. Whole-object
    // upserts of a profile read beforehand used to discard whichever landed first.
    await Promise.all([
      store.patchProfile("work", {
        expectedIdentity: { email: "dev@example.com" },
        lastVerifiedAt: "2026-07-27T00:00:00.000Z"
      }),
      store.patchProfile("work", { telemetryEnabled: true })
    ]);
    const stored = await store.getProfile("work");
    expect(stored?.expectedIdentity?.email).toBe("dev@example.com");
    expect(stored?.telemetryEnabled).toBe(true);
    expect(stored?.lastVerifiedAt).toBe("2026-07-27T00:00:00.000Z");
  });

  it("removes a field when it is patched to undefined, and reports a missing account", async () => {
    const store = await registry();
    await store.createProfile(profile("work", "C:\\Users\\dev\\.claude-work"));
    await store.patchProfile("work", { expectedIdentity: { email: "dev@example.com" } });
    await store.patchProfile("work", { expectedIdentity: undefined });
    const stored = await store.getProfile("work");
    expect(stored).toBeDefined();
    expect("expectedIdentity" in (stored as object)).toBe(false);
    expect(await store.patchProfile("gone", { telemetryEnabled: true })).toBe(false);
  });

  it("merges integration fields without dropping the wrapper path", async () => {
    const store = await registry();
    await store.patchIntegration({ wrapperPath: "C:\\guard\\wrapper.exe" });
    await store.patchIntegration({ telemetryEnabled: false });
    const document = await store.read();
    expect(document.integration.wrapperPath).toBe("C:\\guard\\wrapper.exe");
    expect(document.integration.telemetryEnabled).toBe(false);
  });

  it("leaves a profile untouched when the document on disk is invalid", async () => {
    const store = await registry();
    await store.createProfile(profile("work", "C:\\Users\\dev\\.claude-work"));
    const before = await readFile(store.paths.registry, "utf8");
    await writeFile(store.paths.registry, "{ not json", "utf8");
    await expect(store.patchProfile("work", { telemetryEnabled: true })).rejects.toThrow();
    // The corrupt file is preserved rather than replaced with a fresh, empty registry.
    expect(await readFile(store.paths.registry, "utf8")).not.toBe(before);
  });
});
