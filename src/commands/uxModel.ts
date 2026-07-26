import type { CollectionPhase, LockMode } from "../core/models.js";
import type { BindingIdentityState } from "../core/statusState.js";

/**
 * Pure presentation and decision logic for the Account Guard command surface.
 *
 * Nothing here imports `vscode`, so every state the user can land in — including the
 * "nothing works and nothing explains why" states — is unit-testable.
 */

export const WRAPPER_SETTING_ID = "claudeCode.claudeProcessWrapper";
export const DISABLE_ENVIRONMENT_VARIABLE = "CLAUDE_ACCOUNT_GUARD_DISABLE";

/** What `claudeCode.claudeProcessWrapper` currently points at. */
export type WrapperState = "guard" | "foreign" | "none";

export type WrapperConsent = "granted" | "declined";

export interface WrapperView {
  state: WrapperState;
  /** The value currently stored in the global setting, if any. */
  configuredPath?: string;
  /** Where Account Guard's own wrapper lives. */
  wrapperPath: string;
}

export type ConsentPlan =
  | { kind: "already_configured" }
  | { kind: "blocked_by_setting" }
  | { kind: "previously_declined" }
  | { kind: "configure" }
  | { kind: "ask" }
  | { kind: "ask_chain"; foreignWrapper: string };

export interface ConsentInput {
  /** `claudeAccountGuard.wrapper.autoConfigure`. */
  autoConfigure: boolean;
  /** The answer this user already gave, persisted across windows. */
  storedConsent?: WrapperConsent;
  configuredWrapper?: string;
  configuredIsGuard: boolean;
  /** True when the user asked for this directly rather than tripping a background check. */
  userInitiated: boolean;
}

/**
 * Decide whether the global wrapper setting may be written, and whether the user has to
 * be asked first. Activation must never reach `ask`/`ask_chain` silently: those outcomes
 * require a prompt that names the setting.
 */
export function planWrapperConsent(input: ConsentInput): ConsentPlan {
  if (input.configuredIsGuard) {
    return { kind: "already_configured" };
  }
  if (!input.autoConfigure) {
    return { kind: "blocked_by_setting" };
  }
  if (input.storedConsent === "declined" && !input.userInitiated) {
    return { kind: "previously_declined" };
  }
  if (input.configuredWrapper) {
    return { kind: "ask_chain", foreignWrapper: input.configuredWrapper };
  }
  if (input.storedConsent === "granted") {
    return { kind: "configure" };
  }
  return { kind: "ask" };
}

/**
 * Inputs for the collection diagnosis.
 *
 * These are deliberately raw facts rather than a pre-baked status string, so a richer
 * collection-health record from the telemetry layer can be mapped onto them without
 * changing any UI. When such a record exists it should supply, at minimum: whether the
 * collector is listening, why it is not (port bind, stale registration, heartbeat),
 * whether recent requests were rejected and why, whether batches normalised to nothing,
 * whether inbox files were quarantined, and the last successful write time. Those map to
 * `collectorRegistered`, `snapshotSeen`, and `lastEventAt` today, and would let
 * `diagnoseCollection` distinguish "not listening" from "listening but rejecting".
 */
export interface CollectionInput {
  /** `claudeAccountGuard.telemetry.enabled`. */
  telemetryEnabledSetting: boolean;
  /** True when the active `CLAUDE_CONFIG_DIR` maps to a registered profile. */
  runtimeRegistered: boolean;
  runtimeConfigDir: string;
  /** True when the profile being inspected is the one this window actually launches. */
  selectedIsRuntime: boolean;
  /** True when the status-line bridge was accepted for the inspected profile. */
  profileTelemetryEnabled: boolean;
  wrapperState: WrapperState;
  /** True when the user configured their own OTLP exporter, which the wrapper never overrides. */
  foreignOtelExporter: boolean;
  collectorRegistered: boolean;
  snapshotSeen: boolean;
  lastEventAt?: string;
  /**
   * The telemetry layer's own verdict, when it can be read. It owns everything from the
   * collector's socket inwards, so it wins for those phases; the checks above own the
   * user-facing setup phases, where they have the better copy and a matching action.
   */
  phase?: CollectionPhase;
  /** A sanitized reason or category from the health record. Never payload content. */
  phaseDetail?: string;
}

