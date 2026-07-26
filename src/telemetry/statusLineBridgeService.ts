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

interface BridgeBackup {
  schemaVersion: 1;
  /** The whole previous statusLine object, so padding and custom keys survive a round trip. */
  nextStatusLine?: ClaudeSettings["statusLine"];
  /** The command alone, for the bridge, which only ever needs something to chain to. */
  nextCommand?: string;
  installedAt: string;
}

export type StatusLineBackupState =
  /** No status line existed before installation, so there is nothing to preserve. */
  | "none_recorded"
  /** A backup exists and parses, and names a command to chain. */
  | "valid"
  /** A backup exists and parses but records no command. */
  | "valid_empty"
  /** A backup file exists and could not be read or parsed. The user's command is unrecoverable. */
  | "corrupt"
  /** No backup file at all, though the bridge is installed. */
  | "missing";

export interface StatusLineBackupReport {
  state: StatusLineBackupState;
  /** True only when a real previous command can actually be restored. Never claimed otherwise. */
  restorable: boolean;
  /** Which copy answered: the profile's own record, or the guard-owned mirror. */
  source?: "profile" | "mirror";
  command?: string;
  detail?: string;
}

export interface StatusLineUninstallResult {
  /** What the user's settings.json ended up with. */
  restored: "previous_status_line" | "previous_command" | "claude_default" | "unchanged";
  backup: StatusLineBackupReport;
}

function isStatusLineObject(value: unknown): value is NonNullable<ClaudeSettings["statusLine"]> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The bridge this release installs, invoked directly. */
const BRIDGE_EXECUTABLE = "statusline-bridge.exe";
/** v0.1.0's bridge, which a PowerShell host ran via `-File`. */
const BRIDGE_SCRIPT = "statusline-bridge.ps1";
/** The hosts v0.1.0 could have been launched through. Only these make a `.ps1` argument ours. */
const SCRIPT_HOSTS = new Set(["powershell.exe", "powershell", "pwsh.exe", "pwsh"]);
/** PowerShell's script parameter, and the abbreviations it accepts for it. */
const SCRIPT_FLAGS = new Set(["-file", "-fil", "-fi", "-f", "/file", "/f"]);

/**
 * Split a command line into tokens the way a shell would, so a path can be compared as a path.
 *
 * Quotes are consumed rather than kept: the bridge is installed quoted because a profile directory
 * may contain spaces, and `"C:\a b\statusline-bridge.exe"` has to reduce to one token.
 */
function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const character of command) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** The filename a token names, lower-cased. `path.win32` because this ships on Windows only. */
function tokenFilename(token: string): string {
  return path.win32.basename(token.trim()).toLocaleLowerCase();
}

/**
 * Whether a configured status-line command is one of ours, from any release.
 *
 * Recognising an older bridge matters on upgrade: replacing it without this check would record
 * the previous *bridge* command as the user's own status line, and uninstalling would then
 * "restore" a script that no longer exists. The rename migration matches on the same rule, so a
 * status line that is not ours is never rewritten — hence one exported matcher rather than two.
 *
 * The executable name is deliberately unchanged across the rename, which is why matching on it
 * still recognises a bridge installed by the old extension identity. v0.1.0 installed
 * `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<path>.ps1"`,
 * so the script a PowerShell host was told to run counts too.
 *
 * The match is on the *filename of the executable or script token*, never on a substring of the
 * whole command. Callers act on a true answer by overwriting the command without keeping a copy of
 * it, so a false positive destroys a status line this extension never installed —
 * `node C:\tools\statusline-bridge.exe-helper.js` and any argument that merely mentions the
 * filename used to be claimed as ours. Same reasoning as `isManagedWrapperPath`: the false-positive
 * direction is the one that costs somebody their configuration.
 */
