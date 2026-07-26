import path from "node:path";

/**
 * Support-file names and the predicate that decides whether a configured process wrapper is ours.
 *
 * Deliberately free of `vscode`, for two reasons: the rename migration needs these names and runs
 * before the extension host has any support state, and the predicate below is worth testing without
 * standing up a stub. Keeping one copy of each filename also stops the two from drifting — the
 * migration previously declared its own copy of the legacy name.
 */

/** The wrapper this release installs. */
export const WRAPPER_EXE = "claude-workspace-accounts-wrapper.exe";

/** The wrapper's filename before the rename from Claude Account Guard. */
export const LEGACY_WRAPPER_EXE = "claude-account-guard-wrapper.exe";

/**
 * Unchanged by the rename on purpose: a bridge command already sitting in a user's Claude
 * `settings.json` is recognised by this name, from any release.
 */
export const STATUSLINE_EXE = "statusline-bridge.exe";

/**
 * Files earlier releases installed that current releases no longer use. They are removed on install
 * so a stale copy can never be picked up by something that still looks for it — the two PowerShell
 * scripts both silently corrupted what they were handed.
 *
 * These are deliberately the OLD names. A blanket rename swept `claude-account-guard-wrapper.ps1`
 * into `claude-workspace-accounts-wrapper.ps1`, a file that has never existed, quietly turning the
 * cleanup into a no-op. A list of obsolete filenames is the one place a rename must not reach.
 */
export const OBSOLETE_SUPPORT_FILES: readonly string[] = [
  "claude-account-guard-wrapper.ps1",
  LEGACY_WRAPPER_EXE,
  "statusline-bridge.ps1"
];

/**
 * Whether a `claudeCode.claudeProcessWrapper` value is one of ours.
 *
 * The pre-rename filename counts as ours. Someone upgrading still has the old wrapper in that
 * setting until migration repoints it, and if migration failed or has not run yet, treating it as a
 * stranger's wrapper would make Disconnect and the activation repair refuse to touch it — stranding
 * exactly the person the rename is supposed to carry across. Being left with a global setting
 * pointing at a wrapper the UI will not manage is the original defect this whole effort exists to
 * fix.
 *
 * The false-positive direction matters more than the false-negative one: claiming a third party's
 * wrapper would mean overwriting or deleting their tooling, so match on our own filenames only,
 * never on a substring or a shared prefix.
 */
export function isManagedWrapperPath(
  candidate: string | undefined,
  currentWrapperPath?: string
): boolean {
  if (!candidate || !candidate.trim()) {
    return false;
  }
  const normalized = path.normalize(candidate).toLowerCase();
  if (currentWrapperPath && normalized === path.normalize(currentWrapperPath).toLowerCase()) {
    return true;
  }
  const basename = path.basename(normalized);
  return basename === WRAPPER_EXE.toLowerCase() || basename === LEGACY_WRAPPER_EXE.toLowerCase();
}
