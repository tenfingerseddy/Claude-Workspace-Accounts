import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountProfile } from "../core/models.js";

interface ClaudeSettings {
  statusLine?: {
    type?: string;
    command?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class StatusLineBridgeService {
  public constructor(private readonly bridgePath: string) {}

  public bridgeCommand(): string {
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${this.bridgePath}"`;
  }

  public async install(profile: AccountProfile): Promise<"installed" | "already_installed"> {
    await mkdir(profile.configDir, { recursive: true });
    const settingsPath = path.join(profile.configDir, "settings.json");
    const supportDirectory = path.join(profile.configDir, ".claude-account-guard");
    const nextPath = path.join(supportDirectory, "statusline-next.json");
    await mkdir(supportDirectory, { recursive: true });

    const settings = await this.readSettings(settingsPath);
    const command = this.bridgeCommand();
    if (settings.statusLine?.command === command) {
      return "already_installed";
    }

    await this.atomicWrite(nextPath, {
      schemaVersion: 1,
      nextCommand: settings.statusLine?.command,
      nextStatusLine: settings.statusLine,
      installedAt: new Date().toISOString()
    });
    settings.statusLine = {
      ...(settings.statusLine ?? {}),
      type: "command",
      command
    };
    await this.atomicWrite(settingsPath, settings);
    return "installed";
  }

  public async uninstall(profile: AccountProfile): Promise<void> {
    const settingsPath = path.join(profile.configDir, "settings.json");
    const nextPath = path.join(profile.configDir, ".claude-account-guard", "statusline-next.json");
    const settings = await this.readSettings(settingsPath);
    if (settings.statusLine?.command !== this.bridgeCommand()) {
      return;
    }
    let nextStatusLine: ClaudeSettings["statusLine"];
    try {
      const next = JSON.parse(await readFile(nextPath, "utf8")) as {
        nextCommand?: unknown;
        nextStatusLine?: unknown;
      };
      if (next.nextStatusLine
        && typeof next.nextStatusLine === "object"
        && !Array.isArray(next.nextStatusLine)) {
        nextStatusLine = next.nextStatusLine as ClaudeSettings["statusLine"];
      } else if (typeof next.nextCommand === "string") {
        nextStatusLine = { type: "command", command: next.nextCommand };
      }
    } catch {
      // A missing bridge record means there was no known status line to restore.
    }
    if (nextStatusLine) {
      settings.statusLine = nextStatusLine;
    } else {
      delete settings.statusLine;
    }
    await this.atomicWrite(settingsPath, settings);
  }

  private async readSettings(settingsPath: string): Promise<ClaudeSettings> {
    try {
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Claude settings must contain a JSON object.");
      }
      return parsed as ClaudeSettings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new Error(
        `Claude settings could not be updated safely: ${error instanceof Error ? error.message : "invalid JSON"}`
      );
    }
  }

  private async atomicWrite(filePath: string, value: unknown): Promise<void> {
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  }
}
