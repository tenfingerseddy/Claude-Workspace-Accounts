import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type {
  CollectionHealth,
  DashboardData,
  DashboardDateBounds,
  DashboardRange,
  QuotaReport,
  SharedRegistryDocument
} from "../core/models.js";
import { bindingIdentityState, buildQuotaReport, selectUsageAccount } from "../core/statusState.js";
import type { CollectionDiagnosis, WrapperState } from "../commands/uxModel.js";
import type { BindingIdentityState } from "../core/statusState.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import { parseDashboardMessage } from "./dashboardMessages.js";
import { readQuotaCache } from "../usage/quotaCache.js";

/**
 * The parts of the command controller the dashboard needs. Declared as an interface so the
 * dashboard can explain and fix an empty state without importing the controller itself.
 */
export interface DashboardActions {
  collectionDiagnosis(
    document: SharedRegistryDocument,
    selectedProfileId?: string
  ): CollectionDiagnosis;
  runCollectionAction(diagnosis: CollectionDiagnosis): Promise<void>;
  wrapperState(): WrapperState;
}

interface DashboardPayload extends DashboardData {
  /**
   * The headline. Claude's own plan-headroom figures, derived by the one shared function so the
   * dashboard, the status bar and diagnostics cannot disagree about what Claude said or how old
   * the reading is. Everything else on this page is locally accumulated and therefore secondary:
   * it starts when the extension is installed and measures nothing about the plan.
   */
  quota: QuotaReport;
  /** Whether local usage storage is currently refusing writes, and why. */
  storage: {
    failing: boolean;
    category?: string;
    lastFailureAt?: string;
    lastSuccessfulWriteAt?: string;
  };
  setup: {
    /** How the bound account's identity compares with the one recorded for it. */
    identityState: BindingIdentityState;
    /** The account this workspace is bound to, if any. */
    boundProfileName?: string;
    workspaceLabel?: string;
    /** True when the account in play here is one Workspace Accounts knows about. */
    runtimeRegistered: boolean;
    runtimeConfigDir: string;
    wrapperState: WrapperState;
    profileTelemetryEnabled: boolean;
    collection: CollectionDiagnosis;
  };
}

/**
 * Kept in workspace state, unlike every other preference here.
 *
 * Which account you are looking at is a fact about one workspace; a range or a thread scope is a
 * preference about the page. Stored globally, one look at another account's history followed the
 * user into every workspace they opened and overrode the binding there — the same wrong-account
 * dashboard, arrived at a different way.
 */
const PROFILE_STATE_KEY = "dashboard.selectedProfileId";
const RANGE_STATE_KEY = "dashboard.range";
const THREAD_SCOPE_STATE_KEY = "dashboard.threadScope";
const CUSTOM_FROM_STATE_KEY = "dashboard.customFrom";
const CUSTOM_TO_STATE_KEY = "dashboard.customTo";

