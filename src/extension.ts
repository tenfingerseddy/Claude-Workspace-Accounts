import path from "node:path";
import * as vscode from "vscode";
import { ClaudeBinaryResolver, AuthVerifier } from "./auth/authVerifier.js";
import { CommandController } from "./commands/commandController.js";
import { workspaceHash } from "./core/paths.js";
import { DashboardProvider } from "./dashboard/dashboardProvider.js";
import { DiagnosticsProvider } from "./diagnostics/diagnosticsProvider.js";
import { WorkspaceLockService } from "./locks/workspaceLockService.js";
import type {
  LegacyMigrationReport,
  MigrationHost,
  SettingScope
} from "./migration/legacyMigration.js";
import {
  migrateLegacyInstallation,
  migrationManualSteps,
  resolveLegacySupportRoot,
  summarizeMigration
} from "./migration/legacyMigration.js";
import { ProfileRegistry, resolveSupportPaths } from "./profiles/registryStore.js";
import { RuntimeProfileDetector } from "./profiles/runtimeProfileDetector.js";
import { UsageRepository } from "./storage/usageRepository.js";
import { StatusBarController } from "./statusbar/statusBarController.js";
import { StatusLineBridgeService } from "./telemetry/statusLineBridgeService.js";
import { TelemetryCollector } from "./telemetry/telemetryCollector.js";
import {
  STATUSLINE_EXE,
  WRAPPER_EXE,
  WrapperIntegrationService,
  isManagedWrapperPath
} from "./wrapper/wrapperIntegrationService.js";

interface RuntimeServices {
  collector?: TelemetryCollector;
  repository: UsageRepository;
}

let runtimeServices: RuntimeServices | undefined;

/** The settings and extension lookups the rename migration needs, and nothing else. */
function migrationHost(): MigrationHost {
  const target = (scope: SettingScope): vscode.ConfigurationTarget => scope === "global"
    ? vscode.ConfigurationTarget.Global
    : scope === "workspace"
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.WorkspaceFolder;
  return {
    inspectSetting: (section, key) => {
      const inspected = vscode.workspace.getConfiguration(section).inspect<unknown>(key);
      return inspected
        ? {
            globalValue: inspected.globalValue,
            workspaceValue: inspected.workspaceValue,
            workspaceFolderValue: inspected.workspaceFolderValue
          }
        : undefined;
    },
    updateSetting: async (section, key, value, scope) => {
      await vscode.workspace.getConfiguration(section).update(key, value, target(scope));
    },
    isExtensionInstalled: (extensionId) =>
      Boolean(vscode.extensions.getExtension(extensionId))
  };
}

/**
 * Tell the user what the rename did to their installation, once activation can offer actions.
 *
 * Two installations both writing the global `claudeCode.claudeProcessWrapper` is the worst
 * outcome here — whichever wrote last wins and the other silently stops applying accounts — so
 * that warning is separate and unconditional rather than folded into a summary.
 */