export type CollectionAction =
  | "none"
  | "register_runtime"
  | "open_settings"
  | "enable_profile_usage"
  | "configure_wrapper"
  | "select_runtime_profile"
  | "reload_window";

export interface CollectionDiagnosis {
  state: "active" | "awaiting_data" | "partial" | "blocked";
  headline: string;
  detail: string;
  action: CollectionAction;
  actionLabel?: string;
}

/**
 * Explain the collector's real state. "Telemetry enabled in settings" is not the same as
 * "usage is being collected", and an unexplained empty dashboard is the single most
 * confusing state this extension has.
 */
export function diagnoseCollection(input: CollectionInput): CollectionDiagnosis {
  if (!input.telemetryEnabledSetting) {
    return {
      state: "blocked",
      headline: "Local usage collection is turned off",
      detail: `Nothing is collected while claudeAccountGuard.telemetry.enabled is false.`,
      action: "open_settings",
      actionLabel: "Open Settings"
    };
  }
  if (!input.runtimeRegistered) {
    return {
      state: "blocked",
      headline: "This window's Claude account is not registered",
      detail: `Claude Code here uses ${input.runtimeConfigDir}, which is not one of your Account Guard profiles. No usage is collected and no workspace lock applies until you register it.`,
      action: "register_runtime",
      actionLabel: "Register This Account"
    };
  }
  if (!input.selectedIsRuntime) {
    return {
      state: "blocked",
      headline: "This account is not the one in play in this window",
      detail: "Only the account this window launches collects usage. Switch the dashboard account, or open a window with this profile.",
      action: "select_runtime_profile",
      actionLabel: "Show Account In Play"
    };
  }
  if (!input.profileTelemetryEnabled) {
    return {
      state: "blocked",
      headline: "Local usage is not enabled for this profile",
      detail: "Quota numbers come from a status-line bridge in this profile's Claude settings.json. It is not installed yet; your own status line is chained, not replaced.",
      action: "enable_profile_usage",
      actionLabel: "Enable Local Usage"
    };
  }
  if (input.wrapperState !== "guard") {
    return {
      state: "partial",
      headline: "Quota snapshots only — token-level telemetry is off",
      detail: `Token, cost, and tool detail arrive over OpenTelemetry, which Account Guard injects when Claude Code launches through its wrapper. ${WRAPPER_SETTING_ID} is not pointing at Account Guard, so only status-line quota snapshots are collected.`,
      action: "configure_wrapper",
      actionLabel: "Enable Integration"
    };
  }
  if (input.foreignOtelExporter) {
    return {
      state: "partial",
      headline: "Your own OpenTelemetry exporter is in use",
      detail: "OTEL_EXPORTER_OTLP_* is already set in this environment, so Account Guard deliberately does not redirect Claude's telemetry to its local collector. Quota snapshots still arrive.",
      action: "none"
    };
  }
  const reason = input.phaseDetail ? ` Reported cause: ${input.phaseDetail}.` : "";
  switch (input.phase) {
    case "port_bind_failed":
      return {
        state: "blocked",
        headline: "The local collector could not open a port",
        detail: `Nothing can be received until it does.${reason} Reload the window to retry; the diagnostics report has the sanitized error.`,
        action: "reload_window",
        actionLabel: "Reload Window"
      };
    case "collector_stopped":
      return {
        state: "blocked",
        headline: "The local collector is not running",
        detail: `No collector is listening for this profile.${reason} Reload the window to start it.`,
        action: "reload_window",
        actionLabel: "Reload Window"
      };
    case "registration_stale":
      return {
        state: "blocked",
        headline: "Claude has stopped being pointed at the collector",
        detail: `The collector registration the wrapper reads is too old, so new Claude launches no longer send telemetry to it.${reason} Reload the window to refresh it.`,
        action: "reload_window",
        actionLabel: "Reload Window"
      };
    case "rejecting":
      return {
        state: "blocked",
        headline: "The collector is turning requests away",
        detail: `Claude is sending data but the collector is refusing it.${reason} The diagnostics report lists every rejection reason and count.`,
        action: "none"
      };
    case "accepted_empty":
      return {
        state: "partial",
        headline: "Data is arriving but nothing in it is storable",
        detail: `Batches are being accepted and normalise to no usable measurement.${reason} The diagnostics report lists the counted causes.`,
        action: "none"
      };
    default:
      break;
  }
  if (!input.collectorRegistered) {
    return {
      state: "blocked",
      headline: "The local collector is not running",
      detail: "Reload the window to restart it. If it stays down, a loopback port could not be bound — the diagnostics report names the failure.",
      action: "reload_window",
      actionLabel: "Reload Window"
    };
  }
  if (!input.snapshotSeen && input.phase !== "collecting") {
    return {
      state: "awaiting_data",
      headline: "Waiting for the first Claude response",
      detail: "Collection is configured. Numbers appear after Claude Code answers once in this profile; quota windows only exist for supported subscription sessions.",
      action: "none"
    };
  }
  return {
    state: "active",
    headline: "Collecting locally",
    detail: input.lastEventAt
      ? `Last local observation ${input.lastEventAt}.`
      : "Status snapshots are arriving.",
    action: "none"
  };
}

