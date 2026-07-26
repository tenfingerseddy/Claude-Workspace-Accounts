import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { ProfileRegistry } from "../profiles/registryStore.js";

const WRAPPER_EXE = "claude-account-guard-wrapper.exe";
const STATUSLINE_EXE = "statusline-bridge.exe";

/**
 * Files the launcher may place beside the wrapper. Support files are copied outside the
 * versioned extension directory so a Claude Code launch keeps working across extension
 * upgrades, and every entry is optional so removing one from the build cannot break
 * installation for users who upgrade from a release that still shipped it.
 */
const SUPPORT_FILES: readonly { source: string; name: string }[] = [
  { source: path.join("bin", "native", "win-x64", WRAPPER_EXE), name: WRAPPER_EXE },
  { source: path.join("bin", "native", "win-x64", STATUSLINE_EXE), name: STATUSLINE_EXE }
];

/**
 * Files earlier releases installed that current releases no longer use. They are removed
 * on install so a stale copy can never be picked up by something that still looks for it —
 * both were PowerShell scripts, and both silently corrupted what they were handed.
 */
const OBSOLETE_SUPPORT_FILES: readonly string[] = [
  "claude-account-guard-wrapper.ps1",
  "statusline-bridge.ps1"
];

const WRAPPER_SETTING = "claudeProcessWrapper";
const CLAUDE_CODE_SECTION = "claudeCode";

export type WrapperConfigureOutcome =
  | "configured"
  | "already_configured"
  | "conflict"
  | "disabled";

export type WrapperDisableOutcome = "cleared" | "restored_upstream" | "not_configured";

export type WrapperRepairOutcome =
  | "ok"
  | "not_configured"
  | "foreign"
  | "reinstalled"
  | "cleared";

export interface InstalledSupportFiles {
  wrapperPath: string;
  statusLineBridgePath: string;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export class WrapperIntegrationService {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry
  ) {}

  public get wrapperPath(): string {
    return path.join(this.registry.paths.wrapperDirectory, WRAPPER_EXE);
  }

  public get statusLineBridgePath(): string {
    return path.join(this.registry.paths.wrapperDirectory, STATUSLINE_EXE);
  }

  public async installSupportFiles(): Promise<InstalledSupportFiles> {
    await mkdir(this.registry.paths.wrapperDirectory, { recursive: true });
    for (const file of SUPPORT_FILES) {
      const source = this.context.asAbsolutePath(file.source);
      if (!(await exists(source))) {
        continue;
      }
      await copyFile(source, path.join(this.registry.paths.wrapperDirectory, file.name));
    }
    await Promise.all(
      OBSOLETE_SUPPORT_FILES.map((name) =>
        rm(path.join(this.registry.paths.wrapperDirectory, name), { force: true })
      )
    );
    return {
      wrapperPath: this.wrapperPath,
      statusLineBridgePath: this.statusLineBridgePath
    };
  }

  /** The value Claude Code is currently configured to launch through, if any. */
  public configuredWrapper(): string | undefined {
    const value = vscode.workspace
      .getConfiguration(CLAUDE_CODE_SECTION)
      .get<string>(WRAPPER_SETTING);
    return value && value.trim() ? value : undefined;
  }

  /** True when a configured wrapper path belongs to Account Guard rather than another tool. */
  public isGuardWrapper(candidate: string | undefined): boolean {
    if (!candidate) {
      return false;
    }
    const normalized = path.normalize(candidate).toLowerCase();
    return (
      normalized === path.normalize(this.wrapperPath).toLowerCase()
      || path.basename(normalized) === WRAPPER_EXE
    );
  }

