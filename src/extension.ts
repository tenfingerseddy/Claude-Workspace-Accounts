import * as vscode from "vscode";
import { ClaudeBinaryResolver, AuthVerifier } from "./auth/authVerifier.js";
import { CommandController } from "./commands/commandController.js";
import { compareIdentity } from "./core/identity.js";
import { workspaceHash } from "./core/paths.js";
import { DashboardProvider } from "./dashboard/dashboardProvider.js";
import { DiagnosticsProvider } from "./diagnostics/diagnosticsProvider.js";
import { IsolatedWindowLauncher } from "./launcher/isolatedWindowLauncher.js";
import { LaunchHandshakeService } from "./launcher/launchHandshakeService.js";
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

  const paths = resolveSupportPaths(context.globalStorageUri.fsPath);
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
  const supportFiles = await wrapperIntegration.installSupportFiles();
  let wrapperConflict = false;
  let wrapperFailure = false;
  try {
    const integration = await wrapperIntegration.configure(supportFiles.wrapperPath);
    wrapperConflict = integration === "conflict";
  } catch (error) {
    wrapperFailure = true;
    output.error(`Wrapper integration failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }

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
  const handshakes = new LaunchHandshakeService(paths);
  const launcher = new IsolatedWindowLauncher(handshakes);
  const statusLineBridge = new StatusLineBridgeService(supportFiles.statusLineBridgePath);
  const dashboard = new DashboardProvider(
    context,
    registry,
    repository,
    runtimeDetector,
    lockService
  );
  const statusBar = new StatusBarController(
    registry,
    runtimeDetector,
    authVerifier,
    lockService,
    repository,
    () => void dashboard.refresh()
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
    launcher,
    statusLineBridge,
    repository,
    statusBar,
    dashboard,
    diagnostics
  );
  commands.register();
  if (wrapperConflict) {
    const choice = await vscode.window.showWarningMessage(
      "Claude Code already uses another process wrapper. Account Guard can chain it after the workspace/account preflight.",
      "Use Account Guard Wrapper",
      "Open Diagnostics"
    );
    if (choice === "Use Account Guard Wrapper") {
      await wrapperIntegration.resolveConflict(supportFiles.wrapperPath);
    } else if (choice === "Open Diagnostics") {
      await diagnostics.show();
    }
  } else if (wrapperFailure) {
    const choice = await vscode.window.showWarningMessage(
      "Claude Account Guard could not configure the Claude process wrapper. Workspace locks are visible but cannot be fail-closed until this is resolved.",
      "Open Diagnostics"
    );
    if (choice === "Open Diagnostics") {
      await diagnostics.show();
    }
  }
  context.subscriptions.push(statusBar, dashboard);
  statusBar.start();

  const document = await registry.read();
  const runtime = runtimeDetector.detect(document.profiles);
  let collector: TelemetryCollector | undefined;
  const reconcileCollector = async (): Promise<void> => {
    const enabled = vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<boolean>("telemetry.enabled", true);
    const collectWorkspacePath = vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<boolean>("privacy.collectWorkspacePath", false);
    const currentRegistry = await registry.read();
    if (currentRegistry.integration.telemetryEnabled !== enabled
      || currentRegistry.integration.collectWorkspacePath !== collectWorkspacePath) {
      await registry.setIntegration({
        ...currentRegistry.integration,
        telemetryEnabled: enabled,
        collectWorkspacePath
      });
    }
    if (!runtime.profile || !enabled) {
      if (collector) {
        await collector.dispose();
        collector = undefined;
        if (runtimeServices) {
          runtimeServices.collector = undefined;
        }
        output.info("Local usage collector stopped.");
      }
      return;
    }
    if (!collector) {
      const candidate = new TelemetryCollector(registry, repository, () => {
        void statusBar.refresh();
        void dashboard.refresh();
      });
      try {
        const registration = await candidate.start(runtime.profile);
        collector = candidate;
        if (runtimeServices) {
          runtimeServices.collector = collector;
        }
        output.info(`Local collector listening on loopback port ${registration.port}.`);
      } catch (error) {
        await candidate.dispose().catch(() => undefined);
        output.error(`Local collector failed: ${error instanceof Error ? error.message : "unknown error"}`);
        void vscode.window.showWarningMessage(
          "Local Claude usage collection is unavailable. Account isolation and workspace locks remain active."
        );
      }
    }
  };
  await reconcileCollector();

  const initial = await statusBar.refresh(true);
  if (initial?.runtime.profile && !initial.runtime.profile.expectedIdentity) {
    void vscode.window.showInformationMessage(
      `${initial.runtime.profile.displayName} needs a confirmed Claude identity before it can be used by enforced workspace locks.`,
      "Sign In",
      "Verify Account"
    ).then((choice) => choice === "Sign In"
      ? vscode.commands.executeCommand("claudeAccountGuard.login")
      : choice === "Verify Account"
        ? vscode.commands.executeCommand("claudeAccountGuard.verifyAccount")
        : undefined);
  }

  if (process.env.CLAUDE_ACCOUNT_GUARD_LAUNCH_ID) {
    const profile = initial?.runtime.profile;
    const verification = initial?.verification;
    const identityMatch = profile && verification
      ? compareIdentity(profile.expectedIdentity, verification)
      : "unverifiable";
    const lockCompatible = !initial?.lock
      || initial.lock.mode !== "enforce"
      || initial.lock.profileId === profile?.id;
    const ready = Boolean(
      profile
      && verification?.state === "signed_in"
      && identityMatch === "match"
      && lockCompatible
      && initial?.status.kind !== "wrong_account"
    );
    await handshakes.completeFromEnvironment({
      ready,
      profileId: profile?.id,
      workspace: (await lockService.currentWorkspace())?.label,
      detail: ready ? "Runtime profile, identity, and workspace lock agree." : initial?.status.detail
    });
  }

  const refresh = () => {
    void updateWorkspaceKey();
    statusBar.updateVisibility();
    void statusBar.refresh();
    void dashboard.refresh();
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("claudeAccountGuard")
        || event.affectsConfiguration("claudeCode.claudeProcessWrapper")) {
        repository.applyRetention(
          vscode.workspace.getConfiguration("claudeAccountGuard")
            .get<number>("telemetry.retentionDays", 30)
        );
        if (event.affectsConfiguration("claudeAccountGuard.telemetry.enabled")
          || event.affectsConfiguration("claudeAccountGuard.privacy.collectWorkspacePath")) {
          void reconcileCollector();
        }
        refresh();
      }
    })
  );

  runtimeServices = { collector, repository };
  setTimeout(() => void commands.firstRun(), 800);
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
