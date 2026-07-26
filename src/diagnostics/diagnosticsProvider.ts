import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { workspaceHash } from "../core/paths.js";
import { bindingIdentityState } from "../core/statusState.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import type { ClaudeBinaryResolver } from "../auth/authVerifier.js";
import type { StatusBarController } from "../statusbar/statusBarController.js";
import type { DashboardActions } from "../dashboard/dashboardProvider.js";

export class DiagnosticsProvider {
  private actions?: DashboardActions;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry,
    private readonly runtimeDetector: RuntimeProfileDetector,
    private readonly lockService: WorkspaceLockService,
    private readonly repository: UsageRepository,
    private readonly binaryResolver: ClaudeBinaryResolver,
    private readonly statusBar: StatusBarController
  ) {}

  /** Wired after commands are registered so the report can name the collection state. */
  public useController(actions: DashboardActions): void {
    this.actions = actions;
  }

  public async show(): Promise<void> {
    const content = await this.redactedReport();
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content
    });
    await vscode.window.showTextDocument(document, { preview: true });
    const status = this.statusBar.current()?.status;
    // Offer the recovery from here too: this report is where a user lands when launches are
    // being stopped, and reading it should not be a dead end.
    const needsIdentity = status?.kind === "wrong_account"
      || status?.kind === "wrong_account_warning"
      || status?.text.includes("unverified") === true;
    const choice = await vscode.window.showInformationMessage(
      needsIdentity
        ? "Claude Account Guard diagnostics are redacted by default. This workspace's account cannot be matched against the identity recorded for it."
        : "Claude Account Guard diagnostics are redacted by default.",
      ...(needsIdentity ? ["Update Expected Identity"] : []),
      "Copy Redacted Diagnostics"
    );
    if (choice === "Copy Redacted Diagnostics") {
      await vscode.env.clipboard.writeText(content);
      void vscode.window.showInformationMessage("Redacted diagnostics copied.");
    } else if (choice === "Update Expected Identity") {
      await vscode.commands.executeCommand("claudeAccountGuard.updateExpectedIdentity");
    }
  }

  public async redactedReport(): Promise<string> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    const lock = await this.lockService.currentLock();
    const workspace = await this.lockService.currentWorkspace();
    const current = this.statusBar.current();
    const configuredWrapper = vscode.workspace.getConfiguration("claudeCode")
      .get<string>("claudeProcessWrapper");
    const expectedWrapper = document.integration.wrapperPath;
    // The account in play is the bound one when this workspace has a binding: reading health
    // and snapshots from the ambient profile reported another account's numbers under this
    // one's name, which hid the fact that the bound account was collecting nothing.
    const boundProfile = lock && lock.mode !== "off"
      ? document.profiles.find((profile) => profile.id === lock.profileId)
      : undefined;
    const activeProfile = boundProfile ?? runtime.profile;
    const health = activeProfile
      ? this.repository.collectorHealth(activeProfile.id)
      : {};
    const snapshot = activeProfile
      ? this.repository.latestStatusSnapshot(activeProfile.id)
      : undefined;
    const wrapperHealth = await this.wrapperHealth();
    const redact = (value: string | undefined): string => {
      if (!value) {
        return "Not configured";
      }
      const local = process.env.LOCALAPPDATA;
      const home = os.homedir();
      return value
        .replaceAll(home, "%USERPROFILE%")
        .replaceAll(local ?? "\u0000", "%LOCALAPPDATA%");
    };
    const conflict = configuredWrapper && expectedWrapper
      && path.normalize(configuredWrapper) !== path.normalize(expectedWrapper);
    const collection = this.actions?.collectionDiagnosis(document, activeProfile?.id);
    const identity = bindingIdentityState({
      lock,
      boundProfile,
      verification: current?.verification
    });
    const identityState = identity === "mismatch"
      ? "Mismatch — a different Claude identity answers in that account"
      : identity === "unidentified"
        ? "Unavailable — this Claude version reports no account details while a per-workspace account is in use, so drift cannot be detected"
        : identity === "unconfirmed"
          ? "Not recorded — the account is used without a confirmed identity"
          : identity === "unverifiable"
            ? `Unknown — the last check did not complete (${current?.verification?.state ?? "no result"})`
            : identity === "match"
              ? "Matches the recorded identity"
              : "Not applicable — this workspace uses the default account";
    const bindingCache = await this.fileExists(
      path.join(this.registry.paths.root, "binding-cache.json")
    );
    const terminalEnvironment = vscode.workspace
      .getConfiguration("terminal.integrated")
      .inspect<Record<string, string>>("env.windows")
      ?.workspaceValue?.CLAUDE_CONFIG_DIR;

    return `# Claude Account Guard — Redacted Diagnostics

- Generated: ${new Date().toISOString()}
- Extension version: ${String(this.context.extension.packageJSON.version)}
- VS Code version: ${vscode.version}
- Claude Code version: ${this.binaryResolver.installedVersion() ?? "Not installed"}
- Platform: ${process.platform}-${process.arch}
- Workspace account: ${boundProfile ? `${boundProfile.displayName} (${lock?.mode} mode)` : "None — uses the default account"}
- Workspace account applied: ${boundProfile ? (this.actions?.wrapperState() === "guard" ? "Yes, by the Account Guard wrapper" : "No — Claude Code does not launch through Account Guard") : "N/A"}
- Account in play here: ${activeProfile?.displayName ?? "Not tracked by Account Guard"}
- Account config dir: ${redact(activeProfile?.configDir ?? runtime.configDir)}
- Default (inherited) config dir: ${redact(runtime.configDir)}
- Default config dir tracked: ${runtime.profile ? "Yes" : "No — its usage is not collected"}
- Terminal CLAUDE_CONFIG_DIR for this workspace: ${terminalEnvironment ? redact(terminalEnvironment) : "Not set"}
- Accounts known: ${document.profiles.length}
- Workspace accounts configured: ${document.workspaceLocks.filter((candidate) => candidate.mode !== "off").length}
- Expected identity recorded for the account in play: ${activeProfile ? (activeProfile.expectedIdentity ? "Yes" : "No — bound but never verified, so a wrong-account change is not detected") : "N/A"}
- Identity check state: ${identityState}
- Binding cache present: ${bindingCache ? "Yes" : "No"}
- Status-line bridge enabled for the account in play: ${activeProfile ? (activeProfile.telemetryEnabled === true ? "Yes" : "No") : "N/A"}
- Collector registered for the account in play: ${activeProfile && document.collectors[activeProfile.id] ? "Yes" : "No"}
- Collection state: ${this.actions ? `${collection?.state ?? "unknown"} — ${collection?.headline ?? "unknown"}` : "Unavailable"}
- Collection blocker: ${collection && collection.state !== "active" ? collection.detail : "None"}
- Foreign OTLP exporter present: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_HEADERS ? "Yes" : "No"}
- Workspace URI hash: ${workspace ? workspaceHash(workspace.canonicalPath) : "No workspace"}
- Auth status: ${current?.verification?.state ?? "Not checked"}
- Auth error category: ${current?.verification?.errorCategory ?? "None"}
- Collector status: ${health.status ?? "Inactive"}
- Collector last event: ${health.lastEventAt ?? "Never"}
- Status snapshot: ${snapshot ? `Available (${snapshot.capturedAt})` : "Unavailable"}
- Wrapper path: ${redact(expectedWrapper)}
- Wrapper last exit category: ${wrapperHealth.category ?? "Unavailable"}
- Wrapper last exit code: ${wrapperHealth.exitCode ?? "Unavailable"}
- Wrapper last update: ${wrapperHealth.updatedAt ?? "Never"}
- Configured wrapper: ${redact(configuredWrapper)}
- Wrapper conflict: ${conflict ? "Yes" : "No"}
- Claude Code integration: ${this.actions ? (this.actions.wrapperState() === "guard" ? "On — Claude Code launches through Account Guard" : this.actions.wrapperState() === "foreign" ? "Another tool's wrapper is configured" : "Off — per-workspace accounts are not applied") : "Unavailable"}
- Undo integration: run "Claude Account Guard: Disconnect From Claude Code", or clear claudeCode.claudeProcessWrapper in settings.json and reload the window
- Bypass without uninstalling: set CLAUDE_ACCOUNT_GUARD_DISABLE=1 in the environment
- SQLite size: ${this.formatBytes(this.repository.databaseSize())}
- Raw event retention: ${vscode.workspace.getConfiguration("claudeAccountGuard").get<number>("telemetry.retentionDays", 30)} days
- Prompt/response/tool content collection: Disabled
- Credential file access: Never

This report excludes email addresses, account and organization identifiers, raw authentication output, tokens, command payloads, and full workspace paths.
`;
  }

  private async fileExists(candidate: string): Promise<boolean> {
    try {
      await readFile(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private async wrapperHealth(): Promise<{
    category?: string;
    exitCode?: number;
    updatedAt?: string;
  }> {
    try {
      const content = await readFile(
        path.join(this.registry.paths.root, "wrapper-health.json"),
        "utf8"
      );
      const value = JSON.parse(content.replace(/^\uFEFF/, "")) as Record<string, unknown>;
      return {
        category: typeof value.category === "string"
          ? value.category.replace(/[^a-z0-9_-]/gi, "").slice(0, 80)
          : undefined,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined
      };
    } catch {
      return {};
    }
  }

  private formatBytes(value: number): string {
    if (value < 1024) {
      return `${value} B`;
    }
    if (value < 1024 * 1024) {
      return `${(value / 1024).toFixed(1)} KiB`;
    }
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
}
