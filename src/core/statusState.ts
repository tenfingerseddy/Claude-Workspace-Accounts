import type {
  AccountProfile,
  AccountQuotaCache,
  AuthVerification,
  GuardStatus,
  GuardStatusInput,
  QuotaAbsence,
  QuotaAbsentWindow,
  QuotaReport,
  QuotaWindowKey,
  QuotaWindowReading,
  RateLimitWindow,
  StatusSnapshot,
  WorkspaceLock
} from "./models.js";
import { compareIdentity } from "./identity.js";

interface SelectedUsage {
  label: string;
  percentage: number;
  window: "five_hour" | "seven_day";
  severity: "normal" | "warning" | "critical";
}

function classify(value: number, warning: number, critical: number): SelectedUsage["severity"] {
  if (value >= critical) {
    return "critical";
  }
  if (value >= warning) {
    return "warning";
  }
  return "normal";
}

/**
 * Pick the single window worth alarming about.
 *
 * Superseded for display by `buildQuotaReport`, which reports *both* windows plus the reset times
 * and the reading's age — showing one number in isolation is what made quota look like a guess.
 * Retained because the severity ranking is the same one `buildQuotaReport().worst` uses, and the
 * wrapper smoke gate asserts it.
 */
export function selectUsage(
  fiveHour: RateLimitWindow | undefined,
  sevenDay: RateLimitWindow | undefined,
  warning: number,
  critical: number
): SelectedUsage | undefined {
  const candidates: SelectedUsage[] = [];
  if (fiveHour) {
    candidates.push({
      label: `5h ${Math.round(fiveHour.usedPercentage)}%`,
      percentage: fiveHour.usedPercentage,
      window: "five_hour",
      severity: classify(fiveHour.usedPercentage, warning, critical)
    });
  }
  if (sevenDay) {
    candidates.push({
      label: `7d ${Math.round(sevenDay.usedPercentage)}%`,
      percentage: sevenDay.usedPercentage,
      window: "seven_day",
      severity: classify(sevenDay.usedPercentage, warning, critical)
    });
  }
  return candidates.sort((left, right) => {
    const rank = { normal: 0, warning: 1, critical: 2 };
    return rank[right.severity] - rank[left.severity]
      || (left.window === "five_hour" ? -1 : 1);
  })[0];
}

/* ------------------------------------------------------------------------------------- *
 * Quota, which is the headline.
 *
 * Locally accumulated tokens and cost only start when this extension is installed, so they say
 * nothing about plan headroom. `rate_limits` does: it is Claude's own figure. One derivation,
 * shared by the status bar, the dashboard and diagnostics, so a percentage can never appear on
 * one surface without the reset time and the reading's age that make it interpretable.
 * ------------------------------------------------------------------------------------- */

/**
 * Past this, a percentage describes a window that has probably moved.
 *
 * Calibrated to a status line, which Claude re-renders every few seconds: fifteen minutes without
 * one meant something had stopped.
 */
export const QUOTA_STALE_AFTER_MS = 15 * 60_000;

/**
 * The same judgement for the quota cache, which is refreshed far less often.
 *
 * Claude decides when to refresh `cachedUsageUtilization`, and it is not on session start — a live
 * reading measured thirty-five minutes old with two sessions launched in between. Reusing the
 * status line's fifteen minutes would label almost every genuine reading stale, and a warning that
 * is always on tells the user nothing. The age is stated on every surface regardless; this only
 * decides when to actively distrust the figure.
 */
export const QUOTA_CACHE_STALE_AFTER_MS = 90 * 60_000;

/** The two windows every account is expected to have, and whose absence is therefore explained. */
const QUOTA_WINDOWS: readonly QuotaWindowKey[] = ["five_hour", "seven_day"];

const QUOTA_LABELS: Record<QuotaWindowKey, { label: string; shortLabel: string }> = {
  five_hour: { label: "5-hour window", shortLabel: "5h" },
  seven_day: { label: "7-day window", shortLabel: "7d" },
  // Only ever shown with the model grafted on, since several of these can be present at once.
  weekly_scoped: { label: "weekly window", shortLabel: "7d" }
};

/**
 * One window, normalized away from whichever source produced it.
 *
 * The quota cache states reset times as ISO 8601 and the status line stated them as Unix epoch
 * seconds. Reconciling that here is what lets one derivation serve both, and is why the epoch
 * seconds are carried through unchanged — `resetsAt` on the reading is a documented wire value.
 */
