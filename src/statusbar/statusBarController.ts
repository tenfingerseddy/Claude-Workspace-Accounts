import * as vscode from "vscode";
import type {
  AccountProfile,
  AuthVerification,
  GuardStatus,
  RuntimeProfile,
  StatusSnapshot,
  WorkspaceLock
} from "../core/models.js";
import { deriveGuardStatus } from "../core/statusState.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import type { AuthVerifier } from "../auth/authVerifier.js";

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
    private readonly onChange: () => void
  ) {
    this.item.name = "Claude Account Guard";
    this.item.command = "claudeAccountGuard.openMenu";
  }

  public start(): void {
    this.updateVisibility();
    this.timer = setInterval(() => void this.refresh(), 30_000);
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
    void operation.finally(() => {
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
    const activeProfile = runtime.profile;

    this.render(deriveGuardStatus({
      runtime,
      lock,
      requiredProfile,
      warningThreshold: this.warningThreshold(),
      criticalThreshold: this.criticalThreshold(),
      showUsage: this.showUsage(),
      verifying: Boolean(activeProfile)
    }), runtime, lock, requiredProfile);

    const verification = activeProfile
      ? await this.authVerifier.verify(activeProfile, forceVerification)
      : undefined;
    if (activeProfile && verification) {
      this.repository.recordAuthVerification(activeProfile.id, verification);
    }
    const snapshot = activeProfile
      ? this.repository.latestStatusSnapshot(activeProfile.id)
      : undefined;
    const status = deriveGuardStatus({
      runtime,
      verification,
      lock,
      requiredProfile,
      snapshot,
      warningThreshold: this.warningThreshold(),
      criticalThreshold: this.criticalThreshold(),
      showUsage: this.showUsage(),
      verifying: false
    });
    this.context = { runtime, lock, requiredProfile, verification, snapshot, status };
    this.render(status, runtime, lock, requiredProfile, verification, snapshot);
    this.onChange();
    return this.context;
  }

  private render(
    status: GuardStatus,
    runtime: RuntimeProfile,
    lock?: WorkspaceLock,
    requiredProfile?: AccountProfile,
    verification?: AuthVerification,
    snapshot?: StatusSnapshot
  ): void {
    const activeLock = lock?.mode === "off" ? undefined : lock;
    this.item.text = status.text;
    this.item.command = this.commandFor(status, requiredProfile);
    this.item.backgroundColor = status.severity === "error"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : status.severity === "warning"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**Claude Account Guard**\n\n`);
    tooltip.appendMarkdown(`Profile: **${this.escape(runtime.profile?.displayName ?? "Unregistered")}**  \n`);
    if (verification?.email) {
      tooltip.appendMarkdown(`Verified identity: ${this.escape(verification.email)}  \n`);
    }
    tooltip.appendMarkdown(
      `Workspace lock: ${activeLock ? `${this.escape(requiredProfile?.displayName ?? activeLock.profileId)} (${activeLock.mode})` : "Unlocked"}  \n`
    );
    if (snapshot?.rateLimits?.fiveHour) {
      tooltip.appendMarkdown(
        `Five-hour: ${Math.round(snapshot.rateLimits.fiveHour.usedPercentage)}% used${this.resetText(snapshot.rateLimits.fiveHour.resetsAt)}  \n`
      );
    }
    if (snapshot?.rateLimits?.sevenDay) {
      tooltip.appendMarkdown(
        `Seven-day: ${Math.round(snapshot.rateLimits.sevenDay.usedPercentage)}% used${this.resetText(snapshot.rateLimits.sevenDay.resetsAt)}  \n`
      );
    }
    tooltip.appendMarkdown(`Last verification: ${verification ? new Date(verification.checkedAt).toLocaleString() : "Never"}  \n`);
    tooltip.appendMarkdown(`Usage freshness: ${snapshot ? new Date(snapshot.capturedAt).toLocaleString() : "Unavailable"}  \n`);
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

  private warningThreshold(): number {
    return vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<number>("usage.warningThreshold", 70);
  }

  private criticalThreshold(): number {
    return vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<number>("usage.criticalThreshold", 90);
  }

  private showUsage(): boolean {
    return vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<boolean>("statusBar.showUsage", true);
  }

  private commandFor(status: GuardStatus, requiredProfile?: AccountProfile): vscode.Command {
    if ((status.kind === "wrong_account" || status.kind === "wrong_account_warning")
      && requiredProfile) {
      return {
        command: "claudeAccountGuard.switchProfile",
        title: `Reopen with ${requiredProfile.displayName}`,
        arguments: [requiredProfile.id]
      };
    }
    if (status.kind === "signed_out") {
      return {
        command: "claudeAccountGuard.login",
        title: "Sign in to this profile"
      };
    }
    if (status.kind === "limit_warning") {
      return {
        command: "claudeAccountGuard.openDashboard",
        title: "Open usage dashboard"
      };
    }
    if (status.kind === "verifying") {
      return {
        command: "claudeAccountGuard.diagnostics",
        title: "Open diagnostic details"
      };
    }
    return {
      command: "claudeAccountGuard.openMenu",
      title: "Open account menu"
    };
  }

  private resetText(timestamp: number | undefined): string {
    return timestamp ? `; resets ${new Date(timestamp * 1000).toLocaleString()}` : "";
  }

  private escape(value: string): string {
    return value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
  }
}
