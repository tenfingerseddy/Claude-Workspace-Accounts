import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../../src/core/models.js";
import { StatusLineBridgeService } from "../../src/telemetry/statusLineBridgeService.js";

describe("status-line bridge settings preservation", () => {
  it("restores the complete previous status-line object", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "claude-account-guard-statusline-"));
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

    await bridge.uninstall(profile);
    const restored = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      statusLine: Record<string, unknown>;
      hooks: Record<string, unknown>;
    };
    expect(restored.statusLine).toEqual(previous);
    expect(restored.hooks).toEqual({ preserved: true });
  });
});