  public async configure(wrapperPath: string): Promise<WrapperConfigureOutcome> {
    if (
      !vscode.workspace
        .getConfiguration("claudeAccountGuard")
        .get<boolean>("wrapper.autoConfigure", true)
    ) {
      return "disabled";
    }
    const configuration = vscode.workspace.getConfiguration(CLAUDE_CODE_SECTION);
    const existing = this.configuredWrapper();
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
      WRAPPER_SETTING,
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
    const configuration = vscode.workspace.getConfiguration(CLAUDE_CODE_SECTION);
    const existing = this.configuredWrapper();
    const document = await this.registry.read();
    await this.registry.setIntegration({
      ...document.integration,
      wrapperPath,
      upstreamWrapper:
        existing && path.normalize(existing) !== path.normalize(wrapperPath)
          ? existing
          : document.integration.upstreamWrapper,
      configuredAt: new Date().toISOString(),
      version: this.context.extension.packageJSON.version as string
    });
    await configuration.update(
      WRAPPER_SETTING,
      wrapperPath,
      vscode.ConfigurationTarget.Global
    );
  }

  /**
   * Detach Claude Code from the Account Guard wrapper.
   *
   * The wrapper setting is global and deliberately outlives the extension directory, so
   * uninstalling Account Guard without clearing it leaves Claude Code launching through a
   * path that may no longer exist. This is the supported way back to an unwrapped Claude
   * Code, and it restores a chained third-party wrapper rather than discarding it.
   */
  public async disable(): Promise<WrapperDisableOutcome> {
    const configuration = vscode.workspace.getConfiguration(CLAUDE_CODE_SECTION);
    const existing = this.configuredWrapper();
    const document = await this.registry.read();
    const upstream = document.integration.upstreamWrapper;

    // Another tool's wrapper is not ours to remove.
    if (existing && !this.isGuardWrapper(existing)) {
      return "not_configured";
    }

    let outcome: WrapperDisableOutcome = "not_configured";
    if (existing) {
      if (upstream && !this.isGuardWrapper(upstream) && (await exists(upstream))) {
        await configuration.update(
          WRAPPER_SETTING,
          upstream,
          vscode.ConfigurationTarget.Global
        );
        outcome = "restored_upstream";
      } else {
        await configuration.update(
          WRAPPER_SETTING,
          undefined,
          vscode.ConfigurationTarget.Global
        );
        outcome = "cleared";
      }
    }

    await this.registry.setIntegration({
      ...document.integration,
      wrapperPath: undefined,
      configuredAt: undefined,
      upstreamWrapper: outcome === "restored_upstream"
        ? undefined
        : document.integration.upstreamWrapper
    });
    return outcome;
  }

  /**
   * Reconcile the global wrapper setting with what is actually on disk.
   *
   * A setting pointing at a missing Account Guard wrapper breaks every Claude Code launch,
   * which is exactly the state left behind by uninstalling an earlier release. Reinstall
   * when possible; clear the setting when not, because a working unwrapped Claude Code is
   * always better than a broken wrapped one.
   */
  public async repairIfStale(): Promise<WrapperRepairOutcome> {
    const existing = this.configuredWrapper();
    if (!existing) {
      return "not_configured";
    }
    if (!this.isGuardWrapper(existing)) {
      return "foreign";
    }
    if (await exists(existing)) {
      return "ok";
    }
    try {
      await this.installSupportFiles();
      if (await exists(this.wrapperPath)) {
        if (path.normalize(existing) !== path.normalize(this.wrapperPath)) {
          await vscode.workspace
            .getConfiguration(CLAUDE_CODE_SECTION)
            .update(WRAPPER_SETTING, this.wrapperPath, vscode.ConfigurationTarget.Global);
        }
        return "reinstalled";
      }
    } catch {
      // Fall through to clearing: never leave Claude Code pointed at a missing wrapper.
    }
    await vscode.workspace
      .getConfiguration(CLAUDE_CODE_SECTION)
      .update(WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
    return "cleared";
  }

  /** Remove the installed wrapper and status-line bridge from the support directory. */
  public async removeSupportFiles(): Promise<void> {
    for (const name of [...SUPPORT_FILES.map((file) => file.name), ...OBSOLETE_SUPPORT_FILES]) {
      await rm(path.join(this.registry.paths.wrapperDirectory, name), { force: true });
    }
  }
}