function localDate(offsetDays = 0): string {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export class DashboardProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private actions?: DashboardActions;
  private selectedProfileId?: string;
  private range: DashboardRange;
  private threadScope: "main" | "all";
  private customRange: DashboardDateBounds;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: ProfileRegistry,
    private readonly repository: UsageRepository,
    private readonly runtimeDetector: RuntimeProfileDetector,
    private readonly lockService: WorkspaceLockService,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.selectedProfileId = context.workspaceState.get<string>(PROFILE_STATE_KEY);
    this.range = context.globalState.get<DashboardRange>(
      RANGE_STATE_KEY,
      vscode.workspace.getConfiguration("claudeAccounts").get<DashboardRange>(
        "dashboard.defaultRange",
        "7d"
      )
    );
    this.threadScope = context.globalState.get<"main" | "all">(
      THREAD_SCOPE_STATE_KEY,
      "main"
    );
    this.customRange = {
      from: context.globalState.get<string>(CUSTOM_FROM_STATE_KEY, localDate(-6)),
      to: context.globalState.get<string>(CUSTOM_TO_STATE_KEY, localDate())
    };
  }

  /** Wired after commands are registered so the dashboard can offer the fix it names. */
  public useController(actions: DashboardActions): void {
    this.actions = actions;
  }

  public async open(profileId?: string): Promise<void> {
    if (profileId) {
      this.selectedProfileId = profileId;
    }
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "claudeAccounts.usage",
        "Claude Quota and Usage",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: []
        }
      );
      this.panel.iconPath = vscode.Uri.file(this.context.asAbsolutePath("resources/icon.svg"));
      this.panel.webview.html = this.html(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(
        // A rejected action used to disappear entirely: the button appeared to do nothing.
        (raw) => void this.receiveMessage(raw).catch((error: unknown) => {
          this.log(`Dashboard action failed: ${error instanceof Error ? error.message : "unknown error"}`);
          void vscode.window.showWarningMessage(
            `That dashboard action did not complete: ${error instanceof Error ? error.message : "unknown error"}`
          );
        }),
        undefined,
        this.context.subscriptions
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.context.subscriptions);
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
    await this.refresh();
  }

  /**
   * Push fresh data, or an explicit failure.
   *
   * Refreshes are fire-and-forget from several call sites, so a throw here used to leave
   * the panel stuck on "Loading local account usage…" with no explanation at all.
   */
  public async refresh(): Promise<void> {
    if (!this.panel) {
      return;
    }
    let payload: DashboardPayload;
    try {
      payload = await this.buildData();
    } catch (error) {
      await this.panel.webview.postMessage({
        type: "dashboardError",
        message: error instanceof Error ? error.message : "Unknown error"
      }).then(undefined, () => undefined);
      return;
    }
    await this.panel.webview
      .postMessage({ type: "dashboardData", payload })
      .then(undefined, () => undefined);
  }

  public dispose(): void {
    this.panel?.dispose();
  }

  private async receiveMessage(raw: unknown): Promise<void> {
    const message = parseDashboardMessage(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case "setProfile":
        this.selectedProfileId = message.profileId;
        await this.context.workspaceState.update(PROFILE_STATE_KEY, message.profileId);
        await this.refresh();
        break;
      case "setRange":
        this.range = message.range;
        await this.context.globalState.update(RANGE_STATE_KEY, message.range);
        await this.refresh();
        break;
      case "setCustomRange":
        this.customRange = { from: message.from, to: message.to };
        this.range = "custom";
        await Promise.all([
          this.context.globalState.update(CUSTOM_FROM_STATE_KEY, message.from),
          this.context.globalState.update(CUSTOM_TO_STATE_KEY, message.to),
          this.context.globalState.update(RANGE_STATE_KEY, "custom")
        ]);
        await this.refresh();
        break;
      case "setThreadScope":
        this.threadScope = message.threadScope;
        await this.context.globalState.update(THREAD_SCOPE_STATE_KEY, message.threadScope);
        await this.refresh();
        break;
      case "switchProfile":
        await vscode.commands.executeCommand("claudeAccounts.switchProfile", message.profileId);
        break;
      case "changeLock":
        await vscode.commands.executeCommand("claudeAccounts.bindWorkspace");
        await this.refresh();
        break;
      case "refresh":
        await vscode.commands.executeCommand("claudeAccounts.verifyAccount");
        await this.refresh();
        break;
      case "export":
        await vscode.commands.executeCommand("claudeAccounts.exportUsage", message.profileId);
        break;
      case "retry":
        await this.refresh();
        break;
      case "collectionAction": {
        if (this.actions) {
          const diagnosis = this.actions.collectionDiagnosis(
            await this.registry.read(),
            this.selectedProfileId
          );
          await this.actions.runCollectionAction(diagnosis);
        }
        await this.refresh();
        break;
      }
    }
  }

  /** Degrades to "no phase reported" rather than failing the whole panel. */
  private collectionHealth(profileId?: string): CollectionHealth | undefined {
    try {
      return this.repository.collectionHealth(profileId, {
        telemetryEnabled: vscode.workspace.getConfiguration("claudeAccounts")
          .get<boolean>("telemetry.enabled", true),
        runtimeProfileRegistered: Boolean(profileId)
      });
    } catch (error) {
      this.log(`Collection health unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  }

  private async buildData(): Promise<DashboardPayload> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    const lock = await this.lockService.currentLock();
    const requiredProfile = lock
      ? document.profiles.find((profile) => profile.id === lock.profileId)
      : undefined;
    // The wrapper sets CLAUDE_CONFIG_DIR per launch, so the account in play here is the
    // bound one when there is a binding, not whatever this window inherited.
    const bound = lock && lock.mode !== "off" ? requiredProfile : undefined;
    const activeProfile = bound ?? runtime.profile;
    // Resolved after the binding, and by the shared selector, because this page used to open on
    // the first account in the registry in exactly the case the product exists for: a workspace
    // bound to an account other than the ambient default.
    const selected = selectUsageAccount({
      profiles: document.profiles,
      requestedId: this.selectedProfileId,
      inPlay: activeProfile
    });
    this.selectedProfileId = selected?.id;
    const runtimeVerification = activeProfile
      ? this.repository.latestAuthVerification(activeProfile.id)
      : undefined;
    // One shared status model: only a real mismatch is a problem. Signed-out and
    // "the CLI reported no identity" both allow the launch, and the dashboard used to render
    // them as a wrong account.
    const identityState = bindingIdentityState({
      lock,
      boundProfile: bound,
      verification: runtimeVerification
    });
    const lockCompatible = identityState !== "mismatch";
    const current = selected ? this.repository.latestStatusSnapshot(selected.id) : undefined;
    const health = selected ? this.repository.collectorHealth(selected.id) : {};
    const lastEventAge = health.lastEventAt ? Date.now() - Date.parse(health.lastEventAt) : Infinity;
    const detailed = this.collectionHealth(selected?.id);

    // Read from the selected account's own directory, so viewing another account's quota works
    // without that account having a session, a bridge, or collection enabled.
    const quotaCache = selected ? await readQuotaCache(selected.configDir) : undefined;

    return {
      quota: buildQuotaReport({
        cache: quotaCache,
        snapshot: current,
        warningThreshold: vscode.workspace.getConfiguration("claudeAccounts")
          .get<number>("usage.warningThreshold", 70),
        criticalThreshold: vscode.workspace.getConfiguration("claudeAccounts")
          .get<number>("usage.criticalThreshold", 90)
      }),
      storage: {
        failing: detailed?.phase === "storage_failed",
        category: detailed?.storage.lastFailureCategory,
        lastFailureAt: detailed?.storage.lastFailureAt,
        lastSuccessfulWriteAt: detailed?.storage.lastSuccessfulWriteAt
      },
      generatedAt: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      selectedProfileId: selected?.id,
      runtimeProfileId: activeProfile?.id,
      range: this.range,
      customRange: this.customRange,
      threadScope: this.threadScope,
      thresholds: {
        usageWarning: vscode.workspace.getConfiguration("claudeAccounts")
          .get<number>("usage.warningThreshold", 70),
        usageCritical: vscode.workspace.getConfiguration("claudeAccounts")
          .get<number>("usage.criticalThreshold", 90),
        contextWarning: vscode.workspace.getConfiguration("claudeAccounts")
          .get<number>("context.warningThreshold", 80)
      },
      profiles: document.profiles.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        marker: profile.marker,
        email: profile.expectedIdentity?.email,
        // Name only. The organization ID is a UUID, and printed beside the address in the header it
        // was the longest string on the page while telling the reader nothing they could use.
        organization: profile.expectedIdentity?.organizationName,
        authMethod: profile.authMethod,
        lastVerifiedAt: profile.lastVerifiedAt
      })),
      lock: lock && lock.mode !== "off" ? {
        mode: lock.mode,
        profileId: lock.profileId,
        profileName: requiredProfile?.displayName,
        requiredEmail: requiredProfile?.expectedIdentity?.email,
        requiredOrganization: requiredProfile?.expectedIdentity?.organizationName
          ?? requiredProfile?.expectedIdentity?.organizationId,
        runtimeProfileName: activeProfile?.displayName,
        runtimeEmail: runtimeVerification?.email,
        runtimeOrganization: runtimeVerification?.organizationName
          ?? runtimeVerification?.organizationId,
        workspaceLabel: lock.workspaceLabel,
        compatible: lockCompatible
      } : undefined,
      current,
      daily: selected
        ? this.repository.daily(selected.id, this.range, this.customRange)
          .filter((row) => this.threadScope === "all" || row.querySource === "main")
        : [],
      attribution: selected
        ? this.repository.attribution(
          selected.id,
          this.range,
          this.threadScope,
          this.customRange
        )
        : [],
      reliability: selected
        ? this.repository.reliability(selected.id, this.range, this.customRange)
        : {
            requests: 0,
            errors: 0,
            tools: [],
            permissionDecisions: [],
            authFailures: 0,
            mcpFailures: 0
          },
      collection: {
        status: !selected
          ? "inactive"
          : lastEventAge < 15 * 60_000
            ? "active"
            : health.lastEventAt
              ? "awaiting_data"
              : "inactive",
        lastEventAt: health.lastEventAt,
        source: "Local status snapshots and privacy-minimized OpenTelemetry"
      },
      setup: {
        identityState,
        boundProfileName: bound?.displayName,
        workspaceLabel: lock?.workspaceLabel,
        runtimeRegistered: Boolean(activeProfile),
        runtimeConfigDir: activeProfile?.configDir ?? runtime.configDir,
        wrapperState: this.actions?.wrapperState() ?? "none",
        profileTelemetryEnabled: selected?.telemetryEnabled === true,
        collection: this.actions?.collectionDiagnosis(document, selected?.id) ?? {
          state: current ? "active" : "awaiting_data",
          headline: current ? "Collecting locally" : "Waiting for the first Claude response",
          detail: "Collection state is unavailable in this window.",
          action: "none"
        }
      }
    };
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString("base64");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Claude Quota and Usage</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --gap: 16px;
      --radius: 8px;
      --series-input: var(--vscode-charts-blue);
      --series-output: var(--vscode-charts-purple);
      --series-read: var(--vscode-charts-green);
      --series-create: var(--vscode-charts-orange);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: clamp(16px, 4vw, 36px);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font: 13px/1.45 var(--vscode-font-family);
    }
    button, select, input {
      font: inherit;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      border-radius: 4px;
      min-height: 30px;
      padding: 4px 9px;
    }
    button { cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:focus-visible, select:focus-visible, input:focus-visible, [tabindex="0"]:focus-visible, summary:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .shell { max-width: 1180px; margin: 0 auto; }
    .topline, .identity, .toolbar, .metric-row, .legend, .provenance { display: flex; align-items: center; gap: 10px; }
    .topline { justify-content: space-between; flex-wrap: wrap; margin-bottom: 28px; }
    .identity { min-width: 0; }
    .marker {
      width: 34px; height: 34px; border: 1px solid var(--vscode-panel-border);
      display: grid; place-items: center; border-radius: 9px; font-weight: 650; font-size: 14px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    h1 { margin: 0; font-size: 19px; line-height: 1.2; font-weight: 600; }
    h2 { margin: 0 0 14px; font-size: 15px; letter-spacing: .01em; }
    .subtle, .meta { color: var(--vscode-descriptionForeground); }
    .meta { font-size: 12px; }
    .grid { display: grid; gap: var(--gap); }
    /*
     * Auto-fit, not a fixed two: the card count varies with what Claude reported — two windows, or
     * two plus a credit pool, or one plus an absent-window note — and at a fixed two columns an odd
     * count left the last card alone beside half a row of nothing.
     */
    .summary { grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); }
    .secondary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .lower { grid-template-columns: minmax(0, 1.4fr) minmax(280px, .8fr); }
    .card {
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius);
      padding: 16px;
      min-width: 0;
    }
    /*
     * The accent stripe marks a window worth looking at. It used to be on every hero card, in the
     * same colour, which made it decoration: three identical marks cannot distinguish anything. Now
     * an unremarkable window has none, and the one that is nearly spent is the only coloured edge
     * on the page.
     */
    .card.hero { border-top: 2px solid transparent; }
    .card.hero.warning { border-top-color: var(--vscode-charts-orange); }
    .card.hero.critical { border-top-color: var(--vscode-charts-red); }
    .metric-row { justify-content: space-between; align-items: baseline; }
    .metric { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .badge {
      display: inline-flex; padding: 2px 7px; border-radius: 999px; font-size: 11px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .badge.warning { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
    .badge.error { background: var(--vscode-statusBarItem-errorBackground); color: var(--vscode-statusBarItem-errorForeground); }
    progress {
      width: 100%; height: 11px; margin: 12px 0 5px; border: 0; border-radius: 999px; overflow: hidden;
      accent-color: var(--vscode-progressBar-background);
    }
    progress::-webkit-progress-bar { background: var(--vscode-editor-inactiveSelectionBackground); }
    progress::-webkit-progress-value { background: var(--vscode-progressBar-background); border-radius: 999px; }
    progress.warning::-webkit-progress-value { background: var(--vscode-charts-orange); }
    progress.critical::-webkit-progress-value { background: var(--vscode-charts-red); }
    .lockline {
      padding: 9px 11px; border-left: 3px solid var(--vscode-focusBorder);
      background: var(--vscode-textBlockQuote-background); margin-bottom: 16px;
    }
    .lockline.error { border-left-color: var(--vscode-errorForeground); }
    .context-labels { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
    /* Small multiples, one row per series, each on its own scale. See the activity() renderer
       for why a single stacked axis cannot represent these four together. */
    .sparks { display: grid; gap: 15px; margin-top: 2px; }
    .spark-row { display: grid; gap: 5px; }
    .spark-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 12px; }
    .spark-name { font-weight: 600; }
    .spark-peak { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .spark-plot {
      display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
      align-items: end; gap: 2px; height: 42px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .spark-bar { border-radius: 4px 4px 0 0; background: var(--series-input); }
    .spark-plot.output .spark-bar { background: var(--series-output); }
    .spark-plot.cache-read .spark-bar { background: var(--series-read); }
    .spark-plot.cache-create .spark-bar { background: var(--series-create); }
    .spark-flat { height: 42px; border-bottom: 1px solid var(--vscode-panel-border); }
    .spark-axis { display: flex; justify-content: space-between; font-size: 11px; margin-top: 6px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
    .spark-note { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 11px; }
    .bar-row { display: grid; grid-template-columns: minmax(90px, 1fr) 2fr auto; gap: 10px; align-items: center; margin: 9px 0; }
    .bar-track { height: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 999px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--vscode-charts-blue); border-radius: inherit; }
    .reliability { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .reliability > div, .mini {
      padding: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    }
    .mini .metric { font-size: 18px; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { color: var(--vscode-descriptionForeground); font-weight: 600; }
    td.num, th.num { text-align: right; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
    .empty { min-height: 90px; display: grid; place-items: center; text-align: center; color: var(--vscode-descriptionForeground); }
    .disclaimer { border-left: 3px solid var(--vscode-charts-blue); padding: 9px 11px; margin-top: 12px; background: var(--vscode-textBlockQuote-background); }
    .provenance { justify-content: space-between; flex-wrap: wrap; border-top: 1px solid var(--vscode-panel-border); padding-top: 13px; margin-top: 16px; }
    .spaced { margin-top: 16px; }
    .table-scroll { overflow-x: auto; }
    .quota-lead { margin-bottom: 18px; }
    /*
     * The quota cards are the page. Everything competing with them was removed rather than
     * restyled: a per-card provenance badge, a per-card reading timestamp and a per-card threshold
     * disclaimer said the same four things four times over, so they are stated once for the
     * section and the cards carry only the figure.
     */
    .card.hero { padding: 20px; }
    .quota-lead .metric { font-size: 34px; font-weight: 600; letter-spacing: -.02em; }
    .quota-lead .card.hero h2 { margin: 0; font-size: 13px; font-weight: 500; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .06em; }
    .quota-lead .card.hero .metric-row:first-child { margin-bottom: 10px; }
    /* A window whose own numbers are unremarkable earns no badge; only an exception gets one. */
    .card.hero .badge:empty { display: none; }
    /*
     * Windows Claude reports but that are inactive and unused — a per-model weekly window nobody
     * has touched — are true readings and are kept, but at the weight they deserve: one line,
     * below the cards, instead of a hero tile that reads as headroom news.
     */
    .quiet-windows {
      display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px;
      font-size: 12px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums;
    }
    .provenance-line { margin-top: 14px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .provenance-line:empty { display: none; }
    /* Secondary by construction: local history is collapsed so quota is what the page is about. */
    details.secondary { margin-top: 26px; border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; }
    details.secondary > summary { font-weight: 600; color: var(--vscode-foreground); }
    details.secondary .toolbar { margin: 14px 0 4px; flex-wrap: wrap; }
    @media (max-width: 720px) {
      .summary, .secondary-grid, .lower { grid-template-columns: 1fr; }
      .toolbar { width: 100%; flex-wrap: wrap; }
      .toolbar select { flex: 1; }
      .reliability { grid-template-columns: 1fr 1fr; }
    }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <main class="shell" id="app" aria-live="polite">
    <div class="empty">Loading local account usage…</div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const app = document.getElementById('app');
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const num = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: Math.abs(value || 0) >= 100000 ? 'compact' : 'standard' }).format(value || 0);
    const money = (value) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value || 0);
    const duration = (seconds) => {
      const value = Number(seconds || 0);
      if (value < 60) return Math.round(value) + 's';
      if (value < 3600) return Math.round(value / 60) + 'm';
      return (value / 3600).toFixed(1) + 'h';
    };
    const when = (value, timezone) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value)) : 'Never';
    const pctClass = (value, warning, critical) => value >= critical ? 'critical' : value >= warning ? 'warning' : '';
    const profile = (data) => data.profiles.find((item) => item.id === data.selectedProfileId);
    const aggregateDays = (rows) => {
      const map = new Map();
      for (const row of rows) {
        const current = map.get(row.day) || { day: row.day, input: 0, output: 0, read: 0, create: 0, cost: 0, active: 0, sessions: 0, added: 0, removed: 0, commits: 0, prs: 0, requests: 0, errors: 0 };
        current.input += row.inputTokens; current.output += row.outputTokens;
        current.read += row.cacheReadTokens; current.create += row.cacheCreationTokens;
        current.cost += row.estimatedCostUsd; current.active += row.activeSeconds;
        current.sessions += row.sessions; current.added += row.linesAdded; current.removed += row.linesRemoved;
        current.commits += row.commits; current.prs += row.pullRequests;
        current.requests += row.requests; current.errors += row.errors;
        map.set(row.day, current);
      }
      return [...map.values()].sort((a,b) => a.day.localeCompare(b.day));
    };
    // Quota is the headline: Claude's own figure, the headroom left, and when it resets. The age of
    // the reading and its provenance are stated once for the whole section rather than on each
    // card — they are identical across cards, because they describe the one reading all of them
    // come from. An absent window is stated as absent, never as 0%.
    const quotaCard = (reading, data) => {
      // Only an exception earns a badge. "Reported by Claude" on a card that is reported by Claude,
      // beside three other cards saying the same, is chrome that hides the one badge that matters.
      const note = reading.expired ? 'Window has reset' : data.quota.freshness === 'stale' ? 'Stale reading' : '';
      return \`<section class="card hero \${pctClass(reading.usedPercentage, data.thresholds.usageWarning, data.thresholds.usageCritical)}">
        <div class="metric-row"><h2>\${esc(reading.label)}</h2><span class="badge \${reading.severity === 'critical' ? 'error' : reading.severity === 'warning' ? 'warning' : ''}">\${esc(note)}</span></div>
        <div class="metric-row"><span class="metric">\${Math.round(reading.remainingPercentage)}% left</span><span class="meta">\${Math.round(reading.usedPercentage)}% used</span></div>
        <progress class="\${pctClass(reading.usedPercentage, data.thresholds.usageWarning, data.thresholds.usageCritical)}" max="100" value="\${reading.usedPercentage}" aria-label="\${esc(reading.label)}: \${Math.round(reading.usedPercentage)}% used, \${Math.round(reading.remainingPercentage)}% remaining"></progress>
        <div class="meta">\${reading.resetsAtIso ? (reading.expired ? 'Reset due now · ' : 'Resets in ' + esc(reading.resetsInLabel.replace(/^in /, '')) + ' · ') + esc(when(reading.resetsAtIso, data.timezone)) : 'No reset time reported'}</div>
      </section>\`;
    };
    const quotaAbsentCard = (entry) => \`<section class="card hero">
        <div class="metric-row"><h2>\${esc(entry.label)}</h2><span class="badge">Not reported</span></div>
        <div class="empty">\${esc(entry.detail)}</div>
      </section>\`;
    /*
     * The credit pool is not a time window: it has a currency and a cap that can be reached while
     * every window still has headroom, so it gets its own card rather than a percentage bar.
     *
     * The amounts arrive in minor units with the number of decimal places alongside. Applying that
     * exponent is not cosmetic — without it a A$50.00 cap printed as "A$5,000". When Claude does not
     * say how many places the amounts carry, no amount is shown, because a wrong one is worse.
     */
    const creditCard = (pool, data) => {
      const amount = (minorUnits) => {
        if (minorUnits == null || pool.currencyExponent == null) return null;
        const value = minorUnits / Math.pow(10, pool.currencyExponent);
        return pool.currency
          ? new Intl.NumberFormat(undefined, { style: 'currency', currency: pool.currency, minimumFractionDigits: pool.currencyExponent, maximumFractionDigits: pool.currencyExponent }).format(value)
          : value.toFixed(pool.currencyExponent);
      };
      const used = amount(pool.usedMinorUnits);
      const limit = amount(pool.limitMinorUnits);
      const spend = used && limit ? used + ' of ' + limit : used || (limit ? 'cap ' + limit : '');
      const state = pool.spendLimitReached || pool.utilization >= data.thresholds.usageCritical ? 'error' : pool.utilization >= data.thresholds.usageWarning ? 'warning' : '';
      const note = pool.spendLimitReached ? 'Spend limit reached' : pool.disabledReason ? 'Unavailable' : pool.enabled ? '' : 'Not enabled';
      return \`<section class="card hero \${pctClass(pool.utilization, data.thresholds.usageWarning, data.thresholds.usageCritical)}">
        <div class="metric-row"><h2>Extra usage credits</h2><span class="badge \${state}">\${esc(note)}</span></div>
        <div class="metric-row"><span class="metric">\${spend ? esc(spend) : Math.round(pool.utilization) + '% used'}</span><span class="meta">\${spend ? Math.round(pool.utilization) + '% used' : ''}</span></div>
        <progress class="\${pctClass(pool.utilization, data.thresholds.usageWarning, data.thresholds.usageCritical)}" max="100" value="\${pool.utilization}" aria-label="Extra usage credits: \${Math.round(pool.utilization)}% used\${spend ? ', ' + esc(spend) : ''}"></progress>
        <div class="meta">\${pool.disabledReason ? esc(pool.disabledReason) : 'Used only once a plan window is exhausted'}</div>
      </section>\`;
    };
    /** Reported, but neither in force nor touched — true, and not news. One line, not a tile. */
    const isQuiet = (reading) => reading.window === 'weekly_scoped' && !reading.active && reading.usedPercentage === 0;
    const quotaSection = (data) => {
      const loud = data.quota.windows.filter((reading) => !isQuiet(reading));
      const quiet = data.quota.windows.filter(isQuiet);
      const cards = [
        ...loud.map((reading) => quotaCard(reading, data)),
        ...(data.quota.creditPool ? [creditCard(data.quota.creditPool, data)] : []),
        ...data.quota.absent.map(quotaAbsentCard)
      ].join('');
      const quietLine = quiet.length
        ? \`<div class="quiet-windows">\${quiet.map((reading) => \`<span>\${esc(reading.label)} · unused</span>\`).join('')}</div>\`
        : '';
      const storage = data.storage.failing
        ? \`<div class="lockline error"><strong>Local usage storage is failing\${data.storage.category ? ' (' + esc(data.storage.category) + ')' : ''}</strong><div class="meta">Nothing has been written since\${data.storage.lastFailureAt ? ' ' + esc(when(data.storage.lastFailureAt, data.timezone)) : ''}, so any figure on this page may be frozen. Account switching and workspace bindings are unaffected.</div></div>\`
        : '';
      // Said once, for every card above it: whose figure this is, and how old. Anything a threshold
      // has actually fired on names the threshold — the rest of the time the numbers are unflagged
      // and there is nothing to disclaim.
      const fired = loud.some((reading) => reading.severity !== 'normal')
        || (data.quota.creditPool && data.quota.creditPool.utilization >= data.thresholds.usageWarning);
      const provenance = data.quota.windows.length || data.quota.creditPool
        ? \`Claude's own reading, taken \${esc(data.quota.capturedAt ? when(data.quota.capturedAt, data.timezone) : 'at an unknown time')}\${data.quota.ageLabel ? ' · ' + esc(data.quota.ageLabel) : ''}\${data.quota.freshness === 'stale' ? ' · Claude has not refreshed it since, so this may not be current headroom' : ''}. Never calculated or inferred here.\${fired ? ' Colour thresholds are a preference of this extension (' + num(data.thresholds.usageWarning) + '% / ' + num(data.thresholds.usageCritical) + '% used), not Anthropic policy.' : ''}\`
        : '';
      // Named for assistive technology, unheaded for everyone else: the cards title themselves, so a
      // visible "Plan quota" above them was a row of text restating the row of text below it.
      return \`<section class="quota-lead" aria-label="Plan quota, as reported by Claude">
        \${storage}
        <div class="grid summary">\${cards}</div>
        \${quietLine}
        <div class="provenance-line">\${provenance}</div>
      </section>\`;
    };
    // Small multiples: one row per series, each scaled to its own peak.
    //
    // These four cannot share an axis. Cache reads run three to four orders of magnitude above
    // input — measured at 97% of all tokens and 4,002x input on real data — so a stacked linear
    // chart drew one solid block of the cache-read colour with the other three pinned to the
    // minimum-height floor, on every day and in every range. It looked identical no matter what
    // had happened. Per-series scales cost comparability between rows, which is why each row
    // states its own peak and the note below says heights do not compare across rows.
    const activity = (days) => {
      if (!days.length) return '<div class="empty">No local token activity in this range.</div>';
      const series = [
        ['input', 'Input', 'input'],
        ['output', 'Output', 'output'],
        ['read', 'Cache read', 'cache-read'],
        ['create', 'Cache creation', 'cache-create']
      ];
      const plotHeight = 42;
      const rows = series.map(([key, label, kind]) => {
        const peak = days.reduce((high, day) => Math.max(high, day[key]), 0);
        if (!peak) {
          return \`<div class="spark-row"><div class="spark-head"><span class="spark-name">\${esc(label)}</span><span class="spark-peak">none in this range</span></div><div class="spark-flat"></div></div>\`;
        }
        const bars = days.map((day) => {
          const value = day[key];
          // A real but tiny reading keeps a 2px floor so it stays visible; a genuine zero draws
          // nothing at all, so "none that day" and "a little that day" never look the same.
          const height = value ? Math.max(value / peak * plotHeight, 2) : 0;
          return \`<span class="spark-bar" data-height="\${height.toFixed(2)}" title="\${esc(day.day)} · \${esc(label)}: \${num(value)} tokens"></span>\`;
        }).join('');
        // Capped rather than stretched: a single day against grid-auto-columns:1fr previously
        // expanded to the full panel width and read as a wall rather than one day's bar.
        return \`<div class="spark-row">
          <div class="spark-head"><span class="spark-name">\${esc(label)}</span><span class="spark-peak">peak \${num(peak)}/day</span></div>
          <div class="spark-plot \${kind}" role="img" aria-label="\${esc(label)} per day. Peak \${num(peak)} tokens in one day." data-maxwidth="\${days.length * 26}">\${bars}</div>
        </div>\`;
      }).join('');
      const axis = days.length > 1
        ? \`<div class="spark-axis"><span>\${esc(days[0].day)}</span><span>\${esc(days[days.length - 1].day)}</span></div>\`
        : \`<div class="spark-axis"><span>\${esc(days[0].day)}</span></div>\`;
      return \`<div class="sparks">\${rows}</div>\${axis}
        <div class="spark-note">Each row is scaled to its own peak, stated on its right. Heights compare within a row, never between rows — cache reads run far above the other three.</div>\`;
    };
    let attributionDimension = 'model';
    let attributionMeasure = 'tokens';
    const attributionValue = (row) => Number(row[attributionMeasure] || 0);
    const attributionFormat = (value) => attributionMeasure === 'cost'
      ? money(value)
      : attributionMeasure === 'activeSeconds'
        ? duration(value)
        : num(value) + (attributionMeasure === 'tokens' ? ' tokens' : '');
    const attribution = (rows) => {
      const filtered = rows.filter(row => row.dimension === attributionDimension);
      if (!filtered.length) return '<div class="empty">No '+esc(attributionDimension.replace('_', ' '))+' attribution is available in this range.</div>';
      const max = Math.max(...filtered.map(attributionValue), 1);
      const bars = filtered.map(row => \`<div class="bar-row" tabindex="0" aria-label="\${esc(row.label)}: \${esc(attributionFormat(attributionValue(row)))}">
        <span title="\${esc(row.label)}">\${esc(row.label)}</span>
        <span class="bar-track"><span class="bar-fill" data-width="\${attributionValue(row) ? Math.max(1, attributionValue(row)/max*100) : 0}"></span></span>
        <span class="meta">\${esc(attributionFormat(attributionValue(row)))}</span>
      </div>\`).join('');
      const rowsHtml = filtered.map(row => \`<tr><td>\${esc(row.label)}</td><td class="num">\${esc(attributionFormat(attributionValue(row)))}</td></tr>\`).join('');
      return bars+\`<details><summary>Accessible attribution table</summary><div class="table-scroll"><table><thead><tr><th>Label</th><th class="num">Value</th></tr></thead><tbody>\${rowsHtml}</tbody></table></div></details>\`;
    };
    const toolRows = (tools) => tools.length ? tools.map(tool => \`<tr><td>\${esc(tool.name)}</td><td class="num">\${num(tool.requests)}</td><td class="num">\${tool.requests ? Math.round(tool.successes/tool.requests*100) : 0}%</td><td class="num">\${num(tool.medianDurationMs)} ms</td></tr>\`).join('') : '<tr><td colspan="4">No tool events collected.</td></tr>';
    const permissionRows = (rows) => rows.length ? rows.map(row => \`<tr><td>\${esc(row.source)}</td><td>\${esc(row.decision)}</td><td class="num">\${num(row.count)}</td></tr>\`).join('') : '<tr><td colspan="3">No permission decisions collected.</td></tr>';
    const errorTimeline = (days) => {
      const rows = days.filter(day => day.errors > 0);
      if (!rows.length) return '<div class="empty">No API errors were observed in this range.</div>';
      const max = Math.max(...rows.map(day => day.errors), 1);
      const bars = rows.map(day => \`<div class="bar-row" tabindex="0" aria-label="\${esc(day.day)}: \${num(day.errors)} API errors">
        <span>\${esc(day.day)}</span><span class="bar-track"><span class="bar-fill" data-width="\${day.errors/max*100}"></span></span><span class="meta">\${num(day.errors)}</span>
      </div>\`).join('');
      const table = rows.map(day => \`<tr><td>\${esc(day.day)}</td><td class="num">\${num(day.requests)}</td><td class="num">\${num(day.errors)}</td></tr>\`).join('');
      return bars+\`<details><summary>Accessible error table</summary><div class="table-scroll"><table><thead><tr><th>Day</th><th class="num">Requests</th><th class="num">Errors</th></tr></thead><tbody>\${table}</tbody></table></div></details>\`;
    };
    const tableRows = (days) => days.length ? days.map(day => \`<tr><td>\${esc(day.day)}</td><td class="num">\${num(day.input)}</td><td class="num">\${num(day.output)}</td><td class="num">\${num(day.read)}</td><td class="num">\${num(day.create)}</td><td class="num">\${money(day.cost)}</td><td class="num">\${duration(day.active)}</td></tr>\`).join('') : '<tr><td colspan="7">No rows.</td></tr>';
    let modelFilter = 'all';
    let workspaceFilter = 'all';
    /*
     * Whether the local-detail section is expanded, remembered across renders.
     *
     * It has to be: the range, activity, model and workspace filters moved inside it — they only
     * ever drove the numbers in there, and above the fold they were four controls competing with
     * the quota — and every one of them re-renders the page. Without this the section a filter
     * belongs to would slam shut the moment that filter was used. Null means "not chosen yet",
     * which resolves to open only when there is no quota to be the headline instead.
     *
     * No backticks in here: this comment is inside the template literal that builds the page, so
     * one would end the literal and take the rest of the document with it.
     */
    let detailOpen = null;
    function render(data) {
      const selected = profile(data);
      if (detailOpen === null) detailOpen = data.quota.windows.length === 0;
      if (!selected) {
        app.innerHTML = \`<div class="empty"><div><h1>Claude has not reported any quota yet</h1>
          <p>\${esc(data.setup.collection.headline)}</p>
          <p class="meta">\${esc(data.setup.collection.detail)}</p>
          \${data.setup.collection.actionLabel ? '<p><button id="collection-action">'+esc(data.setup.collection.actionLabel)+'</button></p>' : ''}
        </div></div>\`;
        document.getElementById('collection-action')?.addEventListener('click', () => vscode.postMessage({ type: 'collectionAction' }));
        return;
      }
      const setupBanner = data.setup.collection.state === 'active'
        ? ''
        : \`<div class="lockline \${data.setup.collection.state === 'blocked' ? 'error' : ''}"><strong>\${esc(data.setup.collection.headline)}</strong><div class="meta">\${esc(data.setup.collection.detail)}</div>\${data.setup.collection.actionLabel ? '<div class="toolbar spaced"><button id="collection-action">'+esc(data.setup.collection.actionLabel)+'</button></div>' : ''}</div>\`;
      const models = [...new Set(data.daily.map(row => row.model).filter(Boolean))].sort();
      const workspaces = [...new Set(data.daily.map(row => row.workspaceLabel).filter(Boolean))].sort();
      if (modelFilter !== 'all' && !models.includes(modelFilter)) modelFilter = 'all';
      if (workspaceFilter !== 'all' && !workspaces.includes(workspaceFilter)) workspaceFilter = 'all';
      const filteredDaily = data.daily.filter(row =>
        (modelFilter === 'all' || row.model === modelFilter)
        && (workspaceFilter === 'all' || row.workspaceLabel === workspaceFilter)
      );
      const days = aggregateDays(filteredDaily);
      const totals = days.reduce((sum, day) => ({ cost: sum.cost+day.cost, active: sum.active+day.active, sessions: sum.sessions+day.sessions, added: sum.added+day.added, removed: sum.removed+day.removed, commits: sum.commits+day.commits, prs: sum.prs+day.prs }), {cost:0,active:0,sessions:0,added:0,removed:0,commits:0,prs:0});
      const current = data.current;
      const used = current?.contextWindow?.usedPercentage;
      const lock = data.lock
        ? data.lock.compatible
          ? \`<div class="lockline"><strong>This workspace uses \${esc(data.lock.profileName || data.lock.profileId)}</strong>\${data.setup.identityState === 'unidentified' ? ' · no account details recorded' : data.setup.identityState === 'unconfirmed' ? ' · identity never confirmed' : data.setup.identityState === 'unverifiable' ? ' · sign-in state unknown' : ''} · Claude Code launched in \${esc(data.lock.workspaceLabel)} runs as this account (\${esc(data.lock.mode)} mode)</div>\`
          : \`<div class="lockline error"><strong>Different Claude identity than confirmed · \${esc(data.lock.mode)}</strong><div class="grid secondary-grid"><div><span class="meta">Confirmed earlier</span><br>\${esc(data.lock.profileName || data.lock.profileId)} · \${esc(data.lock.requiredEmail || 'identity unavailable')}\${data.lock.requiredOrganization ? ' · '+esc(data.lock.requiredOrganization) : ''}</div><div><span class="meta">Identity that answered</span><br>\${esc(data.lock.runtimeProfileName || 'unregistered')} · \${esc(data.lock.runtimeEmail || 'identity unavailable')}\${data.lock.runtimeOrganization ? ' · '+esc(data.lock.runtimeOrganization) : ''}</div></div><div class="toolbar spaced"><button id="reopen-required">Re-check \${esc(data.lock.profileName || data.lock.profileId)}</button><button class="secondary" id="change-lock">Change this workspace’s account</button></div></div>\`
        : '<div class="lockline"><strong>This workspace uses your default Claude account</strong> · Choosing an account here only changes what this dashboard shows.</div>';
      const successRate = data.reliability.requests ? Math.round((data.reliability.requests-data.reliability.errors)/data.reliability.requests*100) : 0;
      app.innerHTML = \`
        <header class="topline">
          <div class="identity"><div class="marker" aria-hidden="true">\${esc(selected.marker)}</div><div><h1>\${esc(selected.displayName)} \${selected.id === data.runtimeProfileId ? '<span class="badge">This workspace</span>' : '<span class="badge">Viewing only</span>'}</h1><div class="meta">\${esc(selected.email || 'Identity not yet confirmed')}\${selected.organization ? ' · '+esc(selected.organization) : ''}</div></div></div>
          <div class="toolbar">
            <label class="meta">Account <select id="profile-select" aria-label="Dashboard account">\${data.profiles.map(p => \`<option value="\${esc(p.id)}" \${p.id === selected.id ? 'selected' : ''}>\${esc(p.displayName)}</option>\`).join('')}</select></label>
            \${selected.id === data.runtimeProfileId ? '' : '<button id="switch">Use in this workspace</button>'}
            <button class="secondary" id="refresh">Verify</button>
          </div>
        </header>
        \${setupBanner}
        \${quotaSection(data)}
        \${lock}
        <details class="secondary" \${detailOpen ? 'open' : ''} id="local-detail">
        <summary>Locally collected detail — tokens, cost, tools, and daily history since Workspace Accounts was installed</summary>
        <div class="disclaimer">None of the numbers below measure plan headroom. They are this extension's own observations of Claude Code, they begin when it was installed, and they are shown because they are occasionally useful — not because they say anything about your quota.</div>
        <div class="toolbar">
          <label class="meta">Range <select id="range-select" aria-label="Dashboard date range">\${['24h','7d','30d','custom'].map(value => \`<option value="\${value}" \${value === data.range ? 'selected' : ''}>\${value}</option>\`).join('')}</select></label>
          \${data.range === 'custom' ? \`<label class="meta">From <input id="custom-from" type="date" value="\${esc(data.customRange.from)}"></label><label class="meta">To <input id="custom-to" type="date" value="\${esc(data.customRange.to)}"></label><button class="secondary" id="apply-custom-range">Apply dates</button>\` : ''}
          <label class="meta">Activity <select id="thread-scope" aria-label="Main thread or all activity"><option value="main" \${data.threadScope === 'main' ? 'selected' : ''}>Main thread</option><option value="all" \${data.threadScope === 'all' ? 'selected' : ''}>All + auxiliary</option></select></label>
          <label class="meta">Model <select id="model-filter" aria-label="Filter activity by model"><option value="all">All models</option>\${models.map(value => \`<option value="\${esc(value)}">\${esc(value)}</option>\`).join('')}</select></label>
          <label class="meta">Workspace <select id="workspace-filter" aria-label="Filter activity by workspace"><option value="all">All workspaces</option>\${workspaces.map(value => \`<option value="\${esc(value)}">\${esc(value)}</option>\`).join('')}</select></label>
        </div>
        <section class="card spaced">
          <div class="metric-row"><h2>Current session context</h2><span class="badge">\${current ? 'Locally observed' : 'Unavailable'}</span></div>
          \${current ? \`<div class="context-labels"><span><strong>\${esc(current.modelDisplayName || current.modelId || 'Unknown model')}</strong> · \${esc(current.effort || 'default')} effort\${current.thinkingEnabled ? ' · thinking on' : ''}</span><span>\${used == null ? 'Usage unavailable' : Math.round(used)+'% used · '+Math.round(current.contextWindow?.remainingPercentage ?? Math.max(0, 100-used))+'% remaining'}</span></div>
            \${used == null
              ? '<div class="empty">Claude has not exposed current context utilization for this session.</div>'
              : \`<progress class="\${pctClass(used, data.thresholds.contextWarning, 100)}" max="100" value="\${used}" aria-label="Context window \${used}% used"></progress><div class="meta">\${used >= data.thresholds.contextWarning ? 'Local context warning threshold reached at '+num(data.thresholds.contextWarning)+'%.' : 'Local context warning threshold · '+num(data.thresholds.contextWarning)+'%'}</div>\`}
            <div class="grid secondary-grid">
              <div class="mini"><div class="meta">Estimated session cost</div><div class="metric">\${current.costUsd == null ? '—' : money(current.costUsd)}</div></div>
              <div class="mini"><div class="meta">Elapsed / API wait</div><div class="metric">\${current.durationMs == null ? '—' : duration(current.durationMs/1000)} / \${current.apiDurationMs == null ? '—' : duration(current.apiDurationMs/1000)}</div></div>
              <div class="mini"><div class="meta">Lines added / removed</div><div class="metric">\${current.linesAdded == null ? '—' : '+'+num(current.linesAdded)} / \${current.linesRemoved == null ? '—' : '−'+num(current.linesRemoved)}</div></div>
            </div>
            <div class="meta">Session \${esc(current.sessionName || current.sessionId)} · Workspace \${esc(current.workspacePath || current.workspaceLabel || 'unavailable')} · Context size \${current.contextWindow?.size == null ? 'unavailable' : num(current.contextWindow.size)+' tokens'} · Updated \${esc(when(current.capturedAt, data.timezone))}</div>
            <div class="meta">Source: Claude status snapshot · Locally observed · Context is the most recent state, not a cumulative token total.</div>\`
          : '<div class="empty">Awaiting the first graphical Claude status snapshot.</div>'}
        </section>
        <section class="card spaced">
          <div class="metric-row"><h2>Usage over time</h2><span class="badge">Local · \${esc(data.range === 'custom' ? data.customRange.from+' – '+data.customRange.to : data.range)}</span></div>
          \${activity(days)}
          <div class="grid secondary-grid">
            <div class="mini"><div class="meta">Estimated local cost</div><div class="metric">\${money(totals.cost)}</div></div>
            <div class="mini"><div class="meta">Active time</div><div class="metric">\${duration(totals.active)}</div></div>
            <div class="mini"><div class="meta">Sessions</div><div class="metric">\${num(totals.sessions)}</div></div>
          </div>
          <details><summary>Accessible usage table</summary><div class="table-scroll"><table><thead><tr><th>Day</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache create</th><th class="num">Est. cost</th><th class="num">Active</th></tr></thead><tbody>\${tableRows(days)}</tbody></table></div></details>
        </section>
        <div class="grid lower spaced">
          <section class="card"><div class="metric-row"><h2>Attribution</h2><span class="badge">\${data.threadScope === 'main' ? 'Main thread' : 'All activity'}</span></div>
            <div class="toolbar">
              <label>Dimension <select id="attribution-dimension"><option value="model">Model</option><option value="skill">Skill</option><option value="plugin">Plugin</option><option value="agent">Agent / subagent</option><option value="mcp_tool">MCP server / tool</option><option value="workspace">Workspace</option><option value="query_source">Query source</option></select></label>
              <label>Measure <select id="attribution-measure"><option value="tokens">Tokens</option><option value="cost">Estimated cost</option><option value="requests">Requests</option><option value="activeSeconds">Active time</option></select></label>
            </div>
            <div id="attribution-chart">\${attribution(data.attribution)}</div>
          </section>
          <section class="card"><h2>Reliability</h2><div class="reliability">
            <div><div class="meta">Request success</div><div class="metric">\${data.reliability.requests ? successRate+'%' : '—'}</div></div>
            <div><div class="meta">Median request</div><div class="metric">\${data.reliability.medianRequestMs == null ? '—' : num(data.reliability.medianRequestMs)+' ms'}</div></div>
            <div><div class="meta">P95 request</div><div class="metric">\${data.reliability.p95RequestMs == null ? '—' : num(data.reliability.p95RequestMs)+' ms'}</div></div>
            <div><div class="meta">Median TTFT</div><div class="metric">\${data.reliability.medianTtftMs == null ? '—' : num(data.reliability.medianTtftMs)+' ms'}</div></div>
            <div><div class="meta">Auth / MCP failures</div><div class="metric">\${num(data.reliability.authFailures)} / \${num(data.reliability.mcpFailures)}</div></div>
          </div></section>
        </div>
        <section class="card spaced"><h2>Tool activity</h2><div class="table-scroll"><table><thead><tr><th>Tool</th><th class="num">Results</th><th class="num">Success</th><th class="num">Median duration</th></tr></thead><tbody>\${toolRows(data.reliability.tools)}</tbody></table></div></section>
        <div class="grid lower spaced">
          <section class="card"><h2>Error timeline</h2>\${errorTimeline(days)}</section>
          <section class="card"><h2>Permission decisions</h2><div class="table-scroll"><table><thead><tr><th>Source</th><th>Decision</th><th class="num">Count</th></tr></thead><tbody>\${permissionRows(data.reliability.permissionDecisions)}</tbody></table></div></section>
        </div>
        <section class="card spaced"><h2>Engineering activity</h2><div class="grid secondary-grid">
          <div class="mini"><div class="meta">Lines added / removed</div><div class="metric">+\${num(totals.added)} / −\${num(totals.removed)}</div></div>
          <div class="mini"><div class="meta">Commits</div><div class="metric">\${num(totals.commits)}</div></div>
          <div class="mini"><div class="meta">Pull requests</div><div class="metric">\${num(totals.prs)}</div></div>
        </div><div class="disclaimer">Activity is not a measure of code quality or developer performance.</div></section>
        </details>
        \${/*
          * Setup state, one line. Collection headline and detail are already the banner above
          * whenever collection is not simply working, and quota provenance is already stated under
          * the cards, so repeating either here only buried the integration state — the one fact
          * this footer holds that nothing else on the page shows.
          */''}
        <footer class="provenance"><div class="meta">Claude Code integration \${esc(data.setup.wrapperState === 'guard' ? 'on' : data.setup.wrapperState === 'foreign' ? '· another wrapper is configured' : 'off')} · Local collection \${data.setup.profileTelemetryEnabled ? 'on' : 'off'}, last event \${esc(when(data.collection.lastEventAt, data.timezone))} · Times in \${esc(data.timezone)}</div><button class="secondary" id="export">Export local data</button></footer>
      \`;
      document.getElementById('profile-select')?.addEventListener('change', event => vscode.postMessage({ type: 'setProfile', profileId: event.target.value }));
      document.getElementById('range-select')?.addEventListener('change', event => vscode.postMessage({ type: 'setRange', range: event.target.value }));
      document.getElementById('apply-custom-range')?.addEventListener('click', () => {
        const from = document.getElementById('custom-from')?.value;
        const to = document.getElementById('custom-to')?.value;
        if (from && to) vscode.postMessage({ type: 'setCustomRange', from, to });
      });
      document.getElementById('thread-scope')?.addEventListener('change', event => vscode.postMessage({ type: 'setThreadScope', threadScope: event.target.value }));
      const modelSelect = document.getElementById('model-filter');
      const workspaceSelect = document.getElementById('workspace-filter');
      if (modelSelect) {
        modelSelect.value = modelFilter;
        modelSelect.addEventListener('change', event => {
          modelFilter = event.target.value;
          render(data);
        });
      }
      if (workspaceSelect) {
        workspaceSelect.value = workspaceFilter;
        workspaceSelect.addEventListener('change', event => {
          workspaceFilter = event.target.value;
          render(data);
        });
      }
      document.getElementById('local-detail')?.addEventListener('toggle', event => { detailOpen = event.target.open; });
      document.getElementById('collection-action')?.addEventListener('click', () => vscode.postMessage({ type: 'collectionAction' }));
      document.getElementById('switch')?.addEventListener('click', () => vscode.postMessage({ type: 'switchProfile', profileId: selected.id }));
      document.getElementById('reopen-required')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      document.getElementById('change-lock')?.addEventListener('click', () => vscode.postMessage({ type: 'changeLock' }));
      document.getElementById('refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
      document.getElementById('export')?.addEventListener('click', () => vscode.postMessage({ type: 'export', profileId: selected.id }));
      const dimensionSelect = document.getElementById('attribution-dimension');
      const measureSelect = document.getElementById('attribution-measure');
      if (dimensionSelect) {
        dimensionSelect.value = attributionDimension;
        dimensionSelect.addEventListener('change', event => {
          attributionDimension = event.target.value;
          render(data);
        });
      }
      if (measureSelect) {
        measureSelect.value = attributionMeasure;
        measureSelect.addEventListener('change', event => {
          attributionMeasure = event.target.value;
          render(data);
        });
      }
      document.querySelectorAll('[data-height]').forEach(element => {
        if (element instanceof HTMLElement) element.style.height = Number(element.dataset.height || 0) + 'px';
      });
      document.querySelectorAll('[data-width]').forEach(element => {
        if (element instanceof HTMLElement) element.style.width = Number(element.dataset.width || 0) + '%';
      });
      // Bars stay flexible so a long range fills the panel, but the plot never grows past one
      // sensible bar width per day — otherwise a single day stretches across the whole card.
      document.querySelectorAll('[data-maxwidth]').forEach(element => {
        if (element instanceof HTMLElement) element.style.maxWidth = Number(element.dataset.maxwidth || 0) + 'px';
      });
    }
    const renderError = (message) => {
      app.innerHTML = \`<div class="empty"><div><h1>The usage dashboard could not be built</h1>
        <p class="meta">\${esc(message || 'Unknown error')}</p>
        <p class="meta">Local usage storage or the account registry could not be read. Account switching and workspace bindings are unaffected.</p>
        <p><button id="retry">Try again</button></p>
        <p class="meta">Run “Claude Workspace Accounts: Show Diagnostics” for a redacted report.</p>
      </div></div>\`;
      document.getElementById('retry')?.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
    };
    window.addEventListener('message', event => {
      if (event.data?.type === 'dashboardData') {
        // A render fault must not leave the panel showing "Loading…" forever either.
        try {
          render(event.data.payload);
        } catch (error) {
          renderError(error && error.message ? error.message : String(error));
        }
      } else if (event.data?.type === 'dashboardError') {
        renderError(event.data.message);
      }
    });
  </script>
</body>
</html>`;
  }
}