export type MenuAction =
  | "diagnostics"
  | "registerCurrent"
  | "bind"
  | "unbind"
  | "bindTerminal"
  | "unbindTerminal"
  | "updateIdentity"
  | "addProfile"
  | "verify"
  | "login"
  | "manageProfiles"
  | "dashboard"
  | "enableUsage"
  | "exportUsage"
  | "deleteUsage"
  | "configureWrapper"
  | "disableWrapper"
  | "removeAllData";

export interface MenuEntry {
  kind: "item" | "separator";
  label: string;
  description?: string;
  detail?: string;
  action?: MenuAction;
}

/** Whether this workspace also sets `CLAUDE_CONFIG_DIR` for its integrated terminals. */
export type TerminalBinding = "applied" | "not_applied" | "unsupported";

export interface MenuState {
  hasWorkspace: boolean;
  workspaceLabel?: string;
  /** The account this workspace is bound to, if any. */
  boundProfileName?: string;
  boundMode?: LockMode;
  /** The account Claude Code will actually use here: the bound one, or the default. */
  accountName?: string;
  /** The default Claude configuration directory this window inherited. */
  runtimeConfigDir: string;
  /** True when that default directory is a registered Account Guard account. */
  runtimeRegistered: boolean;
  identityLabel?: string;
  authState?: "signed_in" | "signed_out" | "unavailable";
  lastVerifiedLabel?: string;
  profileCount: number;
  wrapper: WrapperView;
  terminalBinding: TerminalBinding;
  usageLabel?: string;
  /**
   * How the bound account's Claude identity currently compares with the one recorded.
   * "mismatch" is the only state that stops launches; "unverifiable" means the check has
   * silently stopped working; "unconfirmed" is a legitimate never-verified binding.
   */
  identity?: BindingIdentityState;
  collection: CollectionDiagnosis;
}

/** True when a binding exists that is meant to take effect. */
export function bindingActive(state: MenuState): boolean {
  return Boolean(state.boundProfileName) && state.boundMode !== "off";
}

/**
 * Say, in one line, which Claude account this workspace uses — and say plainly when a
 * binding exists but cannot be applied, because a binding that silently does nothing is
 * the worst outcome this UI can produce.
 */
export function describeBinding(state: MenuState): string {
  if (!state.hasWorkspace) {
    return "No folder open — open one to give it its own Claude account";
  }
  if (!bindingActive(state)) {
    return "Uses your default Claude account";
  }
  if (state.wrapper.state !== "guard") {
    return `Set to use ${state.boundProfileName}, but not applied yet — Claude Code is not routed through Account Guard`;
  }
  return state.boundMode === "warn"
    ? `Uses ${state.boundProfileName} (mismatches are reported, never blocked)`
    : `Uses ${state.boundProfileName}`;
}

