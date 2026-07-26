import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../../src/core/models.js";
import { StatusLineBridgeService } from "../../src/telemetry/statusLineBridgeService.js";

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