export function isStatusLineBridgeCommand(command: string | undefined): boolean {
  if (!command || !command.trim()) {
    return false;
  }
  const [executable, ...args] = commandTokens(command);
  if (!executable) {
    return false;
  }
  const executableName = tokenFilename(executable);
  if (executableName === BRIDGE_EXECUTABLE || executableName === BRIDGE_SCRIPT) {
    return true;
  }
  if (!SCRIPT_HOSTS.has(executableName)) {
    return false;
  }
  const flagIndex = args.findIndex((token) => SCRIPT_FLAGS.has(token.toLocaleLowerCase()));
  const script = flagIndex >= 0
    ? args[flagIndex + 1]
    : args.find((token) => tokenFilename(token).endsWith(".ps1"));
  return script !== undefined && tokenFilename(script) === BRIDGE_SCRIPT;
}

export class StatusLineBridgeService {
  /**
   * @param mirrorDirectory Where the guard-owned second copy of each backup lives. Defaults beside
   * the bridge script, which is outside the versioned extension directory, so the backup survives
   * both extension upgrades and a user clearing their Claude profile directory.
   */
  public constructor(
    private readonly bridgePath: string,
    private readonly mirrorDirectory = path.join(
      path.dirname(bridgePath),
      "statusline-backups"
    )
  ) {}

  /**
   * The command Claude runs on every status-line refresh.
   *
   * A native executable invoked directly: the bridge used to be a PowerShell script, which cost
   * most of a second of interpreter start-up on every single refresh and mangled both the payload
   * it was given and the command it chained. The path is quoted because Claude runs this through a
   * shell and a user profile directory may contain spaces.
   */
  public bridgeCommand(): string {
    return `"${this.bridgePath}"`;
  }

  private isBridgeCommand(command: string | undefined): boolean {
    return isStatusLineBridgeCommand(command);
  }

  public async install(profile: AccountProfile): Promise<"installed" | "already_installed"> {
    await mkdir(profile.configDir, { recursive: true });
    const settingsPath = path.join(profile.configDir, "settings.json");
    const nextPath = this.backupPath(profile);
    await mkdir(path.dirname(nextPath), { recursive: true });

    const settings = await this.readSettings(settingsPath);
    const command = this.bridgeCommand();
    if (settings.statusLine?.command === command) {
      return "already_installed";
    }

    // An earlier release installed a different bridge command. Swap it for the current one and
    // leave the existing backup alone: the user's real status line is already recorded there, and
    // overwriting it with a bridge command would make it unrestorable.
    if (this.isBridgeCommand(settings.statusLine?.command)) {
      settings.statusLine = { ...(settings.statusLine ?? {}), type: "command", command };
      await this.atomicWrite(settingsPath, settings);
      return "installed";
    }

    const backup: BridgeBackup = {
      schemaVersion: 1,
      nextCommand: typeof settings.statusLine?.command === "string"
        ? settings.statusLine.command
        : undefined,
      nextStatusLine: settings.statusLine,
      installedAt: new Date().toISOString()
    };
    await this.atomicWrite(nextPath, backup);
    // A second copy the user's own profile directory cannot take with it. Best effort: failing to
    // mirror is not a reason to refuse installation, because the primary record is already durable.
    await this.writeMirror(profile, backup).catch(() => undefined);

    // Read the backup back before touching settings.json. Installing the bridge while the record of
    // what it replaced is unreadable is exactly how a status line ends up unrecoverable.
    if (settings.statusLine) {
      const verified = await this.readBackup(nextPath);
      if (!verified || !this.describeBackup(verified, "profile").restorable) {
        throw new Error(
          "Workspace Accounts did not install the status-line bridge: it could not save a verifiable "
          + "backup of your existing status line, and it will not replace a command it cannot restore."
        );
      }
    }

    settings.statusLine = {
      ...(settings.statusLine ?? {}),
      type: "command",
      command
    };
    await this.atomicWrite(settingsPath, settings);
    return "installed";
  }