export function describeWrapper(state: MenuState): string {
  switch (state.wrapper.state) {
    case "guard":
      return "Claude Code launches through Account Guard";
    case "foreign":
      return `Another tool's wrapper is configured: ${state.wrapper.configuredPath ?? "unknown"}`;
    default:
      return "Not connected to Claude Code — per-workspace accounts are not applied";
  }
}

export function describeAccount(state: MenuState): string {
  return state.accountName ?? "Default Claude account";
}

/**
 * The one entry point. Every row states what it will do, and rows that cannot work yet say
 * what is missing instead of failing when chosen.
 */
export function buildAccountMenu(state: MenuState): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const bound = bindingActive(state);

  entries.push({
    kind: "item",
    label: `$(account) ${describeAccount(state)}`,
    description: state.identityLabel ?? (bound ? "Identity not confirmed yet" : undefined),
    detail: [
      describeBinding(state),
      describeWrapper(state),
      state.usageLabel ?? state.collection.headline
    ].join(" · "),
    action: "diagnostics"
  });

  entries.push({
    kind: "separator",
    label: state.workspaceLabel ? `This workspace · ${state.workspaceLabel}` : "This workspace"
  });
  if (!state.hasWorkspace) {
    entries.push({
      kind: "item",
      label: "$(folder) Open a folder to give it its own Claude account",
      detail: "A Claude account is chosen per workspace. Open a folder or workspace first.",
      action: "diagnostics"
    });
  } else {
    entries.push({
      kind: "item",
      label: bound
        ? "$(arrow-swap) Use a different Claude account in this workspace…"
        : "$(check) Use a specific Claude account in this workspace…",
      description: state.profileCount === 0 ? "Adds your first account" : undefined,
      detail: state.profileCount === 0
        ? "No accounts have been added yet, so you will add one first: a name, then a sign-in in a terminal. Other workspaces keep using your default account."
        : `Claude Code started in this folder will run as the account you pick. Every other workspace is unaffected.${state.wrapper.state === "guard" ? "" : " Account Guard will ask once to route Claude Code launches through it, which is what applies the choice."}`,
      action: "bind"
    });
    if (bound && state.identity === "mismatch") {
      // The one dead end left: an enforcing binding stops every launch here until this is
      // resolved, so it goes first and says both ways out.
      entries.push({
        kind: "item",
        label: `$(alert) Resolve the identity mismatch in ${state.boundProfileName}`,
        description: state.boundMode === "enforce" ? "Launches are being stopped" : undefined,
        detail: `${state.boundProfileName} now answers as a different Claude identity than the one recorded. Shows both, then records the new one — or switches this workspace to warn-only so launches are never stopped.`,
        action: "updateIdentity"
      });
    } else if (bound && state.identity === "unverifiable") {
      entries.push({
        kind: "item",
        label: `$(question) Check the sign-in state of ${state.boundProfileName}`,
        detail: "The account is applied and launches are allowed, but the last check on it did not complete, so its sign-in state is unknown.",
        action: "updateIdentity"
      });
    } else if (bound && state.identity === "unidentified") {
      // Not a fault and not fixable from here: current Claude Code versions report no email
      // or organization whenever a per-workspace account is in use.
      entries.push({
        kind: "item",
        label: `$(check) ${state.boundProfileName} is signed in`,
        description: "Account details not reported by this Claude version",
        detail: "The account is applied and working. Claude Code does not report which account it is when a per-workspace account is in use, so Account Guard cannot warn you if that directory is signed into a different account.",
        action: "verify"
      });
    } else if (bound && state.identity === "unconfirmed") {
      entries.push({
        kind: "item",
        label: `$(check) Check the Claude sign-in for ${state.boundProfileName}`,
        description: "Optional",
        detail: "Confirms the account is signed in, and records which Claude identity it is when Claude Code reports one. The account works either way.",
        action: "verify"
      });
    }
    if (bound) {
      entries.push({
        kind: "item",
        label: `$(circle-slash) Stop using ${state.boundProfileName} in this workspace`,
        detail: "This folder goes back to your default Claude account. Nothing is signed out and no account data is removed.",
        action: "unbind"
      });
      if (state.terminalBinding === "not_applied") {
        entries.push({
          kind: "item",
          label: `$(terminal) Also use ${state.boundProfileName} for \`claude\` in this workspace's terminals`,
          detail: "Adds CLAUDE_CONFIG_DIR to this workspace's terminal.integrated.env.windows setting, so the CLI you run yourself uses the same account. Written to this workspace only.",
          action: "bindTerminal"
        });
      } else if (state.terminalBinding === "applied") {
        entries.push({
          kind: "item",
          label: "$(terminal) Stop setting the account for this workspace's terminals",
          detail: "Removes CLAUDE_CONFIG_DIR from this workspace's terminal.integrated.env.windows setting. Claude Code launched by the extension keeps using the bound account.",
          action: "unbindTerminal"
        });
      }
    }
  }

  entries.push({ kind: "separator", label: "Accounts" });
  entries.push({
    kind: "item",
    label: "$(add) Add a Claude account…",
    detail: "Give it a name; Account Guard creates a separate Claude configuration directory and opens a terminal where you sign in to that account. No new VS Code window.",
    action: "addProfile"
  });
  if (state.accountName) {
    if (state.authState !== "signed_in") {
      entries.push({
        kind: "item",
        label: `$(key) Sign in to ${state.accountName}…`,
        description: state.authState === "signed_out" ? "Signed out" : "Not confirmed",
        detail: "Opens a terminal with that account's CLAUDE_CONFIG_DIR and runs the Claude sign-in. Claude owns the browser flow.",
        action: "login"
      });
    }
    entries.push({
      kind: "item",
      label: `$(check) Verify ${state.accountName} now`,
      detail: `Runs claude auth status for that account and records the identity, which is what lets Account Guard spot a wrong-account mismatch later. Last verified: ${state.lastVerifiedLabel ?? "never"}.`,
      action: "verify"
    });
  }
  if (state.profileCount > 0) {
    entries.push({
      kind: "item",
      label: "$(settings-gear) Manage accounts…",
      detail: "Rename nothing, delete or export Account Guard's account metadata. Claude's own settings and credentials are never touched.",
      action: "manageProfiles"
    });
  }
  if (!state.runtimeRegistered) {
    entries.push({
      kind: "item",
      label: "$(person-add) Track usage for the default account",
      description: state.runtimeConfigDir,
      detail: `Registers ${state.runtimeConfigDir}, the account this window uses when no binding applies, so its usage is collected too. Binding other workspaces does not require this.`,
      action: "registerCurrent"
    });
  }

  entries.push({ kind: "separator", label: "Usage" });
  entries.push({
    kind: "item",
    label: "$(graph) Open usage dashboard",
    description: state.usageLabel,
    detail: state.collection.state === "active"
      ? state.collection.detail
      : `${state.collection.headline} — ${state.collection.detail}`,
    action: "dashboard"
  });
  if (state.collection.action === "enable_profile_usage") {
    entries.push({
      kind: "item",
      label: `$(radio-tower) Collect usage for ${state.accountName ?? "this account"}`,
      detail: "Adds a status-line command to that account's Claude settings.json and chains any status line you already have.",
      action: "enableUsage"
    });
  }
  entries.push({
    kind: "item",
    label: "$(desktop-download) Export local usage…",
    detail: "Writes the locally collected numbers to JSON or CSV. Never includes credentials or prompt content.",
    action: "exportUsage"
  });
  entries.push({
    kind: "item",
    label: "$(trash) Delete local usage data",
    detail: "Deletes every locally stored snapshot and event. Accounts, bindings, and Claude's own data are kept.",
    action: "deleteUsage"
  });

  entries.push({ kind: "separator", label: "Claude Code integration" });
  if (state.wrapper.state === "guard") {
    entries.push({
      kind: "item",
      label: "$(debug-disconnect) Disconnect from Claude Code",
      description: "Undo",
      detail: `Clears ${WRAPPER_SETTING_ID} (now ${state.wrapper.configuredPath ?? state.wrapper.wrapperPath}). Per-workspace accounts stop being applied — every workspace goes back to your default Claude account — and token telemetry stops. Accounts and bindings are kept.`,
      action: "disableWrapper"
    });
  } else {
    entries.push({
      kind: "item",
      label: "$(plug) Connect to Claude Code",
      description: bound ? "Required for this workspace's account" : undefined,
      detail: `Sets one global setting, ${WRAPPER_SETTING_ID}, to Account Guard's wrapper. That wrapper is what puts the chosen account in front of each Claude Code launch. ${state.wrapper.state === "foreign" ? "Your existing wrapper is chained, not discarded." : "Reversible from this menu."}`,
      action: "configureWrapper"
    });
  }
  entries.push({
    kind: "item",
    label: "$(info) Show diagnostics",
    detail: "Opens a redacted report: which account each part of the chain thinks is active, integration state, collection state. Safe to paste into an issue.",
    action: "diagnostics"
  });
  entries.push({
    kind: "item",
    label: "$(trash) Remove Account Guard data…",
    detail: "Disconnects from Claude Code, restores chained status lines, and deletes all accounts, bindings, and local usage. Claude Code's own configuration is left alone.",
    action: "removeAllData"
  });

  return entries;
}

