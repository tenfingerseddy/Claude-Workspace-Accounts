import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyRegistry } from "../../src/core/models.js";
import type {
  InspectedSetting,
  MigrationHost,
  MigrationStep,
  SettingScope
} from "../../src/migration/legacyMigration.js";
import {
  LEGACY_EXTENSION_ID,
  MIGRATION_MARKER,
  MIGRATION_PROVENANCE,
  MIGRATION_REPORT,
  SETTING_KEYS,
  isLegacyWrapperPath,
  migrateLegacyInstallation,
  migrationManualSteps,
  resolveLegacySupportRoot
} from "../../src/migration/legacyMigration.js";

/**
 * Every path in these tests is built from a fresh temporary directory. Nothing is ever derived
 * from %LOCALAPPDATA% or the developer's home directory: a test that patched a path resolved from
 * the real environment once corrupted a real `registry.json`, which was the only copy of that
 * user's workspace bindings. `vitest.config.ts` also isolates %LOCALAPPDATA% for the whole suite,
 * so both defences have to fail before a test can reach a real installation.
 */
const NEW_WRAPPER = "C:\\new\\wrapper\\claude-workspace-accounts-wrapper.exe";
const NEW_BRIDGE = "C:\\new\\wrapper\\statusline-bridge.exe";
const OLD_WRAPPER = "C:\\Users\\dev\\AppData\\Local\\ClaudeAccountGuard\\wrapper"
  + "\\claude-account-guard-wrapper.exe";

class FakeHost implements MigrationHost {
  public readonly values = new Map<string, Map<SettingScope, unknown>>();
  public readonly writes: string[] = [];
  public installedExtensions = new Set<string>();
  /** `section.key` combinations whose `updateSetting` throws, to exercise the failure paths. */
  public readonly unwritable = new Set<string>();

  public set(section: string, key: string, scope: SettingScope, value: unknown): void {
    const id = `${section}.${key}`;
    const scoped = this.values.get(id) ?? new Map<SettingScope, unknown>();
    scoped.set(scope, value);
    this.values.set(id, scoped);
  }

  public get(section: string, key: string, scope: SettingScope): unknown {
    return this.values.get(`${section}.${key}`)?.get(scope);
  }

  public inspectSetting(section: string, key: string): InspectedSetting | undefined {
    const scoped = this.values.get(`${section}.${key}`);
    if (!scoped) {
      return undefined;
    }
    return {
      globalValue: scoped.get("global"),
      workspaceValue: scoped.get("workspace"),
      workspaceFolderValue: scoped.get("workspaceFolder")
    };
  }

  public async updateSetting(
    section: string,
    key: string,
    value: unknown,
    scope: SettingScope
  ): Promise<void> {
    const id = `${section}.${key}`;
    if (this.unwritable.has(id)) {
      throw new Error(`${id} is read-only in this test`);
    }
    this.writes.push(`${id}@${scope}=${JSON.stringify(value)}`);
    if (value === undefined) {
      this.values.get(id)?.delete(scope);
      if (this.values.get(id)?.size === 0) {
        this.values.delete(id);
      }
      return Promise.resolve();
    }
    this.set(section, key, scope, value);
    return Promise.resolve();
  }

  public isExtensionInstalled(extensionId: string): boolean {
    return this.installedExtensions.has(extensionId);
  }
}

interface Fixture {
  root: string;
  legacyRoot: string;
  claudeConfigDir: string;
  host: FakeHost;
}

const created: string[] = [];

function fixture(): Fixture {
  const base = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-migration-"));
  created.push(base);
  const legacyRoot = path.join(base, "ClaudeAccountGuard");
  const root = path.join(base, "ClaudeWorkspaceAccounts");
  const claudeConfigDir = path.join(base, ".claude-work");
  return { root, legacyRoot, claudeConfigDir, host: new FakeHost() };
}

function options(target: Fixture) {
  return {
    root: target.root,
    legacyRoot: target.legacyRoot,
    wrapperPath: NEW_WRAPPER,
    statusLineBridgePath: NEW_BRIDGE,
    host: target.host
  };
}

