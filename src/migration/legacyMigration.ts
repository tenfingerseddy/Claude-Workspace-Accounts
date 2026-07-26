/**
 * Migration from the `claude-account-guard` extension identity to `claude-workspace-accounts`.
 *
 * Publishing under a new `name` creates a *new* Marketplace listing and a new extension
 * directory, so an upgrading user gets a fresh install that would otherwise see none of their
 * accounts, bindings, or usage: the support directory, the configuration namespace, the wrapper
 * executable name, and the per-profile subdirectory inside each Claude configuration directory
 * all changed at once. Without this module the rename orphans every existing installation.
 *
 * Three rules shape the implementation, and all three are about not destroying data:
 *
 * 1. **Copy, never move.** `registry.json` is frequently the only copy of a user's workspace
 *    bindings. A move that fails half way through takes them with it, so the old directory is
 *    left intact and marked instead. The cost is disk space the user can reclaim by hand.
 * 2. **Never overwrite what is already at the destination.** That makes the copy resumable
 *    after a partial failure and makes a second run a no-op rather than a regression.
 * 3. **Fail open.** A migration failure must never stop activation or block a Claude launch.
 *    Every step is isolated, every failure is recorded, and whatever succeeded is kept. The
 *    record is written to disk so the failure is retrievable rather than silent, in the same
 *    way `wrapper-health.json` records the wrapper's last outcome.
 *
 * Nothing here imports `vscode`: settings access and extension lookup arrive through
 * {@link MigrationHost} so every branch is testable without an extension host, and so no test
 * can reach a real installation by accident.
 */

import { constants } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { isStatusLineBridgeCommand } from "../telemetry/statusLineBridgeService.js";
import { LEGACY_WRAPPER_EXE } from "../wrapper/wrapperPaths.js";

/** The support directory the previous extension identity used, under `%LOCALAPPDATA%`. */
export const LEGACY_SUPPORT_DIRECTORY = "ClaudeAccountGuard";
/** The wrapper executable the previous extension identity installed and configured. */
/** Re-exported for callers and tests; the name itself lives with the other wrapper filenames. */
export { LEGACY_WRAPPER_EXE as LEGACY_WRAPPER_EXECUTABLE } from "../wrapper/wrapperPaths.js";
/** The per-profile subdirectory the previous extension identity created in a Claude config dir. */
export const LEGACY_PROFILE_DIRECTORY = ".claude-account-guard";
/** Its replacement. */
export const PROFILE_DIRECTORY = ".claude-workspace-accounts";
/** The previous Marketplace identity. Two installs would fight over one global setting. */
export const LEGACY_EXTENSION_ID = "ResonanceLattice-Semanticus.claude-account-guard";
export const LEGACY_CONFIGURATION_SECTION = "claudeAccountGuard";
export const CONFIGURATION_SECTION = "claudeAccounts";
export const CLAUDE_CODE_SECTION = "claudeCode";
export const WRAPPER_SETTING = "claudeProcessWrapper";
/**
 * Written into the *old* support directory once its contents have been copied. This is the only
 * write this module ever makes there: everything else treats the old directory as read-only,
 * because until the copy is verified it may hold the only copy of a user's bindings.
 */
export const MIGRATION_MARKER = "migrated-to-claude-workspace-accounts.json";
/** Written into the new support directory so a partial migration is retrievable, not silent. */
export const MIGRATION_REPORT = "migration-report.json";

/**
 * Files copied from the old support directory, in the order they matter.
 *
 * `wrapper/` is deliberately absent: the new binaries are installed fresh under their new name,
 * and copying the old ones would leave an executable nothing manages. `handoffs/` and `vscode/`
 * are absent because they belong to the isolated-window launcher, which no longer exists.
 * `wrapper-health.json` is absent because it describes the previous wrapper's last launch.
 */
const MIGRATED_FILES: readonly string[] = [
  "registry.json",
  "usage.sqlite3",
  // SQLite leaves a write-ahead log and a shared-memory file beside the database. Copying the
  // database without them can lose the most recent committed transactions.
  "usage.sqlite3-wal",
  "usage.sqlite3-shm",
  "binding-cache.json"
];