interface QuotaSourceWindow {
  window: QuotaWindowKey;
  usedPercentage: number;
  resetsAtMs?: number;
  scopeModel?: string;
  reportedSeverity?: string;
  active?: boolean;
}

function sourceWindows(input: {
  cache?: AccountQuotaCache;
  snapshot?: Pick<StatusSnapshot, "capturedAt" | "rateLimits">;
}): QuotaSourceWindow[] {
  if (input.cache) {
    return input.cache.windows.map((entry) => {
      const parsed = entry.resetsAt === undefined ? Number.NaN : Date.parse(entry.resetsAt);
      return {
        window: entry.window,
        usedPercentage: entry.usedPercentage,
        resetsAtMs: Number.isFinite(parsed) ? parsed : undefined,
        scopeModel: entry.scopeModel,
        reportedSeverity: entry.reportedSeverity,
        active: entry.active
      };
    });
  }
  const windows: QuotaSourceWindow[] = [];
  for (const key of QUOTA_WINDOWS) {
    const value: RateLimitWindow | undefined = key === "five_hour"
      ? input.snapshot?.rateLimits?.fiveHour
      : input.snapshot?.rateLimits?.sevenDay;
    if (!value) {
      continue;
    }
    windows.push({
      window: key,
      usedPercentage: value.usedPercentage,
      // Claude reported epoch *seconds*. Treating them as milliseconds put every reset in 1970.
      resetsAtMs: value.resetsAt === undefined || !Number.isFinite(value.resetsAt)
        ? undefined
        : value.resetsAt * 1000
    });
  }
  return windows;
}