/* ------------------------------------------------------------------------------------- *
 * Teardown decisions.
 *
 * Every rule below exists because a cleanup path once left a user unable to start Claude
 * Code. They are pure so they can be tested directly instead of trusted.
 * ------------------------------------------------------------------------------------- */

export interface SupportFileRemovalInput {
  /** What `disable()` reported, or undefined when it threw. */
  disableOutcome?: "cleared" | "restored_upstream" | "not_configured";
  /** Sanitised failure detail when `disable()` threw. */
  disableError?: string;
  /** Re-read after disabling: does the global setting still name an Account Guard wrapper? */
  settingStillReferencesGuard: boolean;
  /** The path the setting would be pointing at. */
  wrapperPath: string;
}

export interface SupportFileRemovalPlan {
  remove: boolean;
  state: "removed" | "kept";
  detail: string;
  manual?: string;
}

/**
 * Deleting the wrapper while Claude Code is still configured to launch through it is the
 * exact failure this whole feature exists to prevent, so the executable is only ever removed
 * once the setting has been re-read and no longer names it.
 */
export function planSupportFileRemoval(
  input: SupportFileRemovalInput
): SupportFileRemovalPlan {
  if (input.settingStillReferencesGuard) {
    return {
      remove: false,
      state: "kept",
      detail: `${WRAPPER_SETTING_ID} still points at Account Guard, so its wrapper was left in place. Deleting it now would stop Claude Code from starting at all.`,
      manual: `Clear "${WRAPPER_SETTING_ID}" in your user settings.json, reload the window, then delete ${input.wrapperPath}.`
    };
  }
  if (!input.disableOutcome) {
    return {
      remove: false,
      state: "kept",
      detail: `Account Guard could not confirm it had detached from Claude Code${input.disableError ? ` (${input.disableError})` : ""}, so its wrapper was left in place.`,
      manual: `Check "${WRAPPER_SETTING_ID}" in your user settings.json, clear it if it names Account Guard, reload the window, then delete ${input.wrapperPath}.`
    };
  }
  return {
    remove: true,
    state: "removed",
    detail: input.disableOutcome === "restored_upstream"
      ? "The wrapper you had configured before Account Guard was restored, and Account Guard's own wrapper was removed."
      : "Claude Code no longer launches through Account Guard, and its wrapper was removed."
  };
}

