import os from "node:os";
import path from "node:path";
import type { AccountProfile, RuntimeProfile } from "../core/models.js";
import { normalizeWindowsPath } from "../core/paths.js";

export class RuntimeProfileDetector {
  public detect(profiles: readonly AccountProfile[]): RuntimeProfile {
    const configDir = process.env.CLAUDE_CONFIG_DIR?.trim()
      || path.join(os.homedir(), ".claude");
    const configDirNormalized = normalizeWindowsPath(configDir);
    return {
      configDir,
      configDirNormalized,
      profile: profiles.find((profile) => profile.configDirNormalized === configDirNormalized)
    };
  }
}