function windowLabels(entry: QuotaSourceWindow): { label: string; shortLabel: string } {
  const base = QUOTA_LABELS[entry.window];
  if (entry.window !== "weekly_scoped") {
    return base;
  }
  // A per-model window with no model named is unusable as a heading, so it says so rather than
  // rendering as a second, indistinguishable "weekly window" card.
  const model = entry.scopeModel ?? "unnamed model";
  return { label: `${model} ${base.label}`, shortLabel: `${base.shortLabel} ${model}` };
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "2h 40m", "3d 4h", "45m". Coarse on purpose: a reset time is not a stopwatch. */
export function formatQuotaDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (totalMinutes < 1) {
    return "under a minute";
  }
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** How old the reading is, in words. A percentage with no age is not a measurement. */
export function formatQuotaAge(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) {
    return "seconds ago";
  }
  if (minutes < 60) {
    return `${plural(minutes, "minute")} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${plural(hours, "hour")} ago`;
  }
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

/**
 * Say why a figure is missing. Never "0%", never "unavailable" on its own.
 *
 * Absence must read as a fact about the account rather than a fault here. It says nothing about
 * which plans report quota: an earlier note claimed a `team` subscription never does, and a live
 * team account reports both windows, a per-model window and a credit pool. Do not put a
 * subscription type in this copy again.
 */
export function describeQuotaAbsence(reason: QuotaAbsence, label: string): string {
  switch (reason) {
    case "no_session":
      return `Claude has not recorded a quota reading for this account yet, so there is no ${label} to show. Claude writes one into the account's configuration directory when it next refreshes usage, which happens the first time it answers under this account.`;
    case "not_reported_for_account":
      return `Claude has a usage reading for this account but no ${label} in it. That is a fact about the plan rather than a fault here.`;
    case "window_not_reported":
      return `Claude reported quota for this account but not the ${label}. The windows are independently optional and one can be absent while the others are present.`;
  }
}

function mostSevere(windows: readonly QuotaWindowReading[]): QuotaWindowReading | undefined {
  const rank = { normal: 0, warning: 1, critical: 2 };
  return [...windows].sort((left, right) => rank[right.severity] - rank[left.severity]
    || (left.window === "five_hour" ? -1 : 1))[0];
}

/**
 * Reduce a status snapshot to what Claude actually said about plan headroom.
 *
 * `now` is injectable because every field here is time-relative and a test that cannot pin the
 * clock cannot assert any of it.
 */
export function buildQuotaReport(input: {
  /** The quota cache for the account. The preferred source; see `AccountQuotaCache`. */
  cache?: AccountQuotaCache;
  /**
   * A status-line snapshot, used only when there is no cache.
   *
   * Retained rather than deleted because a status line does still fire for `claude` run in a
   * terminal, and a reading from one is a real reading. It is simply never the source inside the
   * editor, which is what the earlier design got wrong.
   */
  snapshot?: Pick<StatusSnapshot, "capturedAt" | "rateLimits">;
  warningThreshold: number;
  criticalThreshold: number;
  now?: number;
}): QuotaReport {
  const now = input.now ?? Date.now();
  const capturedAt = input.cache?.fetchedAt ?? input.snapshot?.capturedAt;
  const capturedAtMs = capturedAt === undefined ? Number.NaN : Date.parse(capturedAt);
  const ageMs = Number.isFinite(capturedAtMs) ? Math.max(0, now - capturedAtMs) : undefined;
  const source = sourceWindows(input);
  const hasReading = Boolean(input.cache) || Boolean(input.snapshot);
  const staleAfter = input.cache ? QUOTA_CACHE_STALE_AFTER_MS : QUOTA_STALE_AFTER_MS;
  const freshness: QuotaReport["freshness"] = !hasReading
    ? "none"
    : ageMs !== undefined && ageMs <= staleAfter
      ? "fresh"
      : "stale";
  const windows: QuotaWindowReading[] = source.map((entry) => {
    const { label, shortLabel } = windowLabels(entry);
    const used = Math.max(0, Math.min(100, entry.usedPercentage));
    const resetsAtMs = entry.resetsAtMs;
    return {
      window: entry.window,
      label,
      shortLabel,
      usedPercentage: used,
      remainingPercentage: Math.max(0, 100 - used),
      severity: classify(used, input.warningThreshold, input.criticalThreshold),
      // The reading keeps epoch seconds, which is the shape both sources are documented in.
      resetsAt: resetsAtMs === undefined ? undefined : Math.floor(resetsAtMs / 1000),
      resetsAtIso: resetsAtMs === undefined ? undefined : new Date(resetsAtMs).toISOString(),
      resetsInLabel: resetsAtMs === undefined
        ? undefined
        : resetsAtMs <= now
          ? "due now"
          : `in ${formatQuotaDuration(resetsAtMs - now)}`,
      expired: resetsAtMs !== undefined && resetsAtMs <= now,
      scopeModel: entry.scopeModel,
      reportedSeverity: entry.reportedSeverity,
      active: entry.active
    };
  });
  // Only the two windows every account is expected to have are reported as absent. A per-model
  // window that is not present is not missing — most accounts have none at all.
  const absent: QuotaAbsentWindow[] = [];
  for (const key of QUOTA_WINDOWS) {
    if (windows.some((entry) => entry.window === key)) {
      continue;
    }
    const { label } = QUOTA_LABELS[key];
    const reason: QuotaAbsence = !hasReading
      ? "no_session"
      : windows.length > 0
        ? "window_not_reported"
        : "not_reported_for_account";
    absent.push({ window: key, label, reason, detail: describeQuotaAbsence(reason, label) });
  }
  return {
    windows,
    absent,
    capturedAt,
    ageMs,
    ageLabel: ageMs === undefined ? undefined : formatQuotaAge(ageMs),
    freshness,
    worst: mostSevere(windows),
    creditPool: input.cache?.creditPool
  };
}

/** The status bar's quota label: "5h 42% · 7d 86%", present windows only. */
export function quotaStatusLabel(report: QuotaReport): string | undefined {
  if (report.windows.length === 0) {
    return undefined;
  }
  return report.windows
    .map((entry) => `${entry.shortLabel} ${Math.round(entry.usedPercentage)}%`)
    .join(" · ");
}

/**
 * How a workspace's bound account compares with the identity recorded for it.
 *
 * One definition, used by the status bar, the dashboard and the diagnostics report, because
 * three near-copies disagreed: two of them treated "signed out" and "cannot tell" as a wrong
 * account, while the wrapper allows both and stops a launch only on a real mismatch.
 */
export type BindingIdentityState =
  /** No account is bound to this workspace, or the binding is switched off. */
  | "unbound"
  /** Bound, but no identity was ever recorded. Legitimate: nothing is probed or blocked. */
  | "unconfirmed"
  /** The recorded identity answered. */
  | "match"
  /** A different identity answered. The only state that can stop a launch. */
  | "mismatch"
  /**
   * Signed in, but the CLI reported no identity at all. This is the normal outcome for any
   * account used through `CLAUDE_CONFIG_DIR` on current Claude Code versions, so it is a
   * distinct, non-alarming state rather than a failure.
   */
  | "unidentified"
  /** A probe failed or the account is signed out, so nothing can be compared. Never blocks. */
  | "unverifiable";

export function bindingIdentityState(input: {
  lock?: Pick<WorkspaceLock, "mode"> | undefined;
  boundProfile?: Pick<AccountProfile, "expectedIdentity"> | undefined;
  verification?: Pick<AuthVerification, "state" | "email" | "accountId" | "organizationId">;
}): BindingIdentityState {
  if (!input.lock || input.lock.mode === "off" || !input.boundProfile) {
    return "unbound";
  }
  if (!input.boundProfile.expectedIdentity) {
    return "unconfirmed";
  }
  if (!input.verification || input.verification.state !== "signed_in") {
    return "unverifiable";
  }
  if (!input.verification.email && !input.verification.accountId) {
    return "unidentified";
  }
  const match = compareIdentity(input.boundProfile.expectedIdentity, input.verification);
  return match === "mismatch" ? "mismatch" : match === "match" ? "match" : "unverifiable";
}

/**
 * Which account a usage surface should present.
 *
 * The order is the whole point. An account the user explicitly asked to view wins, because viewing
 * one account's history from another's workspace is a legitimate thing to do. Failing that it is the
 * account this workspace actually uses — its binding when it has one, and only otherwise whatever
 * this window inherited.
 *
 * The dashboard skipped the middle term: it fell back to the *ambient* account and then to the first
 * entry in the registry. A workspace bound to the second registered account therefore opened the
 * dashboard on the first one, showing that account's name, quota and history while the status bar
 * named the bound account — and the ambient directory is usually the plain default, which is
 * registered as no profile at all, so the arbitrary fallback was what the user actually got.
 */
export function selectUsageAccount<T extends { id: string }>(input: {
  profiles: readonly T[];
  /** An account the user explicitly chose to view. Honoured even when it is not the one in use. */
  requestedId?: string;
  /** The account in play here: the bound one when this workspace has a binding, else the ambient. */
  inPlay?: T;
}): T | undefined {
  return input.profiles.find((profile) => profile.id === input.requestedId)
    ?? input.inPlay
    ?? input.profiles[0];
}

/**
 * Say that local storage has stopped accepting writes, on whatever the status would otherwise be.
 *
 * Applied last, to every outcome, because the failure this repairs was silence: a storage failure
 * was recorded and then discarded by each of the three consumers, so the status bar kept showing
 * the last quota reading as though it were current.
 */
function withStorageWarning(status: GuardStatus, input: GuardStatusInput): GuardStatus {
  if (input.collectionPhase !== "storage_failed") {
    return status;
  }
  const category = input.collectionDetail ? ` (${input.collectionDetail})` : "";
  const warning = `Local usage storage is failing${category}, so nothing new is being recorded and any quota figure shown may be frozen.`;
  return {
    ...status,
    // A real identity mismatch is the more urgent problem and keeps its own error styling.
    severity: status.severity === "normal" ? "warning" : status.severity,
    text: `$(warning) ${status.text.replace(/^\$\([^)]+\)\s*/, "")} · storage failing`,
    collectionWarning: warning,
    detail: `${status.detail} ${warning}`
  };
}

export function deriveGuardStatus(input: GuardStatusInput): GuardStatus {
  const status = deriveBaseStatus(input);
  // Verification is transient and says nothing about storage; everything else must report it.
  return status.kind === "verifying" ? status : withStorageWarning(status, input);
}

/**
 * Replace a status's text while keeping any storage warning attached to it.
 *
 * Presentation rules downstream rewrite the text for some identity states, which silently dropped
 * the warning. Composing through one function is what stops that, and stops a consumer from having
 * to inspect the string it was handed to work out what is in it.
 */
export function withStatusText(status: GuardStatus, text: string): GuardStatus {
  return {
    ...status,
    text: status.collectionWarning
      ? `$(warning) ${text.replace(/^\$\([^)]+\)\s*/, "")} · storage failing`
      : text
  };
}

function deriveBaseStatus(input: GuardStatusInput): GuardStatus {
  const runtimeName = input.runtime.profile?.displayName ?? "Unregistered";
  const requiredName = input.requiredProfile?.displayName ?? "unknown profile";
  const activeLock = input.lock?.mode === "off" ? undefined : input.lock;

  if (input.verifying) {
    return {
      kind: "verifying",
      text: "$(sync~spin) Claude · Verifying",
      severity: "normal",
      detail: `Verifying ${runtimeName}`
    };
  }

  if (activeLock) {
    // Only a real mismatch is reported as blocked. The wrapper applies the bound account
    // itself, so the ambient configuration directory is irrelevant here, and it forwards the
    // launch when the identity cannot be read — reporting either as "blocked" was a lie that
    // sent people hunting for a problem that did not exist.
    const identity = bindingIdentityState({
      lock: activeLock,
      boundProfile: input.requiredProfile,
      verification: input.verification
    });
    if (identity === "mismatch") {
      if (activeLock.mode === "warn") {
        return {
          kind: "wrong_account_warning",
          text: `$(warning) Claude · ${requiredName} identity changed`,
          severity: "warning",
          detail: `A different Claude identity now answers in ${requiredName}. Launches are not stopped in warn mode.`
        };
      }
      return {
        kind: "wrong_account",
        text: `$(error) Claude blocked · ${requiredName} identity changed`,
        severity: "error",
        detail: `A different Claude identity now answers in ${requiredName}, so launches in this workspace are stopped. Update the expected identity, or switch this workspace to warn.`
      };
    }
  }

  if (!input.runtime.profile) {
    return {
      kind: "unregistered",
      text: "$(warning) Claude · Unregistered account",
      severity: "warning",
      detail: "Track this Claude configuration directory to bind a workspace to it and see its quota."
    };
  }

  if (input.verification?.state === "signed_out") {
    return {
      kind: "signed_out",
      text: `$(warning) Claude · ${runtimeName} · Sign in`,
      severity: "warning",
      detail: `${runtimeName} is not authenticated.`
    };
  }

  if (input.verification?.state !== "signed_in") {
    return {
      kind: "usage_unavailable",
      text: `${activeLock ? "$(link)" : "$(account)"} Claude · ${runtimeName}`,
      severity: "normal",
      detail: "Authentication could not be verified."
    };
  }

  const quota = buildQuotaReport({
    cache: input.quotaCache,
    snapshot: input.snapshot,
    warningThreshold: input.warningThreshold,
    criticalThreshold: input.criticalThreshold
  });
  const prefix = activeLock ? "$(link)" : "$(account)";
  const label = quotaStatusLabel(quota);
  // Quota leads. It is Claude's own figure and the only measure of plan headroom this product can
  // obtain; the account name follows it, and nothing accumulated locally appears here at all.
  if (label && input.showUsage && quota.freshness === "fresh") {
    const severe = quota.worst && quota.worst.severity !== "normal";
    return {
      kind: severe ? "limit_warning" : activeLock ? "locked_valid" : "valid_unlocked",
      text: `${severe ? "$(warning)" : prefix} ${label} · ${runtimeName}`,
      severity: severe ? "warning" : "normal",
      usageLabel: label,
      usagePercentage: quota.worst?.usedPercentage,
      usageWindow: quota.worst?.window,
      quota,
      detail: describeQuota(quota, runtimeName)
    };
  }

  // Absent or stale quota is stated, not hidden: the owner's complaint was seeing nothing at all
  // and having no way to tell whether that was breakage or an empty history.
  const suffix = !input.showUsage
    ? undefined
    : label
      ? "quota reading is stale"
      : quota.absent[0]?.reason === "no_session"
        ? "no quota reported yet"
        : "quota not reported for this account";
  return {
    kind: input.quotaCache ?? input.snapshot
      ? (activeLock ? "locked_valid" : "valid_unlocked")
      : "usage_unavailable",
    text: `${prefix} Claude · ${runtimeName}${suffix ? ` · ${suffix}` : ""}`,
    severity: "normal",
    quota,
    detail: label
      ? `${describeQuota(quota, runtimeName)} That reading is stale — Claude has not refreshed it since.`
      : quota.absent.map((entry) => entry.detail).join(" ")
  };
}

/** One sentence per reported window: used, left, and when it resets. */
function describeQuota(quota: QuotaReport, runtimeName: string): string {
  const parts = quota.windows.map((entry) => {
    const reset = entry.resetsInLabel
      ? entry.expired
        ? ", reset due now"
        : `, resets ${entry.resetsInLabel}`
      : ", reset time not reported";
    return `${entry.label}: ${Math.round(entry.usedPercentage)}% used, ${Math.round(entry.remainingPercentage)}% left${reset}`;
  });
  const missing = quota.absent.map((entry) => entry.detail);
  const age = quota.ageLabel ? ` Reported by Claude ${quota.ageLabel}.` : "";
  return `${runtimeName} — ${parts.join("; ")}.${age}${missing.length > 0 ? ` ${missing.join(" ")}` : ""}`;
}
