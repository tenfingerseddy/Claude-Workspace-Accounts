import type {
  GuardStatus,
  GuardStatusInput,
  RateLimitWindow
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
    const runtimeMatches = input.runtime.profile?.id === activeLock.profileId;
    const identityMatches = compareIdentity(
      input.requiredProfile?.expectedIdentity,
      input.verification ?? { state: "unavailable" }
    );
    const signedOutRuntime = runtimeMatches && input.verification?.state === "signed_out";
    if (!signedOutRuntime && (!runtimeMatches || identityMatches !== "match")) {
      if (activeLock.mode === "warn") {
        return {
          kind: "wrong_account_warning",
          text: `$(warning) Claude · ${requiredName} required`,
          severity: "warning",
          detail: !runtimeMatches
            ? `Warning-only lock requires ${requiredName}; runtime profile is ${runtimeName}.`
            : `Warning-only lock identity does not match ${requiredName}.`
        };
      }
      return {
        kind: "wrong_account",
        text: `$(error) Claude blocked · ${requiredName} required`,
        severity: "error",
        detail: !runtimeMatches
          ? `Workspace requires ${requiredName}; runtime profile is ${runtimeName}.`
          : `The verified identity does not match ${requiredName}.`
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