const MIGRATED_DIRECTORIES: readonly string[] = [
  "snapshots",
  // The one exception to "do not migrate wrapper/": this holds the guard-owned mirror of each
  // account's *previous* status-line command, which is the fallback used when the copy inside
  // the user's own Claude directory is unreadable. It is user data, not a binary, and losing it
  // can make somebody's status line unrestorable.
  path.join("wrapper", "statusline-backups")
];

/**
 * Every configuration key, old leaf to new leaf.
 *
 * `renameMigration.test.ts` asserts this covers every property `package.json` contributes, so a
 * setting added later cannot be silently left behind in the old namespace.
 */
export const SETTING_KEYS: readonly (readonly [string, string])[] = [
  ["defaultLockMode", "defaultBindMode"],
  ["telemetry.enabled", "telemetry.enabled"],
  ["telemetry.retentionDays", "telemetry.retentionDays"],
  ["usage.warningThreshold", "usage.warningThreshold"],
  ["usage.criticalThreshold", "usage.criticalThreshold"],
  ["context.warningThreshold", "context.warningThreshold"],
  ["statusBar.showUsage", "statusBar.showUsage"],
  ["dashboard.defaultRange", "dashboard.defaultRange"],
  ["privacy.collectWorkspacePath", "privacy.collectWorkspacePath"],
  ["wrapper.autoConfigure", "wrapper.autoConfigure"]
];

export type SettingScope = "global" | "workspace" | "workspaceFolder";

const SETTING_SCOPES: readonly SettingScope[] = ["global", "workspace", "workspaceFolder"];