  public async uninstall(profile: AccountProfile): Promise<StatusLineUninstallResult> {
    const settingsPath = path.join(profile.configDir, "settings.json");
    const settings = await this.readSettings(settingsPath);
    const backup = await this.backupState(profile);
    // Any release's bridge command counts, so a user who upgraded can still detach cleanly.
    if (!this.isBridgeCommand(settings.statusLine?.command)) {
      return { restored: "unchanged", backup };
    }

    const record = (await this.readBackup(this.backupPath(profile)))
      ?? (await this.readBackup(this.mirrorPath(profile)));

    if (record && isStatusLineObject(record.nextStatusLine)) {
      settings.statusLine = record.nextStatusLine;
      await this.atomicWrite(settingsPath, settings);
      return { restored: "previous_status_line", backup };
    }
    if (record && typeof record.nextCommand === "string" && record.nextCommand) {
      settings.statusLine = { type: "command", command: record.nextCommand };
      await this.atomicWrite(settingsPath, settings);
      return { restored: "previous_command", backup };
    }
    if (backup.state === "corrupt" || backup.state === "missing") {
      // Deleting the setting here is what blanked people's status lines: the bridge command goes
      // away along with any record of what it replaced. Leave settings.json alone and report the
      // loss so the caller can tell the user which command to put back by hand.
      return { restored: "unchanged", backup };
    }
    // A verified "there was nothing here before": removing the key restores Claude's own default.
    delete settings.statusLine;
    await this.atomicWrite(settingsPath, settings);
    return { restored: "claude_default", backup };
  }

  /**
   * What can actually be restored for this profile. The caller must consult this before telling a
   * user their status line is preserved — the claim used to be unconditional and often untrue.
   */
  public async backupState(profile: AccountProfile): Promise<StatusLineBackupReport> {
    for (const [source, location] of [
      ["profile", this.backupPath(profile)],
      ["mirror", this.mirrorPath(profile)]
    ] as const) {
      let raw: string;
      try {
        raw = await readFile(location, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        return {
          state: "corrupt",
          restorable: false,
          source,
          detail: (error as NodeJS.ErrnoException).code ?? "unreadable"
        };
      }
      try {
        return this.describeBackup(JSON.parse(raw) as BridgeBackup, source);
      } catch {
        return { state: "corrupt", restorable: false, source, detail: "invalid_json" };
      }
    }
    return { state: "missing", restorable: false };
  }

  private describeBackup(
    record: BridgeBackup,
    source: "profile" | "mirror"
  ): StatusLineBackupReport {
    if (record.schemaVersion !== 1) {
      return { state: "corrupt", restorable: false, source, detail: "unsupported_schema" };
    }
    const command = isStatusLineObject(record.nextStatusLine)
      && typeof record.nextStatusLine.command === "string"
      ? record.nextStatusLine.command
      : typeof record.nextCommand === "string" ? record.nextCommand : undefined;
    if (command) {
      return { state: "valid", restorable: true, source, command };
    }
    if (isStatusLineObject(record.nextStatusLine)) {
      return { state: "valid", restorable: true, source };
    }
    // Recorded, parseable, and genuinely empty: the profile had no status line before.
    return { state: "none_recorded", restorable: false, source };
  }

  private backupPath(profile: AccountProfile): string {
    return path.join(profile.configDir, ".claude-workspace-accounts", "statusline-next.json");
  }

  private mirrorPath(profile: AccountProfile): string {
    return path.join(this.mirrorDirectory, `${profile.id}.json`);
  }

  private async writeMirror(profile: AccountProfile, backup: BridgeBackup): Promise<void> {
    await mkdir(this.mirrorDirectory, { recursive: true });
    await this.atomicWrite(this.mirrorPath(profile), backup);
  }

  private async readBackup(location: string): Promise<BridgeBackup | undefined> {
    try {
      const parsed = JSON.parse(await readFile(location, "utf8")) as BridgeBackup;
      return parsed.schemaVersion === 1 ? parsed : undefined;
    } catch {
      return undefined;
    }
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
