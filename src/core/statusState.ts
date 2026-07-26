import type {
  AccountProfile,
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

/** Past this, a percentage describes a window that has probably moved. */
export const QUOTA_STALE_AFTER_MS = 15 * 60_000;

const QUOTA_WINDOWS: readonly QuotaWindowKey[] = ["five_hour", "seven_day"];

const QUOTA_LABELS: Record<QuotaWindowKey, { label: string; shortLabel: string }> = {
  five_hour: { label: "5-hour window", shortLabel: "5h" },
  seven_day: { label: "7-day window", shortLabel: "7d" }
};

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
 * The owner's own account is on a `team` subscription, which the documentation describes quota as
 * a Pro/Max feature of — so "never reported for this account" is a legitimate permanent outcome
 * and has to read as a fact about the plan rather than as a fault in this extension.
 */
export function describeQuotaAbsence(reason: QuotaAbsence, label: string): string {
  switch (reason) {
    case "no_session":
      return `No Claude Code session has run under this account yet, so Claude has not reported the ${label}. It appears once Claude answers in a workspace that uses this account.`;
    case "not_reported_for_account":
      return `Claude did not report the ${label} for this account. Quota reaches a status line only for Claude.ai subscription accounts, and only after the first response in a session; on some plans it is never reported.`;
    case "window_not_reported":
      return `Claude reported quota for this account but not the ${label}. The two windows are independently optional and one can be absent while the other is present.`;
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
  snapshot?: Pick<StatusSnapshot, "capturedAt" | "rateLimits">;
  warningThreshold: number;
  criticalThreshold: number;
  now?: number;
}): QuotaReport {
  const now = input.now ?? Date.now();
  const snapshot = input.snapshot;
  const capturedAtMs = snapshot ? Date.parse(snapshot.capturedAt) : Number.NaN;
  const ageMs = Number.isFinite(capturedAtMs) ? Math.max(0, now - capturedAtMs) : undefined;
  const freshness: QuotaReport["freshness"] = !snapshot
    ? "none"
    : ageMs !== undefined && ageMs <= QUOTA_STALE_AFTER_MS
      ? "fresh"
      : "stale";
  // Normalization already discards a null percentage, so an object here means Claude reported one.
  const anyReported = Boolean(snapshot?.rateLimits?.fiveHour ?? snapshot?.rateLimits?.sevenDay);
  const windows: QuotaWindowReading[] = [];
  const absent: QuotaAbsentWindow[] = [];
  for (const key of QUOTA_WINDOWS) {
    const { label, shortLabel } = QUOTA_LABELS[key];
    const value: RateLimitWindow | undefined = key === "five_hour"
      ? snapshot?.rateLimits?.fiveHour
      : snapshot?.rateLimits?.sevenDay;
    if (!value) {
      const reason: QuotaAbsence = !snapshot
        ? "no_session"
        : anyReported
          ? "window_not_reported"
          : "not_reported_for_account";
      absent.push({ window: key, label, reason, detail: describeQuotaAbsence(reason, label) });
      continue;
    }
    const used = Math.max(0, Math.min(100, value.usedPercentage));
    // Claude reports epoch *seconds*. Treating them as milliseconds put every reset in 1970.
    const resetsAtMs = value.resetsAt === undefined || !Number.isFinite(value.resetsAt)
      ? undefined
      : value.resetsAt * 1000;
    windows.push({
      window: key,
      label,
      shortLabel,
      usedPercentage: used,
      remainingPercentage: Math.max(0, 100 - used),
      severity: classify(used, input.warningThreshold, input.criticalThreshold),
      resetsAt: value.resetsAt,
      resetsAtIso: resetsAtMs === undefined ? undefined : new Date(resetsAtMs).toISOString(),
      resetsInLabel: resetsAtMs === undefined
        ? undefined
        : resetsAtMs <= now
          ? "due now"
          : `in ${formatQuotaDuration(resetsAtMs - now)}`,
      expired: resetsAtMs !== undefined && resetsAtMs <= now
    });
  }
  return {
    windows,
    absent,
    capturedAt: snapshot?.capturedAt,
    ageMs,
    ageLabel: ageMs === undefined ? undefined : formatQuotaAge(ageMs),
    freshness,
    worst: mostSevere(windows)
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
    kind: input.snapshot ? (activeLock ? "locked_valid" : "valid_unlocked") : "usage_unavailable",
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
