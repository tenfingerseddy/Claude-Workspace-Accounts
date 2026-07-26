import type {
  AccountProfile,
  AuthVerification,
  GuardStatus,
  GuardStatusInput,
  RateLimitWindow,
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

export function deriveGuardStatus(input: GuardStatusInput): GuardStatus {
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
      detail: "Register the runtime configuration directory before using workspace locks."
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
      text: `${activeLock ? "$(lock)" : "$(account)"} Claude · ${runtimeName}`,
      severity: "normal",
      detail: "Authentication could not be verified."
    };
  }

  const snapshotTimestamp = input.snapshot ? Date.parse(input.snapshot.capturedAt) : NaN;
  const snapshotAge = Date.now() - snapshotTimestamp;
  const snapshotFresh = Number.isFinite(snapshotTimestamp)
    && snapshotAge >= -60_000
    && snapshotAge <= 15 * 60_000;
  const usage = snapshotFresh
    ? selectUsage(
      input.snapshot?.rateLimits?.fiveHour,
      input.snapshot?.rateLimits?.sevenDay,
      input.warningThreshold,
      input.criticalThreshold
    )
    : undefined;
  const prefix = activeLock ? "$(lock)" : "$(account)";
  if (usage && input.showUsage) {
    const warning = usage.severity !== "normal";
    return {
      kind: warning ? "limit_warning" : activeLock ? "locked_valid" : "valid_unlocked",
      text: `${warning ? "$(warning)" : prefix} Claude · ${runtimeName} · ${usage.label}`,
      severity: warning ? "warning" : "normal",
      usageLabel: usage.label,
      usagePercentage: usage.percentage,
      usageWindow: usage.window,
      detail: `${runtimeName} is verified${activeLock ? " and matches the workspace lock" : ""}.`
    };
  }

  return {
    kind: input.snapshot ? (activeLock ? "locked_valid" : "valid_unlocked") : "usage_unavailable",
    text: `${prefix} Claude · ${runtimeName}`,
    severity: "normal",
    detail: input.snapshot
      ? snapshotFresh
        ? `${runtimeName} is verified.`
        : `${runtimeName} is verified; the latest usage snapshot is stale.`
      : "Usage is unavailable until Claude emits a status snapshot."
  };
}