async function reportMigration(
  report: LegacyMigrationReport,
  output: vscode.LogOutputChannel
): Promise<void> {
  if (!report.legacyInstallationFound) {
    return;
  }
  const manual = migrationManualSteps(report);
  if (report.legacyExtensionInstalled) {
    void vscode.window.showWarningMessage(
      "Claude Account Guard is still installed alongside Claude Workspace Accounts. Both set the "
      + "same global claudeCode.claudeProcessWrapper setting, so they will overwrite each other "
      + "and one of them will stop applying per-workspace accounts. Uninstall Claude Account "
      + "Guard, then reload the window.",
      "Show Extensions"
    ).then((choice) => choice === "Show Extensions"
      ? vscode.commands.executeCommand(
          "workbench.extensions.search",
          "ResonanceLattice-Semanticus"
        )
      : undefined);
  }
  if (report.failures.length > 0) {
    output.error(`Migration left ${report.failures.length} item(s) unfinished.`);
    // A blocked migration is a different message from a partial one. Nothing was repointed, the old
    // installation is still the one Claude Code launches through, and the old support directory is
    // the only complete copy of the user's accounts — so it must not read as "mostly fine".
    void vscode.window.showWarningMessage(
      report.blockedBy
        ? "Claude Workspace Accounts stopped migrating your previous installation before changing "
          + "anything, because it could not confirm your accounts and workspace bindings had been "
          + `copied (${report.blockedBy}). Claude Account Guard is still the version in charge, `
          + "nothing was deleted, and Claude Code keeps working. Do not delete "
          + `${report.legacyRoot ?? "your previous support directory"} yet.`
        : `Claude Workspace Accounts could not finish migrating your previous installation: `
          + `${report.failures.length} item${report.failures.length === 1 ? "" : "s"} need your `
          + "attention. Nothing was deleted, and Claude Code keeps working.",
      "Show Details",
      "Show Diagnostics"
    ).then(async (choice) => {
      if (choice === "Show Details") {
        const details = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `# Claude Workspace Accounts — upgrade report\n\n`
            + `Your previous installation is still in place at `
            + `${report.legacyRoot ?? "its original location"}; nothing was deleted.\n\n`
            + (report.blockedBy
              ? `**The migration stopped before changing anything: ${report.blockedBy}.** The `
                + "wrapper setting, the settings namespace and your Claude account directories were "
                + "left exactly as Claude Account Guard had them, so nothing is half-moved.\n\n"
              : "")
            + `## Still to do by hand\n\n${manual.map((step) => `- ${step}`).join("\n") || "- Nothing."}\n\n`
            + `## Every step\n\n${report.steps.map((step) =>
              `- **${step.artifact}** — ${step.state}${step.detail ? `: ${step.detail}` : ""}`
            ).join("\n")}\n`
        });
        await vscode.window.showTextDocument(details, { preview: true });
      } else if (choice === "Show Diagnostics") {
        await vscode.commands.executeCommand("claudeAccounts.diagnostics");
      }
    });
    return;
  }
  if (report.changed) {
    void vscode.window.showInformationMessage(
      "Claude Workspace Accounts carried your accounts, workspace bindings, and local usage "
      + "over from Claude Account Guard. Reload the window so Claude Code launches through the "
      + "renamed wrapper. Your previous data was copied, not moved, so nothing was deleted.",
      "Reload Window",
      "Show Details"
    ).then(async (choice) => {
      if (choice === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else if (choice === "Show Details") {
        const details = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `# Claude Workspace Accounts — upgrade report\n\n${report.steps.map((step) =>
            `- **${step.artifact}** — ${step.state}${step.detail ? `: ${step.detail}` : ""}`
          ).join("\n")}\n${manual.length > 0
            ? `\n## Optional cleanup\n\n${manual.map((step) => `- ${step}`).join("\n")}\n`
            : ""}`
        });
        await vscode.window.showTextDocument(details, { preview: true });
      }
    });
  }
}

/** Every command id the manifest contributes, read from the manifest rather than duplicated here. */
function contributedCommandIds(context: vscode.ExtensionContext): string[] {
  const contributes = (context.extension.packageJSON as {
    contributes?: { commands?: { command?: unknown }[] };
  }).contributes;
  return (contributes?.commands ?? [])
    .map((entry) => entry.command)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Activate just enough to explain a registry that cannot be loaded, and to undo the integration.
 *
 * `ProfileRegistry` refuses to overwrite a registry it cannot validate, because it may be the only
 * copy of somebody's bindings — and activation used to rethrow at that point. That left the whole
 * command surface, the diagnostics report, the status bar and the repair UI unregistered while
 * `claudeCode.claudeProcessWrapper` still pointed at the wrapper. The wrapper then fails open to the
 * ambient account, so bindings silently stop applying, and there is nothing left in the product able
 * to say so or to undo it: a global setting the user can no longer manage from the UI, which is the
 * exact defect this extension exists to prevent. So activation degrades instead of dying.
 *
 * Two things genuinely work without a registry: saying what is wrong, and detaching Claude Code.
 * Every other contributed command is registered too, so invoking one explains the state rather than
 * failing with "command not found".
 */
async function activateRegistryRepairOnly(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  paths: ReturnType<typeof resolveSupportPaths>,
  failure: unknown,
  migration: LegacyMigrationReport
): Promise<void> {
  const detail = failure instanceof Error ? failure.message : "unknown error";
  const explanation =
    "Claude Workspace Accounts is running in repair mode: its shared registry at "
    + `${paths.registry} could not be loaded (${detail}), so per-workspace accounts are not being `
    + "applied. The registry was preserved exactly as it is, in case it is the only copy of your "
    + "accounts and bindings. Repair or move it aside and reload the window.";
  output.error(explanation);

  const configuredWrapper = (): string | undefined => {
    const value = vscode.workspace
      .getConfiguration("claudeCode")
      .get<string>("claudeProcessWrapper");
    return value && value.trim() ? value : undefined;
  };

  const showDiagnostics = async (): Promise<void> => {
    const wrapper = configuredWrapper();
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `# Claude Workspace Accounts — repair mode\n\n${explanation}\n\n`
        + `## State\n\n`
        + `- Registry: \`${paths.registry}\`\n`
        + `- Why it could not be loaded: ${detail}\n`
        + `- Support directory: \`${paths.root}\`\n`
        + `- Claude Code wrapper setting: ${wrapper ? `\`${wrapper}\`` : "not set"}\n`
        + `- Wrapper belongs to this extension: ${isManagedWrapperPath(wrapper) ? "yes" : "no"}\n\n`
        + `## What is and is not happening\n\n`
        + "- Claude Code still launches. The wrapper fails open, so it launches on whichever "
        + "account is ambient.\n"
        + "- No workspace binding is being applied, and no usage is being collected.\n"
        + "- Nothing has been deleted, and the registry has not been rewritten.\n\n"
        + `## Upgrade from Claude Account Guard\n\n`
        + `- Previous installation found: ${migration.legacyInstallationFound ? "yes" : "no"}\n`
        + (migration.blockedBy ? `- Migration halted because: ${migration.blockedBy}\n` : "")
        + (migration.legacyRoot ? `- Previous support directory: \`${migration.legacyRoot}\`\n` : "")
        + `${migration.steps.map((step) =>
          `- **${step.artifact}** — ${step.state}${step.detail ? `: ${step.detail}` : ""}`
        ).join("\n")}\n\n`
        + `## How to get out of repair mode\n\n`
        + `1. Open \`${paths.registry}\` and fix it, or rename it so a fresh one is created.\n`
        + "2. Reload the window.\n"
        + "3. If you would rather Claude Code stopped launching through this extension entirely, "
        + "run \"Claude Workspace Accounts: Disconnect From Claude Code\".\n"
        + `${migrationManualSteps(migration).map((step) => `- ${step}`).join("\n")}\n`
    });
    await vscode.window.showTextDocument(document, { preview: true });
  };

  /**
   * Clear the global wrapper setting without the registry.
   *
   * `WrapperIntegrationService.disable` reads the registry to restore a chained upstream wrapper,
   * which is exactly what is unavailable here, so this does the one thing that is always safe:
   * remove our own wrapper and leave anybody else's alone.
   */
  const disconnect = async (): Promise<void> => {
    const wrapper = configuredWrapper();
    if (!wrapper) {
      void vscode.window.showInformationMessage(
        "Claude Code is not configured to launch through Claude Workspace Accounts."
      );
      return;
    }
    if (!isManagedWrapperPath(wrapper)) {
      void vscode.window.showWarningMessage(
        `claudeCode.claudeProcessWrapper names ${wrapper}, which is not a wrapper this extension `
        + "installed, so it was left alone."
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove ${wrapper} from claudeCode.claudeProcessWrapper? Claude Code will launch directly `
      + "afterwards, and per-workspace accounts will not be applied until you reconnect.",
      { modal: true },
      "Disconnect"
    );
    if (choice !== "Disconnect") {
      return;
    }
    await vscode.workspace
      .getConfiguration("claudeCode")
      .update("claudeProcessWrapper", undefined, vscode.ConfigurationTarget.Global);
    output.info("Repair mode: cleared claudeCode.claudeProcessWrapper.");
    void vscode.window.showInformationMessage(
      "Claude Code no longer launches through Claude Workspace Accounts. Reload the window to "
      + "finish."
    );
  };

  const handlers = new Map<string, () => Promise<void>>([
    ["claudeAccounts.diagnostics", showDiagnostics],
    ["claudeAccounts.disableWrapper", disconnect]
  ]);
  for (const id of new Set(contributedCommandIds(context))) {
    const handler = handlers.get(id) ?? (async (): Promise<void> => {
      const choice = await vscode.window.showErrorMessage(
        explanation,
        "Show Diagnostics",
        "Reveal Registry"
      );
      if (choice === "Show Diagnostics") {
        await showDiagnostics();
      } else if (choice === "Reveal Registry") {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(paths.registry));
      }
    });
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => handler().catch((error: unknown) => output.error(
        `${id} failed in repair mode: ${error instanceof Error ? error.message : "unknown error"}`
      )))
    );
  }

  // Visible rather than only announced: a modal the user dismissed is not a diagnosis they can
  // come back to.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = "$(error) Claude Accounts";
  item.tooltip = explanation;
  item.command = "claudeAccounts.diagnostics";
  item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  item.show();
  context.subscriptions.push(item);

  void vscode.window.showErrorMessage(
    explanation,
    "Show Diagnostics",
    "Reveal Registry",
    "Disconnect From Claude Code"
  ).then(async (choice) => {
    if (choice === "Show Diagnostics") {
      await showDiagnostics();
    } else if (choice === "Reveal Registry") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(paths.registry));
    } else if (choice === "Disconnect From Claude Code") {
      await disconnect();
    }
  });

  await reportMigration(migration, output).catch((error: unknown) => output.error(
    `Upgrade reporting failed: ${error instanceof Error ? error.message : "unknown error"}`
  ));
  output.info("Claude Workspace Accounts is active in repair mode only.");
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Claude Workspace Accounts", { log: true });
  context.subscriptions.push(output);
  output.info("Activating Claude Workspace Accounts.");
  if (process.platform !== "win32" || vscode.env.remoteName) {
    const environment = vscode.env.remoteName
      ? `VS Code Remote (${vscode.env.remoteName})`
      : process.platform;
    output.warn(`Workspace Accounts is inactive in unsupported environment: ${environment}.`);
    void vscode.window.showWarningMessage(
      `Claude Workspace Accounts v1 supports local Windows VS Code only. No wrapper, profile, lock, or telemetry changes were made in ${environment}.`
    );
    return;
  }

  const paths = resolveSupportPaths({ fallbackRoot: context.globalStorageUri.fsPath });

  // First, before anything reads support state. This extension was published under a different
  // `name` until 0.2.0, so an upgrading user has a fresh install pointed at a support directory,
  // a settings namespace and a wrapper executable that did not exist a moment ago. Reading the
  // registry before migrating would create an empty one and present the user with no accounts.
  // It never throws: a failed migration must not stop activation or block a Claude launch.
  const migration = await migrateLegacyInstallation({
    root: paths.root,
    legacyRoot: resolveLegacySupportRoot(process.env.LOCALAPPDATA),
    wrapperPath: path.join(paths.wrapperDirectory, WRAPPER_EXE),
    statusLineBridgePath: path.join(paths.wrapperDirectory, STATUSLINE_EXE),
    host: migrationHost()
  });
  output.info(summarizeMigration(migration));
  for (const step of migration.steps) {
    const line = `Upgrade · ${step.artifact}: ${step.state}${step.detail ? ` — ${step.detail}` : ""}`;
    if (step.state === "failed") {
      output.error(line);
    } else {
      output.info(line);
    }
  }

  const registry = new ProfileRegistry(paths);
  try {
    await registry.initialize();
  } catch (error) {
    // Deliberately not rethrown. Everything below needs a registry, but the user needs a way to
    // find out why nothing works and a way to detach Claude Code far more than the extension host
    // needs an activation error.
    await activateRegistryRepairOnly(context, output, paths, error, migration);
    return;
  }

  const repository = new UsageRepository(paths.database);
  repository.mirrorRegistry(await registry.read());
  repository.applyRetention(
    vscode.workspace.getConfiguration("claudeAccounts")
      .get<number>("telemetry.retentionDays", 30)
  );

  const wrapperIntegration = new WrapperIntegrationService(context, registry);
  // Support files are copied outside the extension directory but nothing about how Claude
  // Code launches changes here: the global wrapper setting is written only after explicit
  // consent, and only when an enforced lock or local usage actually needs it.
  const supportFiles = await wrapperIntegration.installSupportFiles();
  for (const failure of supportFiles.failures) {
    // Refreshing is best-effort. The already-installed copy keeps launches working, and the
    // next activation with no Claude running will pick the new build up.
    output.warn(`Could not refresh ${failure.name}: ${failure.reason}`);
  }

  // Assigned once the collector plumbing further down exists. Commands must be able to
  // restart collection the moment a profile is registered, deleted, or switched, instead
  // of waiting for the next window reload.
  let reconcileCollection: () => Promise<void> = async () => undefined;
  const runtimeDetector = new RuntimeProfileDetector();
  const binaryResolver = new ClaudeBinaryResolver();
  const authVerifier = new AuthVerifier(binaryResolver);
  const lockService = new WorkspaceLockService(registry);
  const updateWorkspaceKey = async (): Promise<void> => {
    const activeWorkspace = await lockService.currentWorkspace();
    if (activeWorkspace) {
      process.env.CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY = workspaceHash(
        activeWorkspace.uri.toString()
      );
    } else {
      delete process.env.CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY;
    }
  };
  await updateWorkspaceKey();
  const statusLineBridge = new StatusLineBridgeService(supportFiles.statusLineBridgePath);
  const dashboard = new DashboardProvider(
    context,
    registry,
    repository,
    runtimeDetector,
    lockService,
    (message) => output.warn(message)
  );
  const describeIntegration = (): string => {
    const configured = wrapperIntegration.configuredWrapper();
    if (!configured) {
      return "Not connected to Claude Code — per-workspace accounts are not applied";
    }
    return wrapperIntegration.isGuardWrapper(configured)
      ? "Claude Code launches through Workspace Accounts"
      : `Another tool's wrapper is configured (${configured})`;
  };
  const statusBar = new StatusBarController(
    registry,
    runtimeDetector,
    authVerifier,
    lockService,
    repository,
    () => void dashboard.refresh(),
    describeIntegration,
    (message) => output.warn(message)
  );
  const diagnostics = new DiagnosticsProvider(
    context,
    registry,
    runtimeDetector,
    lockService,
    repository,
    binaryResolver,
    statusBar
  );
  const commands = new CommandController(
    context,
    registry,
    runtimeDetector,
    authVerifier,
    lockService,
    binaryResolver,
    statusLineBridge,
    repository,
    statusBar,
    dashboard,
    diagnostics,
    wrapperIntegration,
    () => reconcileCollection(),
    (message) => output.warn(message)
  );
  commands.register();
  dashboard.useController(commands);
  diagnostics.useController(commands);

  // Self-healing: a global setting pointing at a wrapper that no longer exists breaks
  // every Claude Code launch, which is exactly what uninstalling an earlier release left
  // behind. Repair or clear it before anything else runs.
  try {
    await commands.repairIntegration();
  } catch (error) {
    output.error(
      `Wrapper reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
  // Restore the integration only for users who already consented to it.
  const integrationOutcome = await commands.ensureIntegration(
    "Workspace Accounts needs Claude Code to launch through it.",
    { userInitiated: false, allowPrompt: false }
  );
  output.info(`Claude Code integration: ${integrationOutcome}.`);
  context.subscriptions.push(statusBar, dashboard);
  statusBar.start();

  let collector: TelemetryCollector | undefined;
  let collectorProfileId: string | undefined;
  /**
   * Start, stop, or re-target the local collector for whichever profile is active *now*.
   *
   * The runtime profile is re-detected on every call. Closing over a snapshot taken at
   * activation meant that registering the account this window uses — the normal first
   * step — left the collector stopped until the extension host happened to reload, so
   * every usage table stayed empty and nothing said why.
   */
  const reconcileCollector = async (): Promise<void> => {
    const enabled = vscode.workspace.getConfiguration("claudeAccounts")
      .get<boolean>("telemetry.enabled", true);
    const collectWorkspacePath = vscode.workspace.getConfiguration("claudeAccounts")
      .get<boolean>("privacy.collectWorkspacePath", false);
    const currentRegistry = await registry.read();
    if (currentRegistry.integration.telemetryEnabled !== enabled
      || currentRegistry.integration.collectWorkspacePath !== collectWorkspacePath) {
      // A field patch, applied inside the registry's lock: writing the whole integration
      // object read a moment ago discards whatever another window recorded meanwhile.
      await registry.patchIntegration({ telemetryEnabled: enabled, collectWorkspacePath });
    }
    // The collector must serve the account the wrapper will actually launch. The wrapper
    // looks up the collector registration for the *bound* account, so choosing by ambient
    // config dir alone left a bound workspace requesting a registration that never existed —
    // with no way for the user to fix it, reload included.
    const lock = await lockService.currentLock();
    const boundProfile = lock && lock.mode !== "off"
      ? currentRegistry.profiles.find((profile) => profile.id === lock.profileId)
      : undefined;
    const activeProfile = boundProfile
      ?? runtimeDetector.detect(currentRegistry.profiles).profile;
    const target = enabled ? activeProfile : undefined;
    if (collector && (!target || collectorProfileId !== target.id)) {
      await collector.dispose();
      collector = undefined;
      collectorProfileId = undefined;
      if (runtimeServices) {
        runtimeServices.collector = undefined;
      }
      output.info("Local usage collector stopped.");
    }
    if (!target) {
      return;
    }
    if (!collector) {
      const candidate = new TelemetryCollector(registry, repository, () => {
        void statusBar.refresh();
        void dashboard.refresh();
      });
      try {
        const registration = await candidate.start(target);
        collector = candidate;
        collectorProfileId = target.id;
        if (runtimeServices) {
          runtimeServices.collector = collector;
        }
        output.info(
          `Local collector listening on loopback port ${registration.port} for ${target.displayName}.`
        );
      } catch (error) {
        await candidate.dispose().catch((failure: unknown) => output.error(
          `Local collector cleanup failed: ${failure instanceof Error ? failure.message : "unknown error"}`
        ));
        output.error(`Local collector failed: ${error instanceof Error ? error.message : "unknown error"}`);
        void vscode.window.showWarningMessage(
          "Local usage collection could not start: Workspace Accounts could not bind a loopback port for its collector. Quota snapshots from Claude's status line still work, and account switching and workspace locks are unaffected. Reload the window to retry.",
          "Reload Window",
          "Show Diagnostics"
        ).then((choice) => choice === "Reload Window"
          ? vscode.commands.executeCommand("workbench.action.reloadWindow")
          : choice === "Show Diagnostics"
            ? vscode.commands.executeCommand("claudeAccounts.diagnostics")
            : undefined);
      }
    }
  };
  reconcileCollection = reconcileCollector;
  await reconcileCollector();

  const initial = await statusBar.refresh(true);
  if (initial?.requiredProfile && !initial.requiredProfile.expectedIdentity) {
    // The account is applied either way; confirming its identity is what lets Workspace
    // Accounts notice later that the wrong Claude identity answered.
    void vscode.window.showInformationMessage(
      `This workspace uses ${initial.requiredProfile.displayName}. Confirm its Claude identity once so Workspace Accounts can warn you if that account changes.`,
      "Confirm Identity",
      "Not Now"
    ).then((choice) => choice === "Confirm Identity"
      ? vscode.commands.executeCommand("claudeAccounts.verifyAccount")
      : undefined);
  }

  const refresh = () => {
    void updateWorkspaceKey();
    statusBar.updateVisibility();
    void statusBar.refresh();
    void dashboard.refresh();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refresh();
      void reconcileCollector().catch((error: unknown) => output.error(
        `Local collection could not be reconciled after a workspace change: ${error instanceof Error ? error.message : "unknown error"}`
      ));
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("claudeAccounts")
        || event.affectsConfiguration("claudeCode.claudeProcessWrapper")) {
        repository.applyRetention(
          vscode.workspace.getConfiguration("claudeAccounts")
            .get<number>("telemetry.retentionDays", 30)
        );
        if (event.affectsConfiguration("claudeAccounts.telemetry.enabled")
          || event.affectsConfiguration("claudeAccounts.privacy.collectWorkspacePath")) {
          void reconcileCollector().catch((error: unknown) => output.error(
            `Local collection could not be reconciled after a settings change: ${error instanceof Error ? error.message : "unknown error"}`
          ));
        }
        refresh();
      }
    })
  );

  runtimeServices = { collector, repository };
  // Deferred to here rather than reported at the point of migration: the useful buttons —
  // diagnostics, reload — only exist once commands are registered.
  await reportMigration(migration, output).catch((error: unknown) => output.error(
    `Upgrade reporting failed: ${error instanceof Error ? error.message : "unknown error"}`
  ));
  // Explains the extension once, and afterwards only speaks up when this window's Claude
  // account is unregistered — the state in which nothing this extension shows can work.
  // Suppressed for an upgrade that had something to say: two modals at once is noise.
  if (!migration.changed && migration.failures.length === 0) {
    void commands.firstRun().catch((error: unknown) => output.error(
      `First-run guidance failed: ${error instanceof Error ? error.message : "unknown error"}`
    ));
  }
  output.info("Claude Workspace Accounts is active.");
}

export async function deactivate(): Promise<void> {
  const services = runtimeServices;
  if (services) {
    await services.collector?.dispose();
    services.repository.close();
  }
  runtimeServices = undefined;
}
