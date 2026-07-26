import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../../src/core/models.js";
import {
  StatusLineBridgeService,
  isStatusLineBridgeCommand
} from "../../src/telemetry/statusLineBridgeService.js";

interface Scenario {
  directory: string;
  profile: AccountProfile;
  settingsPath: string;
  mirrorDirectory: string;
}

/** A profile directory whose settings.json starts with `statusLine`, plus a guard-owned mirror dir. */
async function scenario(statusLine: Record<string, unknown> | undefined): Promise<Scenario> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-statusline-"));
  const settingsPath = path.join(directory, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(statusLine ? { statusLine } : {}), "utf8");
  return {
    directory,
    settingsPath,
    mirrorDirectory: path.join(directory, "guard-mirror"),
    profile: {
      id: "work",
      displayName: "Work",
      marker: "W",
      configDir: directory,
      configDirNormalized: directory.toLocaleLowerCase(),
      vsCodeUserDataDir: path.join(directory, "vscode"),
      createdAt: new Date().toISOString()
    }
  };
}

/**
 * Ownership decides whether a user's status line gets overwritten without a copy being kept, so a
 * false positive destroys a command this extension never installed. The predicate used to answer on
 * a *substring* of the whole command, which claimed anything that so much as mentioned the bridge's
 * filename anywhere in it — including inside an argument to somebody else's script.
 */
describe("recognising a status-line command as ours", () => {
  it("claims a bridge this or any earlier release installed", () => {
    for (const command of [
      "\"C:\\Users\\dev\\AppData\\Local\\ClaudeWorkspaceAccounts\\wrapper\\statusline-bridge.exe\"",
      "C:\\Users\\dev\\AppData\\Local\\ClaudeWorkspaceAccounts\\wrapper\\statusline-bridge.exe",
      "\"C:\\Program Files\\Claude Accounts\\statusline-bridge.exe\" --json",
      "c:/tools/STATUSLINE-BRIDGE.EXE",
      // v0.1.0's command, verbatim.
      "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass "
        + "-File \"C:\\Users\\dev\\AppData\\Local\\ClaudeAccountGuard\\wrapper\\statusline-bridge.ps1\"",
      "pwsh -File 'C:\\old\\statusline-bridge.ps1'",
      "\"C:\\old\\statusline-bridge.ps1\""
    ]) {
      expect(isStatusLineBridgeCommand(command), command).toBe(true);
    }
  });

  it("leaves a command alone when the bridge's name is only part of a longer filename", () => {
    for (const command of [
      // Every one of these was claimed as ours by the substring match.
      "node C:\\tools\\statusline-bridge.exe-helper.js",
      "C:\\tools\\statusline-bridge.exe-helper.exe",
      "C:\\tools\\my-statusline-bridge.exe",
      "C:\\tools\\statusline-bridge.exe.bak",
      "C:\\tools\\statusline-bridge.ps1.disabled",
      "statusline-bridge.exe.cmd"
    ]) {
      expect(isStatusLineBridgeCommand(command), command).toBe(false);
    }
  });

  it("leaves a command alone when the bridge is only mentioned in an argument", () => {
    for (const command of [
      "node C:\\tools\\my-line.js --bridge \"statusline-bridge.exe\"",
      "node C:\\tools\\my-line.js --note statusline-bridge.ps1",
      "python wrap.py C:\\old\\statusline-bridge.exe",
      "powershell.exe -NoProfile -Command \"Write-Host statusline-bridge.ps1\"",
      // The script the host was actually told to run is somebody else's.
      "powershell.exe -File \"C:\\tools\\other.ps1\" C:\\old\\statusline-bridge.ps1"
    ]) {
      expect(isStatusLineBridgeCommand(command), command).toBe(false);
    }
  });

  it("has no opinion about a command that is plainly not ours, or absent", () => {
    for (const command of [
      undefined,
      "",
      "   ",
      "node existing-status.js",
      "powershell.exe -File \"C:\\tools\\other.ps1\""
    ]) {
      expect(isStatusLineBridgeCommand(command), String(command)).toBe(false);
    }
  });
});