export interface StatusLineTeardownInput {
  profileName: string;
  configDir: string;
  /** What `uninstall()` reported, or undefined when it threw. */
  restored?: "previous_status_line" | "previous_command" | "claude_default" | "unchanged";
  backupState?: "none_recorded" | "valid" | "valid_empty" | "corrupt" | "missing";
  /** Re-read of the profile's settings.json: does an Account Guard status line remain? */
  guardCommandRemains: boolean;
  error?: string;
}

export interface StatusLineTeardownPlan {
  state: "removed" | "kept" | "failed";
  /** False when the profile's metadata must survive so the bridge can still be detached. */
  safeToForgetProfile: boolean;
  detail: string;
  manual?: string;
}

/**
 * A non-throwing `uninstall()` is not success: it deliberately reports `unchanged` when the
 * backup is missing or corrupt, and leaves its own command in `settings.json` rather than
 * blanking the user's status line. Deleting the bridge script in that state points Claude at
 * a file that no longer exists on every status-line refresh.
 */
export function planStatusLineTeardown(
  input: StatusLineTeardownInput
): StatusLineTeardownPlan {
  const settings = `${input.configDir}\\settings.json`;
  if (input.error) {
    return {
      state: "failed",
      safeToForgetProfile: false,
      detail: `The status line for ${input.profileName} could not be restored (${input.error}).`,
      manual: `Open ${settings} and set "statusLine" back to your own command, or remove it.`
    };
  }
  if (input.guardCommandRemains) {
    return {
      state: "kept",
      safeToForgetProfile: false,
      detail: input.backupState === "corrupt" || input.backupState === "missing"
        ? `${input.profileName} still runs Account Guard's status line: the record of what it replaced is ${input.backupState}, so nothing was overwritten in ${settings}.`
        : `${input.profileName} still runs Account Guard's status line in ${settings}.`,
      manual: `Open ${settings} and replace the "statusLine" command with your own, or remove it. Account Guard's files were kept so that status line keeps working until you do.`
    };
  }
  return {
    state: "removed",
    safeToForgetProfile: true,
    detail: input.restored === "previous_status_line" || input.restored === "previous_command"
      ? `${input.profileName} had its previous status line restored.`
      : input.restored === "claude_default"
        ? `${input.profileName} went back to Claude's default status line.`
        : `${input.profileName} had no Account Guard status line to remove.`
  };
}

