import type { AccountProfile, WorkspaceLock } from "./models.js";
import { normalizeWindowsPath, pathContains } from "./paths.js";

export interface ResolvedLock {
  lock?: WorkspaceLock;
  profile?: AccountProfile;
}

export function resolveLockForPath(
  workspacePath: string,
  locks: readonly WorkspaceLock[],
  profiles: readonly AccountProfile[]
): ResolvedLock {
  const normalized = normalizeWindowsPath(workspacePath);
  const matching = locks
    .map((lock) => {
      const roots = lock.workspaceRootPathsNormalized?.length
        ? lock.workspaceRootPathsNormalized
        : [lock.workspacePathNormalized];
      const matchLength = roots
        .filter((root) => pathContains(root, normalized))
        .reduce((longest, root) => Math.max(longest, root.length), 0);
      return { lock, matchLength };
    })
    .filter(({ lock, matchLength }) => lock.mode !== "off" && matchLength > 0)
    .sort((left, right) => right.matchLength - left.matchLength)
    .map(({ lock }) => lock);
  const lock = matching[0];
  if (!lock) {
    return {};
  }
  return {
    lock,
    profile: profiles.find((profile) => profile.id === lock.profileId)
  };
}

export function conflictingMultiRootLocks(locks: readonly WorkspaceLock[]): boolean {
  const enforcedProfileIds = new Set(
    locks.filter((lock) => lock.mode === "enforce").map((lock) => lock.profileId)
  );
  return enforcedProfileIds.size > 1;
}
