import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import type { AuthVerifier } from "../auth/authVerifier.js";
import { compareIdentity } from "../core/identity.js";
import type {
  AccountProfile,
  AuthVerification,
  LockMode
} from "../core/models.js";
import {
  normalizeWindowsPath,
  pathContains,
  profileMarker,
  safeProfileId
} from "../core/paths.js";
import type { DashboardProvider } from "../dashboard/dashboardProvider.js";
import type { DiagnosticsProvider } from "../diagnostics/diagnosticsProvider.js";
import type { IsolatedWindowLauncher } from "../launcher/isolatedWindowLauncher.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import type { StatusBarController } from "../statusbar/statusBarController.js";
import type { StatusLineBridgeService } from "../telemetry/statusLineBridgeService.js";

interface ProfileExport {
  schemaVersion: 1;
  exportedAt: string;
  profiles: AccountProfile[];
}

export class CommandController {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry,
    private readonly runtimeDetector: RuntimeProfileDetector,
    private readonly authVerifier: AuthVerifier,
    private readonly lockService: WorkspaceLockService,
    private readonly launcher: IsolatedWindowLauncher,
    private readonly statusLineBridge: StatusLineBridgeService,
    private readonly repository: UsageRepository,
    private readonly statusBar: StatusBarController,
    private readonly dashboard: DashboardProvider,
    private readonly diagnostics: DiagnosticsProvider
  ) {}

  public register(): void {
    const registrations: Array<[string, (...args: unknown[]) => unknown]> = [
      ["claudeAccountGuard.openMenu", () => this.openMenu()],
      ["claudeAccountGuard.openDashboard", () => this.dashboard.open()],
      ["claudeAccountGuard.addProfile", () => this.addProfile()],
      ["claudeAccountGuard.registerCurrentProfile", () => this.registerCurrentProfile()],
      ["claudeAccountGuard.switchProfile", (profileId) => this.switchProfile(
        typeof profileId === "string" ? profileId : undefined
      )],
      ["claudeAccountGuard.lockWorkspace", () => this.lockWorkspace()],
      ["claudeAccountGuard.unlockWorkspace", () => this.unlockWorkspace()],
      ["claudeAccountGuard.verifyAccount", () => this.verifyAccount()],
      ["claudeAccountGuard.login", () => this.login()],
      ["claudeAccountGuard.manageProfiles", () => this.manageProfiles()],
      ["claudeAccountGuard.diagnostics", () => this.diagnostics.show()],
      ["claudeAccountGuard.deleteUsageData", () => this.deleteUsageData()],
      ["claudeAccountGuard.exportUsage", (profileId) => this.exportUsage(
        typeof profileId === "string" ? profileId : undefined
      )]
    ];
    for (const [command, handler] of registrations) {
      this.context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    }
  }

  public async firstRun(): Promise<void> {
    const document = await this.registry.read();
    if (document.profiles.length > 0 || !(await this.lockService.currentWorkspace())) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      "Claude Account Guard can register the Claude configuration inherited by this window or create an isolated account profile.",
      "Register current account as a profile",
      "Create another account profile",
      "Not now"
    );
    if (choice === "Register current account as a profile") {
      await this.registerCurrentProfile();
    } else if (choice === "Create another account profile") {
      await this.addProfile();
    }
  }

  private async openMenu(): Promise<void> {
    const current = await this.statusBar.refresh();
    const profile = current?.runtime.profile;
    const lock = current?.lock;
    const items: Array<vscode.QuickPickItem & { action?: string }> = [
      {
        label: profile ? `$(${profile.marker === "?" ? "account" : "verified"}) ${profile.displayName}` : "$(warning) Unregistered runtime",
        description: current?.verification?.email,
        detail: `Workspace: ${lock ? `locked to ${current?.requiredProfile?.displayName ?? lock.profileId} (${lock.mode})` : "unlocked"} · Last verified: ${current?.verification ? new Date(current.verification.checkedAt).toLocaleString() : "never"}`
      },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(graph) Open Usage Dashboard", action: "dashboard" },
      { label: "$(arrow-swap) Switch Account Profile…", action: "switch" },
      {
        label: lock ? "$(lock) Change Workspace Lock…" : "$(lock) Lock This Workspace…",
        action: "lock"
      },
      ...(lock ? [{ label: "$(unlock) Remove Workspace Lock", action: "unlock" }] : []),
      { label: "$(refresh) Verify Account Now", action: "verify" },
      { label: "$(key) Sign In to This Profile", action: "login" },
      { label: "$(settings-gear) Open Profile Settings", action: "profiles" },
      { label: "$(info) Diagnostics", action: "diagnostics" }
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: "Claude Account Guard",
      placeHolder: "Choose an account action"
    });
    switch (selected?.action) {
      case "dashboard": await this.dashboard.open(); break;
      case "switch": await this.switchProfile(); break;
      case "lock": await this.lockWorkspace(); break;
      case "unlock": await this.unlockWorkspace(); break;
      case "verify": await this.verifyAccount(); break;
      case "login": await this.login(); break;
      case "profiles": await this.manageProfiles(); break;
      case "diagnostics": await this.diagnostics.show(); break;
    }
  }

  private async registerCurrentProfile(): Promise<void> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    if (runtime.profile) {
      void vscode.window.showInformationMessage(
        `This window is already registered as ${runtime.profile.displayName}.`
      );
      return;
    }
    const displayName = await this.askDisplayName("Current");
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
      vsCodeUserDataDir: path.join(this.registry.paths.root, "vscode", id),
      createdAt: new Date().toISOString()
    };
    const verification = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Verifying ${displayName} through claude auth status`,
        cancellable: false
      },
      () => this.authVerifier.verify(profile, true)
    );
    if (!(await this.confirmIdentity(profile, verification, false))) {
      return;
    }
    await this.registry.upsertProfile(profile);
    await this.maybeInstallStatusBridge(profile);
    await this.synchronizeAndRefresh();
    void vscode.window.showInformationMessage(`${displayName} is registered.`, "Lock This Workspace")
      .then((choice) => choice === "Lock This Workspace" ? this.lockProfile(profile) : undefined);
  }

  private async addProfile(): Promise<void> {
    const document = await this.registry.read();
    const displayName = await this.askDisplayName();
    if (!displayName) {
      return;
    }
    const id = safeProfileId(displayName, new Set(document.profiles.map((profile) => profile.id)));
    const configDir = await vscode.window.showInputBox({
      title: "Claude configuration directory",
      prompt: "This directory remains owned by Claude Code. Account Guard never reads its credentials.",
      value: path.join(os.homedir(), `.claude-${id}`),
      validateInput: this.validateAbsolutePath
    });
    if (!configDir) {
      return;
    }
    const vsCodeUserDataDir = await vscode.window.showInputBox({
      title: "Isolated VS Code user data directory",
      value: path.join(this.registry.paths.root, "vscode", id),
      validateInput: this.validateAbsolutePath
    });
    if (!vsCodeUserDataDir) {
      return;
    }
    const normalizedConfigDir = normalizeWindowsPath(configDir);
    const normalizedVsCodeUserDataDir = normalizeWindowsPath(vsCodeUserDataDir);
    const requestedDirectories = [normalizedConfigDir, normalizedVsCodeUserDataDir];
    const existingDirectories = document.profiles.flatMap((profile) => [
      profile.configDirNormalized,
      normalizeWindowsPath(profile.vsCodeUserDataDir)
    ]);
    if (pathContains(normalizedConfigDir, normalizedVsCodeUserDataDir)
      || pathContains(normalizedVsCodeUserDataDir, normalizedConfigDir)
      || existingDirectories.some((existing) => requestedDirectories.some((requested) =>
        pathContains(existing, requested) || pathContains(requested, existing)))) {
      void vscode.window.showErrorMessage(
        "Claude and VS Code isolation directories must be distinct and cannot be nested inside another profile directory."
      );
      return;
    }

    const profile: AccountProfile = {
      id,
      displayName,
      marker: profileMarker(displayName),
      configDir,
      configDirNormalized: normalizedConfigDir,
      vsCodeUserDataDir,
      createdAt: new Date().toISOString()
    };
    await Promise.all([
      mkdir(configDir, { recursive: true }),
      mkdir(vsCodeUserDataDir, { recursive: true })
    ]);
    await this.registry.upsertProfile(profile);
    await this.maybeInstallStatusBridge(profile);
    this.repository.mirrorRegistry(await this.registry.read());
    const readiness = await this.launcher.launch(profile);
    if (readiness?.ready) {
      void vscode.window.showInformationMessage(`${displayName} opened and verified in an isolated window.`);
    } else {
      void vscode.window.showInformationMessage(
        `${displayName} was created. Complete Claude sign-in in the isolated window, then run “Verify Account”.`
      );
    }
  }

  private async switchProfile(profileId?: string): Promise<void> {
    const profiles = await this.registry.listProfiles();
    if (profiles.length === 0) {
      await this.addProfile();
      return;
    }
    let profile = profileId ? profiles.find((candidate) => candidate.id === profileId) : undefined;
    if (!profile) {
      const choices = await Promise.all(profiles.map(async (candidate) => {
        const verification = await this.authVerifier.verify(candidate);
        const snapshot = this.repository.latestStatusSnapshot(candidate.id);
        const quota = [
          snapshot?.rateLimits?.fiveHour
            ? `5h ${Math.round(snapshot.rateLimits.fiveHour.usedPercentage)}%`
            : undefined,
          snapshot?.rateLimits?.sevenDay
            ? `7d ${Math.round(snapshot.rateLimits.sevenDay.usedPercentage)}%`
            : undefined
        ].filter(Boolean).join(" · ");
        return {
          label: `${candidate.marker}  ${candidate.displayName}`,
          description: verification.state === "signed_in"
            ? verification.email ?? "Signed in"
            : verification.state === "signed_out" ? "Signed out" : "Verification unavailable",
          detail: quota || "Usage unavailable",
          profile: candidate
        };
      }));
      profile = (await vscode.window.showQuickPick(choices, {
        title: "Switch Account Profile",
        placeHolder: "The current window stays open"
      }))?.profile;
    }
    if (!profile) {
      return;
    }
    const readiness = await this.launcher.launch(profile);
    if (readiness?.ready) {
      void vscode.window.showInformationMessage(
        `${profile.displayName} is ready in the new window. You may close this window manually.`
      );
    } else if (readiness) {
      void vscode.window.showWarningMessage(
        `${profile.displayName} opened, but Account Guard did not mark it ready: ${readiness.detail ?? "verification incomplete"}.`
      );
    } else {
      void vscode.window.showWarningMessage(
        `${profile.displayName} opened, but readiness was not confirmed within 30 seconds. The original window remains open.`
      );
    }
  }

  private async lockWorkspace(): Promise<void> {
    const profiles = (await this.registry.listProfiles()).filter((profile) => profile.expectedIdentity);
    if (profiles.length === 0) {
      void vscode.window.showErrorMessage("Verify at least one account profile before locking a workspace.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: `${profile.marker}  ${profile.displayName}`,
        description: profile.expectedIdentity?.email,
        profile
      })),
      { title: "Lock This Workspace", placeHolder: "Choose the intended verified identity" }
    );
    if (!selected) {
      return;
    }
    await this.lockProfile(selected.profile);
  }

  private async lockProfile(profile: AccountProfile): Promise<void> {
    const defaultMode = vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<LockMode>("defaultLockMode", "enforce");
    const mode = await vscode.window.showQuickPick<{
      label: string;
      description: string;
      mode: LockMode;
    }>([
      { label: "$(shield) Enforce", description: "Block Claude before launch on any mismatch", mode: "enforce" },
      { label: "$(warning) Warn", description: "Show the mismatch without blocking", mode: "warn" },
      { label: "$(circle-slash) Off", description: "Keep a disabled binding", mode: "off" }
    ], {
      title: `Lock workspace to ${profile.displayName}`,
      placeHolder: `Default: ${defaultMode}`
    });
    if (!mode) {
      return;
    }
    const identityLabel = [
      profile.expectedIdentity?.email ?? "verified identity",
      profile.expectedIdentity?.organizationName ?? profile.expectedIdentity?.organizationId
    ].filter(Boolean).join(" · ");
    const confirmed = await vscode.window.showWarningMessage(
      `Bind this workspace to ${profile.displayName} (${identityLabel}) in ${mode.mode} mode? The binding is stored outside the repository.`,
      { modal: true },
      "Create Lock"
    );
    if (confirmed !== "Create Lock") {
      return;
    }
    await this.lockService.lock(profile, mode.mode);
    await this.synchronizeAndRefresh();
  }

  private async unlockWorkspace(): Promise<void> {
    const lock = await this.lockService.currentLock();
    if (!lock) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      "Remove this workspace's Claude account lock?",
      { modal: true },
      "Remove Lock"
    );
    if (confirmed === "Remove Lock") {
      await this.lockService.unlock();
      await this.synchronizeAndRefresh();
    }
  }

  private async verifyAccount(): Promise<void> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    if (!runtime.profile) {
      const choice = await vscode.window.showWarningMessage(
        "The runtime Claude configuration is not registered.",
        "Register Current Account"
      );
      if (choice === "Register Current Account") {
        await this.registerCurrentProfile();
      }
      return;
    }
    const verification = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Verifying ${runtime.profile.displayName}`,
        cancellable: false
      },
      () => this.authVerifier.verify(runtime.profile!, true)
    );
    if (await this.confirmIdentity(runtime.profile, verification, true)) {
      await this.registry.upsertProfile(runtime.profile);
      await this.synchronizeAndRefresh(true);
      void vscode.window.showInformationMessage(`${runtime.profile.displayName} is verified.`);
    }
  }

  private async login(): Promise<void> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    if (!runtime.profile) {
      void vscode.window.showErrorMessage("Register the runtime profile before starting Claude sign-in.");
      return;
    }
    const continueLogin = await vscode.window.showInformationMessage(
      "Claude owns the browser sign-in flow. If the browser selects the wrong Claude account, choose the intended browser profile or sign out there; Account Guard does not control browser sessions.",
      { modal: true },
      "Continue to Sign In"
    );
    if (continueLogin !== "Continue to Sign In") {
      return;
    }
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Signing in to ${runtime.profile.displayName}`,
          cancellable: true
        },
        async (_progress, token) => {
          await this.authVerifier.login(runtime.profile!, token);
        }
      );
      await this.verifyAccount();
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Claude sign-in did not complete: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  private async manageProfiles(): Promise<void> {
    const profiles = await this.registry.listProfiles();
    const selection = await vscode.window.showQuickPick<
      vscode.QuickPickItem & { action: string; profile?: AccountProfile }
    >([
      { label: "$(add) Add Account Profile", action: "add" },
      { label: "$(export) Export Profile Metadata", action: "export" },
      { label: "$(cloud-download) Import Profile Metadata", action: "import" },
      { label: "", kind: vscode.QuickPickItemKind.Separator, action: "separator" },
      ...profiles.map((profile) => ({
        label: `$(trash) Delete ${profile.displayName} Metadata`,
        description: profile.expectedIdentity?.email,
        action: "delete",
        profile
      }))
    ], { title: "Manage Claude Account Profiles" });
    if (!selection) {
      return;
    }
    if (selection.action === "add") {
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
      title: "Export Claude Account Guard Profile Metadata",
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
    const selected = await vscode.window.showOpenDialog({
      title: "Import Claude Account Guard Profile Metadata",
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
      await this.synchronizeAndRefresh();
      void vscode.window.showInformationMessage("Profile metadata imported. Verify each identity before creating an enforced lock.");
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Profile metadata was not imported: ${error instanceof Error ? error.message : "invalid file"}`
      );
    }
  }

  private async deleteProfile(profile: AccountProfile): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      `Delete only the Account Guard metadata for ${profile.displayName}? Claude settings and credentials remain in place; local usage is deleted separately.`,
      { modal: true },
      "Delete Profile Metadata"
    );
    if (confirmed !== "Delete Profile Metadata") {
      return;
    }
    await this.statusLineBridge.uninstall(profile).catch(() => undefined);
    await this.registry.deleteProfile(profile.id);
    this.repository.deleteProfileMetadata(profile.id);
    await this.synchronizeAndRefresh();
  }

  private async deleteUsageData(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      "Delete all locally collected usage, status snapshots, and diagnostics? Profiles, workspace locks, Claude settings, and credentials are not deleted.",
      { modal: true },
      "Delete Usage Data"
    );
    if (confirmed === "Delete Usage Data") {
      this.repository.deleteUsageData();
      await this.statusBar.refresh();
      await this.dashboard.refresh();
      void vscode.window.showInformationMessage("Local usage data deleted.");
    }
  }

  private async exportUsage(profileId?: string): Promise<void> {
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

  private async confirmIdentity(
    profile: AccountProfile,
    verification: AuthVerification,
    allowDrift: boolean
  ): Promise<boolean> {
    if (verification.state === "signed_out") {
      void vscode.window.showWarningMessage(
        `${profile.displayName} is signed out.`,
        "Sign In"
      ).then((choice) => choice === "Sign In" ? this.login() : undefined);
      return false;
    }
    if (verification.state !== "signed_in"
      || (!verification.email && !verification.accountId)) {
      void vscode.window.showErrorMessage(
        `Account identity could not be verified (${verification.errorCategory ?? "unavailable"}). No identity metadata was changed.`
      );
      return false;
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
      void vscode.window.showErrorMessage(
        `Claude returned an authenticated status for ${profile.displayName}, but not enough stable identity metadata to compare it safely. Stored identity metadata was not changed.`
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

  private async maybeInstallStatusBridge(profile: AccountProfile): Promise<void> {
    if (!vscode.workspace.getConfiguration("claudeAccountGuard")
      .get<boolean>("telemetry.enabled", true)) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Enable privacy-minimized local usage collection for ${profile.displayName}? Existing Claude status-line output is chained and preserved.`,
      { modal: true },
      "Enable Local Usage",
      "Not Now"
    );
    if (choice === "Enable Local Usage") {
      try {
        await this.statusLineBridge.install(profile);
        profile.telemetryEnabled = true;
        await this.registry.upsertProfile(profile);
      } catch (error) {
        void vscode.window.showWarningMessage(
          `The profile was saved, but its status-line bridge was not installed: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    } else {
      profile.telemetryEnabled = false;
      await this.registry.upsertProfile(profile);
    }
  }

  private async synchronizeAndRefresh(force = false): Promise<void> {
    this.repository.mirrorRegistry(await this.registry.read());
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

  private readonly validateAbsolutePath = (value: string): string | undefined => {
    if (!path.isAbsolute(value)) {
      return "Enter an absolute Windows path.";
    }
    if (value.toLocaleLowerCase().endsWith(".credentials.json")) {
      return "Credential files cannot be selected.";
    }
    return undefined;
  };
}