/** Every change of which account a workspace uses invalidates the wrapper's binding cache. */
export type BindingChange =
  | "bind"
  | "rebind"
  | "unbind"
  | "mode_change"
  | "profile_delete"
  | "data_removal";

export function requiresBindingCacheInvalidation(change: BindingChange): boolean {
  // All of them: the cache is what the wrapper falls back to when the registry cannot be
  // read, so a stale entry silently runs Claude as the account the user just stopped using.
  return [
    "bind",
    "rebind",
    "unbind",
    "mode_change",
    "profile_delete",
    "data_removal"
  ].includes(change);
}

export interface TeardownStep {
  artifact: string;
  state: "removed" | "kept" | "failed" | "not_present";
  detail?: string;
  manual?: string;
}

export interface TeardownSummary {
  complete: boolean;
  headline: string;
  /** Ordered manual steps, ready to show. Empty when nothing was left behind. */
  manual: string[];
  detail: string[];
}

/** Report per artifact, so "removed everything" is never claimed on top of a failure. */
export function summarizeTeardown(steps: readonly TeardownStep[]): TeardownSummary {
  const unfinished = steps.filter((step) => step.state === "kept" || step.state === "failed");
  return {
    complete: unfinished.length === 0,
    headline: unfinished.length === 0
      ? "Account Guard removed everything it had installed and detached from Claude Code."
      : `Account Guard removed most of its data, but ${unfinished.length} item${unfinished.length === 1 ? "" : "s"} need${unfinished.length === 1 ? "s" : ""} your attention.`,
    manual: unfinished.flatMap((step) => step.manual ? [`${step.artifact}: ${step.manual}`] : []),
    detail: steps.flatMap((step) => step.detail ? [`${step.artifact}: ${step.detail}`] : [])
  };
}

export type FirstRunPlan = "none" | "onboarding" | "register_runtime_notice";

export function planFirstRun(input: {
  onboarded: boolean;
  hasWorkspace: boolean;
  boundToProfile: boolean;
  profileCount: number;
  runtimeRegistered: boolean;
  noticeSeenForConfigDir: boolean;
}): FirstRunPlan {
  if (!input.hasWorkspace) {
    return "none";
  }
  if (!input.onboarded) {
    return "onboarding";
  }
  // Only worth mentioning once accounts exist and this workspace is not using one: that is
  // the state where usage collection silently has nothing to attribute.
  if (
    !input.runtimeRegistered
    && !input.boundToProfile
    && input.profileCount > 0
    && !input.noticeSeenForConfigDir
  ) {
    return "register_runtime_notice";
  }
  return "none";
}