describe("status-line bridge settings preservation", () => {
  it("restores the complete previous status-line object", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-workspace-accounts-statusline-"));
    const settingsPath = path.join(directory, "settings.json");
    const previous = {
      type: "command",
      command: "node existing-status.js",
      padding: 2,
      customMetadata: {
        owner: "user"
      }
    };
    writeFileSync(settingsPath, JSON.stringify({
      statusLine: previous,
      hooks: {
        preserved: true
      }
    }));
    const profile: AccountProfile = {
      id: "work",
      displayName: "Work",
      marker: "W",
      configDir: directory,
      configDirNormalized: directory.toLocaleLowerCase(),
      vsCodeUserDataDir: path.join(directory, "vscode"),
      createdAt: new Date().toISOString()
    };
    const bridge = new StatusLineBridgeService("C:\\Guard\\statusline-bridge.ps1");

    await bridge.install(profile);
    const installed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: Record<string, unknown>;
      hooks: Record<string, unknown>;
    };
    expect(installed.statusLine.command).toContain("statusline-bridge.ps1");
    expect(installed.statusLine.padding).toBe(2);
    expect(installed.hooks).toEqual({ preserved: true });

    const result = await bridge.uninstall(profile);
    expect(result.restored).toBe("previous_status_line");
    expect(result.backup).toMatchObject({ state: "valid", restorable: true });
    const restored = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: Record<string, unknown>;
      hooks: Record<string, unknown>;
    };
    expect(restored.statusLine).toEqual(previous);
    expect(restored.hooks).toEqual({ preserved: true });
  });

  it("keeps a recoverable second copy outside the profile directory", async () => {
    // The only backup used to live inside the profile's own Claude directory, so clearing that
    // directory made the user's original status line unrecoverable.
    const { directory, profile, settingsPath, mirrorDirectory } = await scenario({
      type: "command",
      command: "node existing-status.js"
    });
    const bridge = new StatusLineBridgeService("C:\\Guard\\statusline-bridge.ps1", mirrorDirectory);
    await bridge.install(profile);

    rmSync(path.join(directory, ".claude-workspace-accounts"), { recursive: true, force: true });
    expect(await bridge.backupState(profile)).toMatchObject({
      state: "valid",
      restorable: true,
      source: "mirror",
      command: "node existing-status.js"
    });

    const result = await bridge.uninstall(profile);
    expect(result.restored).toBe("previous_status_line");
    expect((JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: { command: string };
    }).statusLine.command).toBe("node existing-status.js");
  });

  it("never claims preservation when the backup is gone", async () => {
    // `settings.statusLine` used to be deleted whenever the backup could not be read, so the user's
    // status line silently disappeared with no record of what it had been.
    const { directory, profile, settingsPath, mirrorDirectory } = await scenario({
      type: "command",
      command: "node existing-status.js"
    });
    const bridge = new StatusLineBridgeService("C:\\Guard\\statusline-bridge.ps1", mirrorDirectory);
    await bridge.install(profile);
    rmSync(path.join(directory, ".claude-workspace-accounts"), { recursive: true, force: true });
    rmSync(mirrorDirectory, { recursive: true, force: true });

    expect(await bridge.backupState(profile)).toMatchObject({
      state: "missing",
      restorable: false
    });
    const result = await bridge.uninstall(profile);
    expect(result.restored).toBe("unchanged");
    expect(result.backup.restorable).toBe(false);
    // Settings are left exactly as they were: losing the backup must not also lose the setting.
    expect((JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: { command: string };
    }).statusLine.command).toContain("statusline-bridge.ps1");
  });

  it("reports a corrupt backup as corrupt, not as absent", async () => {
    const { directory, profile, mirrorDirectory } = await scenario({
      type: "command",
      command: "node existing-status.js"
    });
    const bridge = new StatusLineBridgeService("C:\\Guard\\statusline-bridge.ps1", mirrorDirectory);
    await bridge.install(profile);
    writeFileSync(
      path.join(directory, ".claude-workspace-accounts", "statusline-next.json"),
      "{not json",
      "utf8"
    );
    rmSync(mirrorDirectory, { recursive: true, force: true });

    expect(await bridge.backupState(profile)).toMatchObject({
      state: "corrupt",
      restorable: false,
      detail: "invalid_json"
    });
    expect((await bridge.uninstall(profile)).restored).toBe("unchanged");
  });

  it("restores Claude's default only when it verified there was nothing to keep", async () => {
    const { profile, settingsPath, mirrorDirectory } = await scenario(undefined);
    const bridge = new StatusLineBridgeService("C:\\Guard\\statusline-bridge.ps1", mirrorDirectory);
    await bridge.install(profile);
    expect(await bridge.backupState(profile)).toMatchObject({
      state: "none_recorded",
      restorable: false
    });

    const result = await bridge.uninstall(profile);
    expect(result.restored).toBe("claude_default");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).not.toHaveProperty("statusLine");
  });

  it("refuses to install when the backup cannot be written", async () => {
    const { directory, profile, settingsPath, mirrorDirectory } = await scenario({
      type: "command",
      command: "node existing-status.js"
    });
    // A file where the support directory belongs: mkdir fails, so no backup can be recorded.
    writeFileSync(path.join(directory, ".claude-workspace-accounts"), "not a directory", "utf8");
    const bridge = new StatusLineBridgeService("C:\\Guard\\statusline-bridge.ps1", mirrorDirectory);

    await expect(bridge.install(profile)).rejects.toBeDefined();
    // The bridge must never be installed over a status line it could not record.
    expect((JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: { command: string };
    }).statusLine.command).toBe("node existing-status.js");
  });
});
