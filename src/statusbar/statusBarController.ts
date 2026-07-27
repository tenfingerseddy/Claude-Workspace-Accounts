import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type {
  AccountProfile,
  AccountQuotaCache,
  AuthVerification,
  CollectionHealth,
  GuardStatus,
  QuotaReport,
  RuntimeProfile,
  StatusSnapshot,
  WorkspaceLock
} from "../core/models.js";
import { compareIdentity } from "../core/identity.js";
import { buildQuotaReport, deriveGuardStatus, withStatusText } from "../core/statusState.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import type { AuthVerifier } from "../auth/authVerifier.js";
import { readQuotaCache } from "../usage/quotaCache.js";

export interface CurrentGuardContext {
  runtime: RuntimeProfile;
  lock?: WorkspaceLock;
  requiredProfile?: AccountProfile;
  verification?: AuthVerification;
  snapshot?: StatusSnapshot;
  status: GuardStatus;
}

export class StatusBarController implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    101
  );
  private timer?: NodeJS.Timeout;
  private refreshPromise?: Promise<CurrentGuardContext | undefined>;
  private context?: CurrentGuardContext;

  public constructor(
    private readonly registry: ProfileRegistry,
    private readonly runtimeDetector: RuntimeProfileDetector,
    private readonly authVerifier: AuthVerifier,
    private readonly lockService: WorkspaceLockService,
    private readonly repository: UsageRepository,
    private readonly onChange: () => void,
    private readonly describeIntegration: () => string = () => "Unknown",
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.item.name = "Claude Workspace Accounts";
    this.item.command = "claudeAccounts.openMenu";
  }

  public start(): void {
    this.updateVisibility();
    // Failures here used to vanish: an unhandled rejection in a timer tick left the item
    // frozen on stale state with nothing written anywhere.
    this.timer = setInterval(() => {
      void this.refresh().catch((error: unknown) => this.report("refreshing the status bar", error));
    }, 30_000);
  }

  private report(context: string, error: unknown): void {
    this.log(`Failed while ${context}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  public current(): CurrentGuardContext | undefined {
    return this.context;
  }

  public refresh(forceVerification = false): Promise<CurrentGuardContext | undefined> {
    if (!forceVerification && this.refreshPromise) {
      return this.refreshPromise;
    }
    const operation = this.performRefresh(forceVerification);
    this.refreshPromise = operation;
    void operation
      .catch((error: unknown) => this.report("refreshing the status bar", error))
      .finally(() => {
        if (this.refreshPromise === operation) {
          this.refreshPromise = undefined;
        }
      });
    return operation;
  }

  public updateVisibility(): void {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0 || vscode.workspace.workspaceFile) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.item.dispose();
  }

  private async performRefresh(forceVerification: boolean): Promise<CurrentGuardContext | undefined> {
    this.updateVisibility();
    const document = await this.registry.read();
    this.repository.mirrorRegistry(document);
    const runtime = this.runtimeDetector.detect(document.profiles);
    const lock = await this.lockService.currentLock();
    const requiredProfile = lock
      ? document.profiles.find((profile) => profile.id === lock.profileId)
      : undefined;
    // The wrapper sets CLAUDE_CONFIG_DIR per launch, so a bound workspace uses its bound
    // account no matter what this VS Code window inherited. The status bar has to report the
    // same thing the wrapper will do.
    const bound = lock && lock.mode !== "off" ? requiredProfile : undefined;
    const activeProfile = bound ?? runtime.profile;
    const effectiveRuntime: RuntimeProfile = bound ? { ...runtime, profile: bound } : runtime;
    // The lock is handed to the status derivation only when the bound account's identity can
    // actually be compared. An account with no confirmed identity, or one the CLI cannot
    // report on, is bound and allowed by the wrapper and must never render as a block.
    const comparable = (candidate?: AuthVerification): WorkspaceLock | undefined => {
      if (!bound?.expectedIdentity || !candidate) {
        return undefined;
      }
      const match = compareIdentity(bound.expectedIdentity, candidate);
      return match === "match" || match === "mismatch" ? lock : undefined;
    };
    // Keeps the palette's contextual commands honest even when state changes elsewhere.
    void vscode.commands.executeCommand(
      "setContext",
      "claudeAccounts.locked",
      Boolean(lock)
    );
    void vscode.commands.executeCommand(
      "setContext",
      "claudeAccounts.hasProfiles",
      document.profiles.length > 0
    );

    const health = this.collectionHealth(activeProfile?.id);

    this.render(this.present(deriveGuardStatus({
      runtime: effectiveRuntime,
      lock: undefined,
      requiredProfile: bound,
      warningThreshold: this.warningThreshold(),
      criticalThreshold: this.criticalThreshold(),
      showUsage: this.showUsage(),
      verifying: Boolean(activeProfile),
      collectionPhase: health?.phase,
      collectionDetail: health?.storage.lastFailureCategory
    }), runtime, bound), effectiveRuntime, lock, requiredProfile);

    // A 30-second cache can report a healthy account after the wrapper's own live probe has
    // started stopping launches, so a recorded mismatch forces a fresh check.
    const blocked = await this.wrapperReportedMismatch(this.context?.verification?.checkedAt);
    const verification = activeProfile
      ? await this.authVerifier.verify(activeProfile, forceVerification || blocked)
      : undefined;
    if (activeProfile && verification) {
      this.repository.recordAuthVerification(activeProfile.id, verification);
    }
    const snapshot = activeProfile
      ? this.repository.latestStatusSnapshot(activeProfile.id)
      : undefined;
    // Quota comes from the account's own configuration directory, so it is available without a
    // session, without the status line, and without local collection being enabled at all.
    const quotaCache = activeProfile
      ? await readQuotaCache(activeProfile.configDir)
      : undefined;
    const status = this.present(deriveGuardStatus({
      runtime: effectiveRuntime,
      verification,
      lock: comparable(verification),
      requiredProfile: bound,
      snapshot,
      quotaCache,
      warningThreshold: this.warningThreshold(),
      criticalThreshold: this.criticalThreshold(),
      showUsage: this.showUsage(),
      verifying: false,
      collectionPhase: health?.phase,
      collectionDetail: health?.storage.lastFailureCategory
    }), runtime, bound, verification);
    this.context = {
      runtime: effectiveRuntime,
      lock,
      requiredProfile,
      verification,
      snapshot,
      status
    };
    this.render(status, effectiveRuntime, lock, requiredProfile, verification, snapshot, quotaCache);
    // Surfaces the recovery command in the palette exactly when it is the thing to run.
    void vscode.commands.executeCommand(
      "setContext",
      "claudeAccounts.identityNeedsAttention",
      status.kind === "wrong_account"
        || status.kind === "wrong_account_warning"
        || status.identityCheckInactive === true
    );
    this.onChange();
    return this.context;
  }

  /**
   * The collection-health record, or nothing.
   *
   * The status bar ignored this entirely, which is how a database that had gone locked, full,
   * read-only or corrupt after one successful write kept a frozen quota figure on screen with no
   * indication that it had stopped moving. Reading it must never be able to break the item, so a
   * failure here degrades to "no phase reported".
   */
  private collectionHealth(profileId?: string): CollectionHealth | undefined {
    try {
      return this.repository.collectionHealth(profileId, {
        telemetryEnabled: vscode.workspace.getConfiguration("claudeAccounts")
          .get<boolean>("telemetry.enabled", true),
        runtimeProfileRegistered: Boolean(profileId)
      });
    } catch (error) {
      this.report("reading collection health", error);
      return undefined;
    }
  }

  /**
   * Presentation-only adjustment.
   *
   * Using the default Claude account in a workspace with no account of its own is normal,
   * not a fault, so it must not be rendered as a warning. It is still named, because a
   * default account Workspace Accounts does not know about collects no usage.
   */
  private present(
    status: GuardStatus,
    runtime: RuntimeProfile,
    bound?: AccountProfile,
    verification?: AuthVerification
  ): GuardStatus {
    if (!bound) {
      if (status.kind !== "unregistered") {
        return status;
      }
      return {
        ...withStatusText(status, "$(account) Claude · Default account"),
        severity: "normal",
        detail: `This workspace uses the default Claude account (${runtime.configDir}), which Workspace Accounts does not track. Choose an account for this workspace, or track this one to collect its usage.`
      };
    }
    if (!bound.expectedIdentity) {
      // Legitimate and by design: bound accounts do not need a confirmed identity. Say so,
      // rather than implying either enforcement or a fault — but never at the cost of a
      // signed-out signal or a usage figure.
      if (status.kind === "signed_out" || status.kind === "verifying" || status.usageLabel) {
        return {
          ...status,
          detail: `${status.detail} This workspace uses ${bound.displayName}, whose Claude identity has not been confirmed.`
        };
      }
      return {
        ...withStatusText(status, `$(link) Claude · ${bound.displayName}`),
        severity: status.severity === "error" ? "warning" : status.severity,
        detail: `This workspace uses ${bound.displayName}. Its Claude identity has not been confirmed, so a change of account inside it would not be noticed.`
      };
    }
    if (verification && verification.state !== "signed_in") {
      return status;
    }
    if (verification
      && verification.state === "signed_in"
      && !verification.email
      && !verification.accountId) {
      // Signed in, but this probe came back without an email or organization. Identity is
      // normally readable per directory, so this is unusual rather than the norm — still not a
      // fault, and never a reason to treat the account as wrong.
      return {
        ...status,
        detail: `${status.detail} Claude returned no account details for ${bound.displayName} on the last check, so a change of account inside it cannot be detected until one is recorded.`
      };
    }
    if (verification
      && compareIdentity(bound.expectedIdentity, verification) === "unverifiable") {
      // The account is applied and launches are allowed, but drift detection is inactive.
      // Silence here would be indistinguishable from a working check.
      return {
        ...withStatusText(status, `$(warning) Claude · ${bound.displayName} · unverified`),
        kind: "usage_unavailable",
        // A flag, not a word in the text for three consumers to grep for.
        identityCheckInactive: true,
        severity: "warning",
        detail: `This workspace uses ${bound.displayName}, but Claude did not return an identity comparable with the one stored, so a wrong-account change would not be detected. Launches are still allowed. Update the expected identity to restore the check.`
      };
    }
    return status;
  }

  private render(
    status: GuardStatus,
    runtime: RuntimeProfile,
    lock?: WorkspaceLock,
    requiredProfile?: AccountProfile,
    verification?: AuthVerification,
    snapshot?: StatusSnapshot,
    quotaCache?: AccountQuotaCache
  ): void {
    const activeLock = lock?.mode === "off" ? undefined : lock;
    // Every rewrite of this text goes through `withStatusText`, so a storage warning cannot be
    // dropped by a presentation rule and nothing here has to inspect the string to find out.
    this.item.text = status.text;
    this.item.command = this.commandFor(status, requiredProfile);
    this.item.backgroundColor = status.severity === "error"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : status.severity === "warning"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = true;
    tooltip.appendMarkdown(`**Claude Workspace Accounts**\n\n`);
    // Quota first, because it is the only figure here that measures plan headroom. Everything
    // else — the account, the integration, the local history — is context for it.
    this.appendQuota(tooltip, status.quota ?? buildQuotaReport({
      cache: quotaCache,
      snapshot,
      warningThreshold: this.warningThreshold(),
      criticalThreshold: this.criticalThreshold()
    }));
    if (status.collectionWarning) {
      tooltip.appendMarkdown(`$(warning) ${this.escape(status.collectionWarning)}  \n\n`);
    }
    if (activeLock && requiredProfile) {
      tooltip.appendMarkdown(
        `This workspace uses **${this.escape(requiredProfile.displayName)}**  \n`
      );
      tooltip.appendMarkdown(`Account directory: \`${requiredProfile.configDir}\`  \n`);
      tooltip.appendMarkdown(
        `[Use a different account here](command:claudeAccounts.bindWorkspace) · [Stop using it here](command:claudeAccounts.unbindWorkspace)  \n`
      );
    } else {
      // Normal, but worth naming: a default account Workspace Accounts does not know about
      // collects no usage, which is why the dashboard would look empty.
      tooltip.appendMarkdown(`This workspace uses your **default Claude account**  \n`);
      tooltip.appendMarkdown(`Account directory: \`${runtime.configDir}\`  \n`);
      tooltip.appendMarkdown(
        `[Use a specific account here](command:claudeAccounts.bindWorkspace)${runtime.profile ? "" : " · [Track this account's usage](command:claudeAccounts.registerCurrentProfile)"}  \n`
      );
    }
    if (verification?.email) {
      tooltip.appendMarkdown(`Confirmed identity: ${this.escape(verification.email)}  \n`);
    }
    tooltip.appendMarkdown(`Claude Code integration: ${this.escape(this.describeIntegration())}  \n`);
    tooltip.appendMarkdown(`Last verification: ${verification ? new Date(verification.checkedAt).toLocaleString() : "Never"}  \n`);
    tooltip.appendMarkdown(
      `Workspace: ${this.escape(snapshot?.workspaceLabel ?? activeLock?.workspaceLabel ?? vscode.workspace.name ?? "Unknown")}  \n`
    );
    tooltip.appendMarkdown(`State: ${this.escape(status.detail)}`);
    this.item.tooltip = tooltip;
    this.item.accessibilityInformation = {
      label: status.text.replace(/\$\([^)]+\)\s*/g, ""),
      role: "button"
    };
  }

  /**
   * True when the wrapper's own health record shows an identity mismatch more recent than the
   * cached verification. The wrapper probes at launch; the status bar must not contradict it.
   */
  private async wrapperReportedMismatch(cachedAt?: string): Promise<boolean> {
    try {
      const raw = await readFile(
        path.join(this.registry.paths.root, "wrapper-health.json"),
        "utf8"
      );
      const health = JSON.parse(raw.replace(/^\uFEFF/, "")) as {
        category?: unknown;
        updatedAt?: unknown;
      };
      if (health.category !== "identity_mismatch" || typeof health.updatedAt !== "string") {
        return false;
      }
      const reportedAt = Date.parse(health.updatedAt);
      if (!Number.isFinite(reportedAt)) {
        return false;
      }
      const cached = cachedAt ? Date.parse(cachedAt) : 0;
      return reportedAt > cached;
    } catch {
      // No health record, or an unreadable one, is not evidence of a mismatch.
      return false;
    }
  }

  private warningThreshold(): number {
    return vscode.workspace.getConfiguration("claudeAccounts")
      .get<number>("usage.warningThreshold", 70);
  }

  private criticalThreshold(): number {
    return vscode.workspace.getConfiguration("claudeAccounts")
      .get<number>("usage.criticalThreshold", 90);
  }

  private showUsage(): boolean {
    return vscode.workspace.getConfiguration("claudeAccounts")
      .get<boolean>("statusBar.showUsage", true);
  }

  private commandFor(status: GuardStatus, requiredProfile?: AccountProfile): vscode.Command {
    if ((status.kind === "wrong_account" || status.kind === "wrong_account_warning")
      && requiredProfile) {
      // The account is applied by the wrapper; a mismatch means the identity inside it
      // changed. An enforcing binding stops every launch until this is resolved, so the
      // click has to be the recovery, not a diagnosis.
      return {
        command: "claudeAccounts.updateExpectedIdentity",
        title: `Resolve the identity mismatch in ${requiredProfile.displayName}`
      };
    }
    if (status.identityCheckInactive === true) {
      return {
        command: "claudeAccounts.updateExpectedIdentity",
        title: "Restore identity checking for this workspace's account"
      };
    }
    if (status.kind === "signed_out") {
      return {
        command: "claudeAccounts.login",
        title: "Sign in to this workspace's Claude account"
      };
    }
    if (status.kind === "limit_warning") {
      return {
        command: "claudeAccounts.openDashboard",
        title: "Open usage dashboard"
      };
    }
    if (status.kind === "verifying") {
      return {
        command: "claudeAccounts.diagnostics",
        title: "Open diagnostic details"
      };
    }
    return {
      command: "claudeAccounts.openMenu",
      title: "Open account menu"
    };
  }

  /**
   * The quota block: used, left, reset, and how old the reading is.
   *
   * The age is not decoration. A five-hour percentage from ninety minutes ago is not current
   * headroom, and showing the number without its age was the difference between information and
   * a guess.
   */
  private appendQuota(tooltip: vscode.MarkdownString, quota: QuotaReport): void {
    tooltip.appendMarkdown(`**Quota reported by Claude**  \n`);
    for (const entry of quota.windows) {
      const reset = entry.resetsAtIso
        ? entry.expired
          ? " · reset due now"
          : ` · resets ${new Date(entry.resetsAtIso).toLocaleString()} (${entry.resetsInLabel})`
        : " · reset time not reported";
      tooltip.appendMarkdown(
        `${this.escape(entry.label)}: **${Math.round(entry.usedPercentage)}% used**, ${Math.round(entry.remainingPercentage)}% left${this.escape(reset)}  \n`
      );
    }
    for (const entry of quota.absent) {
      tooltip.appendMarkdown(`${this.escape(entry.label)}: ${this.escape(entry.detail)}  \n`);
    }
    if (quota.windows.length > 0) {
      tooltip.appendMarkdown(
        `Reading: ${quota.ageLabel ? this.escape(quota.ageLabel) : "age unknown"}${quota.freshness === "stale" ? " — stale" : ""}  \n`
      );
    }
    if (quota.creditPool) {
      const pool = quota.creditPool;
      tooltip.appendMarkdown(
        `Extra usage credits: **${Math.round(pool.utilization)}% used**${pool.spendLimitReached ? " · spend limit reached" : ""}  \n`
      );
    }
    tooltip.appendMarkdown(
      `Read from this account's own usage reading, never calculated here.  \n\n`
    );
  }

  private escape(value: string): string {
    return value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
  }
}
