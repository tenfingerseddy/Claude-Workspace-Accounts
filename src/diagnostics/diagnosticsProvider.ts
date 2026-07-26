import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { workspaceHash } from "../core/paths.js";
import { bindingIdentityState, buildQuotaReport } from "../core/statusState.js";
import { detectForeignOtelConfiguration } from "../telemetry/otelEnvironment.js";
import {
  activeDisableVariables,
  DISABLE_ENVIRONMENT_VARIABLE,
  LEGACY_DISABLE_ENVIRONMENT_VARIABLE
} from "../commands/uxModel.js";
import type { CollectionHealth } from "../core/models.js";
import type { LegacyMigrationReport } from "../migration/legacyMigration.js";
import { MIGRATION_REPORT } from "../migration/legacyMigration.js";
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
      || status?.identityCheckInactive === true;
    const choice = await vscode.window.showInformationMessage(
      needsIdentity
        ? "Claude Workspace Accounts diagnostics are redacted by default. This workspace's account cannot be matched against the identity recorded for it."
        : "Claude Workspace Accounts diagnostics are redacted by default.",
      ...(needsIdentity ? ["Update Expected Identity"] : []),
      "Copy Redacted Diagnostics"
    );
    if (choice === "Copy Redacted Diagnostics") {
      await vscode.env.clipboard.writeText(content);
      void vscode.window.showInformationMessage("Redacted diagnostics copied.");
    } else if (choice === "Update Expected Identity") {
      await vscode.commands.executeCommand("claudeAccounts.updateExpectedIdentity");
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
    const migration = await this.migrationState();
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
    // Names only, from the one shared detector. Two variables were checked here against the
    // twenty-five the wrapper refuses to override, so this report blamed the collector for a
    // refusal the user's own configuration had caused. A value could be a bearer token.
    const foreignOtel = detectForeignOtelConfiguration();
    // "The guard appears disabled and I don't know why" is exactly what a stranded legacy setx
    // value produces, so name whichever variable is actually set rather than only the current one.
    const disabled = activeDisableVariables(process.env);
    const detailed = this.collectionHealth(activeProfile?.id);
    const quota = buildQuotaReport({
      snapshot,
      warningThreshold: vscode.workspace.getConfiguration("claudeAccounts")
        .get<number>("usage.warningThreshold", 70),
      criticalThreshold: vscode.workspace.getConfiguration("claudeAccounts")
        .get<number>("usage.criticalThreshold", 90)
    });
    const quotaLines = [
      ...quota.windows.map((entry) => `- ${entry.label}: ${Math.round(entry.usedPercentage)}% used, ${Math.round(entry.remainingPercentage)}% remaining, ${entry.resetsAtIso ? `resets ${entry.resetsAtIso}${entry.expired ? " (already due)" : ` (${entry.resetsInLabel})`}` : "reset time not reported"}`),
      ...quota.absent.map((entry) => `- ${entry.label}: not reported — ${entry.detail}`)
    ].join("\n");

    return `# Claude Workspace Accounts — Redacted Diagnostics

- Generated: ${new Date().toISOString()}
- Extension version: ${String(this.context.extension.packageJSON.version)}
- VS Code version: ${vscode.version}
- Claude Code version: ${this.binaryResolver.installedVersion() ?? "Not installed"}
- Platform: ${process.platform}-${process.arch}
- Workspace account: ${boundProfile ? `${boundProfile.displayName} (${lock?.mode} mode)` : "None — uses the default account"}
- Workspace account applied: ${boundProfile ? (this.actions?.wrapperState() === "guard" ? "Yes, by the Workspace Accounts wrapper" : "No — Claude Code does not launch through Workspace Accounts") : "N/A"}
- Account in play here: ${activeProfile?.displayName ?? "Not tracked by Workspace Accounts"}
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
- Collection phase: ${detailed?.phase ?? "Unavailable"}
- Local storage last successful write: ${detailed?.storage.lastSuccessfulWriteAt ?? "Never"}
- Local storage last failure: ${detailed?.storage.lastFailureAt ? `${detailed.storage.lastFailureAt} (${detailed.storage.lastFailureCategory ?? "category unavailable"})` : "None"}
- Local storage currently failing: ${detailed?.phase === "storage_failed" ? `Yes — nothing has been written since the failure, so any figure shown may be frozen` : "No"}
- Your own OTEL configuration present: ${foreignOtel.present ? `Yes — ${foreignOtel.variables.join(", ")} (names only; Workspace Accounts will not override these, so its collector receives nothing)` : "No"}
- Workspace URI hash: ${workspace ? workspaceHash(workspace.canonicalPath) : "No workspace"}
- Auth status: ${current?.verification?.state ?? "Not checked"}
- Auth error category: ${current?.verification?.errorCategory ?? "None"}
- Collector status: ${health.status ?? "Inactive"}
- Collector last event: ${health.lastEventAt ?? "Never"}
- Status snapshot: ${snapshot ? `Available (${snapshot.capturedAt})` : "Unavailable — no Claude session has run under this account"}

## Quota reported by Claude

Claude's own figures, from the status line. Reading taken ${quota.capturedAt ?? "never"}${quota.ageLabel ? ` (${quota.ageLabel}${quota.freshness === "stale" ? ", stale" : ""})` : ""}.

${quotaLines}

Per-model windows and extra-usage credit pools are not exposed to third-party extensions, so they are not reported here. Warning and critical thresholds are local preferences, not Anthropic policy.

## Wrapper, integration, and local data

- Wrapper path: ${redact(expectedWrapper)}
- Wrapper last exit category: ${wrapperHealth.category ?? "Unavailable"}
- Wrapper last exit code: ${wrapperHealth.exitCode ?? "Unavailable"}
- Wrapper last update: ${wrapperHealth.updatedAt ?? "Never"}
- Configured wrapper: ${redact(configuredWrapper)}
- Wrapper conflict: ${conflict ? "Yes" : "No"}
- Claude Code integration: ${this.actions ? (this.actions.wrapperState() === "guard" ? "On — Claude Code launches through Workspace Accounts" : this.actions.wrapperState() === "foreign" ? "Another tool's wrapper is configured" : "Off — per-workspace accounts are not applied") : "Unavailable"}
- Upgrade from Claude Account Guard: ${migration.summary}
- Upgrade items still needing attention: ${migration.failures.length > 0 ? migration.failures.join("; ") : "None"}
- Previous support directory: ${migration.legacyRoot ? `${redact(migration.legacyRoot)} — ${migration.blocked ? "DO NOT DELETE: the migration stopped before it could prove your accounts had been copied, so this is still the only complete copy" : "copied, not deleted; safe to delete by hand once you are satisfied nothing is missing"}` : "Not present"}
- Undo integration: run "Claude Workspace Accounts: Disconnect From Claude Code", or clear claudeCode.claudeProcessWrapper in settings.json and reload the window
- Bypass without uninstalling: set ${DISABLE_ENVIRONMENT_VARIABLE}=1 in the environment (the v0.1.0 name ${LEGACY_DISABLE_ENVIRONMENT_VARIABLE}=1 is still honoured)
- Kill switch currently set: ${disabled.length > 0 ? `Yes — ${disabled.join(", ")}. Per-workspace accounts and usage collection are bypassed until it is cleared${disabled.includes(LEGACY_DISABLE_ENVIRONMENT_VARIABLE) ? `; ${LEGACY_DISABLE_ENVIRONMENT_VARIABLE} is the old name and may be a persistent setx value left from Claude Account Guard` : ""}` : "No"}
- SQLite size: ${this.formatBytes(this.repository.databaseSize())}
- Raw event retention: ${vscode.workspace.getConfiguration("claudeAccounts").get<number>("telemetry.retentionDays", 30)} days
- Prompt/response/tool content collection: ${foreignOtel.present ? "Not applicable — your own OTEL pipeline is in use, so Workspace Accounts injects and overrides nothing" : disabled.length > 0 ? "Not applicable — the kill switch is set, so the wrapper changes no environment variable at all" : "Disabled — the wrapper forces the five OTEL_LOG_* flags to 0 on every wrapped launch"}
- Credential file access: Never

This report excludes email addresses, account and organization identifiers, raw authentication output, tokens, command payloads, and full workspace paths.
`;
  }

  /** Never allowed to throw: this report is where a user lands when nothing else explains itself. */
  private collectionHealth(profileId?: string): CollectionHealth | undefined {
    try {
      return this.repository.collectionHealth(profileId, {
        telemetryEnabled: vscode.workspace.getConfiguration("claudeAccounts")
          .get<boolean>("telemetry.enabled", true),
        runtimeProfileRegistered: Boolean(profileId)
      });
    } catch {
      return undefined;
    }
  }

  private async fileExists(candidate: string): Promise<boolean> {
    try {
      await readFile(candidate);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The rename migration's own record, read back from disk.
   *
   * A migration that silently half-succeeded would leave the user with some accounts and no
   * explanation, so its outcome is retrievable here rather than only in a notification that has
   * already been dismissed.
   */
  private async migrationState(): Promise<{
    summary: string;
    failures: string[];
    legacyRoot?: string;
    blocked: boolean;
  }> {
    try {
      const content = await readFile(
        path.join(this.registry.paths.root, MIGRATION_REPORT),
        "utf8"
      );
      const value = JSON.parse(content.replace(/^\uFEFF/, "")) as Partial<LegacyMigrationReport>;
      if (!value.legacyInstallationFound) {
        return {
          summary: "Not applicable — no previous installation was found",
          failures: [],
          blocked: false
        };
      }
      const failures = Array.isArray(value.failures)
        ? value.failures.filter((entry): entry is string => typeof entry === "string")
        : [];
      // Read the outcome the migration recorded rather than inferring it from a failure count.
      // A barrier stop is not an ordinary partial failure: nothing was repointed, the previous
      // installation is still the one Claude Code launches through, and the old support directory
      // holds the only complete copy of the accounts. Inferring left that indistinguishable from
      // "some items need attention" — the one state in which deleting the old directory is safe.
      const blockedBy = typeof value.blockedBy === "string" && value.blockedBy
        ? value.blockedBy
        : undefined;
      return {
        summary: blockedBy
          ? `Stopped safely as of ${value.completedAt ?? "an unknown time"} — nothing was changed, because ${blockedBy}. Your previous installation is still the one Claude Code launches through.`
          : failures.length > 0
            ? `Incomplete as of ${value.completedAt ?? "an unknown time"}`
            : `Complete as of ${value.completedAt ?? "an unknown time"}`,
        failures,
        legacyRoot: typeof value.legacyRoot === "string" ? value.legacyRoot : undefined,
        blocked: Boolean(blockedBy)
      };
    } catch {
      return {
        summary: "No record — this install has not migrated anything",
        failures: [],
        blocked: false
      };
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
