import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { AccountProfile } from "../core/models.js";
import { workspaceHash } from "../core/paths.js";
import type { LaunchHandshakeService} from "./launchHandshakeService.js";
import { type LaunchReadiness } from "./launchHandshakeService.js";

export class IsolatedWindowLauncher {
  public constructor(private readonly handshakes: LaunchHandshakeService) {}

  public async launch(profile: AccountProfile): Promise<LaunchReadiness | undefined> {
    const dirty = vscode.workspace.textDocuments.some((document) => document.isDirty && !document.isUntitled);
    if (dirty) {
      const choice = await vscode.window.showWarningMessage(
        "This window has unsaved editors. Account switching opens a new window and leaves this one open.",
        { modal: true },
        "Save All and Continue"
      );
      if (choice !== "Save All and Continue" || !(await vscode.workspace.saveAll(false))) {
        return undefined;
      }
    }

    const workspaceUri = vscode.workspace.workspaceFile
      ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) {
      throw new Error("Open a folder or workspace before switching account profiles.");
    }
    const workspace = workspaceUri.fsPath;

    const launchId = this.handshakes.createId();
    const args = [
      "--new-window",
      "--user-data-dir",
      profile.vsCodeUserDataDir,
      workspace
    ];
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: profile.configDir,
        CLAUDE_ACCOUNT_GUARD_LAUNCH_ID: launchId,
        CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY: workspaceHash(workspaceUri.toString())
      },
      detached: true,
      shell: false,
      windowsHide: false,
      stdio: "ignore"
    });
    child.unref();

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Opening ${profile.displayName} in an isolated VS Code window`,
        cancellable: false
      },
      () => this.handshakes.waitFor(launchId)
    );
  }
}
