import * as vscode from "vscode";
import { ClaudeBinaryResolver, AuthVerifier } from "./auth/authVerifier.js";
import { CommandController } from "./commands/commandController.js";
import { workspaceHash } from "./core/paths.js";
import { DashboardProvider } from "./dashboard/dashboardProvider.js";
import { DiagnosticsProvider } from "./diagnostics/diagnosticsProvider.js";
import { WorkspaceLockService } from "./locks/workspaceLockService.js";
import { ProfileRegistry, resolveSupportPaths } from "./profiles/registryStore.js";
import { RuntimeProfileDetector } from "./profiles/runtimeProfileDetector.js";
import { UsageRepository } from "./storage/usageRepository.js";
import { StatusBarController } from "./statusbar/statusBarController.js";
import { StatusLineBridgeService } from "./telemetry/statusLineBridgeService.js";
import { TelemetryCollector } from "./telemetry/telemetryCollector.js";
import { WrapperIntegrationService } from "./wrapper/wrapperIntegrationService.js";

interface RuntimeServices {
  collector?: TelemetryCollector;
  repository: UsageRepository;
}

let runtimeServices: RuntimeServices | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Claude Account Guard", { log: true });
  context.subscriptions.push(output);
  output.info("Activating Claude Account Guard.");
  if (process.platform !== "win32" || vscode.env.remoteName) {
    const environment = vscode.env.remoteName
      ? `VS Code Remote (${vscode.env.remoteName})`
      : process.platform;
    output.warn(`Account Guard is inactive in unsupported environment: ${environment}.`);
    void vscode.window.showWarningMessage(
      `Claude Account Guard v1 supports local Windows VS Code only. No wrapper, profile, lock, or telemetry changes were made in ${environment}.`
    );
    return;
  }

  const paths = resolveSupportPaths({ fallbackRoot: context.globalStorageUri.fsPath });
  const registry = new ProfileRegistry(paths);
  try {
    await registry.initialize();
  } catch (error) {
    output.error(
      `Shared registry validation failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
    const choice = await vscode.window.showErrorMessage(
      "Claude Account Guard preserved an invalid shared registry and guarded Claude launches remain blocked. Restore or repair the registry before continuing.",
      "Reveal Registry"
    );
    if (choice === "Reveal Registry") {
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(paths.registry));
    }
    throw error;
  }

  const repository = new UsageRepository(paths.database);
  repository.mirrorRegistry(await registry.read());
  repository.applyRetention(
    vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<number>("telemetry.retentionDays", 30)
  );

  const wrapperIntegration = new WrapperIntegrationService(context, registry);
  // Support files are copied outside the extension directory but nothing about how Claude
  // Code launches changes here: the global wrapper setting is written only after explicit
  // consent, and only when an enforced lock or local usage actually needs it.
  const supportFiles = await wrapperIntegration.installSupportFiles();

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
      process.env.CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY = workspaceHash(
        activeWorkspace.uri.toString()
      );
    } else {
      delete process.env.CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY;
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
      ? "Claude Code launches through Account Guard"
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
    "Account Guard needs Claude Code to launch through it.",
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
    const enabled = vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<boolean>("telemetry.enabled", true);
    const collectWorkspacePath = vscode.workspace.getConfiguration("claudeAccountGuard")
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
          "Local usage collection could not start: Account Guard could not bind a loopback port for its collector. Quota snapshots from Claude's status line still work, and account switching and workspace locks are unaffected. Reload the window to retry.",
          "Reload Window",
          "Show Diagnostics"
        ).then((choice) => choice === "Reload Window"
          ? vscode.commands.executeCommand("workbench.action.reloadWindow")
          : choice === "Show Diagnostics"
            ? vscode.commands.executeCommand("claudeAccountGuard.diagnostics")
            : undefined);
      }
    }
  };
  reconcileCollection = reconcileCollector;
  await reconcileCollector();

  const initial = await statusBar.refresh(true);
  if (initial?.requiredProfile && !initial.requiredProfile.expectedIdentity) {
    // The account is applied either way; confirming its identity is what lets Account
    // Guard notice later that the wrong Claude identity answered.
    void vscode.window.showInformationMessage(
      `This workspace uses ${initial.requiredProfile.displayName}. Confirm its Claude identity once so Account Guard can warn you if that account changes.`,
      "Confirm Identity",
      "Not Now"
    ).then((choice) => choice === "Confirm Identity"
      ? vscode.commands.executeCommand("claudeAccountGuard.verifyAccount")
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
      if (event.affectsConfiguration("claudeAccountGuard")
        || event.affectsConfiguration("claudeCode.claudeProcessWrapper")) {
        repository.applyRetention(
          vscode.workspace.getConfiguration("claudeAccountGuard")
            .get<number>("telemetry.retentionDays", 30)
        );
        if (event.affectsConfiguration("claudeAccountGuard.telemetry.enabled")
          || event.affectsConfiguration("claudeAccountGuard.privacy.collectWorkspacePath")) {
          void reconcileCollector().catch((error: unknown) => output.error(
            `Local collection could not be reconciled after a settings change: ${error instanceof Error ? error.message : "unknown error"}`
          ));
        }
        refresh();
      }
    })
  );

  runtimeServices = { collector, repository };
  // Explains the extension once, and afterwards only speaks up when this window's Claude
  // account is unregistered — the state in which nothing this extension shows can work.
  void commands.firstRun().catch((error: unknown) => output.error(
    `First-run guidance failed: ${error instanceof Error ? error.message : "unknown error"}`
  ));
  output.info("Claude Account Guard is active.");
}

export async function deactivate(): Promise<void> {
  const services = runtimeServices;
  if (services) {
    await services.collector?.dispose();
    services.repository.close();
  }
  runtimeServices = undefined;
}