/** The live state of the owner's own installation, reduced to its shape. */
function legacyRegistry(configDir: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    revision: 9,
    profiles: [
      {
        id: "work",
        displayName: "Work",
        marker: "W",
        configDir,
        configDirNormalized: configDir.toLowerCase(),
        vsCodeUserDataDir: "C:\\old\\vscode\\work",
        createdAt: "2026-01-01T00:00:00.000Z",
        telemetryEnabled: true
      }
    ],
    workspaceLocks: [],
    collectors: {},
    integration: {
      wrapperPath: OLD_WRAPPER,
      configuredAt: "2026-01-02T00:00:00.000Z",
      version: "0.1.0",
      telemetryEnabled: true
    },
    updatedAt: "2026-01-02T00:00:00.000Z"
  }, null, 2)}\n`;
}

/**
 * A real WAL-mode usage database, left open the way the previous extension leaves it.
 *
 * The literal strings "SQLITE", "WAL" and "SHM" used to stand in for the database, which is why the
 * suite could not see that the three files were being copied independently while another process was
 * committing to them. A live handle is the whole point: it keeps the write-ahead log
 * uncheckpointed, which is the state that makes a file-at-a-time copy inconsistent.
 */
interface LegacyDatabase {
  file: string;
  rows: number;
  commit: (count: number) => void;
  /** Fold the log into the database file and reset it — the event a naive copy cannot survive. */
  checkpoint: () => void;
  close: () => void;
}

const openDatabases: DatabaseSync[] = [];

function populateLegacyDatabase(target: Fixture, rows = 400): LegacyDatabase {
  mkdirSync(target.legacyRoot, { recursive: true });
  const file = path.join(target.legacyRoot, "usage.sqlite3");
  const database = new DatabaseSync(file);
  openDatabases.push(database);
  database.exec("PRAGMA journal_mode = WAL");
  // Small enough that a checkpoint really can land part way through a naive copy.
  database.exec("PRAGMA wal_autocheckpoint = 8");
  database.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  const insert = database.prepare("INSERT INTO events (payload) VALUES (?)");
  const payload = "p".repeat(2048);
  let written = 0;
  const commit = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      insert.run(payload);
    }
    written += count;
  };
  commit(rows);
  let closed = false;
  return {
    file,
    get rows() {
      return written;
    },
    commit,
    checkpoint: () => database.exec("PRAGMA wal_checkpoint(TRUNCATE)"),
    close: () => {
      if (!closed) {
        closed = true;
        database.close();
      }
    }
  };
}

/** Reopen a migrated database and report what SQLite thinks of it. */
function inspectDatabase(file: string): { integrity: string; rows: number } {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = (database.prepare("PRAGMA integrity_check").get() as
      { integrity_check: string }).integrity_check;
    const rows = (database.prepare("SELECT COUNT(*) AS n FROM events").get() as
      { n: number }).n;
    return { integrity, rows };
  } finally {
    database.close();
  }
}

/** A populated old support directory, exactly as an upgrading user has it. */
function populateLegacy(target: Fixture): LegacyDatabase {
  mkdirSync(target.legacyRoot, { recursive: true });
  mkdirSync(path.join(target.legacyRoot, "snapshots"), { recursive: true });
  mkdirSync(path.join(target.legacyRoot, "wrapper", "statusline-backups"), { recursive: true });
  mkdirSync(path.join(target.legacyRoot, "handoffs"), { recursive: true });
  mkdirSync(path.join(target.legacyRoot, "vscode", "work"), { recursive: true });
  writeFileSync(
    path.join(target.legacyRoot, "registry.json"),
    legacyRegistry(target.claudeConfigDir),
    "utf8"
  );
  const database = populateLegacyDatabase(target);
  writeFileSync(path.join(target.legacyRoot, "binding-cache.json"), "{\"cache\":1}", "utf8");
  writeFileSync(path.join(target.legacyRoot, "wrapper-health.json"), "{\"pid\":1}", "utf8");
  writeFileSync(
    path.join(target.legacyRoot, "wrapper", "claude-account-guard-wrapper.exe"),
    "MZ",
    "utf8"
  );
  writeFileSync(
    path.join(target.legacyRoot, "snapshots", "snap-1.json"),
    "{\"snapshot\":1}",
    "utf8"
  );
  writeFileSync(
    path.join(target.legacyRoot, "wrapper", "statusline-backups", "work.json"),
    "{\"schemaVersion\":1,\"nextCommand\":\"my-own-line\"}",
    "utf8"
  );
  return database;
}

/** The empty document `ProfileRegistry.initialize()` writes when it finds no registry. */
function writePlaceholderRegistry(target: Fixture): void {
  mkdirSync(target.root, { recursive: true });
  writeFileSync(
    path.join(target.root, "registry.json"),
    `${JSON.stringify(createEmptyRegistry("2026-02-01T00:00:00.000Z"), null, 2)}\n`,
    "utf8"
  );
}

/** The account's own Claude configuration directory, with our bridge already installed. */
function populateProfile(target: Fixture, statusLineCommand?: string): void {
  mkdirSync(path.join(target.claudeConfigDir, ".claude-account-guard"), { recursive: true });
  writeFileSync(
    path.join(target.claudeConfigDir, ".claude-account-guard", "statusline-next.json"),
    "{\"schemaVersion\":1,\"nextCommand\":\"my-own-line\"}",
    "utf8"
  );
  writeFileSync(
    path.join(target.claudeConfigDir, "settings.json"),
    `${JSON.stringify({
      model: "sonnet",
      statusLine: {
        type: "command",
        command: statusLineCommand
          ?? "\"C:\\\\Users\\\\dev\\\\AppData\\\\Local\\\\ClaudeAccountGuard\\\\wrapper"
            + "\\\\statusline-bridge.exe\"",
        padding: 0
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

function step(steps: readonly MigrationStep[], artifact: string): MigrationStep | undefined {
  return steps.find((candidate) => candidate.artifact === artifact);
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Binary-safe, for comparing a database file that must not have been touched. */
function bytes(file: string): string {
  return readFileSync(file).toString("base64");
}

beforeEach(() => {
  // Windows refuses to remove a directory holding an open SQLite file, and a leaked handle would
  // make the next test's fixture inherit the last one's database.
  for (const database of openDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("legacy support root resolution", () => {
  it("names the previous directory under %LOCALAPPDATA%", () => {
    expect(resolveLegacySupportRoot("C:\\Users\\dev\\AppData\\Local"))
      .toBe("C:\\Users\\dev\\AppData\\Local\\ClaudeAccountGuard");
  });

  it("has nothing to migrate when %LOCALAPPDATA% is unavailable", () => {
    // Both identities fall back to the same extension-storage layout, so there is no old
    // directory that is distinguishable from the new one.
    expect(resolveLegacySupportRoot(undefined)).toBeUndefined();
  });

  it("recognises only the previous wrapper executable", () => {
    expect(isLegacyWrapperPath(OLD_WRAPPER)).toBe(true);
    expect(isLegacyWrapperPath("c:/x/CLAUDE-ACCOUNT-GUARD-WRAPPER.EXE")).toBe(true);
    expect(isLegacyWrapperPath(NEW_WRAPPER)).toBe(false);
    expect(isLegacyWrapperPath("C:\\tools\\my-wrapper.exe")).toBe(false);
    expect(isLegacyWrapperPath(undefined)).toBe(false);
    expect(isLegacyWrapperPath("   ")).toBe(false);
  });
});

describe("nothing to migrate", () => {
  it("reports no previous installation and writes nothing at all", async () => {
    const target = fixture();
    const report = await migrateLegacyInstallation(options(target));

    expect(report.legacyInstallationFound).toBe(false);
    expect(report.changed).toBe(false);
    expect(report.steps).toEqual([]);
    expect(report.failures).toEqual([]);
    // A clean install must not have a support root created by the migration, and must not have a
    // migration report implying one happened.
    expect(existsSync(target.root)).toBe(false);
    expect(existsSync(target.legacyRoot)).toBe(false);
    expect(target.host.writes).toEqual([]);
  });
});

describe("a full previous installation", () => {
  it("copies the support state, leaves the old directory intact, and marks it", async () => {
    const target = fixture();
    const database = populateLegacy(target);
    populateProfile(target);
    const before = readdirSync(target.legacyRoot).sort();

    const report = await migrateLegacyInstallation(options(target));

    expect(report.legacyInstallationFound).toBe(true);
    expect(report.changed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.blockedBy).toBeUndefined();
    expect(step(report.steps, "Support directory")?.state).toBe("migrated");

    for (const [name, content] of [
      ["registry.json", undefined],
      ["usage.sqlite3", undefined],
      ["binding-cache.json", "{\"cache\":1}"]
    ] as const) {
      expect(existsSync(path.join(target.root, name))).toBe(true);
      if (content) {
        expect(read(path.join(target.root, name))).toBe(content);
      }
    }
    // The database arrives as one checkpointed file. Copying SQLite's sidecars alongside it is what
    // produced an inconsistent destination, so they are deliberately not carried over.
    expect(existsSync(path.join(target.root, "usage.sqlite3-wal"))).toBe(false);
    expect(existsSync(path.join(target.root, "usage.sqlite3-shm"))).toBe(false);
    expect(inspectDatabase(path.join(target.root, "usage.sqlite3")))
      .toEqual({ integrity: "ok", rows: database.rows });
    expect(read(path.join(target.root, "snapshots", "snap-1.json"))).toBe("{\"snapshot\":1}");
    // The status-line backup mirror is user data, not a binary: losing it can leave somebody's
    // own status line unrestorable.
    expect(existsSync(path.join(target.root, "wrapper", "statusline-backups", "work.json")))
      .toBe(true);

    // The old binaries, the dead isolated-window directories, and the previous wrapper's health
    // record are deliberately not carried over.
    expect(existsSync(path.join(target.root, "wrapper", "claude-account-guard-wrapper.exe")))
      .toBe(false);
    expect(existsSync(path.join(target.root, "handoffs"))).toBe(false);
    expect(existsSync(path.join(target.root, "vscode"))).toBe(false);
    expect(existsSync(path.join(target.root, "wrapper-health.json"))).toBe(false);

    // Copy, not move: the only new thing in the old directory is the marker.
    expect(readdirSync(target.legacyRoot).sort()).toEqual([...before, MIGRATION_MARKER].sort());
    expect(read(path.join(target.legacyRoot, "registry.json")))
      .toBe(legacyRegistry(target.claudeConfigDir));
    expect(JSON.parse(read(path.join(target.legacyRoot, MIGRATION_MARKER))))
      .toMatchObject({ schemaVersion: 1, to: target.root });
  });

  it("repoints the recorded wrapper path at the renamed executable", async () => {
    const target = fixture();
    populateLegacy(target);
    populateProfile(target);

    const report = await migrateLegacyInstallation(options(target));

    const migrated = JSON.parse(read(path.join(target.root, "registry.json"))) as {
      revision: number;
      integration: { wrapperPath: string; version: string };
      profiles: { id: string }[];
    };
    expect(migrated.integration.wrapperPath).toBe(NEW_WRAPPER);
    // The schema stays at version 1 with no migration, so nothing else about the document moves.
    expect(migrated.revision).toBe(9);
    expect(migrated.profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect(step(report.steps, "Recorded wrapper path")?.state).toBe("migrated");
  });

  it("drops an upstream wrapper that is really the previous executable", async () => {
    const target = fixture();
    mkdirSync(target.legacyRoot, { recursive: true });
    writeFileSync(
      path.join(target.legacyRoot, "registry.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profiles: [],
        workspaceLocks: [],
        collectors: {},
        integration: { wrapperPath: OLD_WRAPPER, upstreamWrapper: OLD_WRAPPER },
        updatedAt: "2026-01-02T00:00:00.000Z"
      })}\n`,
      "utf8"
    );

    await migrateLegacyInstallation(options(target));

    const migrated = JSON.parse(read(path.join(target.root, "registry.json"))) as {
      integration: Record<string, unknown>;
    };
    // Left in place, "restoring" it on disconnect would hand Claude Code back to an executable
    // this extension no longer manages.
    expect(migrated.integration.upstreamWrapper).toBeUndefined();
    expect(migrated.integration.wrapperPath).toBe(NEW_WRAPPER);
  });

  it("renames the per-account directory and repoints that account's status line", async () => {
    const target = fixture();
    populateLegacy(target);
    populateProfile(target);

    const report = await migrateLegacyInstallation(options(target));

    expect(existsSync(path.join(target.claudeConfigDir, ".claude-account-guard"))).toBe(false);
    expect(read(path.join(
      target.claudeConfigDir,
      ".claude-workspace-accounts",
      "statusline-next.json"
    ))).toContain("my-own-line");

    const settings = JSON.parse(read(path.join(target.claudeConfigDir, "settings.json"))) as {
      model: string;
      statusLine: { type: string; command: string; padding: number };
    };
    expect(settings.statusLine.command).toBe(`"${NEW_BRIDGE}"`);
    // The rest of the user's Claude settings, and the rest of their statusLine object, survive.
    expect(settings.model).toBe("sonnet");
    expect(settings.statusLine.padding).toBe(0);
    expect(step(report.steps, "Status line for Work")?.state).toBe("migrated");
  });
});

describe("a partially migrated installation", () => {
  it("copies only what is missing and never overwrites the destination", async () => {
    const target = fixture();
    populateLegacy(target);
    // A local database this migration cannot account for. Usage history is the one artifact where a
    // newer destination is more useful than an older import, so it is left alone.
    mkdirSync(target.root, { recursive: true });
    writeFileSync(path.join(target.root, "usage.sqlite3"), "NEWER SQLITE", "utf8");

    const report = await migrateLegacyInstallation(options(target));

    expect(report.failures).toEqual([]);
    expect(report.blockedBy).toBeUndefined();
    // Not clobbered: a newer file at the destination always wins.
    expect(read(path.join(target.root, "usage.sqlite3"))).toBe("NEWER SQLITE");
    expect(existsSync(path.join(target.root, "registry.json"))).toBe(true);
    expect(step(report.steps, "Support file usage.sqlite3")?.state).toBe("skipped");
    expect(step(report.steps, "Support directory")?.state).toBe("migrated");
    expect(step(report.steps, "Support directory")?.detail).not.toContain("usage.sqlite3,");
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(true);
  });

  it("resumes a registry copy whose provenance record did not survive", async () => {
    const target = fixture();
    populateLegacy(target);
    // The bytes are identical, so the data provably arrived even though nothing recorded it.
    mkdirSync(target.root, { recursive: true });
    writeFileSync(
      path.join(target.root, "registry.json"),
      legacyRegistry(target.claudeConfigDir),
      "utf8"
    );

    const report = await migrateLegacyInstallation(options(target));

    expect(report.blockedBy).toBeUndefined();
    expect(report.failures).toEqual([]);
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(true);
  });
});

describe("an already migrated installation", () => {
  it("is a no-op on the second run", async () => {
    const target = fixture();
    populateLegacy(target);
    populateProfile(target);
    target.host.set("claudeAccountGuard", "defaultLockMode", "global", "warn");
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);

    const first = await migrateLegacyInstallation(options(target));
    expect(first.changed).toBe(true);
    const registryAfterFirst = read(path.join(target.root, "registry.json"));
    const settingsAfterFirst = read(path.join(target.claudeConfigDir, "settings.json"));
    const writesAfterFirst = target.host.writes.length;

    const second = await migrateLegacyInstallation(options(target));

    // Still "found", because the old directory is deliberately kept — but nothing changes.
    expect(second.legacyInstallationFound).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.failures).toEqual([]);
    expect(step(second.steps, "Support directory")?.state).toBe("already_migrated");
    expect(step(second.steps, "Recorded wrapper path")?.state).toBe("already_migrated");
    expect(step(second.steps, "Account directory for Work")?.state).toBe("already_migrated");
    expect(step(second.steps, "Status line for Work")?.state).toBe("already_migrated");
    expect(step(second.steps, "Settings namespace")?.state).toBe("not_present");
    expect(step(second.steps, "Claude Code wrapper setting")?.state).toBe("already_migrated");
    expect(read(path.join(target.root, "registry.json"))).toBe(registryAfterFirst);
    expect(read(path.join(target.claudeConfigDir, "settings.json"))).toBe(settingsAfterFirst);
    expect(target.host.writes).toHaveLength(writesAfterFirst);
  });
});

describe("the Claude Code wrapper setting", () => {
  it("is repointed when it names the previous wrapper", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);

    const report = await migrateLegacyInstallation(options(target));

    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(NEW_WRAPPER);
    expect(step(report.steps, "Claude Code wrapper setting")?.state).toBe("migrated");
  });

  it("is left entirely alone when it names another tool's wrapper", async () => {
    const target = fixture();
    populateLegacy(target);
    const foreign = "C:\\tools\\somebody-elses-wrapper.exe";
    target.host.set("claudeCode", "claudeProcessWrapper", "global", foreign);

    const report = await migrateLegacyInstallation(options(target));

    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(foreign);
    expect(target.host.writes.filter((entry) => entry.includes("claudeProcessWrapper")))
      .toEqual([]);
    const wrapperStep = step(report.steps, "Claude Code wrapper setting");
    expect(wrapperStep?.state).toBe("skipped");
    expect(wrapperStep?.detail).toContain(foreign);
  });

  it("is absent rather than invented when the user never set one", async () => {
    const target = fixture();
    populateLegacy(target);

    const report = await migrateLegacyInstallation(options(target));

    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBeUndefined();
    expect(step(report.steps, "Claude Code wrapper setting")?.state).toBe("not_present");
  });

  it("reports a setting it could not write instead of claiming success", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    target.host.unwritable.add("claudeCode.claudeProcessWrapper");

    const report = await migrateLegacyInstallation(options(target));

    expect(report.failures.some((entry) => entry.includes("Claude Code wrapper setting")))
      .toBe(true);
    expect(step(report.steps, "Claude Code wrapper setting")?.manual).toContain(NEW_WRAPPER);
    // Everything else still migrated: one failure does not abandon the rest.
    expect(existsSync(path.join(target.root, "registry.json"))).toBe(true);
  });
});

describe("the settings namespace", () => {
  it("moves only values the user actually set, at the scope they set them", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeAccountGuard", "defaultLockMode", "global", "warn");
    target.host.set("claudeAccountGuard", "telemetry.retentionDays", "workspace", 7);
    target.host.set("claudeAccountGuard", "statusBar.showUsage", "workspaceFolder", false);

    const report = await migrateLegacyInstallation(options(target));

    expect(target.host.get("claudeAccounts", "defaultBindMode", "global")).toBe("warn");
    expect(target.host.get("claudeAccounts", "telemetry.retentionDays", "workspace")).toBe(7);
    expect(target.host.get("claudeAccounts", "statusBar.showUsage", "workspaceFolder"))
      .toBe(false);
    // Cleared, so the old namespace stops appearing in settings.json as something that works.
    expect(target.host.get("claudeAccountGuard", "defaultLockMode", "global")).toBeUndefined();
    expect(target.host.get("claudeAccountGuard", "telemetry.retentionDays", "workspace"))
      .toBeUndefined();
    // Nothing was written for a key the user never set: writing defaults would freeze them.
    expect(target.host.get("claudeAccounts", "usage.warningThreshold", "global")).toBeUndefined();
    expect(target.host.writes.some((entry) => entry.includes("usage.warningThreshold")))
      .toBe(false);
    expect(step(report.steps, "Settings namespace")?.state).toBe("migrated");
  });

  it("writes the new value before clearing the old one", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeAccountGuard", "defaultLockMode", "global", "off");
    // Clearing first and then failing to write would lose the setting outright.
    target.host.unwritable.add("claudeAccounts.defaultBindMode");

    const report = await migrateLegacyInstallation(options(target));

    expect(target.host.get("claudeAccountGuard", "defaultLockMode", "global")).toBe("off");
    expect(report.failures.some((entry) => entry.includes("claudeAccounts.defaultBindMode")))
      .toBe(true);
  });

  it("leaves both keys alone when the new key is already set at that scope", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeAccountGuard", "defaultLockMode", "global", "off");
    target.host.set("claudeAccounts", "defaultBindMode", "global", "warn");

    const report = await migrateLegacyInstallation(options(target));

    // Neither value is discarded; the one in force wins and the stale one is named for removal.
    expect(target.host.get("claudeAccounts", "defaultBindMode", "global")).toBe("warn");
    expect(target.host.get("claudeAccountGuard", "defaultLockMode", "global")).toBe("off");
    expect(step(report.steps, "Settings namespace")?.state).toBe("skipped");
    expect(step(report.steps, "Settings namespace")?.manual).toContain("defaultLockMode");
  });

  it("is enough on its own to count as a previous installation", async () => {
    const target = fixture();
    target.host.set("claudeAccountGuard", "telemetry.enabled", "global", false);

    const report = await migrateLegacyInstallation(options(target));

    expect(report.legacyInstallationFound).toBe(true);
    expect(target.host.get("claudeAccounts", "telemetry.enabled", "global")).toBe(false);
    expect(step(report.steps, "Support directory")?.state).toBe("not_present");
  });

  it("covers every configuration property package.json contributes", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const contributed = Object.keys(manifest.contributes.configuration.properties);
    expect(contributed.length).toBeGreaterThan(0);
    const mapped = new Set(SETTING_KEYS.map(([, newKey]) => `claudeAccounts.${newKey}`));
    // A setting added later without a migration entry would be silently stranded in the old
    // namespace for every upgrading user, so this fails the build instead.
    expect([...contributed].sort()).toEqual([...mapped].sort());
    // And every old leaf is distinct, so no two keys can migrate onto each other.
    expect(new Set(SETTING_KEYS.map(([oldKey]) => oldKey)).size).toBe(SETTING_KEYS.length);
  });
});

describe("status lines that are not ours", () => {
  it("leaves a foreign status-line command completely untouched", async () => {
    const target = fixture();
    populateLegacy(target);
    populateProfile(target, "node C:\\\\tools\\\\my-own-statusline.js");
    const before = read(path.join(target.claudeConfigDir, "settings.json"));

    const report = await migrateLegacyInstallation(options(target));

    expect(read(path.join(target.claudeConfigDir, "settings.json"))).toBe(before);
    const statusStep = step(report.steps, "Status line for Work");
    expect(statusStep?.state).toBe("skipped");
    expect(statusStep?.detail).toContain("not one this extension installed");
    // The per-account directory rename is independent of the status line and still happens.
    expect(existsSync(path.join(target.claudeConfigDir, ".claude-workspace-accounts"))).toBe(true);
  });

  it("leaves a status line that merely names the bridge in an argument untouched", async () => {
    const target = fixture();
    populateLegacy(target);
    // The substring matcher claimed this as ours and overwrote it, with no copy kept anywhere.
    populateProfile(target, "node C:\\\\tools\\\\statusline-bridge.exe-helper.js");
    const before = read(path.join(target.claudeConfigDir, "settings.json"));

    const report = await migrateLegacyInstallation(options(target));

    expect(read(path.join(target.claudeConfigDir, "settings.json"))).toBe(before);
    expect(step(report.steps, "Status line for Work")?.state).toBe("skipped");
  });

  it("recognises a bridge command from any release, including the PowerShell one", async () => {
    const target = fixture();
    populateLegacy(target);
    populateProfile(target, "\"C:\\\\old\\\\statusline-bridge.ps1\"");

    await migrateLegacyInstallation(options(target));

    const settings = JSON.parse(read(path.join(target.claudeConfigDir, "settings.json"))) as {
      statusLine: { command: string };
    };
    expect(settings.statusLine.command).toBe(`"${NEW_BRIDGE}"`);
  });

  it("leaves an unreadable settings.json alone and says so", async () => {
    const target = fixture();
    populateLegacy(target);
    mkdirSync(target.claudeConfigDir, { recursive: true });
    writeFileSync(path.join(target.claudeConfigDir, "settings.json"), "{not json", "utf8");

    const report = await migrateLegacyInstallation(options(target));

    expect(read(path.join(target.claudeConfigDir, "settings.json"))).toBe("{not json");
    expect(step(report.steps, "Status line for Work")?.state).toBe("failed");
    expect(report.failures.some((entry) => entry.includes("Status line for Work"))).toBe(true);
  });
});

describe("a copy that fails", () => {
  it("leaves the old directory intact, unmarked, and retryable", async () => {
    const target = fixture();
    populateLegacy(target);
    // A registry that cannot be read as a file: the copy of the one artifact that matters most
    // fails, and everything downstream has to behave as though nothing arrived.
    rmSync(path.join(target.legacyRoot, "registry.json"), { force: true });
    mkdirSync(path.join(target.legacyRoot, "registry.json"), { recursive: true });

    const report = await migrateLegacyInstallation(options(target));

    expect(report.legacyInstallationFound).toBe(true);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(step(report.steps, "Support file registry.json")?.state).toBe("failed");
    expect(step(report.steps, "Support directory")?.state).toBe("failed");
    // No marker, so the next activation tries again rather than treating this as done.
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(false);
    // Nothing was deleted: the old directory is still the only complete copy.
    expect(existsSync(path.join(target.legacyRoot, "usage.sqlite3"))).toBe(true);
    expect(existsSync(path.join(target.legacyRoot, "registry.json"))).toBe(true);
    expect(existsSync(path.join(target.legacyRoot, "snapshots", "snap-1.json"))).toBe(true);
    // Whatever could be copied still was.
    expect(inspectDatabase(path.join(target.root, "usage.sqlite3")).integrity).toBe("ok");
    expect(step(report.steps, "Support directory")?.manual).toContain(target.legacyRoot);
  });

  it("halts the whole migration rather than repointing anything at a registry that never arrived",
    async () => {
      const target = fixture();
      populateLegacy(target);
      populateProfile(target);
      target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
      target.host.set("claudeAccountGuard", "defaultLockMode", "global", "warn");
      rmSync(path.join(target.legacyRoot, "registry.json"), { force: true });
      mkdirSync(path.join(target.legacyRoot, "registry.json"), { recursive: true });

      const report = await migrateLegacyInstallation(options(target));

      expect(report.blockedBy).toContain("registry.json");
      // The previous installation stays in charge. A repointed wrapper with no registry behind it
      // fails open to the ambient account and applies no bindings at all.
      expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(OLD_WRAPPER);
      expect(target.host.get("claudeAccountGuard", "defaultLockMode", "global")).toBe("warn");
      expect(target.host.get("claudeAccounts", "defaultBindMode", "global")).toBeUndefined();
      expect(target.host.writes).toEqual([]);
      for (const artifact of [
        "Claude Code wrapper setting",
        "Settings namespace",
        "Account directories"
      ]) {
        expect(step(report.steps, artifact)?.state).toBe("skipped");
      }
      // The per-account directory rename and status-line rewrite are part of "Account directories",
      // so neither happened either.
      expect(existsSync(path.join(target.claudeConfigDir, ".claude-account-guard"))).toBe(true);
      expect(existsSync(path.join(target.claudeConfigDir, ".claude-workspace-accounts")))
        .toBe(false);
      expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(false);
    });
});

describe("a second activation after a failed registry copy", () => {
  /**
   * The scenario that could destroy a user's accounts, in the order it happens.
   *
   * Antivirus blocks the first `registry.json` copy; activation continues anyway;
   * `ProfileRegistry.initialize()` writes an empty registry at the destination. The second
   * activation used to see a file there, call the artifact migrated, write the marker, and tell the
   * user the old directory was safe to delete — at which point their accounts and bindings were
   * gone and the marker said everything had succeeded.
   */
  it("never treats a placeholder registry as proof the copy happened", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    // First activation: the one artifact that matters cannot be copied.
    rmSync(path.join(target.legacyRoot, "registry.json"), { force: true });
    mkdirSync(path.join(target.legacyRoot, "registry.json"), { recursive: true });
    const first = await migrateLegacyInstallation(options(target));
    expect(first.blockedBy).toBeDefined();

    // Activation carries on regardless, and ProfileRegistry creates an empty registry.
    writePlaceholderRegistry(target);

    const second = await migrateLegacyInstallation(options(target));

    // Still blocked, still unmarked, and still nothing telling the user to delete anything.
    expect(second.blockedBy).toBeDefined();
    expect(second.failures.length).toBeGreaterThan(0);
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(false);
    expect(step(second.steps, "Support directory")?.state).toBe("failed");
    expect(migrationManualSteps(second).join("\n")).not.toContain("Delete");
    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(OLD_WRAPPER);
    // And the old directory is untouched, so the data is still recoverable.
    expect(existsSync(path.join(target.legacyRoot, "usage.sqlite3"))).toBe(true);
  });

  it("replaces the placeholder with the previous registry once the copy can succeed", async () => {
    const target = fixture();
    populateLegacy(target);
    populateProfile(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    // The state a failed first activation leaves behind: an empty registry at the destination and no
    // provenance record for it. Leaving it in place is what strands the user with no accounts.
    writePlaceholderRegistry(target);

    const report = await migrateLegacyInstallation(options(target));

    expect(report.blockedBy).toBeUndefined();
    const migrated = JSON.parse(read(path.join(target.root, "registry.json"))) as {
      revision: number;
      profiles: { id: string }[];
      integration: { wrapperPath: string };
    };
    expect(migrated.profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect(migrated.revision).toBe(9);
    expect(migrated.integration.wrapperPath).toBe(NEW_WRAPPER);
    expect(step(report.steps, "Support file registry.json")?.state).toBe("migrated");
    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(NEW_WRAPPER);
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(true);
  });

  it("refuses to overwrite a destination registry that holds somebody's accounts", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    // Not a placeholder: real profiles this migration did not put there. Either copy could be the
    // one the user wants, so neither is destroyed and nothing is repointed.
    const local = legacyRegistry(path.join(target.claudeConfigDir, "other"))
      .replace(/"work"/g, "\"local\"");
    mkdirSync(target.root, { recursive: true });
    writeFileSync(path.join(target.root, "registry.json"), local, "utf8");

    const report = await migrateLegacyInstallation(options(target));

    expect(report.blockedBy).toContain("could not be proven");
    expect(read(path.join(target.root, "registry.json"))).toBe(local);
    expect(read(path.join(target.legacyRoot, "registry.json")))
      .toBe(legacyRegistry(target.claudeConfigDir));
    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(OLD_WRAPPER);
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(false);
    expect(step(report.steps, "Support file registry.json")?.manual).toContain("keep whichever");
  });

  it("records what it copied, and from where, so existence is never taken as proof", async () => {
    const target = fixture();
    populateLegacy(target);

    await migrateLegacyInstallation(options(target));

    const provenance = JSON.parse(read(path.join(target.root, MIGRATION_PROVENANCE))) as {
      schemaVersion: number;
      artifacts: Record<string, {
        source: string;
        method: string;
        sourceBytes: number;
        sha256?: string;
      }>;
    };
    expect(provenance.schemaVersion).toBe(1);
    expect(provenance.artifacts["registry.json"]).toMatchObject({
      source: path.join(target.legacyRoot, "registry.json"),
      method: "copy",
      sourceBytes: legacyRegistry(target.claudeConfigDir).length
    });
    expect(provenance.artifacts["registry.json"]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance.artifacts["usage.sqlite3"]).toMatchObject({
      source: path.join(target.legacyRoot, "usage.sqlite3"),
      method: "sqlite-snapshot"
    });
  });
});

describe("a migrated registry this version cannot load", () => {
  it("leaves the previous wrapper setting in place rather than stranding activation", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    target.host.set("claudeAccountGuard", "telemetry.enabled", "global", false);
    // Parses, but is not a registry ProfileRegistry will accept — and activation refuses to
    // continue past one of those, so nothing may be repointed at it.
    writeFileSync(
      path.join(target.legacyRoot, "registry.json"),
      "{\"schemaVersion\":1,\"revision\":\"nine\",\"profiles\":[]}\n",
      "utf8"
    );

    const report = await migrateLegacyInstallation(options(target));

    expect(step(report.steps, "Migrated registry")?.state).toBe("failed");
    expect(report.blockedBy).toContain("could not be loaded");
    // The wrapper the user already has still works. Repointing at the new one would leave Claude
    // Code launching through a wrapper with no UI able to manage it.
    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(OLD_WRAPPER);
    expect(target.host.get("claudeAccountGuard", "telemetry.enabled", "global")).toBe(false);
    expect(target.host.get("claudeAccounts", "telemetry.enabled", "global")).toBeUndefined();
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(false);
    expect(step(report.steps, "Migrated registry")?.manual).toContain("reload the window");
  });

  it("stops advertising the old directory as deletable if the copy stops loading", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    const first = await migrateLegacyInstallation(options(target));
    expect(first.blockedBy).toBeUndefined();
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(true);
    expect(migrationManualSteps(first).join("\n")).toContain("Delete");

    // Something corrupts the migrated copy afterwards. A marker from an earlier activation is not a
    // promise that what it marked still loads, and telling the user to delete their only remaining
    // copy at this point is the worst advice available.
    writeFileSync(path.join(target.root, "registry.json"), "{not json", "utf8");

    const second = await migrateLegacyInstallation(options(target));

    expect(second.blockedBy).toContain("could not be loaded");
    expect(migrationManualSteps(second).join("\n")).not.toContain("Delete");
    expect(step(second.steps, "Support directory")?.state).toBe("skipped");
    expect(read(path.join(target.root, "registry.json"))).toBe("{not json");
  });

  it("is not blocked by a previous installation that simply had no registry", async () => {
    const target = fixture();
    mkdirSync(target.legacyRoot, { recursive: true });
    writeFileSync(path.join(target.legacyRoot, "binding-cache.json"), "{}", "utf8");
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);

    const report = await migrateLegacyInstallation(options(target));

    expect(report.blockedBy).toBeUndefined();
    expect(step(report.steps, "Migrated registry")?.state).toBe("not_present");
    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(NEW_WRAPPER);
  });
});

describe("the live usage database", () => {
  it("arrives as a consistent snapshot even while the old extension keeps committing", async () => {
    const target = fixture();
    const database = populateLegacy(target);
    // A checkpoint and further commits land while the migration is copying, which is exactly what a
    // file-at-a-time copy of usage.sqlite3, -wal and -shm cannot survive: the copied log describes a
    // database that has already moved on. Interleaving is inherently racy, so this is a detector
    // rather than a proof — the deterministic evidence is that no sidecar reaches the destination
    // and that a database which fails verification is discarded rather than imported.
    const migrating = migrateLegacyInstallation(options(target));
    database.commit(200);
    database.checkpoint();
    database.commit(50);
    const report = await migrating;
    const committed = database.rows;
    database.close();

    expect(report.failures).toEqual([]);
    const inspected = inspectDatabase(path.join(target.root, "usage.sqlite3"));
    expect(inspected.integrity).toBe("ok");
    // Some of the concurrent commits may legitimately miss the snapshot; none may corrupt it, and
    // everything committed before the migration started has to be there.
    expect(inspected.rows).toBeGreaterThanOrEqual(committed - 250);
    expect(inspected.rows).toBeLessThanOrEqual(committed);
  });

  it("discards a database that cannot be verified, and still migrates the accounts", async () => {
    const target = fixture();
    const database = populateLegacy(target);
    database.close();
    target.host.set("claudeCode", "claudeProcessWrapper", "global", OLD_WRAPPER);
    // Corrupt the middle of the file, leaving a readable header. Importing this would break the
    // dashboard for good; usage history is the one thing cheap enough to simply drop.
    const corrupted = readFileSync(database.file);
    corrupted.fill(0, 2000, Math.min(corrupted.length, 9000));
    writeFileSync(database.file, corrupted);

    const report = await migrateLegacyInstallation(options(target));

    expect(existsSync(path.join(target.root, "usage.sqlite3"))).toBe(false);
    // No staging debris left behind either.
    expect(readdirSync(target.root).filter((name) => name.includes(".migration.tmp"))).toEqual([]);
    const usage = step(report.steps, "Support file usage.sqlite3");
    expect(usage?.state).toBe("failed");
    expect(usage?.detail).toContain("integrity");
    // A corrupt usage database is not a reason to strand somebody's accounts.
    expect(report.blockedBy).toBeUndefined();
    expect(existsSync(path.join(target.root, "registry.json"))).toBe(true);
    expect(target.host.get("claudeCode", "claudeProcessWrapper", "global")).toBe(NEW_WRAPPER);
    // Unfinished, so the old directory is not advertised as safe to delete.
    expect(existsSync(path.join(target.legacyRoot, MIGRATION_MARKER))).toBe(false);
  });
});

describe("the previous extension still being installed", () => {
  it("is reported as something the user must fix by hand", async () => {
    const target = fixture();
    populateLegacy(target);
    target.host.installedExtensions.add(LEGACY_EXTENSION_ID);

    const report = await migrateLegacyInstallation(options(target));

    expect(report.legacyExtensionInstalled).toBe(true);
    const conflict = step(report.steps, "Previous extension");
    expect(conflict?.state).toBe("skipped");
    expect(conflict?.detail).toContain("claudeCode.claudeProcessWrapper");
    expect(conflict?.manual).toContain("Uninstall");
  });

  it("is reported even when there is nothing else to migrate", async () => {
    const target = fixture();
    target.host.installedExtensions.add(LEGACY_EXTENSION_ID);

    const report = await migrateLegacyInstallation(options(target));

    // No previous data, but two installations fighting over one global setting still matters.
    expect(report.legacyInstallationFound).toBe(false);
    expect(report.legacyExtensionInstalled).toBe(true);
  });
});

describe("the migration record", () => {
  it("is written into the new support directory so a partial run is retrievable", async () => {
    const target = fixture();
    populateLegacy(target);
    rmSync(path.join(target.legacyRoot, "registry.json"), { force: true });
    mkdirSync(path.join(target.legacyRoot, "registry.json"), { recursive: true });

    await migrateLegacyInstallation(options(target));

    const record = JSON.parse(read(path.join(target.root, MIGRATION_REPORT))) as {
      schemaVersion: number;
      legacyInstallationFound: boolean;
      failures: string[];
      legacyRoot: string;
    };
    expect(record.schemaVersion).toBe(1);
    expect(record.legacyInstallationFound).toBe(true);
    expect(record.failures.length).toBeGreaterThan(0);
    expect(record.legacyRoot).toBe(target.legacyRoot);
  });

  it("never writes anything but the marker into the old directory", async () => {
    const target = fixture();
    // Closed first, so SQLite has folded its log away and every remaining file is stable. Anything
    // this migration created there would then show up, including the `-shm` a read-only SQLite
    // connection would leave behind if the database were opened in place.
    populateLegacy(target).close();
    populateProfile(target);
    const before = new Map(
      readdirSync(target.legacyRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => [
          entry.name,
          bytes(path.join(target.legacyRoot, entry.name))
        ] as const)
    );

    await migrateLegacyInstallation(options(target));

    const after = readdirSync(target.legacyRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(after.filter((name) => !before.has(name))).toEqual([MIGRATION_MARKER]);
    for (const [name, content] of before) {
      expect(bytes(path.join(target.legacyRoot, name))).toBe(content);
    }
    // Including the old wrapper: nothing about the previous installation is disturbed.
    expect(read(path.join(target.legacyRoot, "wrapper", "claude-account-guard-wrapper.exe")))
      .toBe("MZ");
  });
});