/** The subset of `vscode.WorkspaceConfiguration.inspect` this migration needs. */
export interface InspectedSetting {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

function scopedValue(inspected: InspectedSetting | undefined, scope: SettingScope): unknown {
  if (!inspected) {
    return undefined;
  }
  return scope === "global"
    ? inspected.globalValue
    : scope === "workspace" ? inspected.workspaceValue : inspected.workspaceFolderValue;
}

/**
 * Everything the migration needs from the extension host.
 *
 * Deliberately narrow, and deliberately not `vscode`: the settings migration has to be
 * exercised for every scope, an absent value has to be distinguishable from a default one, and
 * neither is testable against the real API here.
 */
export interface MigrationHost {
  /** `undefined` when the setting is not known at all; otherwise the per-scope values. */
  inspectSetting(section: string, key: string): InspectedSetting | undefined;
  /** `undefined` as the value clears the setting at that scope. */
  updateSetting(
    section: string,
    key: string,
    value: unknown,
    scope: SettingScope
  ): Promise<void>;
  isExtensionInstalled(extensionId: string): boolean;
}

export interface LegacyMigrationOptions {
  /** The current support root, from `resolveSupportPaths`. */
  root: string;
  /**
   * The previous support root. Undefined when this machine cannot have one — the fallback
   * layout used when `%LOCALAPPDATA%` is unset is identical under both names, so there is
   * nothing to move.
   */
  legacyRoot?: string;
  /** Where the new wrapper executable lives. */
  wrapperPath: string;
  /** Where the new status-line bridge lives. */
  statusLineBridgePath: string;
  host: MigrationHost;
}

export type MigrationStepState =
  /** Changed by this run. */
  | "migrated"
  /** Already in its migrated form when this run looked. */
  | "already_migrated"
  /** The old installation had nothing of this kind. */
  | "not_present"
  /** Deliberately left alone, with a reason. */
  | "skipped"
  /** Attempted and failed. Whatever it was, the old copy is still there. */
  | "failed";

export interface MigrationStep {
  artifact: string;
  state: MigrationStepState;
  detail?: string;
  /** What the user has to do by hand. Only ever set when there genuinely is something. */
  manual?: string;
}

export interface LegacyMigrationReport {
  schemaVersion: 1;
  completedAt: string;
  /** True when a previous installation was found at all. Everything else is moot without it. */
  legacyInstallationFound: boolean;
  /** True when this run changed something. False on the second and later activations. */
  changed: boolean;
  /**
   * True when the old extension is still installed. Both would write the same global
   * `claudeCode.claudeProcessWrapper`, and the loser silently stops applying accounts.
   */
  legacyExtensionInstalled: boolean;
  /** Kept, never deleted: the copy above is not a move. */
  legacyRoot?: string;
  steps: MigrationStep[];
  /** Sanitised messages for everything that could not be migrated. */
  failures: string[];
}

/**
 * The previous support root for this machine, or undefined when there cannot be one.
 *
 * `%LOCALAPPDATA%` is passed in rather than read here: a default argument cannot be overridden
 * with `undefined`, so the "there is no old directory" branch would be untestable — and the one
 * mistake this codebase has already paid for is a path silently resolved from the real
 * environment when a test meant to supply its own.
 */
export function resolveLegacySupportRoot(
  localAppData: string | undefined
): string | undefined {
  return localAppData ? path.join(localAppData, LEGACY_SUPPORT_DIRECTORY) : undefined;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** True when a path names the wrapper the previous extension identity installed. */
export function isLegacyWrapperPath(candidate: string | undefined): boolean {
  if (!candidate || !candidate.trim()) {
    return false;
  }
  return path.basename(path.normalize(candidate)).toLocaleLowerCase()
    === LEGACY_WRAPPER_EXE;
}

/** Temp file plus rename, matching how `ProfileRegistry` writes the same file. */
async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.migration.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Migrate a previous installation, once, before anything reads support state.
 *
 * Never throws. The returned report is the whole outcome; the caller decides what to say about
 * it. Safe to call on every activation: each step is idempotent and re-checks its own
 * preconditions, and the directory copy is gated on a marker written into the old directory.
 */
export async function migrateLegacyInstallation(
  options: LegacyMigrationOptions
): Promise<LegacyMigrationReport> {
  const steps: MigrationStep[] = [];
  const failures: string[] = [];
  const record = (step: MigrationStep): void => {
    steps.push(step);
    if (step.state === "failed") {
      failures.push(`${step.artifact}: ${step.detail ?? "unknown error"}`);
    }
  };

  const legacyExtensionInstalled = safeIsInstalled(options.host);
  const legacyRoot = options.legacyRoot;
  const legacyRootPresent = legacyRoot !== undefined
    && path.normalize(legacyRoot).toLocaleLowerCase()
      !== path.normalize(options.root).toLocaleLowerCase()
    && await isDirectory(legacyRoot);
  const legacySettingsPresent = hasLegacySettings(options.host);
  const legacyWrapperSetting = hasLegacyWrapperSetting(options.host);

  if (!legacyRootPresent && !legacySettingsPresent && !legacyWrapperSetting) {
    // A clean install. Not "migrated with nothing to do" — there was no previous installation.
    return {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      legacyInstallationFound: false,
      changed: false,
      legacyExtensionInstalled,
      steps: [],
      failures: []
    };
  }

  let changed = false;

  /**
   * Run one phase. Each phase already records its own per-artifact failures; this is the outer
   * net that keeps an unanticipated throw — an unwritable directory, a path Windows rejects —
   * from taking activation down with it, and keeps the phases after it running.
   */
  const phase = async (
    artifact: string,
    run: () => Promise<boolean>
  ): Promise<void> => {
    try {
      changed = await run() || changed;
    } catch (error) {
      record({ artifact, state: "failed", detail: reason(error) });
    }
  };

  if (legacyRootPresent && legacyRoot) {
    await phase(
      "Support directory",
      () => migrateSupportDirectory(legacyRoot, options.root, record)
    );
    await phase("Recorded wrapper path", () => rewriteMigratedRegistry(options, record));
  } else {
    record({
      artifact: "Support directory",
      state: "not_present",
      detail: legacyRoot
        ? `${legacyRoot} does not exist, so there was nothing to copy.`
        : "%LOCALAPPDATA% is unavailable, so the old and new support directories are the same."
    });
  }

  await phase("Claude Code wrapper setting", () => migrateWrapperSetting(options, record));
  await phase("Settings namespace", () => migrateSettingsNamespace(options, record));
  await phase("Account directories", () => migrateProfileDirectories(options, record));

  if (legacyExtensionInstalled) {
    record({
      artifact: "Previous extension",
      state: "skipped",
      detail:
        "The previous extension is still installed. Both versions write the same global "
        + "claudeCode.claudeProcessWrapper setting, so they will overwrite each other and one "
        + "of them will stop applying per-workspace accounts.",
      manual: "Uninstall \"Claude Account Guard\", then reload the window."
    });
  }

  const report: LegacyMigrationReport = {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    legacyInstallationFound: true,
    changed,
    legacyExtensionInstalled,
    legacyRoot: legacyRootPresent ? legacyRoot : undefined,
    steps,
    failures
  };
  await writeReport(options.root, report);
  return report;
}

function safeIsInstalled(host: MigrationHost): boolean {
  try {
    return host.isExtensionInstalled(LEGACY_EXTENSION_ID);
  } catch {
    return false;
  }
}

function hasLegacySettings(host: MigrationHost): boolean {
  for (const [oldKey] of SETTING_KEYS) {
    let inspected: InspectedSetting | undefined;
    try {
      inspected = host.inspectSetting(LEGACY_CONFIGURATION_SECTION, oldKey);
    } catch {
      continue;
    }
    if (SETTING_SCOPES.some((scope) => scopedValue(inspected, scope) !== undefined)) {
      return true;
    }
  }
  return false;
}

function hasLegacyWrapperSetting(host: MigrationHost): boolean {
  let inspected: InspectedSetting | undefined;
  try {
    inspected = host.inspectSetting(CLAUDE_CODE_SECTION, WRAPPER_SETTING);
  } catch {
    return false;
  }
  return SETTING_SCOPES.some((scope) => {
    const value = scopedValue(inspected, scope);
    return typeof value === "string" && isLegacyWrapperPath(value);
  });
}

/**
 * Copy the old support directory's contents, then mark it as migrated.
 *
 * The marker is what makes this run once. It is written only after every artifact has either
 * been copied or confirmed absent, so a failure part way through leaves the marker off and the
 * next activation resumes — and because nothing at the destination is ever overwritten, resuming
 * cannot undo work that already succeeded.
 */
async function migrateSupportDirectory(
  legacyRoot: string,
  root: string,
  record: (step: MigrationStep) => void
): Promise<boolean> {
  const markerPath = path.join(legacyRoot, MIGRATION_MARKER);
  if (await exists(markerPath)) {
    record({
      artifact: "Support directory",
      state: "already_migrated",
      detail: `${legacyRoot} was migrated by an earlier activation and is left in place.`,
      manual: `Delete ${legacyRoot} once you are satisfied nothing is missing.`
    });
    return false;
  }

  await mkdir(root, { recursive: true });
  const copied: string[] = [];
  let anyFailure = false;

  for (const name of MIGRATED_FILES) {
    const source = path.join(legacyRoot, name);
    const destination = path.join(root, name);
    try {
      if (!(await exists(source)) || await exists(destination)) {
        continue;
      }
      // COPYFILE_EXCL rather than a plain copy: the existence check above is not atomic, and
      // clobbering a newer file at the destination is the one outcome worse than not copying.
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      copied.push(name);
    } catch (error) {
      anyFailure = true;
      record({
        artifact: `Support file ${name}`,
        state: "failed",
        detail: reason(error),
        manual: `Copy ${source} to ${destination} by hand.`
      });
    }
  }

  for (const name of MIGRATED_DIRECTORIES) {
    const source = path.join(legacyRoot, name);
    const destination = path.join(root, name);
    try {
      if (!(await isDirectory(source))) {
        continue;
      }
      // `force: false` skips anything already present rather than overwriting it.
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      copied.push(`${name}/`);
    } catch (error) {
      anyFailure = true;
      record({
        artifact: `Support directory ${name}`,
        state: "failed",
        detail: reason(error),
        manual: `Copy ${source} to ${destination} by hand.`
      });
    }
  }

  if (anyFailure) {
    // No marker: the old directory is still authoritative for whatever did not arrive, and the
    // next activation must try again.
    record({
      artifact: "Support directory",
      state: "failed",
      detail:
        `Some of ${legacyRoot} could not be copied to ${root}, so it was not marked as `
        + "migrated and will be retried on the next reload. Nothing was deleted.",
      manual: `Keep ${legacyRoot} until the items listed above are present in ${root}.`
    });
    return copied.length > 0;
  }

  try {
    await atomicWrite(markerPath, `${JSON.stringify({
      schemaVersion: 1,
      migratedAt: new Date().toISOString(),
      to: root,
      copied
    }, null, 2)}\n`);
  } catch (error) {
    // A marker that cannot be written is not a failure of the migration; the copy is done and
    // re-running it is harmless because nothing is overwritten.
    record({
      artifact: "Migration marker",
      state: "failed",
      detail: reason(error)
    });
  }

  record({
    artifact: "Support directory",
    state: copied.length > 0 ? "migrated" : "not_present",
    detail: copied.length > 0
      ? `Copied ${copied.join(", ")} from ${legacyRoot} to ${root}.`
      : `${legacyRoot} held nothing that needed migrating.`,
    manual: copied.length > 0
      ? `${legacyRoot} was copied, not moved. Delete it once you are satisfied nothing is missing.`
      : undefined
  });
  return copied.length > 0;
}

/**
 * Point the migrated registry's recorded integration at the new executable.
 *
 * A malformed registry is left exactly as it is: it may be the only copy of a user's bindings,
 * and `ProfileRegistry` deliberately preserves rather than rewrites one it cannot validate.
 */
async function rewriteMigratedRegistry(
  options: LegacyMigrationOptions,
  record: (step: MigrationStep) => void
): Promise<boolean> {
  const registryPath = path.join(options.root, "registry.json");
  let document: Record<string, unknown>;
  try {
    if (!(await exists(registryPath))) {
      record({ artifact: "Recorded wrapper path", state: "not_present" });
      return false;
    }
    const raw = (await readFile(registryPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The registry does not contain a JSON object.");
    }
    document = parsed as Record<string, unknown>;
  } catch (error) {
    record({
      artifact: "Recorded wrapper path",
      state: "failed",
      detail: `${reason(error)}. The registry was left untouched.`,
      manual: `Repair ${registryPath}, then reload the window.`
    });
    return false;
  }

  const integration = document.integration;
  if (!integration || typeof integration !== "object" || Array.isArray(integration)) {
    record({ artifact: "Recorded wrapper path", state: "not_present" });
    return false;
  }
  const fields = integration as Record<string, unknown>;
  const current = fields.wrapperPath;
  let mutated = false;

  if (typeof current === "string" && current !== options.wrapperPath) {
    fields.wrapperPath = options.wrapperPath;
    mutated = true;
  }
  // A chained upstream that is really the previous wrapper would be treated as a third party
  // from here on, and "restoring" it on disconnect would hand Claude Code back to an executable
  // this extension no longer manages.
  if (isLegacyWrapperPath(
    typeof fields.upstreamWrapper === "string" ? fields.upstreamWrapper : undefined
  )) {
    delete fields.upstreamWrapper;
    mutated = true;
  }

  if (!mutated) {
    record({ artifact: "Recorded wrapper path", state: "already_migrated" });
    return false;
  }

  try {
    await atomicWrite(registryPath, `${JSON.stringify(document, null, 2)}\n`);
  } catch (error) {
    record({
      artifact: "Recorded wrapper path",
      state: "failed",
      detail: reason(error),
      manual: `Set "integration.wrapperPath" in ${registryPath} to ${options.wrapperPath}.`
    });
    return false;
  }
  record({
    artifact: "Recorded wrapper path",
    state: "migrated",
    detail: `Now names ${options.wrapperPath}.`
  });
  return true;
}

/**
 * Repoint `claudeCode.claudeProcessWrapper`, and only when it names the old wrapper.
 *
 * Anything else is somebody else's wrapper. Overwriting it would be exactly the behaviour this
 * product refuses everywhere else, so a value that is not the previous executable is left
 * completely alone.
 */
async function migrateWrapperSetting(
  options: LegacyMigrationOptions,
  record: (step: MigrationStep) => void
): Promise<boolean> {
  let inspected: InspectedSetting | undefined;
  try {
    inspected = options.host.inspectSetting(CLAUDE_CODE_SECTION, WRAPPER_SETTING);
  } catch (error) {
    record({
      artifact: "Claude Code wrapper setting",
      state: "failed",
      detail: reason(error)
    });
    return false;
  }

  let changed = false;
  let foreign: string | undefined;
  let alreadyOurs = false;
  const wanted = path.normalize(options.wrapperPath).toLocaleLowerCase();
  for (const scope of SETTING_SCOPES) {
    const value = scopedValue(inspected, scope);
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    if (path.normalize(value).toLocaleLowerCase() === wanted) {
      // Already the renamed wrapper, from an earlier activation. Not somebody else's.
      alreadyOurs = true;
      continue;
    }
    if (!isLegacyWrapperPath(value)) {
      foreign = value;
      continue;
    }
    try {
      await options.host.updateSetting(
        CLAUDE_CODE_SECTION,
        WRAPPER_SETTING,
        options.wrapperPath,
        scope
      );
      changed = true;
    } catch (error) {
      record({
        artifact: "Claude Code wrapper setting",
        state: "failed",
        detail: `${scope} scope: ${reason(error)}`,
        manual:
          `Set "${CLAUDE_CODE_SECTION}.${WRAPPER_SETTING}" to ${options.wrapperPath} in your `
          + "settings.json and reload the window."
      });
    }
  }

  if (changed) {
    record({
      artifact: "Claude Code wrapper setting",
      state: "migrated",
      detail: `Repointed from ${LEGACY_WRAPPER_EXE} to ${options.wrapperPath}.`,
      manual: "Reload the window so Claude Code picks up the new wrapper."
    });
  } else if (foreign) {
    record({
      artifact: "Claude Code wrapper setting",
      state: "skipped",
      detail: `Left alone: it names ${foreign}, which is not a wrapper this extension installed.`
    });
  } else if (alreadyOurs) {
    record({ artifact: "Claude Code wrapper setting", state: "already_migrated" });
  } else {
    record({ artifact: "Claude Code wrapper setting", state: "not_present" });
  }
  return changed;
}

/**
 * Move each configuration value from `claudeAccountGuard.*` to `claudeAccounts.*`, per scope.
 *
 * Only values the user actually set are moved. Writing a key because it has a default would turn
 * every default into an explicit user setting, which then stops tracking any future change to
 * that default.
 */
async function migrateSettingsNamespace(
  options: LegacyMigrationOptions,
  record: (step: MigrationStep) => void
): Promise<boolean> {
  const moved: string[] = [];
  const skipped: string[] = [];

  for (const [oldKey, newKey] of SETTING_KEYS) {
    let legacy: InspectedSetting | undefined;
    let target: InspectedSetting | undefined;
    try {
      legacy = options.host.inspectSetting(LEGACY_CONFIGURATION_SECTION, oldKey);
      target = options.host.inspectSetting(CONFIGURATION_SECTION, newKey);
    } catch (error) {
      record({
        artifact: `Setting ${LEGACY_CONFIGURATION_SECTION}.${oldKey}`,
        state: "failed",
        detail: reason(error)
      });
      continue;
    }

    for (const scope of SETTING_SCOPES) {
      const value = scopedValue(legacy, scope);
      if (value === undefined) {
        continue;
      }
      if (scopedValue(target, scope) !== undefined) {
        // The new key is already set here. Clearing the old one would discard a value the user
        // may still want, and overwriting the new one would discard the value in force.
        skipped.push(`${LEGACY_CONFIGURATION_SECTION}.${oldKey} (${scope})`);
        continue;
      }
      try {
        await options.host.updateSetting(CONFIGURATION_SECTION, newKey, value, scope);
      } catch (error) {
        record({
          artifact: `Setting ${CONFIGURATION_SECTION}.${newKey}`,
          state: "failed",
          detail: `${scope} scope: ${reason(error)}`,
          manual:
            `Set "${CONFIGURATION_SECTION}.${newKey}" to ${JSON.stringify(value)} and remove `
            + `"${LEGACY_CONFIGURATION_SECTION}.${oldKey}" from your settings.json.`
        });
        continue;
      }
      try {
        // Only after the new value is durable: clearing first and then failing to write would
        // lose the setting outright.
        await options.host.updateSetting(
          LEGACY_CONFIGURATION_SECTION,
          oldKey,
          undefined,
          scope
        );
      } catch (error) {
        record({
          artifact: `Setting ${LEGACY_CONFIGURATION_SECTION}.${oldKey}`,
          state: "failed",
          detail: `${scope} scope: copied but not cleared: ${reason(error)}`,
          manual:
            `Remove "${LEGACY_CONFIGURATION_SECTION}.${oldKey}" from your settings.json; it no `
            + "longer does anything."
        });
      }
      moved.push(`${oldKey} → ${newKey} (${scope})`);
    }
  }

  if (skipped.length > 0) {
    record({
      artifact: "Settings namespace",
      state: "skipped",
      detail: `Left in place because the new key is already set: ${skipped.join(", ")}.`,
      manual: `Remove ${skipped.join(", ")} from your settings.json; they no longer do anything.`
    });
  }
  if (moved.length === 0) {
    record({ artifact: "Settings namespace", state: "not_present" });
    return false;
  }
  record({
    artifact: "Settings namespace",
    state: "migrated",
    detail: `Moved ${moved.join(", ")}.`
  });
  return true;
}

interface ClaudeSettingsDocument {
  statusLine?: { type?: string; command?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Rename the per-profile subdirectory in each account's Claude configuration directory, and
 * repoint that account's status line at the renamed bridge.
 *
 * The status-line command is matched with the shared {@link isStatusLineBridgeCommand}, so a
 * command the user wrote themselves is never touched. This directory sits inside the user's own
 * Claude configuration, which is otherwise never modified except for the status line, so the
 * rename is a rename and never a delete.
 */
async function migrateProfileDirectories(
  options: LegacyMigrationOptions,
  record: (step: MigrationStep) => void
): Promise<boolean> {
  let profiles: { id: string; displayName: string; configDir: string }[];
  try {
    profiles = await readProfiles(path.join(options.root, "registry.json"));
  } catch (error) {
    record({
      artifact: "Account directories",
      state: "failed",
      detail: `The migrated registry could not be read: ${reason(error)}`
    });
    return false;
  }
  if (profiles.length === 0) {
    record({ artifact: "Account directories", state: "not_present" });
    return false;
  }

  let changed = false;
  for (const profile of profiles) {
    changed = await migrateProfileDirectory(profile, record) || changed;
    changed = await migrateProfileStatusLine(profile, options, record) || changed;
  }
  return changed;
}

async function readProfiles(
  registryPath: string
): Promise<{ id: string; displayName: string; configDir: string }[]> {
  if (!(await exists(registryPath))) {
    return [];
  }
  const raw = (await readFile(registryPath, "utf8")).replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as { profiles?: unknown };
  if (!Array.isArray(parsed.profiles)) {
    return [];
  }
  return parsed.profiles.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const entry = candidate as Record<string, unknown>;
    return typeof entry.configDir === "string" && path.isAbsolute(entry.configDir)
      ? [{
          id: typeof entry.id === "string" ? entry.id : "unknown",
          displayName: typeof entry.displayName === "string" ? entry.displayName : "unknown",
          configDir: entry.configDir
        }]
      : [];
  });
}

async function migrateProfileDirectory(
  profile: { displayName: string; configDir: string },
  record: (step: MigrationStep) => void
): Promise<boolean> {
  const artifact = `Account directory for ${profile.displayName}`;
  const legacy = path.join(profile.configDir, LEGACY_PROFILE_DIRECTORY);
  const target = path.join(profile.configDir, PROFILE_DIRECTORY);
  if (!(await isDirectory(legacy))) {
    record({
      artifact,
      state: await isDirectory(target) ? "already_migrated" : "not_present"
    });
    return false;
  }
  if (await exists(target)) {
    record({
      artifact,
      state: "skipped",
      detail: `${target} already exists, so ${legacy} was left in place.`,
      manual: `Delete ${legacy} once you are satisfied nothing is missing.`
    });
    return false;
  }
  try {
    await rename(legacy, target);
    record({ artifact, state: "migrated", detail: `${legacy} is now ${target}.` });
    return true;
  } catch (renameError) {
    // A rename can fail on a locked or in-use directory. Copying and leaving the original is
    // strictly better than losing the record of the user's previous status line.
    try {
      await cp(legacy, target, { recursive: true, force: false, errorOnExist: false });
      record({
        artifact,
        state: "migrated",
        detail: `${legacy} could not be renamed (${reason(renameError)}), so it was copied.`,
        manual: `Delete ${legacy} once you are satisfied nothing is missing.`
      });
      return true;
    } catch (copyError) {
      record({
        artifact,
        state: "failed",
        detail: `${reason(renameError)}; copying also failed: ${reason(copyError)}`,
        manual: `Rename ${legacy} to ${target} by hand.`
      });
      return false;
    }
  }
}

async function migrateProfileStatusLine(
  profile: { displayName: string; configDir: string },
  options: LegacyMigrationOptions,
  record: (step: MigrationStep) => void
): Promise<boolean> {
  const artifact = `Status line for ${profile.displayName}`;
  const settingsPath = path.join(profile.configDir, "settings.json");
  let document: ClaudeSettingsDocument;
  try {
    if (!(await exists(settingsPath))) {
      record({ artifact, state: "not_present" });
      return false;
    }
    const raw = (await readFile(settingsPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Claude settings must contain a JSON object.");
    }
    document = parsed as ClaudeSettingsDocument;
  } catch (error) {
    record({
      artifact,
      state: "failed",
      detail: `${settingsPath} could not be read, so it was left untouched: ${reason(error)}`,
      manual:
        `Repair ${settingsPath}, then run "Collect Usage for This Workspace's Account" to `
        + "reinstall the status line."
    });
    return false;
  }

  const command = typeof document.statusLine?.command === "string"
    ? document.statusLine.command
    : undefined;
  if (!isStatusLineBridgeCommand(command)) {
    record({
      artifact,
      state: command ? "skipped" : "not_present",
      detail: command
        ? "Left alone: the configured status line is not one this extension installed."
        : undefined
    });
    return false;
  }
  const replacement = `"${options.statusLineBridgePath}"`;
  if (command === replacement) {
    record({ artifact, state: "already_migrated" });
    return false;
  }
  document.statusLine = {
    ...(document.statusLine ?? {}),
    type: "command",
    command: replacement
  };
  try {
    await atomicWrite(settingsPath, `${JSON.stringify(document, null, 2)}\n`);
  } catch (error) {
    record({
      artifact,
      state: "failed",
      detail: reason(error),
      manual: `Set "statusLine.command" in ${settingsPath} to ${replacement}.`
    });
    return false;
  }
  record({
    artifact,
    state: "migrated",
    detail: `Now runs ${options.statusLineBridgePath}.`
  });
  return true;
}

/**
 * Persist the outcome next to the rest of the support state.
 *
 * The product's rule is that a failure state must be retrievable rather than silent, so the
 * report is on disk whatever the caller does with the returned value — and the diagnostics
 * report reads it back.
 */
async function writeReport(root: string, report: LegacyMigrationReport): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
    await atomicWrite(
      path.join(root, MIGRATION_REPORT),
      `${JSON.stringify(report, null, 2)}\n`
    );
  } catch {
    // Never a reason to fail activation. The report is also logged to the output channel.
  }
}

/** Human-readable one-liner for the output channel. */
export function summarizeMigration(report: LegacyMigrationReport): string {
  if (!report.legacyInstallationFound) {
    return "No previous Claude Account Guard installation was found; nothing to migrate.";
  }
  const counts = new Map<MigrationStepState, number>();
  for (const step of report.steps) {
    counts.set(step.state, (counts.get(step.state) ?? 0) + 1);
  }
  const detail = [...counts.entries()]
    .map(([state, count]) => `${state}: ${count}`)
    .join(", ");
  return `${report.changed ? "Migrated" : "Checked"} the previous installation (${detail}).`;
}

/** The manual steps a user still has to perform, in order. Empty when there are none. */
export function migrationManualSteps(report: LegacyMigrationReport): string[] {
  return report.steps.flatMap((step) => step.manual ? [`${step.artifact}: ${step.manual}`] : []);
}
