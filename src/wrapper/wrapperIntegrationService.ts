import { access, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import {
  OBSOLETE_SUPPORT_FILES,
  STATUSLINE_EXE,
  WRAPPER_EXE,
  isManagedWrapperPath
} from "./wrapperPaths.js";

export {
  WRAPPER_EXE,
  LEGACY_WRAPPER_EXE,
  STATUSLINE_EXE,
  isManagedWrapperPath
} from "./wrapperPaths.js";

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

/**
 * Support files the launcher places beside the wrapper. Copied outside the versioned extension
 * directory so a Claude Code launch keeps working across extension upgrades, and every entry is
 * optional so removing one from the build cannot break installation for someone upgrading from a
 * release that still shipped it.
 */
const SUPPORT_FILES: readonly { source: string; name: string }[] = [
  { source: path.join("bin", "native", "win-x64", WRAPPER_EXE), name: WRAPPER_EXE },
  { source: path.join("bin", "native", "win-x64", STATUSLINE_EXE), name: STATUSLINE_EXE }
];

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

  /** True when a configured wrapper path belongs to Workspace Accounts rather than another tool. */
  public isGuardWrapper(candidate: string | undefined): boolean {
    return isManagedWrapperPath(candidate, this.wrapperPath);
  }

  public async configure(wrapperPath: string): Promise<WrapperConfigureOutcome> {
    if (
      !vscode.workspace
        .getConfiguration("claudeAccounts")
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

  /**
   * Chain a third-party wrapper behind ours, after the user has agreed to it.
   *
   * `expectedUpstream` is the wrapper that was actually named in the consent prompt. Another window
   * or another tool can change the setting while a modal is open, and chaining whatever happens to
   * be there at write time would hand a bearer token and the bound account to a binary the user was
   * never shown. So the disclosed value is re-checked here and the write is abandoned if it moved;
   * the caller re-asks against the new value rather than guessing.
   */
  public async resolveConflict(
    wrapperPath: string,
    expectedUpstream: string | undefined
  ): Promise<"chained" | "upstream_changed"> {
    const configuration = vscode.workspace.getConfiguration(CLAUDE_CODE_SECTION);
    const existing = this.configuredWrapper();
    const sameAsDisclosed = existing === undefined
      ? expectedUpstream === undefined
      : expectedUpstream !== undefined
        && path.normalize(existing).toLowerCase() === path.normalize(expectedUpstream).toLowerCase();
    if (!sameAsDisclosed) {
      return "upstream_changed";
    }
    // patchIntegration deletes any field explicitly set to undefined, so only name
    // upstreamWrapper when there is genuinely a new one to record. Omitting it leaves a
    // previously recorded upstream in place, which is what disable() needs to restore.
    const chained = existing && path.normalize(existing) !== path.normalize(wrapperPath)
      ? existing
      : undefined;
    await this.registry.patchIntegration({
      wrapperPath,
      ...(chained ? { upstreamWrapper: chained } : {}),
      configuredAt: new Date().toISOString(),
      version: this.context.extension.packageJSON.version as string
    });
    await configuration.update(
      WRAPPER_SETTING,
      wrapperPath,
      vscode.ConfigurationTarget.Global
    );
    return "chained";
  }

  /**
   * Detach Claude Code from the Workspace Accounts wrapper.
   *
   * The wrapper setting is global and deliberately outlives the extension directory, so
   * uninstalling Workspace Accounts without clearing it leaves Claude Code launching through a
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
   * A setting pointing at a missing Workspace Accounts wrapper breaks every Claude Code launch,
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
