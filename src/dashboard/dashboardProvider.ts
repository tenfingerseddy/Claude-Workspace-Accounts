import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type {
  DashboardData,
  DashboardDateBounds,
  DashboardRange,
  SharedRegistryDocument
} from "../core/models.js";
import { bindingIdentityState } from "../core/statusState.js";
import type { CollectionDiagnosis, WrapperState } from "../commands/uxModel.js";
import type { BindingIdentityState } from "../core/statusState.js";
import type { WorkspaceLockService } from "../locks/workspaceLockService.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { RuntimeProfileDetector } from "../profiles/runtimeProfileDetector.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import { parseDashboardMessage } from "./dashboardMessages.js";

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
  setup: {
    /** How the bound account's identity compares with the one recorded for it. */
    identityState: BindingIdentityState;
    /** The account this workspace is bound to, if any. */
    boundProfileName?: string;
    workspaceLabel?: string;
    /** True when the account in play here is one Account Guard knows about. */
    runtimeRegistered: boolean;
    runtimeConfigDir: string;
    wrapperState: WrapperState;
    profileTelemetryEnabled: boolean;
    collection: CollectionDiagnosis;
  };
}

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
    this.selectedProfileId = context.globalState.get<string>(PROFILE_STATE_KEY);
    this.range = context.globalState.get<DashboardRange>(
      RANGE_STATE_KEY,
      vscode.workspace.getConfiguration("claudeAccountGuard").get<DashboardRange>(
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
        "claudeAccountGuard.usage",
        "Claude Account Usage",
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
        await this.context.globalState.update(PROFILE_STATE_KEY, message.profileId);
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
        await vscode.commands.executeCommand("claudeAccountGuard.switchProfile", message.profileId);
        break;
      case "changeLock":
        await vscode.commands.executeCommand("claudeAccountGuard.lockWorkspace");
        await this.refresh();
        break;
      case "refresh":
        await vscode.commands.executeCommand("claudeAccountGuard.verifyAccount");
        await this.refresh();
        break;
      case "export":
        await vscode.commands.executeCommand("claudeAccountGuard.exportUsage", message.profileId);
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

  private async buildData(): Promise<DashboardPayload> {
    const document = await this.registry.read();
    const runtime = this.runtimeDetector.detect(document.profiles);
    const selected = document.profiles.find((profile) => profile.id === this.selectedProfileId)
      ?? runtime.profile
      ?? document.profiles[0];
    this.selectedProfileId = selected?.id;
    const lock = await this.lockService.currentLock();
    const requiredProfile = lock
      ? document.profiles.find((profile) => profile.id === lock.profileId)
      : undefined;
    // The wrapper sets CLAUDE_CONFIG_DIR per launch, so the account in play here is the
    // bound one when there is a binding, not whatever this window inherited.
    const bound = lock && lock.mode !== "off" ? requiredProfile : undefined;
    const activeProfile = bound ?? runtime.profile;
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

    return {
      generatedAt: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      selectedProfileId: selected?.id,
      runtimeProfileId: activeProfile?.id,
      range: this.range,
      customRange: this.customRange,
      threadScope: this.threadScope,
      thresholds: {
        usageWarning: vscode.workspace.getConfiguration("claudeAccountGuard")
          .get<number>("usage.warningThreshold", 70),
        usageCritical: vscode.workspace.getConfiguration("claudeAccountGuard")
          .get<number>("usage.criticalThreshold", 90),
        contextWarning: vscode.workspace.getConfiguration("claudeAccountGuard")
          .get<number>("context.warningThreshold", 80)
      },
      profiles: document.profiles.map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        marker: profile.marker,
        email: profile.expectedIdentity?.email,
        organization: profile.expectedIdentity?.organizationName
          ?? profile.expectedIdentity?.organizationId,
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
  <title>Claude Account Usage</title>
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
    .topline { justify-content: space-between; flex-wrap: wrap; margin-bottom: 22px; }
    .identity { min-width: 0; }
    .marker {
      width: 40px; height: 40px; border: 2px solid var(--vscode-focusBorder);
      display: grid; place-items: center; border-radius: 11px; font-weight: 700; font-size: 16px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    h1 { margin: 0; font-size: 24px; line-height: 1.15; }
    h2 { margin: 0 0 14px; font-size: 15px; letter-spacing: .01em; }
    .subtle, .meta { color: var(--vscode-descriptionForeground); }
    .meta { font-size: 12px; }
    .grid { display: grid; gap: var(--gap); }
    .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .secondary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .lower { grid-template-columns: minmax(0, 1.4fr) minmax(280px, .8fr); }
    .card {
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius);
      padding: 16px;
      min-width: 0;
    }
    .card.hero { border-top: 2px solid var(--vscode-focusBorder); }
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
    .activity-chart {
      display: grid; grid-auto-flow: column; grid-auto-columns: minmax(28px, 1fr);
      align-items: end; gap: 8px; min-height: 190px; border-bottom: 1px solid var(--vscode-panel-border);
      padding: 12px 6px 0; overflow-x: auto;
    }
    .day-column { min-width: 28px; display: grid; grid-template-rows: 150px auto; gap: 6px; text-align: center; }
    .stack { align-self: end; display: flex; flex-direction: column-reverse; justify-content: flex-start; height: 150px; }
    .segment { min-height: 1px; }
    .input { background: var(--series-input); }
    .output { background: var(--series-output); }
    .cache-read { background: var(--series-read); }
    .cache-create { background: var(--series-create); }
    .legend { flex-wrap: wrap; font-size: 12px; margin: 10px 0; }
    .swatch { width: 9px; height: 9px; display: inline-block; margin-right: 4px; border-radius: 2px; }
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
    const until = (value) => {
      if (!value) return 'countdown unavailable';
      const milliseconds = new Date(value).getTime() - Date.now();
      if (!Number.isFinite(milliseconds)) return 'countdown unavailable';
      if (milliseconds <= 0) return 'reset due';
      const minutes = Math.ceil(milliseconds / 60000);
      if (minutes < 60) return 'in ' + minutes + 'm';
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      return 'in ' + hours + 'h' + (remainder ? ' ' + remainder + 'm' : '');
    };
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
    const quotaCard = (label, window, data) => {
      const snapshot = data.current;
      const limit = snapshot?.rateLimits?.[window];
      const stale = snapshot && Date.now() - Date.parse(snapshot.capturedAt) > 15 * 60 * 1000;
      if (!limit) {
        const state = snapshot ? 'Awaiting first supported response' : 'Usage unavailable';
        const detail = snapshot ? 'Claude has not exposed this subscription window.' : 'No graphical status snapshot has been collected.';
        return \`<section class="card hero"><div class="metric-row"><h2>\${esc(label)}</h2><span class="badge">\${esc(state)}</span></div><div class="empty">\${esc(detail)}</div><div class="meta">Source · Claude status snapshot</div></section>\`;
      }
      const used = Math.max(0, Math.min(100, Number(limit.usedPercentage)));
      const reset = limit.resetsAt ? new Date(limit.resetsAt * 1000).toISOString() : undefined;
      return \`<section class="card hero">
        <div class="metric-row"><h2>\${esc(label)}</h2>\${stale ? '<span class="badge warning">Stale</span>' : '<span class="badge">Exact</span>'}</div>
        <div class="metric-row"><span class="metric">\${Math.round(used)}% used</span><span>\${Math.round(100-used)}% remaining</span></div>
        <progress class="\${pctClass(used, data.thresholds.usageWarning, data.thresholds.usageCritical)}" max="100" value="\${used}" aria-label="\${esc(label)}: \${used}% used"></progress>
        <div class="meta">Resets \${esc(reset ? when(reset, data.timezone) : 'not supplied')} · \${esc(until(reset))} · Updated \${esc(when(snapshot.capturedAt, data.timezone))}</div>
        <div class="meta">Source · Claude status snapshot · Exact when present · Local alerts at \${num(data.thresholds.usageWarning)}% / \${num(data.thresholds.usageCritical)}%</div>
      </section>\`;
    };
    const activity = (days) => {
      if (!days.length) return '<div class="empty">No local token activity in this range.</div>';
      const max = Math.max(...days.map(d => d.input+d.output+d.read+d.create), 1);
      const columns = days.map(day => {
        const values = [
          ['input', day.input], ['output', day.output], ['cache-read', day.read], ['cache-create', day.create]
        ];
        const segments = values.map(([kind, value]) => \`<span class="segment \${kind}" data-height="\${Math.max(value/max*150, value ? 1 : 0)}" title="\${esc(kind)}: \${num(value)} tokens"></span>\`).join('');
        const total = day.input+day.output+day.read+day.create;
        return \`<div class="day-column" tabindex="0" aria-label="\${esc(day.day)}: \${num(total)} total tokens"><div class="stack">\${segments}</div><span class="meta">\${esc(day.day.slice(5))}</span></div>\`;
      }).join('');
      return \`<div class="activity-chart" role="img" aria-label="Stacked daily token usage">\${columns}</div>
        <div class="legend"><span><i class="swatch input"></i>Input</span><span><i class="swatch output"></i>Output</span><span><i class="swatch cache-read"></i>Cache read</span><span><i class="swatch cache-create"></i>Cache creation</span></div>\`;
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
    function render(data) {
      const selected = profile(data);
      if (!selected) {
        app.innerHTML = \`<div class="empty"><div><h1>Nothing is being collected yet</h1>
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
          ? \`<div class="lockline"><strong>This workspace uses \${esc(data.lock.profileName || data.lock.profileId)}</strong>\${data.setup.identityState === 'unidentified' ? ' · this Claude version does not report which account it is' : data.setup.identityState === 'unconfirmed' ? ' · identity never confirmed' : data.setup.identityState === 'unverifiable' ? ' · sign-in state unknown' : ''} · Claude Code launched in \${esc(data.lock.workspaceLabel)} runs as this account (\${esc(data.lock.mode)} mode)</div>\`
          : \`<div class="lockline error"><strong>Different Claude identity than confirmed · \${esc(data.lock.mode)}</strong><div class="grid secondary-grid"><div><span class="meta">Confirmed earlier</span><br>\${esc(data.lock.profileName || data.lock.profileId)} · \${esc(data.lock.requiredEmail || 'identity unavailable')}\${data.lock.requiredOrganization ? ' · '+esc(data.lock.requiredOrganization) : ''}</div><div><span class="meta">Identity that answered</span><br>\${esc(data.lock.runtimeProfileName || 'unregistered')} · \${esc(data.lock.runtimeEmail || 'identity unavailable')}\${data.lock.runtimeOrganization ? ' · '+esc(data.lock.runtimeOrganization) : ''}</div></div><div class="toolbar spaced"><button id="reopen-required">Re-check \${esc(data.lock.profileName || data.lock.profileId)}</button><button class="secondary" id="change-lock">Change this workspace’s account</button></div></div>\`
        : '<div class="lockline"><strong>This workspace uses your default Claude account</strong> · Choosing an account here only changes what this dashboard shows.</div>';
      const successRate = data.reliability.requests ? Math.round((data.reliability.requests-data.reliability.errors)/data.reliability.requests*100) : 0;
      app.innerHTML = \`
        <header class="topline">
          <div class="identity"><div class="marker" aria-hidden="true">\${esc(selected.marker)}</div><div><h1>\${esc(selected.displayName)} \${selected.id === data.runtimeProfileId ? '<span class="badge">Used in this workspace</span>' : '<span class="badge">Viewing only</span>'}</h1><div class="subtle">\${esc(selected.email || 'Identity not yet confirmed')}\${selected.organization ? ' · '+esc(selected.organization) : ''}</div><div class="meta">\${esc(selected.authMethod || 'Authentication method unavailable')} · Verified \${esc(when(selected.lastVerifiedAt, data.timezone))} · Workspace \${esc(current?.workspaceLabel || data.lock?.workspaceLabel || 'unavailable')}</div></div></div>
          <div class="toolbar">
            <label>Account <select id="profile-select" aria-label="Dashboard account">\${data.profiles.map(p => \`<option value="\${esc(p.id)}" \${p.id === selected.id ? 'selected' : ''}>\${esc(p.displayName)}</option>\`).join('')}</select></label>
            <label>Range <select id="range-select" aria-label="Dashboard date range">\${['24h','7d','30d','custom'].map(value => \`<option value="\${value}" \${value === data.range ? 'selected' : ''}>\${value}</option>\`).join('')}</select></label>
            \${data.range === 'custom' ? \`<label>From <input id="custom-from" type="date" value="\${esc(data.customRange.from)}"></label><label>To <input id="custom-to" type="date" value="\${esc(data.customRange.to)}"></label><button class="secondary" id="apply-custom-range">Apply dates</button>\` : ''}
            <label>Activity <select id="thread-scope" aria-label="Main thread or all activity"><option value="main" \${data.threadScope === 'main' ? 'selected' : ''}>Main thread</option><option value="all" \${data.threadScope === 'all' ? 'selected' : ''}>All + auxiliary</option></select></label>
            <label>Model <select id="model-filter" aria-label="Filter activity by model"><option value="all">All models</option>\${models.map(value => \`<option value="\${esc(value)}">\${esc(value)}</option>\`).join('')}</select></label>
            <label>Workspace <select id="workspace-filter" aria-label="Filter activity by workspace"><option value="all">All workspaces</option>\${workspaces.map(value => \`<option value="\${esc(value)}">\${esc(value)}</option>\`).join('')}</select></label>
            <button id="switch">Use this account in this workspace</button>
            <button class="secondary" id="refresh">Verify now</button>
          </div>
        </header>
        \${setupBanner}
        \${lock}
        <div class="grid summary">
          \${quotaCard('Five-hour window', 'fiveHour', data)}
          \${quotaCard('Seven-day window', 'sevenDay', data)}
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
        <footer class="provenance"><div><strong>\${esc(data.setup.collection.headline)}</strong><div class="meta">\${esc(data.setup.collection.detail)}</div><div class="meta">Account in play · \${esc(data.setup.runtimeRegistered ? ((data.profiles.find(p => p.id === data.runtimeProfileId)?.displayName || 'known') + (data.setup.boundProfileName ? ' (this workspace)' : ' (default)')) : 'not tracked ('+data.setup.runtimeConfigDir+')')} · Status-line bridge for that account · \${data.setup.profileTelemetryEnabled ? 'installed' : 'not installed'} · Claude Code integration · \${esc(data.setup.wrapperState === 'guard' ? 'on' : data.setup.wrapperState === 'foreign' ? 'another wrapper' : 'off')}</div><div class="meta">\${esc(data.collection.source)} · Last event \${esc(when(data.collection.lastEventAt, data.timezone))} · Times shown in \${esc(data.timezone)}</div></div><button class="secondary" id="export">Export local data</button></footer>
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
    }
    const renderError = (message) => {
      app.innerHTML = \`<div class="empty"><div><h1>The usage dashboard could not be built</h1>
        <p class="meta">\${esc(message || 'Unknown error')}</p>
        <p class="meta">Local usage storage or the account registry could not be read. Account switching and workspace locks are unaffected.</p>
        <p><button id="retry">Try again</button></p>
        <p class="meta">Run “Claude Account Guard: Show Diagnostics” for a redacted report.</p>
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
