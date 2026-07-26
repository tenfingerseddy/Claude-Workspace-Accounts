import os from "node:os";
import path from "node:path";

/**
 * How one account is probed, kept free of `vscode` so it can be tested directly.
 *
 * Claude Code reports `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is
 * set — even when it is set to the directory that was already the default — while still
 * reporting `loggedIn: true`. The only way to learn a real identity is therefore to leave the
 * variable unset, which is only honest for the account the CLI would use anyway.
 */
export function defaultConfigDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".claude");
}

export function shouldInheritAmbientConfig(input: {
  profileConfigDirNormalized: string;
  /** `CLAUDE_CONFIG_DIR` as this process inherited it, if anything. */
  ambientConfigDir?: string;
  defaultConfigDirNormalized: string;
}): boolean {
  if (input.ambientConfigDir?.trim()) {
    // The host was launched with an account already selected, so nothing can be claimed
    // about what the CLI would pick on its own.
    return false;
  }
  return input.profileConfigDirNormalized === input.defaultConfigDirNormalized;
}
