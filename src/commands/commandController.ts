import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { AuthVerifier, ClaudeBinaryResolver } from "../auth/authVerifier.js";
import { classifyVerification, compareIdentity } from "../core/identity.js";
import { bindingIdentityState } from "../core/statusState.js";
import type {
  AccountProfile,
  AuthVerification,
  CollectionHealth,
  CollectionHealthContext,
  LockMode,
  SharedRegistryDocument,
  WorkspaceLock
} from "../core/models.js";
import {
  normalizeWindowsPath,
  pathContains,
  profileMarker,
  safeProfileId
} from "../core/paths.js";
import type { DashboardProvider } from "../dashboard/dashboardProvider.js";
import type { DiagnosticsProvider } from "../diagnostics/diagnosticsProvider.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import type { StatusBarController } from "../statusbar/statusBarController.js";
import type {
  StatusLineBridgeService,
  StatusLineUninstallResult
} from "../telemetry/statusLineBridgeService.js";
import type { WrapperIntegrationService } from "../wrapper/wrapperIntegrationService.js";
import type {
  BindingChange,
  CollectionDiagnosis,
  MenuAction,
  MenuEntry,
  MenuState,
  StatusLineTeardownPlan,
  TeardownStep,
  TerminalBinding,
  WrapperConsent,
  WrapperState
} from "./uxModel.js";
import {
  buildAccountMenu,
  diagnoseCollection,
  DISABLE_ENVIRONMENT_VARIABLE,
  planFirstRun,
  planStatusLineTeardown,
  planSupportFileRemoval,
  planWrapperConsent,
  requiresBindingCacheInvalidation,
  summarizeTeardown,
  WRAPPER_SETTING_ID
} from "./uxModel.js";

interface ProfileExport {
  schemaVersion: 1;
  exportedAt: string;
  profiles: AccountProfile[];
}

/** Persisted so the consent question is asked once per user, not once per window. */
const CONSENT_STATE_KEY = "wrapper.consent";
const ONBOARDED_STATE_KEY = "onboarding.completed";
const UNREGISTERED_NOTICE_STATE_KEY = "onboarding.unregisteredNotices";
/** Workspaces whose terminal environment Workspace Accounts wrote, so removal can name them. */
const TERMINAL_WORKSPACES_STATE_KEY = "terminal.boundWorkspaces";

export type IntegrationOutcome =
  | "configured"
  | "chained"
  | "already_configured"
  | "declined"
  | "blocked_by_setting"
  | "deferred"
  | "failed";

