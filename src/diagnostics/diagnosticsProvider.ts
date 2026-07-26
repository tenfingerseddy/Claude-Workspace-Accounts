import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { workspaceHash } from "../core/paths.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import type { ClaudeBinaryResolver } from "../auth/authVerifier.js";
import type { StatusBarController } from "../statusbar/statusBarController.js";

export class DiagnosticsProvider {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry,
    private readonly runtimeDetector: RuntimeProfileDetector,
    private readonly lockService: WorkspaceLockService,
    private readonly repository: UsageRepository,
    private readonly binaryResolver: ClaudeBinaryResolver,
    private readonly statusBar: StatusBarController
  ) {}

  public async show(): Promise<void> {
    const content = await this.redactedReport();
    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content
    });
    await vscode.window.showTextDocument(document, { preview: true });
    const choice = await vscode.window.showInformationMessage(
      "Claude Account Guard diagnostics are redacted by default.",
      "Copy Redacted Diagnostics"
    );
    if (choice === "Copy Redacted Diagnostics") {
      await vscode.env.clipboard.writeText(content);
      void vscode.window.showInformationMessage("Redacted diagnostics copied.");
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
    const health = runtime.profile
      ? this.repository.collectorHealth(runtime.profile.id)
      : {};
    const snapshot = runtime.profile
      ? this.repository.latestStatusSnapshot(runtime.profile.id)
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

    return `# Claude Account Guard — Redacted Diagnostics

- Generated: ${new Date().toISOString()}
- Extension version: ${String(this.context.extension.packageJSON.version)}
- VS Code version: ${vscode.version}
- Claude Code version: ${this.binaryResolver.installedVersion() ?? "Not installed"}
- Platform: ${process.platform}-${process.arch}
- Runtime profile: ${runtime.profile?.displayName ?? "Unregistered"}
- Expected profile: ${current?.requiredProfile?.displayName ?? "None"}
- Workspace URI hash: ${workspace ? workspaceHash(workspace.canonicalPath) : "No workspace"}
- Workspace lock: ${lock ? `${lock.mode} / ${lock.profileId}` : "None"}
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
- SQLite size: ${this.formatBytes(this.repository.databaseSize())}
- Raw event retention: ${vscode.workspace.getConfiguration("claudeAccountGuard").get<number>("telemetry.retentionDays", 30)} days
- Prompt/response/tool content collection: Disabled
- Credential file access: Never

This report excludes email addresses, account and organization identifiers, raw authentication output, tokens, command payloads, and full workspace paths.
`;
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
