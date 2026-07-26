import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { ProfileRegistry } from "../profiles/registryStore.js";

const WRAPPER_EXE = "claude-account-guard-wrapper.exe";
const WRAPPER_PS1 = "claude-account-guard-wrapper.ps1";
const STATUSLINE_PS1 = "statusline-bridge.ps1";

export interface InstalledSupportFiles {
  wrapperPath: string;
  statusLineBridgePath: string;
}

export class WrapperIntegrationService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry
  ) {}

  public async installSupportFiles(): Promise<InstalledSupportFiles> {
    await mkdir(this.registry.paths.wrapperDirectory, { recursive: true });
    const wrapperPath = path.join(this.registry.paths.wrapperDirectory, WRAPPER_EXE);
    const wrapperScript = path.join(this.registry.paths.wrapperDirectory, WRAPPER_PS1);
    const statusLineBridgePath = path.join(this.registry.paths.wrapperDirectory, STATUSLINE_PS1);
    await Promise.all([
      copyFile(
        this.context.asAbsolutePath(path.join("bin", "native", "win-x64", WRAPPER_EXE)),
        wrapperPath
      ),
      copyFile(this.context.asAbsolutePath(path.join("bin", WRAPPER_PS1)), wrapperScript),
      copyFile(this.context.asAbsolutePath(path.join("bin", STATUSLINE_PS1)), statusLineBridgePath)
    ]);
    return { wrapperPath, statusLineBridgePath };
  }

  public async configure(wrapperPath: string): Promise<"configured" | "already_configured" | "conflict" | "disabled"> {
    if (!vscode.workspace.getConfiguration("claudeAccountGuard").get<boolean>("wrapper.autoConfigure", true)) {
      return "disabled";
    }
    const configuration = vscode.workspace.getConfiguration("claudeCode");
    const existing = configuration.get<string>("claudeProcessWrapper");
    if (existing && path.normalize(existing) === path.normalize(wrapperPath)) {
      const current = (await this.registry.read()).integration;
      await this.registry.setIntegration({
        ...current,
        wrapperPath,
        configuredAt: current.configuredAt ?? new Date().toISOString(),
        version: this.context.extension.packageJSON.version as string
      });
      return "already_configured";
    }
    if (existing) {
      const current = (await this.registry.read()).integration;
      await this.registry.setIntegration({
        ...current,
        wrapperPath,
        upstreamWrapper: existing,
        version: this.context.extension.packageJSON.version as string
      });
      return "conflict";
    }
    await configuration.update(
      "claudeProcessWrapper",
      wrapperPath,
      vscode.ConfigurationTarget.Global
    );
    const current = (await this.registry.read()).integration;
    await this.registry.setIntegration({
      ...current,
      wrapperPath,
      configuredAt: new Date().toISOString(),
      version: this.context.extension.packageJSON.version as string
    });
    return "configured";
  }

  public async resolveConflict(wrapperPath: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("claudeCode");
    const existing = configuration.get<string>("claudeProcessWrapper");
    const document = await this.registry.read();
    await this.registry.setIntegration({
      ...document.integration,
      wrapperPath,
      upstreamWrapper: existing && path.normalize(existing) !== path.normalize(wrapperPath)
        ? existing
        : document.integration.upstreamWrapper,
      configuredAt: new Date().toISOString(),
      version: this.context.extension.packageJSON.version as string
    });
    await configuration.update(
      "claudeProcessWrapper",
      wrapperPath,
      vscode.ConfigurationTarget.Global
    );
  }
}