export class CommandController {
  /** Cached so the synchronous collection diagnosis knows which account is bound here. */
  private lastKnownLock?: WorkspaceLock;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry,
    private readonly runtimeDetector: RuntimeProfileDetector,
    private readonly authVerifier: AuthVerifier,
    private readonly lockService: WorkspaceLockService,
    /** Locates the Claude executable so sign-in can run in a terminal for one account. */
    private readonly binaryResolver: ClaudeBinaryResolver,
    private readonly statusLineBridge: StatusLineBridgeService,
    private readonly repository: UsageRepository,
    private readonly statusBar: StatusBarController,
    private readonly dashboard: DashboardProvider,
    private readonly diagnostics: DiagnosticsProvider,
    private readonly wrapper: WrapperIntegrationService,
    /**
     * Restarts or re-targets local collection for whichever profile is active now.
     * Registering a profile has to take effect immediately, not after a window reload.
     */
    private readonly reconcileCollection: () => Promise<void> = async () => undefined,
    /**
     * Where suppressed failures go. Swallowing them is what made "it does not work and
     * nothing says why" possible, so every catch that cannot surface a dialog logs here.
     */
    private readonly log: (message: string) => void = () => undefined
  ) {}

  /** Record a failure that cannot interrupt the user, with a sanitised reason. */
  private report(context: string, error: unknown): void {
    this.log(`Failed while ${context}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  public register(): void {
    const registrations: Array<[string, (...args: unknown[]) => unknown]> = [
      ["claudeAccounts.openMenu", () => this.openMenu()],
      ["claudeAccounts.configureWrapper", () => this.configureIntegration()],
      ["claudeAccounts.disableWrapper", () => this.disableIntegration()],
      ["claudeAccounts.removeAllData", () => this.removeAllData()],
      ["claudeAccounts.enableUsageCollection", () => this.enableUsageCollection()],
      ["claudeAccounts.openDashboard", () => this.dashboard.open()],
      ["claudeAccounts.addProfile", () => this.addProfile()],
      ["claudeAccounts.registerCurrentProfile", () => this.registerCurrentProfile()],
      // Retained IDs. "switch" and "lock" now mean the same thing — choose the Claude
      // account this workspace uses — because that is the only account switch there is.
      ["claudeAccounts.switchProfile", (profileId) => this.bindWorkspace(
        typeof profileId === "string" ? profileId : undefined
      )],
      ["claudeAccounts.bindWorkspace", (profileId) => this.bindWorkspace(
        typeof profileId === "string" ? profileId : undefined
      )],
      ["claudeAccounts.unbindWorkspace", () => this.unbindWorkspace()],
      ["claudeAccounts.bindTerminal", () => this.bindTerminalEnvironment()],
      ["claudeAccounts.updateExpectedIdentity", () => this.updateExpectedIdentity()],
      ["claudeAccounts.verifyAccount", () => this.verifyAccount()],
      ["claudeAccounts.login", () => this.login()],
      ["claudeAccounts.manageProfiles", () => this.manageProfiles()],
      ["claudeAccounts.diagnostics", () => this.diagnostics.show()],
      ["claudeAccounts.deleteUsageData", () => this.deleteUsageData()],
      ["claudeAccounts.exportUsage", (profileId) => this.exportUsage(
        typeof profileId === "string" ? profileId : undefined
      )]
    ];
    for (const [command, handler] of registrations) {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    }
    void this.updateContextKeys();
  }

  /**
   * One prompt that says what the extension does and names the single next step.
   *
   * The next step is "give this workspace its own Claude account", because that is the
   * product. Earlier releases opened with a choice between registering a directory and
   * creating an isolated profile, which told the user nothing about what they would get.
   */
  public async firstRun(): Promise<void> {
    const document = await this.registry.read();
    const account = await this.effectiveAccount();
    const plan = planFirstRun({
      onboarded: this.context.globalState.get<boolean>(ONBOARDED_STATE_KEY, false),
      hasWorkspace: Boolean(await this.lockService.currentWorkspace()),
      boundToProfile: Boolean(account.bound),
      profileCount: document.profiles.length,
      runtimeRegistered: Boolean(account.runtimeProfile),
      noticeSeenForConfigDir: this.unregisteredNoticeSeen(
        normalizeWindowsPath(account.runtimeConfigDir)
      )
    });
    if (plan === "none") {
      return;
    }
    if (plan === "onboarding") {
      await this.context.globalState.update(ONBOARDED_STATE_KEY, true);
      const choice = await vscode.window.showInformationMessage(
        `Claude Workspace Accounts lets each VS Code workspace use its own Claude account, so switching accounts in one project does not change any other. Pick the account for this workspace and Workspace Accounts does the rest; it will ask once before changing how Claude Code launches, and there is a one-step way to undo everything.`,
        "Choose This Workspace's Account",
        "Not Now"
      );
      if (choice === "Choose This Workspace's Account") {
        await this.bindWorkspace();
      }
      return;
    }
    await this.rememberUnregisteredNotice(normalizeWindowsPath(account.runtimeConfigDir));
    const choice = await vscode.window.showInformationMessage(
      `This workspace uses your default Claude account (${account.runtimeConfigDir}), which Workspace Accounts does not track, so its usage will not appear in the dashboard. Give this workspace a specific account, or add the default one so its usage is collected too.`,
      "Choose This Workspace's Account",
      "Track The Default Account",
      "Not Now"
    );
    if (choice === "Choose This Workspace's Account") {
      await this.bindWorkspace();
    } else if (choice === "Track The Default Account") {
      await this.registerCurrentProfile();
    }
  }

  private async openMenu(): Promise<void> {
    const state = await this.menuState();
    const items = buildAccountMenu(state).map((entry) => this.toQuickPickItem(entry));
    const selected = await vscode.window.showQuickPick(items, {
      title: state.workspaceLabel
        ? `Claude account for ${state.workspaceLabel}`
        : "Claude Workspace Accounts",
      placeHolder: "Every action below says what it will change",
      matchOnDescription: true,
      matchOnDetail: true
    });
    await this.runMenuAction(selected?.action);
  }

  private toQuickPickItem(
    entry: MenuEntry
  ): vscode.QuickPickItem & { action?: MenuAction } {
    if (entry.kind === "separator") {
      return { label: entry.label, kind: vscode.QuickPickItemKind.Separator };
    }
    return {
      label: entry.label,
      description: entry.description,
      detail: entry.detail,
      action: entry.action
    };
  }

  private async runMenuAction(action: MenuAction | undefined): Promise<void> {
    switch (action) {
      case "dashboard": await this.dashboard.open(); break;
      case "registerCurrent": await this.registerCurrentProfile(); break;
      case "addProfile": await this.addProfile(); break;
      case "verify": await this.verifyAccount(); break;
      case "login": await this.login(); break;
      case "manageProfiles": await this.manageProfiles(); break;
      case "bind": await this.bindWorkspace(); break;
      case "unbind": await this.unbindWorkspace(); break;
      case "bindTerminal": await this.bindTerminalEnvironment(); break;
      case "unbindTerminal": await this.unbindTerminalEnvironment(); break;
      case "updateIdentity": await this.updateExpectedIdentity(); break;
      case "enableUsage": await this.enableUsageCollection(); break;
      case "exportUsage": await this.exportUsage(); break;
      case "deleteUsage": await this.deleteUsageData(); break;
      case "configureWrapper": await this.configureIntegration(); break;
      case "disableWrapper": await this.disableIntegration(); break;
      case "removeAllData": await this.removeAllData(); break;
      case "diagnostics": await this.diagnostics.show(); break;
      case undefined: break;
    }
  }

  /**
   * The account Claude Code will actually use in this workspace.
   *
   * The wrapper injects `CLAUDE_CONFIG_DIR` per launch, so a bound workspace uses its bound
   * account regardless of what this VS Code window inherited. Everything user-facing has to
   * agree with the wrapper about that, or the UI is lying.
   */
  public async effectiveAccount(): Promise<{
    profile?: AccountProfile;
    bound?: AccountProfile;
    lock?: WorkspaceLock;
    configDir: string;
    runtimeProfile?: AccountProfile;
    runtimeConfigDir: string;
  }> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    const lock = await this.lockService.currentLock();
    this.lastKnownLock = lock;
    const bound = lock && lock.mode !== "off"
      ? document.profiles.find((profile) => profile.id === lock.profileId)
      : undefined;
    return {
      profile: bound ?? runtime.profile,
      bound,
      lock,
      configDir: bound?.configDir ?? runtime.configDir,
      runtimeProfile: runtime.profile,
      runtimeConfigDir: runtime.configDir
    };
  }

  /** Everything the menu, status bar, and dashboard need in order to explain themselves. */
  public async menuState(): Promise<MenuState> {
    const current = await this.statusBar.refresh();
    const document = await this.registry.read();
    const account = await this.effectiveAccount();
    const workspace = await this.lockService.currentWorkspace();
    return {
      hasWorkspace: Boolean(workspace),
      workspaceLabel: workspace?.label,
      boundProfileName: account.bound?.displayName ?? account.lock?.profileId,
      boundMode: account.lock?.mode,
      accountName: account.profile?.displayName,
      runtimeConfigDir: account.runtimeConfigDir,
      runtimeRegistered: Boolean(account.runtimeProfile),
      identityLabel: current?.verification?.email ?? account.profile?.expectedIdentity?.email,
      authState: current?.verification?.state,
      lastVerifiedLabel: account.profile?.lastVerifiedAt
        ? new Date(account.profile.lastVerifiedAt).toLocaleString()
        : undefined,
      profileCount: document.profiles.length,
      wrapper: {
        state: this.wrapperState(),
        configuredPath: this.wrapper.configuredWrapper(),
        wrapperPath: this.wrapper.wrapperPath
      },
      terminalBinding: this.terminalBindingState(account.bound),
      usageLabel: current?.status.usageLabel,
      identity: account.bound
        ? bindingIdentityState({
            lock: account.lock,
            boundProfile: account.bound,
            verification: current?.verification
          })
        : undefined,
      collection: this.collectionDiagnosis(document, account.profile?.id)
    };
  }

  public wrapperState(): WrapperState {
    const configured = this.wrapper.configuredWrapper();
    if (!configured) {
      return "none";
    }
    return this.wrapper.isGuardWrapper(configured) ? "guard" : "foreign";
  }

  /** Explain, in one place, why the collector is or is not producing data. */
  public collectionDiagnosis(
    document: SharedRegistryDocument,
    selectedProfileId?: string
  ): CollectionDiagnosis {
    const runtime = this.runtimeDetector.detect(document.profiles);
    const lock = this.lastKnownLock;
    const active = lock && lock.mode !== "off"
      ? document.profiles.find((profile) => profile.id === lock.profileId) ?? runtime.profile
      : runtime.profile;
    const selected = selectedProfileId
      ? document.profiles.find((profile) => profile.id === selectedProfileId)
      : active;
    const health = selected ? this.repository.collectorHealth(selected.id) : {};
    const collector = selected ? document.collectors[selected.id] : undefined;
    const detailed = this.detailedHealth(selected?.id);
    return diagnoseCollection({
      telemetryEnabledSetting: vscode.workspace.getConfiguration("claudeAccounts")
        .get<boolean>("telemetry.enabled", true),
      runtimeRegistered: Boolean(active),
      runtimeConfigDir: active?.configDir ?? runtime.configDir,
      selectedIsRuntime: Boolean(selected) && selected?.id === active?.id,
      profileTelemetryEnabled: selected?.telemetryEnabled === true,
      wrapperState: this.wrapperState(),
      foreignOtelExporter: Boolean(
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        || process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
        || process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
        || process.env.OTEL_EXPORTER_OTLP_HEADERS
      ),
      collectorRegistered: Boolean(collector),
      snapshotSeen: Boolean(selected && this.repository.latestStatusSnapshot(selected.id)),
      lastEventAt: health.lastEventAt
        ? new Date(health.lastEventAt).toLocaleString()
        : detailed?.storage.lastSuccessfulWriteAt
          ? new Date(detailed.storage.lastSuccessfulWriteAt).toLocaleString()
          : undefined,
      phase: detailed?.phase,
      phaseDetail: this.phaseDetail(detailed)
    });
  }

  /**
   * Read the telemetry layer's collection-health record.
   *
   * That record is the single source of truth for everything from the collector's socket
   * inwards. Failing to read it must never hide the setup problems this class can still
   * diagnose on its own, so a failure degrades to "no phase reported".
   */
  private detailedHealth(profileId?: string): CollectionHealth | undefined {
    const context: CollectionHealthContext = {
      telemetryEnabled: vscode.workspace.getConfiguration("claudeAccounts")
        .get<boolean>("telemetry.enabled", true),
      runtimeProfileRegistered: Boolean(profileId)
    };
    try {
      return this.repository.collectionHealth(profileId, context);
    } catch {
      return undefined;
    }
  }

  private phaseDetail(health: CollectionHealth | undefined): string | undefined {
    if (!health) {
      return undefined;
    }
    const worst = [...health.requests.rejections, ...health.inbox.quarantines]
      .sort((left, right) => right.count - left.count)[0];
    return health.collector.bindError
      ?? health.collector.heartbeatError
      ?? (worst ? `${worst.reason} (${worst.count})` : undefined)
      ?? health.storage.lastFailureCategory;
  }

  /** Run the single fix a collection diagnosis recommends. */
  public async runCollectionAction(diagnosis: CollectionDiagnosis): Promise<void> {
    switch (diagnosis.action) {
      case "register_runtime":
        await this.registerCurrentProfile();
        break;
      case "open_settings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "claudeAccounts.telemetry.enabled"
        );
        break;
      case "enable_profile_usage":
        await this.enableUsageCollection();
        break;
      case "configure_wrapper":
        await this.configureIntegration();
        break;
      case "select_runtime_profile": {
        const account = await this.effectiveAccount();
        await this.dashboard.open(account.profile?.id);
        break;
      }
      case "reload_window":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      case "none":
        break;
    }
  }

  private unregisteredNoticeSeen(configDirNormalized: string): boolean {
    return this.context.globalState
      .get<string[]>(UNREGISTERED_NOTICE_STATE_KEY, [])
      .includes(configDirNormalized);
  }

  private async rememberUnregisteredNotice(configDirNormalized: string): Promise<void> {
    const seen = this.context.globalState
      .get<string[]>(UNREGISTERED_NOTICE_STATE_KEY, [])
      .filter((value) => value !== configDirNormalized);
    await this.context.globalState.update(
      UNREGISTERED_NOTICE_STATE_KEY,
      [...seen.slice(-9), configDirNormalized]
    );
  }

  private async updateContextKeys(): Promise<void> {
    try {
      const document = await this.registry.read();
      const lock = await this.lockService.currentLock();
      this.lastKnownLock = lock;
      await Promise.all([
        vscode.commands.executeCommand(
          "setContext",
          "claudeAccounts.hasProfiles",
          document.profiles.length > 0
        ),
        vscode.commands.executeCommand(
          "setContext",
          "claudeAccounts.locked",
          Boolean(lock)
        ),
        vscode.commands.executeCommand(
          "setContext",
          "claudeAccounts.wrapperConfigured",
          this.wrapperState() === "guard"
        )
      ]);
    } catch {
      // Context keys only affect palette filtering; a failure must not break a command.
    }
  }

  private consent(): WrapperConsent | undefined {
    return this.context.globalState.get<WrapperConsent>(CONSENT_STATE_KEY);
  }

  private wrapperSummary(): string {
    return `${WRAPPER_SETTING_ID} → ${this.wrapper.wrapperPath}`;
  }

  /**
   * Configure the global wrapper setting, asking for consent the first time.
   *
   * The wrapper is what applies a per-workspace account, so this is not an optional extra;
   * `reason` names the thing the user just asked for, and the prompt names the setting that
   * has to change and how to undo it. Nothing is written when the user declines, and the
   * answer is persisted so no other window asks again.
   */
  public async ensureIntegration(
    reason: string,
    options: { userInitiated: boolean; allowPrompt: boolean }
  ): Promise<IntegrationOutcome> {
    const plan = planWrapperConsent({
      autoConfigure: vscode.workspace.getConfiguration("claudeAccounts")
        .get<boolean>("wrapper.autoConfigure", true),
      storedConsent: this.consent(),
      configuredWrapper: this.wrapper.configuredWrapper(),
      configuredIsGuard: this.wrapperState() === "guard",
      userInitiated: options.userInitiated
    });

    if (plan.kind === "already_configured") {
      // Claiming "connected" while the executable is absent is the exact state that breaks
      // every launch, so the file is checked rather than assumed after installing.
      try {
        await this.wrapper.installSupportFiles();
      } catch (error) {
        this.report("refreshing the Workspace Accounts wrapper files", error);
      }
      if (!(await this.wrapperExecutableExists())) {
        void vscode.window.showWarningMessage(
          `Claude Code is configured to launch through Workspace Accounts, but its wrapper is missing from ${this.wrapper.wrapperPath} — antivirus or a cleanup tool may have removed it. Every Claude Code launch fails until this is repaired.`,
          "Repair Now",
          "Disconnect From Claude Code"
        ).then((choice) => choice === "Repair Now"
          ? this.repairIntegration()
          : choice === "Disconnect From Claude Code"
            ? this.disableIntegration()
            : undefined);
        return "failed";
      }
      return "already_configured";
    }
    if (plan.kind === "blocked_by_setting") {
      if (options.userInitiated) {
        const choice = await vscode.window.showWarningMessage(
          "claudeAccounts.wrapper.autoConfigure is off, so Workspace Accounts will not change how Claude Code launches. Per-workspace accounts and token telemetry stay inactive until you turn it on.",
          "Open Settings"
        );
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "claudeAccounts.wrapper.autoConfigure"
          );
        }
      }
      return "blocked_by_setting";
    }
    if ((plan.kind === "previously_declined" || plan.kind === "ask" || plan.kind === "ask_chain")
      && !options.allowPrompt) {
      return "deferred";
    }

    if (plan.kind === "ask" || plan.kind === "previously_declined") {
      const choice = await vscode.window.showInformationMessage(
        `${reason}\n\nTo do that, Workspace Accounts changes one global VS Code setting that belongs to the Claude Code extension:\n\n${this.wrapperSummary()}\n\nClaude Code then starts through Workspace Accounts, which sets this workspace's account and then launches Claude unchanged. Undo it any time with “Claude Workspace Accounts: Disconnect From Claude Code”, or set ${DISABLE_ENVIRONMENT_VARIABLE}=1 in your environment to bypass it entirely.`,
        { modal: true },
        "Connect To Claude Code",
        "Not Now"
      );
      if (choice !== "Connect To Claude Code") {
        await this.context.globalState.update(CONSENT_STATE_KEY, "declined");
        await this.updateContextKeys();
        return "declined";
      }
    } else if (plan.kind === "ask_chain") {
      const choice = await vscode.window.showWarningMessage(
        `Claude Code already launches through another wrapper:\n\n${plan.foreignWrapper}\n\nWorkspace Accounts can select this workspace's account first and then chain that wrapper, by setting ${WRAPPER_SETTING_ID} to its own wrapper and remembering yours. That wrapper then runs with the environment Workspace Accounts prepared, which includes this workspace's CLAUDE_CONFIG_DIR and, when usage collection is on, the local collector's bearer token. Only chain a wrapper you trust with those. Disconnecting later restores your wrapper.`,
        { modal: true },
        "Chain And Connect",
        "Keep My Wrapper"
      );
      if (choice !== "Chain And Connect") {
        await this.context.globalState.update(CONSENT_STATE_KEY, "declined");
        return "declined";
      }
    }

    try {
      const supportFiles = await this.wrapper.installSupportFiles();
      if (plan.kind === "ask_chain") {
        const chaining = await this.wrapper.resolveConflict(
          supportFiles.wrapperPath,
          plan.foreignWrapper
        );
        if (chaining === "upstream_changed") {
          // The wrapper named in the prompt is no longer the one configured, so consent no
          // longer covers what would be chained. Ask again against the new value rather than
          // handing the environment to a binary the user was never shown.
          void vscode.window.showWarningMessage(
            "Claude Code's process wrapper changed while Workspace Accounts was asking about it, so nothing was configured. Review the new wrapper and connect again."
          );
          return "declined";
        }
        await this.context.globalState.update(CONSENT_STATE_KEY, "granted");
        await this.updateContextKeys();
        void vscode.window.showInformationMessage(
          `Workspace Accounts now runs before your existing wrapper. ${this.wrapperSummary()}`
        );
        return "chained";
      }
      const outcome = await this.wrapper.configure(supportFiles.wrapperPath);
      await this.context.globalState.update(CONSENT_STATE_KEY, "granted");
      await this.updateContextKeys();
      if (outcome === "disabled") {
        return "blocked_by_setting";
      }
      if (outcome === "conflict") {
        return this.ensureIntegration(reason, options);
      }
      if (plan.kind !== "configure") {
        void vscode.window.showInformationMessage(
          `Claude Code now launches through Workspace Accounts, so each workspace gets its own account. Changed setting: ${this.wrapperSummary()}. Reverse it with “Claude Workspace Accounts: Disconnect From Claude Code”.`
        );
      }
      return outcome === "already_configured" ? "already_configured" : "configured";
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Workspace Accounts could not configure ${WRAPPER_SETTING_ID}: ${error instanceof Error ? error.message : "unknown error"}. Per-workspace accounts cannot be applied until this succeeds.`
      );
      return "failed";
    }
  }

  private async wrapperExecutableExists(): Promise<boolean> {
    try {
      await access(this.wrapper.wrapperPath);
      return true;
    } catch {
      return false;
    }
  }

  private async configureIntegration(): Promise<void> {
    const outcome = await this.ensureIntegration(
      "Workspace Accounts is about to connect itself to Claude Code so each workspace can use its own Claude account and local usage can be collected.",
      { userInitiated: true, allowPrompt: true }
    );
    if (outcome === "already_configured") {
      void vscode.window.showInformationMessage(
        `Claude Code already launches through Workspace Accounts. ${this.wrapperSummary()}`
      );
    }
    await this.statusBar.refresh();
    await this.dashboard.refresh();
  }

  /**
   * The supported way out.
   *
   * The wrapper setting is global and deliberately outlives the extension directory, so
   * uninstalling Workspace Accounts without clearing it leaves Claude Code launching through a
   * path that may no longer exist. This command is what makes that recoverable from the UI.
   */
  private async disableIntegration(): Promise<void> {
    const configured = this.wrapper.configuredWrapper();
    if (configured && this.wrapperState() === "foreign") {
      void vscode.window.showInformationMessage(
        `${WRAPPER_SETTING_ID} points at another tool's wrapper (${configured}), so Workspace Accounts left it alone. Claude Code does not launch through Workspace Accounts.`
      );
      return;
    }
    const document = await this.registry.read();
    const bindings = document.workspaceLocks.filter((lock) => lock.mode !== "off").length;
    const confirmed = await vscode.window.showWarningMessage(
      `Disconnect Claude Code from Workspace Accounts?\n\nThis clears the global setting ${WRAPPER_SETTING_ID}${configured ? ` (currently ${configured})` : ""}, or restores the third-party wrapper Workspace Accounts chained.\n\n${bindings > 0 ? `${bindings} workspace${bindings === 1 ? "" : "s"} currently choose their own Claude account. They will all go back to your default account` : "Per-workspace Claude accounts stop being applied"}, and token telemetry stops. Accounts, bindings, and collected usage are kept, so reconnecting restores them.`,
      { modal: true },
      "Disconnect Claude Code"
    );
    if (confirmed !== "Disconnect Claude Code") {
      return;
    }
    const outcome = await this.wrapper.disable();
    // Remember the refusal so no later window silently reconfigures the setting.
    await this.context.globalState.update(CONSENT_STATE_KEY, "declined");
    await this.updateContextKeys();
    await this.statusBar.refresh();
    await this.dashboard.refresh();
    const message = outcome === "restored_upstream"
      ? `${WRAPPER_SETTING_ID} was restored to the wrapper that was configured before Workspace Accounts. Reload the window so Claude Code picks it up.`
      : outcome === "cleared"
        ? `${WRAPPER_SETTING_ID} was cleared. Every workspace uses your default Claude account again after a reload.`
        : `${WRAPPER_SETTING_ID} was already unset, so nothing changed. Claude Code launches directly.`;
    const actions = outcome === "not_configured"
      ? ["Remove Workspace Accounts Data…"]
      : ["Reload Window", "Remove Workspace Accounts Data…"];
    const choice = await vscode.window.showInformationMessage(message, ...actions);
    if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } else if (choice === "Remove Workspace Accounts Data…") {
      await this.removeAllData();
    }
  }

  /**
   * Remove everything Workspace Accounts installed, verifying each artifact.
   *
   * Ordering is a safety property, not a style choice: the wrapper executable is deleted only
   * after the global setting has been re-read and no longer names it, and a profile's metadata
   * survives while its Claude settings still run the Workspace Accounts status line. Every artifact
   * reports its own verified state, and anything left behind is named with the manual step.
   */
  private async removeAllData(): Promise<void> {
    const document = await this.registry.read();
    const foreignCollectors = Object.values(document.collectors).filter(
      (collector) => collector.pid !== process.pid
        && Date.now() - Date.parse(collector.updatedAt) < 120_000
    );
    const otherWindows = foreignCollectors.length > 0
      ? `\n\n${foreignCollectors.length} other VS Code window${foreignCollectors.length === 1 ? " is" : "s are"} still collecting usage. Close them first: while one is running it can rewrite the usage database after this removal, and Workspace Accounts cannot coordinate teardown across windows.`
      : "";
    const confirmed = await vscode.window.showWarningMessage(
      `Remove all Claude Workspace Accounts data?\n\nWorkspace Accounts will disconnect from Claude Code (${WRAPPER_SETTING_ID}), restore any status-line command it chained, delete its wrapper files, and delete all accounts, per-workspace bindings, and locally collected usage from ${this.registry.paths.root}.\n\nClaude Code's own configuration directories and credentials are never touched, so no account is signed out.${otherWindows}`,
      { modal: true },
      "Remove Everything"
    );
    if (confirmed !== "Remove Everything") {
      return;
    }

    const steps: TeardownStep[] = [];
    const retainedProfiles: string[] = [];

    // 1. Status lines first: they live in the user's own Claude settings, and whether they
    //    could be restored decides what may be deleted afterwards.
    for (const profile of document.profiles) {
      const plan = await this.teardownStatusLine(profile);
      steps.push({
        artifact: `Status line for ${profile.displayName}`,
        state: plan.state,
        detail: plan.detail,
        manual: plan.manual
      });
      if (!plan.safeToForgetProfile) {
        retainedProfiles.push(profile.id);
      }
    }

    // 2. Terminal settings. Only this workspace's file is writable from here; any other
    //    workspace Workspace Accounts touched is reported with its exact path.
    steps.push(...await this.teardownTerminalEnvironment());

    // 3. Detach from Claude Code, then prove it.
    let disableOutcome: "cleared" | "restored_upstream" | "not_configured" | undefined;
    let disableError: string | undefined;
    try {
      disableOutcome = await this.wrapper.disable();
    } catch (error) {
      disableError = error instanceof Error ? error.message : "unknown error";
    }
    const stillReferencesGuard = this.wrapperState() === "guard";
    steps.push({
      artifact: "Claude Code integration",
      state: stillReferencesGuard || !disableOutcome ? "failed" : "removed",
      detail: stillReferencesGuard
        ? `${WRAPPER_SETTING_ID} still names the Workspace Accounts wrapper.`
        : disableError
          ? `Detaching reported: ${disableError}.`
          : disableOutcome === "restored_upstream"
            ? "The wrapper configured before Workspace Accounts was restored."
            : disableOutcome === "cleared"
              ? `${WRAPPER_SETTING_ID} was cleared.`
              : `${WRAPPER_SETTING_ID} was not set.`,
      manual: stillReferencesGuard || !disableOutcome
        ? `Clear "${WRAPPER_SETTING_ID}" in your user settings.json and reload the window.`
        : undefined
    });

    // 4. Wrapper files, only when nothing still points at them.
    const removal = planSupportFileRemoval({
      disableOutcome,
      disableError,
      settingStillReferencesGuard: stillReferencesGuard,
      wrapperPath: this.wrapper.wrapperPath
    });
    if (removal.remove && retainedProfiles.length > 0) {
      // A retained Workspace Accounts status line still executes the bridge that lives beside the
      // wrapper, so the files stay until that command is gone from the user's settings.
      steps.push({
        artifact: "Workspace Accounts wrapper files",
        state: "kept",
        detail: `Kept because ${retainedProfiles.length} account${retainedProfiles.length === 1 ? "" : "s"} still run the Workspace Accounts status line, which needs the files beside the wrapper.`,
        manual: `After clearing those status lines, delete ${this.registry.paths.wrapperDirectory}.`
      });
    } else if (removal.remove) {
      try {
        await this.wrapper.removeSupportFiles();
        steps.push({
          artifact: "Workspace Accounts wrapper files",
          state: "removed",
          detail: removal.detail
        });
      } catch (error) {
        steps.push({
          artifact: "Workspace Accounts wrapper files",
          state: "failed",
          detail: error instanceof Error ? error.message : "unknown error",
          manual: `Delete ${this.registry.paths.wrapperDirectory} by hand.`
        });
      }
    } else {
      steps.push({
        artifact: "Workspace Accounts wrapper files",
        state: "kept",
        detail: removal.detail,
        manual: removal.manual
      });
    }

    // 5. The wrapper's binding cache: authoritative enough to run the wrong account.
    steps.push(await this.teardownFile(
      "Workspace binding cache",
      path.join(this.registry.paths.root, "binding-cache.json")
    ));

    // 6. Registry contents: accounts and bindings. Profiles whose status line survived are
    //    kept so the user can still detach them from inside Workspace Accounts.
    for (const profile of document.profiles) {
      if (retainedProfiles.includes(profile.id)) {
        steps.push({
          artifact: `Account ${profile.displayName}`,
          state: "kept",
          detail: "Kept so Workspace Accounts can still restore its status line."
        });
        continue;
      }
      try {
        await this.registry.deleteProfile(profile.id);
        this.repository.deleteProfileMetadata(profile.id);
        steps.push({ artifact: `Account ${profile.displayName}`, state: "removed" });
      } catch (error) {
        steps.push({
          artifact: `Account ${profile.displayName}`,
          state: "failed",
          detail: error instanceof Error ? error.message : "unknown error",
          manual: `Remove it from ${this.registry.paths.registry}.`
        });
      }
    }

    // 7. Usage database. Rows first, then the file, so a locked file still leaves no data.
    try {
      this.repository.deleteUsageData();
      steps.push({ artifact: "Collected usage", state: "removed" });
    } catch (error) {
      steps.push({
        artifact: "Collected usage",
        state: "failed",
        detail: error instanceof Error ? error.message : "unknown error",
        manual: `Delete ${this.repository.databasePath} after closing VS Code.`
      });
    }
    await this.reconcileCollection().catch((error: unknown) => this.report(
      "stopping local collection during removal",
      error
    ));

    // 8. Registry file itself, once nothing needs it.
    if (retainedProfiles.length === 0) {
      steps.push(await this.teardownFile("Account registry", this.registry.paths.registry));
      steps.push(await this.teardownFile(
        "Usage database",
        this.repository.databasePath,
        () => this.repository.close()
      ));
    } else {
      steps.push({
        artifact: "Account registry",
        state: "kept",
        detail: "Kept: it still describes the accounts whose status lines were preserved."
      });
    }

    // 9. Remembered answers. Consent is cleared rather than set to "declined": there is
    //    nothing left to protect, and activation still never writes the setting unprompted.
    await this.context.globalState.update(CONSENT_STATE_KEY, undefined);
    await this.context.globalState.update(ONBOARDED_STATE_KEY, undefined);
    await this.context.globalState.update(UNREGISTERED_NOTICE_STATE_KEY, undefined);
    await this.context.globalState.update(TERMINAL_WORKSPACES_STATE_KEY, undefined);
    steps.push({ artifact: "Remembered answers", state: "removed" });

    await this.updateContextKeys();
    if (retainedProfiles.length > 0) {
      await this.statusBar.refresh(true);
      await this.dashboard.refresh();
    }

    const summary = summarizeTeardown(steps);
    this.log(`Workspace Accounts teardown: ${summary.detail.join(" | ")}`);
    if (summary.complete) {
      const choice = await vscode.window.showInformationMessage(
        `${summary.headline} Reload the window so Claude Code stops using the wrapper, then uninstall the extension if you are done.`,
        "Reload Window",
        "Reveal Support Folder"
      );
      if (choice === "Reload Window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else if (choice === "Reveal Support Folder") {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(this.registry.paths.root)
        );
      }
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${summary.headline}\n\n${summary.manual.map((step, index) => `${index + 1}. ${step}`).join("\n\n")}`,
      { modal: true },
      "Show Details",
      "Reload Window"
    );
    if (choice === "Show Details") {
      const details = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Claude Workspace Accounts — removal report\n\n## Still to do by hand\n\n${summary.manual.map((step) => `- ${step}`).join("\n")}\n\n## Every artifact\n\n${steps.map((step) => `- **${step.artifact}** — ${step.state}${step.detail ? `: ${step.detail}` : ""}`).join("\n")}\n`
      });
      await vscode.window.showTextDocument(details, { preview: true });
    } else if (choice === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }

  /** Restore one account's status line and decide what that permits afterwards. */
  private async teardownStatusLine(profile: AccountProfile): Promise<StatusLineTeardownPlan> {
    let restored: StatusLineUninstallResult | undefined;
    let error: string | undefined;
    try {
      restored = await this.statusLineBridge.uninstall(profile);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "unknown error";
    }
    return planStatusLineTeardown({
      profileName: profile.displayName,
      configDir: profile.configDir,
      restored: restored?.restored,
      backupState: restored?.backup.state,
      guardCommandRemains: await this.guardStatusLineRemains(profile),
      error
    });
  }

  /**
   * True when this account's Claude settings still run an Workspace Accounts status line.
   *
   * An unreadable settings file counts as "still there": the safe assumption is the one that
   * keeps the files the status line needs.
   */
  private async guardStatusLineRemains(profile: AccountProfile): Promise<boolean> {
    try {
      const raw = await readFile(path.join(profile.configDir, "settings.json"), "utf8");
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
        statusLine?: { command?: unknown };
      };
      const command = typeof parsed.statusLine?.command === "string"
        ? parsed.statusLine.command.toLowerCase()
        : "";
      return command.includes("claude-workspace-accounts") || command.includes("statusline-bridge");
    } catch (failure) {
      return (failure as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  private async teardownFile(
    artifact: string,
    target: string,
    before?: () => void
  ): Promise<TeardownStep> {
    try {
      before?.();
    } catch (error) {
      this.report(`closing ${artifact} before removing it`, error);
    }
    try {
      await access(target);
    } catch {
      return { artifact, state: "not_present" };
    }
    try {
      await rm(target, { force: true });
      // SQLite leaves a write-ahead log and shared-memory file beside the database.
      await Promise.all([
        rm(`${target}-wal`, { force: true }).catch(() => undefined),
        rm(`${target}-shm`, { force: true }).catch(() => undefined)
      ]);
      return { artifact, state: "removed" };
    } catch (error) {
      return {
        artifact,
        state: "failed",
        detail: error instanceof Error ? error.message : "unknown error",
        manual: `Delete ${target} after closing VS Code.`
      };
    }
  }

  /**
   * Clear the terminal variable from this workspace, and name every other workspace where
   * Workspace Accounts wrote one. VS Code can only write the settings of the workspace it has
   * open, so the rest have to be reported rather than silently left behind.
   */
  private async teardownTerminalEnvironment(): Promise<TeardownStep[]> {
    const steps: TeardownStep[] = [];
    const recorded = this.context.globalState.get<string[]>(TERMINAL_WORKSPACES_STATE_KEY, []);
    const current = (await this.lockService.currentWorkspace())?.canonicalPath;
    const cleared = await this.clearTerminalEnvironment();
    steps.push({
      artifact: "Terminal account variable (this workspace)",
      state: cleared === "removed"
        ? "removed"
        : cleared === "absent" ? "not_present" : "failed",
      detail: cleared === "failed"
        ? "This workspace's terminal setting could not be written."
        : undefined,
      manual: cleared === "failed"
        ? "Remove CLAUDE_CONFIG_DIR from terminal.integrated.env.windows in this workspace's .vscode/settings.json."
        : undefined
    });
    const others = recorded.filter((path_) => path_ !== current);
    if (others.length > 0) {
      steps.push({
        artifact: "Terminal account variable (other workspaces)",
        state: "kept",
        detail: `Workspace Accounts also set it in: ${others.join(", ")}.`,
        manual: `Remove CLAUDE_CONFIG_DIR from terminal.integrated.env.windows in the .vscode/settings.json of: ${others.join(", ")}.`
      });
    }
    return steps;
  }

  /**
   * Reconcile the global setting with the wrapper actually on disk.
   *
   * Called on activation: a setting pointing at a deleted wrapper breaks every Claude Code
   * launch, and that is exactly the state an uninstall of an earlier release left behind.
   */
  public async repairIntegration(): Promise<void> {
    const outcome = await this.wrapper.repairIfStale();
    await this.updateContextKeys();
    if (outcome === "reinstalled") {
      void vscode.window.showInformationMessage(
        `Claude Workspace Accounts reinstalled its missing process wrapper, so Claude Code launches keep working. ${this.wrapperSummary()}`
      );
    } else if (outcome === "cleared") {
      // Not awaited: this runs during activation, and a notification with buttons stays
      // until the user dismisses it.
      void vscode.window.showWarningMessage(
        `Claude Code was configured to launch through an Workspace Accounts wrapper that no longer exists, which would have broken every launch. ${WRAPPER_SETTING_ID} has been cleared, so Claude Code launches directly again. Per-workspace accounts are remembered but not applied until you reconnect.`,
        "Reload Window",
        "Reconnect",
        "Show Diagnostics"
      ).then((choice) => {
        if (choice === "Reload Window") {
          return vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
        if (choice === "Reconnect") {
          return this.configureIntegration();
        }
        if (choice === "Show Diagnostics") {
          return this.diagnostics.show();
        }
        return undefined;
      });
    }
  }

  /** Install the per-account status-line bridge that produces quota snapshots. */
  private async enableUsageCollection(): Promise<void> {
    const account = await this.effectiveAccount();
    const profile = account.profile;
    if (!profile) {
      const choice = await vscode.window.showWarningMessage(
        `Usage is collected per Claude account, and this workspace's account (${account.runtimeConfigDir}) is not one Workspace Accounts knows about yet.`,
        "Choose An Account For This Workspace",
        "Track The Default Account"
      );
      if (choice === "Choose An Account For This Workspace") {
        await this.bindWorkspace();
      } else if (choice === "Track The Default Account") {
        await this.registerCurrentProfile();
      }
      return;
    }
    if (!vscode.workspace.getConfiguration("claudeAccounts")
      .get<boolean>("telemetry.enabled", true)) {
      const choice = await vscode.window.showWarningMessage(
        "claudeAccounts.telemetry.enabled is off, so nothing would be collected even with the status-line bridge installed.",
        "Open Settings"
      );
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "claudeAccounts.telemetry.enabled"
        );
      }
      return;
    }
    let result: "installed" | "already_installed";
    try {
      result = await this.statusLineBridge.install(profile);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `The status-line bridge was not installed: ${error instanceof Error ? error.message : "unknown error"}. ${profile.configDir}\\settings.json was left unchanged.`
      );
      return;
    }
    profile.telemetryEnabled = true;
    const recorded = await this.registry.patchProfile(profile.id, { telemetryEnabled: true });
    await this.ensureIntegration(
      `Token and cost detail for ${profile.displayName} is injected by Workspace Accounts when Claude Code launches.`,
      { userInitiated: false, allowPrompt: true }
    );
    await this.synchronizeAndRefresh();
    if (!recorded) {
      void vscode.window.showWarningMessage(
        `The status line in ${profile.configDir}\\settings.json now reports to Workspace Accounts, but that account is no longer in its registry, so nothing will be stored.`
      );
      return;
    }
    void vscode.window.showInformationMessage(
      result === "already_installed"
        ? `${profile.displayName} already reports usage through the status line in ${profile.configDir}\\settings.json. Numbers appear after the next Claude response.`
        : `Usage collection is on for ${profile.displayName}. The status line in ${profile.configDir}\\settings.json now reports quota to Workspace Accounts and then runs your previous status line. Numbers appear after the next Claude response.`
    );
  }

  /**
   * Add the Claude configuration this window already uses as a named account.
   *
   * Optional in the new model — a workspace can bind any account without this — but it is
   * what lets the default account's usage be attributed instead of silently discarded.
   */
  private async registerCurrentProfile(): Promise<void> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    if (runtime.profile) {
      void vscode.window.showInformationMessage(
        `${runtime.configDir} is already known to Workspace Accounts as ${runtime.profile.displayName}.`
      );
      return;
    }
    const displayName = await this.askDisplayName(
      path.basename(runtime.configDir).replace(/^\.claude-?/, "") || "Default"
    );
    if (!displayName) {
      return;
    }
    const id = safeProfileId(displayName, new Set(document.profiles.map((profile) => profile.id)));
    const profile: AccountProfile = {
      id,
      displayName,
      marker: profileMarker(displayName),
      configDir: runtime.configDir,
      configDirNormalized: runtime.configDirNormalized,
      // Retained for registry compatibility only; no isolated VS Code window is launched.
      vsCodeUserDataDir: path.join(this.registry.paths.root, "vscode", id),
      createdAt: new Date().toISOString()
    };
    const verification = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking ${displayName} with claude auth status`,
        cancellable: false
      },
      () => this.authVerifier.verify(profile, true)
    );
    // Identity confirmation is best-effort here: an unconfirmed account is still usable.
    await this.confirmIdentity(profile, verification, false);
    // Uniqueness is decided inside the registry's lock: the check above happened before a
    // modal and a probe, which is long enough for another window to register this directory.
    const created = await this.registry.createProfile(profile);
    if (created !== "created") {
      const owner = (await this.registry.listProfiles()).find(
        (candidate) => candidate.configDirNormalized === profile.configDirNormalized
      );
      void vscode.window.showInformationMessage(
        created === "duplicate_config_dir"
          ? `${runtime.configDir} is already tracked as ${owner?.displayName ?? "another account"}, so nothing was added.`
          : `An account named ${displayName} already exists, so nothing was added.`
      );
      await this.synchronizeAndRefresh();
      return;
    }
    await this.maybeInstallStatusBridge(profile);
    await this.synchronizeAndRefresh();
    await this.updateContextKeys();
    const choice = await vscode.window.showInformationMessage(
      `${displayName} now refers to ${runtime.configDir}, the Claude account this window uses when no workspace account applies. Nothing about your Claude setup was changed.`,
      "Use It In This Workspace",
      "Open Account Menu"
    );
    if (choice === "Use It In This Workspace") {
      await this.bindProfile(profile);
    } else if (choice === "Open Account Menu") {
      await this.openMenu();
    }
  }
  /**
   * Add a Claude account.
   *
   * Deliberately lightweight: a name is the only question. Earlier releases asked for two
   * absolute paths and then opened a blank second VS Code window with its own
   * `--user-data-dir`, which meant none of the user's extensions or settings — that is why
   * adding an account and then using it was effectively impossible.
   */
  private async addProfile(): Promise<AccountProfile | undefined> {
    const document = await this.registry.read();
    const displayName = await this.askDisplayName();
    if (!displayName) {
      return undefined;
    }
    const id = safeProfileId(displayName, new Set(document.profiles.map((profile) => profile.id)));
    const configDir = path.join(os.homedir(), `.claude-${id}`);
    const normalizedConfigDir = normalizeWindowsPath(configDir);
    if (document.profiles.some((profile) =>
      pathContains(profile.configDirNormalized, normalizedConfigDir)
      || pathContains(normalizedConfigDir, profile.configDirNormalized))) {
      void vscode.window.showErrorMessage(
        `${configDir} overlaps an account that already exists. Choose a different name.`
      );
      return undefined;
    }
    const confirmed = await vscode.window.showInformationMessage(
      `Add “${displayName}” as a Claude account?\n\nIts Claude configuration and credentials will live in ${configDir}, separate from your other accounts. Your default account is untouched, and no new VS Code window is opened.`,
      { modal: true },
      "Add Account"
    );
    if (confirmed !== "Add Account") {
      return undefined;
    }

    const profile: AccountProfile = {
      id,
      displayName,
      marker: profileMarker(displayName),
      configDir,
      configDirNormalized: normalizedConfigDir,
      // Retained for registry compatibility only; no isolated VS Code window is launched.
      vsCodeUserDataDir: path.join(this.registry.paths.root, "vscode", id),
      createdAt: new Date().toISOString()
    };
    // The registry entry is committed first: a directory with no account pointing at it is
    // harmless, while an account pointing at a directory that was never created is not.
    const created = await this.registry.createProfile(profile);
    if (created !== "created") {
      void vscode.window.showErrorMessage(
        created === "duplicate_config_dir"
          ? `Another Workspace Accounts account already uses ${configDir}. Choose a different name.`
          : `An account named ${displayName} was just added by another window. Choose a different name.`
      );
      return undefined;
    }
    try {
      await mkdir(configDir, { recursive: true });
    } catch (error) {
      await this.registry.deleteProfile(id).catch((failure: unknown) =>
        this.report("rolling back an account whose directory could not be created", failure));
      void vscode.window.showErrorMessage(
        `${configDir} could not be created, so ${displayName} was not added: ${error instanceof Error ? error.message : "unknown error"}`
      );
      return undefined;
    }
    await this.synchronizeAndRefresh();
    await this.updateContextKeys();

    const next = await vscode.window.showInformationMessage(
      `${displayName} was added. It has no Claude session yet — sign in to it, then it can be used by any workspace.`,
      "Sign In Now",
      "Later"
    );
    if (next === "Sign In Now") {
      await this.signIn(profile);
    }
    return profile;
  }

  /**
   * Sign in to one account, in a visible terminal.
   *
   * A terminal is used rather than a background process because Claude's sign-in is
   * interactive: the user needs to see the prompt, the URL, and any error. `CLAUDE_CONFIG_DIR`
   * is set for that terminal only, so the session lands in this account's directory.
   */
  private async signIn(profile: AccountProfile): Promise<void> {
    const binary = this.binaryResolver.resolve();
    // The command below is PowerShell, so the shell is named explicitly rather than
    // inherited: under cmd.exe or Git Bash the call operator is a syntax error, and sign-in
    // is on the critical path of the only flow that matters.
    const terminal = vscode.window.createTerminal({
      name: `Claude sign-in · ${profile.displayName}`,
      shellPath: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass"],
      env: { CLAUDE_CONFIG_DIR: profile.configDir },
      isTransient: true
    });
    terminal.show();
    terminal.sendText(binary ? `& "${binary}" auth login` : "claude auth login");
    const choice = await vscode.window.showInformationMessage(
      `Complete the Claude sign-in in the “${terminal.name}” terminal. It is signing in to ${profile.configDir}, so your other accounts are unaffected. When it finishes, confirm the identity so Workspace Accounts can spot a wrong-account mismatch later.`,
      "Confirm Identity",
      "Later"
    );
    if (choice === "Confirm Identity") {
      await this.verifyProfile(profile);
    }
  }

  /**
   * Bind this workspace to an account, which is the product's core action.
   *
   * There is no verification gate and no enforce/warn/off question: the binding itself is
   * what selects the account, and the mode comes from settings. Asking three questions
   * before anything worked is what made this unusable.
   */
  private async bindWorkspace(profileId?: string): Promise<void> {
    const workspace = await this.lockService.currentWorkspace();
    if (!workspace) {
      void vscode.window.showWarningMessage(
        "A Claude account is chosen per workspace, so open a folder or workspace first."
      );
      return;
    }
    const profiles = await this.registry.listProfiles();
    const requested = profileId
      ? profiles.find((candidate) => candidate.id === profileId)
      : undefined;
    if (requested) {
      await this.bindProfile(requested);
      return;
    }
    if (profiles.length === 0) {
      const created = await this.addProfile();
      if (created) {
        await this.bindProfile(created);
      }
      return;
    }

    const account = await this.effectiveAccount();
    const items = await Promise.all(profiles.map(async (candidate) => {
      const verification = await this.authVerifier.verify(candidate);
      const isBound = candidate.id === account.bound?.id;
      return {
        label: `${candidate.marker}  ${candidate.displayName}`,
        description: [
          isBound ? "Currently used here" : undefined,
          verification.state === "signed_in"
            ? verification.email ?? "Signed in"
            : verification.state === "signed_out"
              ? "Signed out — sign in after choosing"
              : "Sign-in state unknown"
        ].filter(Boolean).join(" · "),
        detail: `Claude Code in ${workspace.label} will run as this account (${candidate.configDir}). Other workspaces keep their own.`,
        profile: candidate
      };
    }));
    const selected = await vscode.window.showQuickPick<
      vscode.QuickPickItem & { profile?: AccountProfile; add?: boolean }
    >([
      ...items,
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      {
        label: "$(add) Add another Claude account…",
        detail: "Name it, then sign in. It becomes available to every workspace.",
        add: true
      }
    ], {
      title: `Claude account for ${workspace.label}`,
      placeHolder: "Pick the account this workspace should use",
      matchOnDescription: true
    });
    if (!selected) {
      return;
    }
    if (selected.add) {
      const created = await this.addProfile();
      if (created) {
        await this.bindProfile(created);
      }
      return;
    }
    if (selected.profile) {
      await this.bindProfile(selected.profile);
    }
  }

  private async bindProfile(profile: AccountProfile): Promise<void> {
    const workspace = await this.lockService.currentWorkspace();
    if (!workspace) {
      void vscode.window.showWarningMessage(
        "A Claude account is chosen per workspace, so open a folder or workspace first."
      );
      return;
    }
    const mode = vscode.workspace.getConfiguration("claudeAccounts")
      .get<LockMode>("defaultBindMode", "enforce");
    const previous = await this.lockService.currentLock();
    await this.lockService.lock(profile, mode);
    // The wrapper's cache is what it falls back to when the registry cannot be read, so a
    // stale entry would keep launching the account this call just replaced.
    await this.invalidateBindingCache(previous ? "rebind" : "bind");
    await this.updateContextKeys();
    await this.synchronizeAndRefresh();

    // The binding is applied by the wrapper at launch, so without the wrapper it does
    // nothing at all. This is the moment where changing the global setting is justified.
    const outcome = await this.ensureIntegration(
      `${workspace.label} is now set to use the Claude account “${profile.displayName}”. Workspace Accounts applies that by setting CLAUDE_CONFIG_DIR for each Claude Code launch in this workspace, which requires Claude Code to start through Workspace Accounts.`,
      { userInitiated: false, allowPrompt: true }
    );
    if (outcome === "declined" || outcome === "blocked_by_setting" || outcome === "failed") {
      const choice = await vscode.window.showWarningMessage(
        `${workspace.label} is set to use ${profile.displayName}, but the choice is not being applied: Claude Code is not launching through Workspace Accounts, so it still uses your default account here.`,
        "Connect To Claude Code",
        "Leave It"
      );
      if (choice === "Connect To Claude Code") {
        await this.configureIntegration();
      }
      return;
    }
    if (mode === "off") {
      void vscode.window.showWarningMessage(
        `${workspace.label} recorded ${profile.displayName}, but claudeAccounts.defaultBindMode is "off", so no account is applied. Set it to "enforce" to make per-workspace accounts take effect.`
      );
      return;
    }

    const verification = await this.authVerifier.verify(profile);
    const actions = [
      ...(verification.state === "signed_in" ? [] : ["Sign In"]),
      ...(this.terminalBindingState(profile) === "not_applied" ? ["Also Use In Terminals"] : []),
      "Done"
    ];
    const choice = await vscode.window.showInformationMessage(
      verification.state === "signed_in"
        ? `Claude Code in ${workspace.label} now uses ${profile.displayName}${verification.email ? ` (${verification.email})` : ""}. Reload or restart Claude Code sessions started before now.`
        : `Claude Code in ${workspace.label} now uses ${profile.displayName}, but that account has no Claude session yet — sign in to it or Claude will report itself signed out here.`,
      ...actions
    );
    if (choice === "Sign In") {
      await this.signIn(profile);
    } else if (choice === "Also Use In Terminals") {
      await this.bindTerminalEnvironment();
    }
  }

  private async unbindWorkspace(): Promise<void> {
    const lock = await this.lockService.currentLock();
    if (!lock) {
      const choice = await vscode.window.showInformationMessage(
        "This workspace has no Claude account of its own, so it already uses your default account.",
        "Choose An Account"
      );
      if (choice === "Choose An Account") {
        await this.bindWorkspace();
      }
      return;
    }
    const profile = await this.registry.getProfile(lock.profileId);
    const confirmed = await vscode.window.showWarningMessage(
      `Stop using ${profile?.displayName ?? lock.profileId} in this workspace? It will go back to your default Claude account. Nothing is signed out and no account is deleted.`,
      { modal: true },
      "Stop Using It Here"
    );
    if (confirmed !== "Stop Using It Here") {
      return;
    }
    await this.lockService.unlock();
    await this.invalidateBindingCache("unbind");
    const terminal = await this.clearTerminalEnvironment();
    await this.updateContextKeys();
    await this.synchronizeAndRefresh();
    void vscode.window.showInformationMessage(
      terminal === "failed"
        // Leaving this unsaid would let a plain `claude` keep using the account the user
        // just stopped using here.
        ? "This workspace now uses your default Claude account for Claude Code, but its terminal setting could not be changed, so terminals here still set CLAUDE_CONFIG_DIR to the old account. Remove it from terminal.integrated.env.windows in this workspace's .vscode/settings.json."
        : "This workspace now uses your default Claude account. Accounts and collected usage were kept."
    );
  }

  /**
   * Whether this workspace also exports `CLAUDE_CONFIG_DIR` to its integrated terminals.
   *
   * `terminal.integrated.env.windows` is not writable at workspace scope in every VS Code
   * configuration, so "unsupported" is a real state and is reported rather than guessed at.
   */
  private terminalBindingState(profile?: AccountProfile): TerminalBinding {
    if (!profile || !vscode.workspace.workspaceFolders?.length) {
      return "unsupported";
    }
    const inspected = vscode.workspace
      .getConfiguration("terminal.integrated")
      .inspect<Record<string, string>>("env.windows");
    if (!inspected) {
      return "unsupported";
    }
    const configured = inspected.workspaceValue?.CLAUDE_CONFIG_DIR
      ?? inspected.workspaceFolderValue?.CLAUDE_CONFIG_DIR;
    return configured && normalizeWindowsPath(configured) === profile.configDirNormalized
      ? "applied"
      : "not_applied";
  }

  private async bindTerminalEnvironment(): Promise<void> {
    const account = await this.effectiveAccount();
    if (!account.bound) {
      void vscode.window.showWarningMessage(
        "Choose the Claude account for this workspace first; the terminal setting follows that choice."
      );
      return;
    }
    const configuration = vscode.workspace.getConfiguration("terminal.integrated");
    const inspected = configuration.inspect<Record<string, string>>("env.windows");
    const next = {
      ...(inspected?.workspaceValue ?? {}),
      CLAUDE_CONFIG_DIR: account.bound.configDir
    };
    try {
      await configuration.update("env.windows", next, vscode.ConfigurationTarget.Workspace);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `This workspace cannot set terminal.integrated.env.windows (${error instanceof Error ? error.message : "unknown error"}). Claude Code launched by the extension still uses ${account.bound.displayName}; a plain "claude" in a terminal will use your default account unless you set CLAUDE_CONFIG_DIR=${account.bound.configDir} yourself.`
      );
      return;
    }
    await this.rememberTerminalWorkspace();
    void vscode.window.showInformationMessage(
      `New terminals in this workspace will set CLAUDE_CONFIG_DIR=${account.bound.configDir}, so a plain "claude" uses ${account.bound.displayName} too. Existing terminals keep their old environment. The setting is written to this workspace's settings.json.`
    );
    await this.statusBar.refresh();
  }

  private async unbindTerminalEnvironment(): Promise<void> {
    const outcome = await this.clearTerminalEnvironment();
    if (outcome === "removed") {
      void vscode.window.showInformationMessage(
        "CLAUDE_CONFIG_DIR was removed from this workspace's terminal environment. Claude Code launched by the extension still uses this workspace's account."
      );
    } else if (outcome === "failed") {
      void vscode.window.showWarningMessage(
        "This workspace's terminal setting could not be written, so CLAUDE_CONFIG_DIR is still set for its terminals. Remove it from terminal.integrated.env.windows in this workspace's .vscode/settings.json."
      );
    }
    await this.statusBar.refresh();
  }

  /**
   * Drop the wrapper's binding cache.
   *
   * The wrapper writes `binding-cache.json` so a workspace keeps its account even when the
   * registry cannot be read. That makes it authoritative enough to be dangerous once a
   * binding is removed, and it holds workspace paths and expected emails, so it has to go
   * whenever bindings or Workspace Accounts data are removed. The wrapper rebuilds what it still
   * needs on the next launch.
   */
  private async invalidateBindingCache(change: BindingChange): Promise<void> {
    if (!requiresBindingCacheInvalidation(change)) {
      return;
    }
    const target = path.join(this.registry.paths.root, "binding-cache.json");
    try {
      await rm(target, { force: true });
    } catch (error) {
      // Not cosmetic: a surviving entry lets the wrapper fall back to the account the user
      // just stopped using, so the user has to be told rather than left guessing.
      this.report("clearing the workspace binding cache", error);
      void vscode.window.showWarningMessage(
        `Workspace Accounts could not clear its binding cache (${target}). If its account registry ever becomes unreadable, Claude Code may fall back to the previous account for this workspace. Delete that file to be sure.`,
        "Reveal File"
      ).then((choice) => choice === "Reveal File"
        ? vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target))
        : undefined);
    }
  }

  /**
   * Remove only the variable Workspace Accounts added, leaving any other terminal env alone.
   *
   * The tri-state matters during teardown: "absent" and "failed" used to be the same `false`,
   * so a setting that could not be written was reported as nothing to do.
   */
  private async clearTerminalEnvironment(): Promise<"removed" | "absent" | "failed"> {
    const configuration = vscode.workspace.getConfiguration("terminal.integrated");
    const inspected = configuration.inspect<Record<string, string>>("env.windows");
    const current = inspected?.workspaceValue;
    if (!current || current.CLAUDE_CONFIG_DIR === undefined) {
      return "absent";
    }
    const next = { ...current };
    delete next.CLAUDE_CONFIG_DIR;
    try {
      await configuration.update(
        "env.windows",
        Object.keys(next).length > 0 ? next : undefined,
        vscode.ConfigurationTarget.Workspace
      );
      await this.forgetTerminalWorkspace();
      return "removed";
    } catch (error) {
      this.report("clearing this workspace's terminal account variable", error);
      return "failed";
    }
  }

  /** Remember which workspaces were changed, so removal can name the ones it cannot reach. */
  private async rememberTerminalWorkspace(): Promise<void> {
    const workspace = await this.lockService.currentWorkspace();
    if (!workspace) {
      return;
    }
    const recorded = this.context.globalState
      .get<string[]>(TERMINAL_WORKSPACES_STATE_KEY, [])
      .filter((candidate) => candidate !== workspace.canonicalPath);
    await this.context.globalState.update(
      TERMINAL_WORKSPACES_STATE_KEY,
      [...recorded.slice(-19), workspace.canonicalPath]
    );
  }

  private async forgetTerminalWorkspace(): Promise<void> {
    const workspace = await this.lockService.currentWorkspace();
    if (!workspace) {
      return;
    }
    const recorded = this.context.globalState
      .get<string[]>(TERMINAL_WORKSPACES_STATE_KEY, [])
      .filter((candidate) => candidate !== workspace.canonicalPath);
    await this.context.globalState.update(
      TERMINAL_WORKSPACES_STATE_KEY,
      recorded.length > 0 ? recorded : undefined
    );
  }
  /** Verify the account this workspace actually uses, bound or default. */
  private async verifyAccount(): Promise<void> {
    const account = await this.effectiveAccount();
    if (!account.profile) {
      const choice = await vscode.window.showWarningMessage(
        `There is nothing to verify yet: this workspace has no Claude account of its own, and the default account (${account.runtimeConfigDir}) is not one Workspace Accounts knows about.`,
        "Choose An Account For This Workspace",
        "Track The Default Account"
      );
      if (choice === "Choose An Account For This Workspace") {
        await this.bindWorkspace();
      } else if (choice === "Track The Default Account") {
        await this.registerCurrentProfile();
      }
      return;
    }
    await this.verifyProfile(account.profile);
  }

  /**
   * The escape from an enforced identity mismatch.
   *
   * When a bound account's directory is re-authenticated as somebody else, an enforcing
   * binding stops every launch in that workspace with exit code 78. Without this the only
   * ways out were editing settings or hunting for "verify"; both are dead ends mid-work.
   * Shows the stored identity and the one that answered, then stores the new one — or
   * switches this workspace to warn-only, which is the other escape the wrapper names.
   */
  private async updateExpectedIdentity(): Promise<void> {
    const account = await this.effectiveAccount();
    const profile = account.bound ?? account.profile;
    if (!profile) {
      void vscode.window.showInformationMessage(
        "This workspace has no Claude account of its own, so there is no expected identity to update."
      );
      return;
    }
    const verification = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking which Claude identity answers in ${profile.displayName}`,
        cancellable: false
      },
      () => this.authVerifier.verify(profile, true)
    );
    if (verification.state === "signed_out") {
      const choice = await vscode.window.showWarningMessage(
        `${profile.displayName} is signed out, so there is no identity to record yet. Sign in to it, then update the expected identity.`,
        "Sign In"
      );
      if (choice === "Sign In") {
        await this.signIn(profile);
      }
      return;
    }
    if (verification.state !== "signed_in" || (!verification.email && !verification.accountId)) {
      // The identity cannot be read, which is exactly when the enforcing binding may already
      // be stopping launches. Offering only an error message here removed the one escape.
      const enforcing = account.lock?.mode === "enforce";
      const structural = classifyVerification(verification) === "signed_in_unidentified";
      const choice = await vscode.window.showWarningMessage(
        structural
          ? `${profile.displayName} is signed in, but this version of Claude Code does not report account details when a per-workspace account is in use, so there is no identity to record. The account works normally; Workspace Accounts simply cannot tell you if that directory is signed into a different account.${enforcing ? " Because it can never confirm a match, this workspace's enforcing setting behaves like warn." : ""}`
          : `Claude could not be asked about ${profile.displayName} (${verification.errorCategory ?? "unavailable"}), so the expected identity was not changed.${enforcing ? " While this workspace enforces its account, a mismatch the wrapper has already found will keep stopping launches." : ""}`,
        ...(enforcing ? ["Only Warn In This Workspace"] : []),
        "Show Diagnostics"
      );
      if (choice === "Only Warn In This Workspace") {
        await this.switchToWarnMode(profile);
      } else if (choice === "Show Diagnostics") {
        await this.diagnostics.show();
      }
      return;
    }
    const recorded = profile.expectedIdentity;
    const actual = verification.email ?? verification.accountId ?? "an unnamed identity";
    if (recorded && compareIdentity(recorded, verification) === "match") {
      void vscode.window.showInformationMessage(
        `${profile.displayName} still answers as ${actual}, which matches the identity Workspace Accounts expects. Nothing needed changing.`
      );
      await this.synchronizeAndRefresh(true);
      return;
    }
    const options = ["Use The New Identity"];
    if (account.lock && account.lock.mode === "enforce") {
      options.push("Only Warn In This Workspace");
    }
    const choice = await vscode.window.showWarningMessage(
      recorded
        ? `${profile.displayName} now answers as ${actual}.\n\nWorkspace Accounts expected ${recorded.email ?? recorded.accountId ?? "a different identity"}, which is why launches in this workspace are being stopped.\n\nRecord the new identity if you signed that account directory into ${actual} on purpose. If you did not, sign that directory back into the intended account instead.`
        : `${profile.displayName} answers as ${actual}. Record it as the expected identity so Workspace Accounts can tell you if it ever changes?`,
      { modal: true },
      ...options
    );
    if (choice === "Only Warn In This Workspace") {
      await this.switchToWarnMode(profile);
      return;
    }
    if (choice !== "Use The New Identity") {
      return;
    }
    const identity = {
      email: verification.email,
      accountId: verification.accountId,
      organizationId: verification.organizationId,
      organizationName: verification.organizationName
    };
    profile.expectedIdentity = identity;
    profile.authMethod = verification.authMethod;
    profile.lastVerifiedAt = verification.checkedAt;
    this.repository.recordAuthVerification(profile.id, verification);
    // Patch, not upsert: this profile object was read before a prompt and a probe, and
    // another window may have changed unrelated fields since.
    const stored = await this.registry.patchProfile(profile.id, {
      expectedIdentity: identity,
      authMethod: verification.authMethod,
      lastVerifiedAt: verification.checkedAt
    });
    await this.synchronizeAndRefresh(true);
    void vscode.window.showInformationMessage(
      stored
        ? `${profile.displayName} is now expected to be ${actual}. Launches in this workspace are no longer stopped.`
        : `${profile.displayName} is no longer a known account, so the new identity was not recorded.`
    );
  }

  /** Keep the account, stop it from blocking: the second escape from a mismatch. */
  private async switchToWarnMode(profile: AccountProfile): Promise<void> {
    await this.lockService.lock(profile, "warn");
    await this.invalidateBindingCache("mode_change");
    await this.updateContextKeys();
    await this.synchronizeAndRefresh(true);
    void vscode.window.showInformationMessage(
      `This workspace still uses ${profile.displayName}, and an identity mismatch will now be reported in the status bar instead of stopping the launch.`
    );
  }

  private async verifyProfile(profile: AccountProfile): Promise<void> {
    const verification = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Checking ${profile.displayName} with claude auth status`,
        cancellable: false
      },
      () => this.authVerifier.verify(profile, true)
    );
    if (await this.confirmIdentity(profile, verification, true)) {
      const stored = await this.storeConfirmedIdentity(profile);
      await this.synchronizeAndRefresh(true);
      const identified = classifyVerification(verification) === "signed_in_identified";
      void vscode.window.showInformationMessage(
        !stored
          ? `${profile.displayName} is no longer a known account, so nothing was recorded.`
          : identified
            ? `${profile.displayName} is signed in as ${verification.email ?? verification.accountId}. Workspace Accounts will notice if that changes.`
            : `${profile.displayName} is signed in and ready to use. This version of Claude Code does not report account details when a per-workspace account is in use, so Workspace Accounts cannot record which account it is — or warn you if it changes.`
      );
    }
  }

  /** Sign in to the account this workspace uses. */
  private async login(): Promise<void> {
    const account = await this.effectiveAccount();
    if (!account.profile) {
      const choice = await vscode.window.showWarningMessage(
        `Workspace Accounts signs in one account at a time, and this workspace has no account of its own yet. Choose one first — or sign in with Claude Code directly, which Workspace Accounts never interferes with.`,
        "Choose An Account For This Workspace",
        "Add A Claude Account"
      );
      if (choice === "Choose An Account For This Workspace") {
        await this.bindWorkspace();
      } else if (choice === "Add A Claude Account") {
        await this.addProfile();
      }
      return;
    }
    await this.signIn(account.profile);
  }
  private async manageProfiles(): Promise<void> {
    const profiles = await this.registry.listProfiles();
    const runtime = this.runtimeDetector.detect(profiles);
    const selection = await vscode.window.showQuickPick<
      vscode.QuickPickItem & { action: string; profile?: AccountProfile }
    >([
      ...(runtime.profile ? [] : [{
        label: "$(person-add) Register this window's account",
        detail: `Adds ${runtime.configDir}, the Claude configuration this window already uses.`,
        action: "register"
      }]),
      {
        label: "$(add) Create a new isolated account profile",
        detail: "Creates a separate Claude configuration directory for a second account, then opens a terminal to sign in to it. No new VS Code window.",
        action: "add"
      },
      {
        label: "$(export) Export profile metadata",
        detail: "Names, directories, and expected identities. No credentials.",
        action: "export"
      },
      {
        label: "$(cloud-download) Import profile metadata",
        detail: "Restores profile definitions from an export. Each imported identity must be verified again.",
        action: "import"
      },
      ...(profiles.length > 0
        ? [{ label: "Registered profiles", kind: vscode.QuickPickItemKind.Separator, action: "separator" }]
        : []),
      ...profiles.map((profile) => ({
        label: `$(trash) Delete ${profile.displayName} from Workspace Accounts`,
        description: profile.expectedIdentity?.email ?? "identity not confirmed",
        detail: `Forgets the Workspace Accounts metadata and locks for ${profile.configDir}. Claude's own settings and credentials there are left in place.`,
        action: "delete",
        profile
      }))
    ], {
      title: "Manage Claude Account Profiles",
      placeHolder: profiles.length === 0
        ? "No profiles are registered yet"
        : `${profiles.length} profile${profiles.length === 1 ? "" : "s"} registered`,
      matchOnDetail: true
    });
    if (!selection) {
      return;
    }
    if (selection.action === "register") {
      await this.registerCurrentProfile();
    } else if (selection.action === "add") {
      await this.addProfile();
    } else if (selection.action === "export") {
      await this.exportProfiles();
    } else if (selection.action === "import") {
      await this.importProfiles();
    } else if (selection.action === "delete" && selection.profile) {
      await this.deleteProfile(selection.profile);
    }
  }

  private async exportProfiles(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "Export profile names, paths, and expected identity metadata? The export contains no credentials, but email and organization fields are personal data.",
      { modal: true },
      "Export Metadata"
    );
    if (confirmed !== "Export Metadata") {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: "Export Claude Workspace Accounts Profile Metadata",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "claude-account-profiles.json")),
      filters: { JSON: ["json"] }
    });
    if (!target) {
      return;
    }
    const payload: ProfileExport = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      profiles: await this.registry.listProfiles()
    };
    await writeFile(target.fsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private async importProfiles(): Promise<void> {
    let imported = 0;
    const selected = await vscode.window.showOpenDialog({
      title: "Import Claude Workspace Accounts Profile Metadata",
      canSelectMany: false,
      filters: { JSON: ["json"] }
    });
    if (!selected?.[0]) {
      return;
    }
    try {
      const raw = JSON.parse(await readFile(selected[0].fsPath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || (raw as ProfileExport).schemaVersion !== 1
        || !Array.isArray((raw as ProfileExport).profiles)) {
        throw new Error("Unsupported profile export schema.");
      }
      const existing = await this.registry.listProfiles();
      const existingIds = new Set(existing.map((profile) => profile.id));
      const importedProfiles: AccountProfile[] = [];
      for (const candidate of (raw as ProfileExport).profiles) {
        if (!candidate || typeof candidate.displayName !== "string"
          || typeof candidate.configDir !== "string"
          || typeof candidate.vsCodeUserDataDir !== "string") {
          throw new Error("A profile entry is missing required metadata.");
        }
        if (!path.isAbsolute(candidate.configDir)
          || !path.isAbsolute(candidate.vsCodeUserDataDir)
          || candidate.configDir.toLocaleLowerCase().endsWith(".credentials.json")
          || candidate.vsCodeUserDataDir.toLocaleLowerCase().endsWith(".credentials.json")) {
          throw new Error("A profile entry contains an unsafe or non-absolute path.");
        }
        const id = existingIds.has(candidate.id)
          ? safeProfileId(candidate.displayName, existingIds)
          : candidate.id;
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
          throw new Error("A profile ID is invalid.");
        }
        existingIds.add(id);
        const expectedIdentity = candidate.expectedIdentity
          && typeof candidate.expectedIdentity === "object"
          && !Array.isArray(candidate.expectedIdentity)
          ? {
              email: typeof candidate.expectedIdentity.email === "string"
                ? candidate.expectedIdentity.email
                : undefined,
              accountId: typeof candidate.expectedIdentity.accountId === "string"
                ? candidate.expectedIdentity.accountId
                : undefined,
              organizationId: typeof candidate.expectedIdentity.organizationId === "string"
                ? candidate.expectedIdentity.organizationId
                : undefined,
              organizationName: typeof candidate.expectedIdentity.organizationName === "string"
                ? candidate.expectedIdentity.organizationName
                : undefined
            }
          : undefined;
        importedProfiles.push({
          id,
          displayName: candidate.displayName.trim().slice(0, 40),
          marker: profileMarker(candidate.displayName),
          configDir: candidate.configDir,
          configDirNormalized: normalizeWindowsPath(candidate.configDir),
          vsCodeUserDataDir: candidate.vsCodeUserDataDir,
          expectedIdentity,
          authMethod: typeof candidate.authMethod === "string"
            ? candidate.authMethod.slice(0, 100)
            : undefined,
          telemetryEnabled: candidate.telemetryEnabled === true,
          createdAt: typeof candidate.createdAt === "string"
            ? candidate.createdAt
            : new Date().toISOString(),
          lastVerifiedAt: typeof candidate.lastVerifiedAt === "string"
            ? candidate.lastVerifiedAt
            : undefined
        });
      }
      await this.registry.upsertProfiles(importedProfiles);
      imported = importedProfiles.length;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `No accounts were imported: ${error instanceof Error ? error.message : "invalid file"}`
      );
      return;
    }
    // The import is committed. A refresh failure after this point is a separate problem and
    // must not be reported as "nothing was imported".
    try {
      await this.synchronizeAndRefresh();
    } catch (error) {
      this.report("refreshing after importing accounts", error);
    }
    void vscode.window.showInformationMessage(
      `${imported} account${imported === 1 ? "" : "s"} imported. Confirm each identity before a workspace relies on it.`
    );
  }

  private async deleteProfile(profile: AccountProfile): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete only the Workspace Accounts metadata for ${profile.displayName}? Claude settings and credentials remain in place; local usage is deleted separately.`,
      { modal: true },
      "Delete Profile Metadata"
    );
    if (confirmed !== "Delete Profile Metadata") {
      return;
    }
    // Deleting an account also deletes any workspace binding to it, so the wrapper's cache
    // must not be able to keep applying it.
    const teardown = await this.teardownStatusLine(profile);
    if (!teardown.safeToForgetProfile) {
      const choice = await vscode.window.showWarningMessage(
        `${teardown.detail} ${profile.displayName} was kept in Workspace Accounts so its status line can still be detached.`,
        ...(teardown.manual ? ["Show What To Do"] : [])
      );
      if (choice === "Show What To Do" && teardown.manual) {
        void vscode.window.showInformationMessage(teardown.manual, { modal: true });
      }
      return;
    }
    await this.registry.deleteProfile(profile.id);
    this.repository.deleteProfileMetadata(profile.id);
    await this.invalidateBindingCache("profile_delete");
    await this.updateContextKeys();
    await this.synchronizeAndRefresh();
    void vscode.window.showInformationMessage(
      `${profile.displayName} was removed from Workspace Accounts. ${teardown.detail} Its Claude configuration directory and credentials were left untouched.`
    );
  }

  private async deleteUsageData(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "Delete all locally collected usage, status snapshots, and diagnostics? Profiles, workspace locks, Claude settings, and credentials are not deleted.",
      { modal: true },
      "Delete Usage Data"
    );
    if (confirmed === "Delete Usage Data") {
      this.repository.deleteUsageData();
      // The wrapper's binding cache also holds identity hints; it is rebuilt on next launch.
      await this.invalidateBindingCache("data_removal");
      await this.statusBar.refresh();
      await this.dashboard.refresh();
      void vscode.window.showInformationMessage("Local usage data deleted.");
    }
  }

  private async exportUsage(profileId?: string): Promise<void> {
    const available = this.repository.exportRows(profileId);
    if (Object.values(available).every((rows) => rows.length === 0)) {
      const diagnosis = this.collectionDiagnosis(await this.registry.read(), profileId);
      const choice = await vscode.window.showWarningMessage(
        `There is no local usage to export yet. ${diagnosis.headline}: ${diagnosis.detail}`,
        ...(diagnosis.actionLabel ? [diagnosis.actionLabel] : []),
        "Show Diagnostics"
      );
      if (choice === "Show Diagnostics") {
        await this.diagnostics.show();
      } else if (choice && choice === diagnosis.actionLabel) {
        await this.runCollectionAction(diagnosis);
      }
      return;
    }
    const format = await vscode.window.showQuickPick(["JSON", "CSV"], {
      title: "Export Local Usage",
      placeHolder: "Exports normalized local observations, never credentials or prompt content"
    });
    if (!format) {
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: "Export Local Usage",
      defaultUri: vscode.Uri.file(path.join(
        os.homedir(),
        `claude-account-usage.${format.toLocaleLowerCase()}`
      )),
      filters: format === "JSON" ? { JSON: ["json"] } : { CSV: ["csv"] }
    });
    if (!target) {
      return;
    }
    const rows = this.repository.exportRows(profileId);
    if (format === "JSON") {
      await writeFile(target.fsPath, `${JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        profileId,
        provenance: "Locally observed Claude Code status snapshots and OpenTelemetry",
        data: rows
      }, null, 2)}\n`, "utf8");
    } else {
      const daily = rows.usageDaily as Record<string, unknown>[];
      const columns = daily.length > 0 ? Object.keys(daily[0]!) : [];
      const escape = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
      const content = [
        columns.map(escape).join(","),
        ...daily.map((row) => columns.map((column) => escape(row[column])).join(","))
      ].join("\r\n");
      await writeFile(target.fsPath, `${content}\r\n`, "utf8");
    }
    void vscode.window.showInformationMessage(`Local usage exported to ${target.fsPath}.`);
  }

  /**
   * Record what a probe found. Never a gate.
   *
   * Claude Code reports `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is
   * set, so a per-workspace account is signed in and perfectly usable while being
   * unidentifiable. Refusing to store the account in that case is what abandoned registration
   * and left users with an account that no workspace could use. Identity is recorded when the
   * CLI supplies it and simply omitted when it does not.
   */
  private async confirmIdentity(
    profile: AccountProfile,
    verification: AuthVerification,
    allowDrift: boolean
  ): Promise<boolean> {
    const outcome = classifyVerification(verification);
    if (outcome === "signed_out") {
      // Sign in to the profile that was just checked, not to whatever this workspace uses:
      // registering the default account while bound to another opened the wrong terminal.
      void vscode.window.showWarningMessage(
        `${profile.displayName} is signed out.`,
        "Sign In"
      ).then((choice) => choice === "Sign In" ? this.signIn(profile) : undefined);
      return false;
    }
    if (outcome === "unavailable") {
      void vscode.window.showWarningMessage(
        `Claude could not be asked about ${profile.displayName} (${verification.errorCategory ?? "unavailable"}), so no identity was recorded. The account still works.`
      );
      return false;
    }
    if (outcome === "signed_in_unidentified") {
      // A usable account with no identity to compare. Recorded as verified-signed-in, with no
      // expected identity, and reported honestly rather than as a failure.
      profile.authMethod = verification.authMethod;
      profile.lastVerifiedAt = verification.checkedAt;
      this.repository.recordAuthVerification(profile.id, verification);
      return true;
    }

    const match = compareIdentity(profile.expectedIdentity, verification);
    if (profile.expectedIdentity && match === "mismatch") {
      if (!allowDrift) {
        return false;
      }
      const accepted = await vscode.window.showWarningMessage(
        `${profile.displayName} now returns ${verification.email ?? verification.accountId}; the stored identity is ${profile.expectedIdentity.email ?? profile.expectedIdentity.accountId}.`,
        { modal: true },
        "Accept New Identity",
        "Sign In Again"
      );
      if (accepted === "Sign In Again") {
        await this.login();
        return false;
      }
      if (accepted !== "Accept New Identity") {
        return false;
      }
    } else if (profile.expectedIdentity && match === "unverifiable") {
      void vscode.window.showWarningMessage(
        `${profile.displayName} is signed in, but Claude did not return details comparable with the identity recorded for it, so the recorded identity was left as it is.`
      );
      return false;
    } else if (!profile.expectedIdentity) {
      const confirmed = await vscode.window.showInformationMessage(
        `Confirm ${verification.email ?? verification.accountId} as the expected identity for ${profile.displayName}?`,
        { modal: true },
        "Confirm Identity"
      );
      if (confirmed !== "Confirm Identity") {
        return false;
      }
    }

    profile.expectedIdentity = {
      email: verification.email,
      accountId: verification.accountId,
      organizationId: verification.organizationId,
      organizationName: verification.organizationName
    };
    profile.authMethod = verification.authMethod;
    profile.lastVerifiedAt = verification.checkedAt;
    this.repository.recordAuthVerification(profile.id, verification);
    return true;
  }

  /**
   * Persist a confirmed identity as a field patch.
   *
   * The profile object reaching this point was read before a modal and a `claude auth status`
   * probe, so writing it whole would discard whatever another window recorded meanwhile.
   * Returns false only when the account itself has gone.
   */
  private async storeConfirmedIdentity(profile: AccountProfile): Promise<boolean> {
    return this.registry.patchProfile(profile.id, {
      expectedIdentity: profile.expectedIdentity,
      authMethod: profile.authMethod,
      lastVerifiedAt: profile.lastVerifiedAt
    });
  }

  private async maybeInstallStatusBridge(profile: AccountProfile): Promise<void> {
    if (!vscode.workspace.getConfiguration("claudeAccounts")
      .get<boolean>("telemetry.enabled", true)) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Collect local usage for ${profile.displayName}?\n\nWorkspace Accounts adds a status-line command to ${profile.configDir}\\settings.json — only that profile's Claude settings — which reports quota to this machine and then runs whatever status line you already had. You can turn it off later from the account menu.`,
      { modal: true },
      "Enable Local Usage",
      "Not Now"
    );
    if (choice !== "Enable Local Usage") {
      profile.telemetryEnabled = false;
      await this.registry.patchProfile(profile.id, { telemetryEnabled: false });
      return;
    }
    try {
      await this.statusLineBridge.install(profile);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `${profile.displayName} was added, but its status-line bridge was not installed, so no usage will be collected for it: ${error instanceof Error ? error.message : "unknown error"}. ${profile.configDir}\\settings.json was left unchanged.`
      );
      return;
    }
    // The bridge is installed at this point. A failure to record that fact is a different
    // failure and must not be reported as "settings.json was left unchanged".
    profile.telemetryEnabled = true;
    if (!(await this.registry.patchProfile(profile.id, { telemetryEnabled: true }))) {
      void vscode.window.showWarningMessage(
        `${profile.displayName} now reports usage from ${profile.configDir}\\settings.json, but Workspace Accounts could not record that, so nothing will be stored. Run “Collect Usage for This Workspace's Account” to retry.`
      );
      return;
    }
    await this.ensureIntegration(
      `Token and cost detail for ${profile.displayName} is injected by Workspace Accounts when Claude Code launches.`,
      { userInitiated: false, allowPrompt: true }
    );
  }

  private async synchronizeAndRefresh(force = false): Promise<void> {
    this.repository.mirrorRegistry(await this.registry.read());
    // Which profile is active can have just changed, so collection is reconciled before
    // the UI is redrawn: otherwise a freshly registered account collects nothing until
    // the window reloads and the dashboard reports emptiness it cannot explain.
    await this.reconcileCollection().catch((error: unknown) =>
      this.report("restarting local usage collection", error));
    await this.statusBar.refresh(force);
    await this.dashboard.refresh();
  }

  private async askDisplayName(initial = ""): Promise<string | undefined> {
    const profiles = await this.registry.listProfiles();
    return vscode.window.showInputBox({
      title: "Account profile display name",
      prompt: "Use a short, obvious name such as Work or Personal.",
      value: initial,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "Enter a display name.";
        }
        if (trimmed.length > 40) {
          return "Use 40 characters or fewer.";
        }
        if (profiles.some((profile) =>
          profile.displayName.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) {
          return "That display name is already in use.";
        }
        return undefined;
      }
    }).then((value) => value?.trim());
  }

}
