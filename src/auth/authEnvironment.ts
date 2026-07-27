import os from "node:os";
import path from "node:path";

/**
 * How one account is probed, kept free of `vscode` so it can be tested directly.
 *
 * `claude auth status` reports `email`, `orgId` and `orgName` for whichever directory
 * `CLAUDE_CONFIG_DIR` names, so identity is readable per account. The variable is still left
 * unset when the account is the directory the CLI would use anyway: same answer, one less
 * variable in play.
 *
 * An earlier revision of this comment said those fields come back null whenever the variable is
 * set, and three layers of the product were built on it. Re-verified against 2.1.220 that is
 * wrong. Re-test a load-bearing claim about the CLI before building on it again.
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
