import { describe, expect, it } from "vitest";
import type { AccountProfile, GuardStatusInput } from "../../src/core/models.js";
import {
  bindingIdentityState,
  buildQuotaReport,
  deriveGuardStatus,
  formatQuotaAge,
  formatQuotaDuration,
  quotaStatusLabel,
  selectUsage,
  selectUsageAccount
} from "../../src/core/statusState.js";

const lock = (mode: "enforce" | "warn" | "off") => ({
  workspaceUri: "file:///c:/repo",
  workspacePathNormalized: "c:\repo",
  workspaceLabel: "repo",
  profileId: "work",
  mode,
  createdAt: "",
  updatedAt: ""
});

const profile = {
  id: "work",
  displayName: "Work",
  expectedIdentity: { email: "work@example.com" }
} as AccountProfile;

const base: GuardStatusInput = {
  runtime: {
    configDir: "C:\\Users\\dev\\.claude-work",
    configDirNormalized: "c:\\users\\dev\\.claude-work",
    profile
  },
  verification: {
    state: "signed_in",
    checkedAt: "2026-07-23T00:00:00Z",
    email: "work@example.com"
  },
  warningThreshold: 70,
  criticalThreshold: 90,
  showUsage: true,
  verifying: false
};

describe("status state machine", () => {
  it("blocks an enforced binding whose account answers as somebody else", () => {
    const result = deriveGuardStatus({
      ...base,
      verification: {
        state: "signed_in",
        checkedAt: "2026-07-23T00:00:00Z",
        email: "someone.else@example.com"
      },
      lock: lock("enforce"),
      requiredProfile: profile
    });
    expect(result.kind).toBe("wrong_account");
    expect(result.severity).toBe("error");
  });

  it("does not block merely because the ambient account differs from the bound one", () => {
    // The wrapper sets CLAUDE_CONFIG_DIR itself, so the ambient directory proves nothing.
    const result = deriveGuardStatus({
      ...base,
      lock: { ...lock("enforce"), profileId: "personal" },
      requiredProfile: { ...profile, id: "personal", displayName: "Personal" }
    });
    expect(result.kind).not.toBe("wrong_account");
    expect(result.severity).not.toBe("error");
  });

  it("does not block when the identity cannot be read", () => {
    const result = deriveGuardStatus({
      ...base,
      verification: { state: "unavailable", checkedAt: "2026-07-23T00:00:00Z" },
      lock: lock("enforce"),
      requiredProfile: profile
    });
    expect(result.kind).not.toBe("wrong_account");
  });

  it("does not block a binding with no recorded identity", () => {
    const result = deriveGuardStatus({
      ...base,
      lock: lock("enforce"),
      requiredProfile: { ...profile, expectedIdentity: undefined }
    });
    expect(result.kind).not.toBe("wrong_account");
  });

  it("shows but does not block a warning-only mismatch", () => {
    const result = deriveGuardStatus({
      ...base,
      verification: {
        state: "signed_in",
        checkedAt: "2026-07-23T00:00:00Z",
        email: "someone.else@example.com"
      },
      lock: lock("warn"),
      requiredProfile: profile
    });
    expect(result.kind).toBe("wrong_account_warning");
    expect(result.severity).toBe("warning");
    expect(result.text).not.toContain("blocked");
  });

  it("treats an off binding as unlocked", () => {
    const result = deriveGuardStatus({
      ...base,
      lock: {
        workspaceUri: "file:///c:/repo",
        workspacePathNormalized: "c:\\repo",
        workspaceLabel: "repo",
        profileId: "work",
        mode: "off",
        createdAt: "",
        updatedAt: ""
      },
      requiredProfile: profile,
      snapshot: {
        schemaVersion: 1,
        capturedAt: "2026-07-23T00:00:00Z",
        profileId: "work",
        sessionId: "session"
      }
    });
    expect(result.kind).toBe("valid_unlocked");
    expect(result.text).toContain("$(account)");
  });

  it("keeps sign-in as the action when the required runtime is signed out", () => {
    const result = deriveGuardStatus({
      ...base,
      verification: {
        state: "signed_out",
        checkedAt: "2026-07-23T00:00:00Z"
      },
      lock: {
        workspaceUri: "file:///c:/repo",
        workspacePathNormalized: "c:\\repo",
        workspaceLabel: "repo",
        profileId: "work",
        mode: "enforce",
        createdAt: "",
        updatedAt: ""
      },
      requiredProfile: profile
    });
    expect(result.kind).toBe("signed_out");
    expect(result.text).toContain("Sign in");
  });

  it("does not fabricate unavailable usage as zero", () => {
    const result = deriveGuardStatus(base);
    expect(result.kind).toBe("usage_unavailable");
    expect(result.usagePercentage).toBeUndefined();
    expect(result.text).not.toContain("0%");
  });

  it("does not show stale quota in the status bar", () => {
    const result = deriveGuardStatus({
      ...base,
      snapshot: {
        schemaVersion: 1,
        capturedAt: "2020-01-01T00:00:00Z",
        profileId: "work",
        sessionId: "old",
        rateLimits: {
          fiveHour: { usedPercentage: 42 }
        }
      }
    });
    expect(result.text).not.toContain("42%");
    expect(result.detail).toMatch(/stale/i);
  });

  it("prefers a more severe seven-day window", () => {
    expect(selectUsage(
      { usedPercentage: 42 },
      { usedPercentage: 86 },
      70,
      90
    )).toMatchObject({ window: "seven_day", percentage: 86, severity: "warning" });
  });

  it("leads the status bar with quota, not with the account name", () => {
    // The owner's complaint: the surfaces led with locally accumulated numbers, which begin when
    // the extension is installed and say nothing about plan headroom.
    const result = deriveGuardStatus({
      ...base,
      snapshot: {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        profileId: "work",
        sessionId: "live",
        rateLimits: {
          fiveHour: { usedPercentage: 42, resetsAt: Math.floor(Date.now() / 1000) + 9_600 },
          sevenDay: { usedPercentage: 18 }
        }
      }
    });
    expect(result.text).toBe("$(account) 5h 42% · 7d 18% · Work");
    expect(result.text.indexOf("42%")).toBeLessThan(result.text.indexOf("Work"));
    expect(result.detail).toContain("58% left");
    expect(result.detail).toMatch(/resets in 2h 40m/);
    expect(result.detail).toMatch(/Reported by Claude/);
  });

  it("says a storage failure is happening instead of showing a healthy quota reading", () => {
    // Storage went bad after one successful write. Every surface used to keep reporting the last
    // figure as current, because the phase stayed "collecting" and the status bar ignored health.
    const result = deriveGuardStatus({
      ...base,
      collectionPhase: "storage_failed",
      collectionDetail: "disk_full",
      snapshot: {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        profileId: "work",
        sessionId: "live",
        rateLimits: { fiveHour: { usedPercentage: 42 } }
      }
    });
    expect(result.text).toContain("storage failing");
    expect(result.severity).toBe("warning");
    expect(result.collectionWarning).toContain("disk_full");
    expect(result.collectionWarning).toMatch(/frozen/);
  });

  it("keeps a real identity mismatch as the error even while storage is failing", () => {
    const result = deriveGuardStatus({
      ...base,
      verification: {
        state: "signed_in",
        checkedAt: "2026-07-23T00:00:00Z",
        email: "someone.else@example.com"
      },
      lock: lock("enforce"),
      requiredProfile: profile,
      collectionPhase: "storage_failed"
    });
    expect(result.kind).toBe("wrong_account");
    expect(result.severity).toBe("error");
    expect(result.collectionWarning).toBeDefined();
  });

  it("names an absent window rather than implying zero use", () => {
    const result = deriveGuardStatus({
      ...base,
      snapshot: {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        profileId: "work",
        sessionId: "live"
      }
    });
    expect(result.text).toContain("quota not reported for this account");
    expect(result.text).not.toContain("0%");
    expect(result.detail).toContain("a fact about the plan");
  });

  it("distinguishes never having run from a plan that reports nothing", () => {
    const result = deriveGuardStatus(base);
    expect(result.text).toContain("no quota reported yet");
    expect(result.detail).toContain("has not recorded a quota reading for this account yet");
  });

  it("respects the setting that turns the quota label off", () => {
    const result = deriveGuardStatus({
      ...base,
      showUsage: false,
      snapshot: {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        profileId: "work",
        sessionId: "live",
        rateLimits: { fiveHour: { usedPercentage: 42 } }
      }
    });
    expect(result.text).toBe("$(account) Claude · Work");
  });
});

describe("buildQuotaReport", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const report = (
    rateLimits: NonNullable<GuardStatusInput["snapshot"]>["rateLimits"],
    capturedAt = "2026-07-27T11:58:00Z"
  ) => buildQuotaReport({
    snapshot: { capturedAt, rateLimits },
    warningThreshold: 70,
    criticalThreshold: 90,
    now
  });

  it("treats resets_at as Unix epoch seconds, which is what Claude reports", () => {
    // Read as milliseconds, every reset landed in 1970 and every window looked expired.
    const result = report({
      fiveHour: { usedPercentage: 42, resetsAt: Math.floor(now / 1000) + 9_600 }
    });
    expect(result.windows[0]?.resetsAtIso).toBe("2026-07-27T14:40:00.000Z");
    expect(result.windows[0]?.resetsInLabel).toBe("in 2h 40m");
    expect(result.windows[0]?.expired).toBe(false);
  });

  it("reports headroom alongside the used percentage", () => {
    const result = report({ sevenDay: { usedPercentage: 86 } });
    expect(result.windows[0]).toMatchObject({
      window: "seven_day",
      usedPercentage: 86,
      remainingPercentage: 14,
      severity: "warning"
    });
  });

  it("marks a window whose reset time has already passed", () => {
    const result = report({
      fiveHour: { usedPercentage: 90, resetsAt: Math.floor(now / 1000) - 60 }
    });
    expect(result.windows[0]?.expired).toBe(true);
    expect(result.windows[0]?.resetsInLabel).toBe("due now");
  });

  it("carries the reading's age, because a percentage without one is not a measurement", () => {
    expect(report({ fiveHour: { usedPercentage: 10 } })).toMatchObject({
      freshness: "fresh",
      ageMs: 120_000,
      ageLabel: "2 minutes ago"
    });
    expect(report({ fiveHour: { usedPercentage: 10 } }, "2026-07-27T09:00:00Z")).toMatchObject({
      freshness: "stale",
      ageLabel: "3 hours ago"
    });
  });

  it("explains each absent window differently, and never as 0%", () => {
    const none = buildQuotaReport({ warningThreshold: 70, criticalThreshold: 90, now });
    expect(none.freshness).toBe("none");
    expect(none.windows).toHaveLength(0);
    expect(none.absent.map((entry) => entry.reason)).toEqual(["no_session", "no_session"]);
    expect(none.absent[0]?.detail).toContain("has not recorded a quota reading");

    // Not a claim about which plans report quota. Team accounts do report it — verified against a
    // live team account, which is why the copy no longer names subscription types at all.
    const plan = report({});
    expect(plan.absent.map((entry) => entry.reason))
      .toEqual(["not_reported_for_account", "not_reported_for_account"]);
    expect(plan.absent[0]?.detail).toContain("a fact about the plan");

    // The documentation says the two windows are independently optional.
    const one = report({ fiveHour: { usedPercentage: 42 } });
    expect(one.windows).toHaveLength(1);
    expect(one.absent).toEqual([expect.objectContaining({
      window: "seven_day",
      reason: "window_not_reported"
    })]);
    expect(one.absent[0]?.detail).toContain("independently optional");
    for (const entry of [...none.absent, ...plan.absent, ...one.absent]) {
      expect(entry.detail).not.toContain("0%");
    }
  });

  it("picks the more severe window for the status bar and labels both", () => {
    const result = report({
      fiveHour: { usedPercentage: 42 },
      sevenDay: { usedPercentage: 95 }
    });
    expect(result.worst?.window).toBe("seven_day");
    expect(result.worst?.severity).toBe("critical");
    expect(quotaStatusLabel(result)).toBe("5h 42% · 7d 95%");
  });
});

describe("quota time formatting", () => {
  it("is coarse and readable rather than a stopwatch", () => {
    expect(formatQuotaDuration(9_600_000)).toBe("2h 40m");
    expect(formatQuotaDuration(2_700_000)).toBe("45m");
    expect(formatQuotaDuration(273_600_000)).toBe("3d 4h");
    expect(formatQuotaDuration(7_200_000)).toBe("2h");
    expect(formatQuotaDuration(1_000)).toBe("under a minute");
  });

  it("reports an age in whole units", () => {
    expect(formatQuotaAge(30_000)).toBe("seconds ago");
    expect(formatQuotaAge(60_000)).toBe("1 minute ago");
    expect(formatQuotaAge(600_000)).toBe("10 minutes ago");
    expect(formatQuotaAge(3_600_000)).toBe("1 hour ago");
    expect(formatQuotaAge(172_800_000)).toBe("2 days ago");
  });
});

describe("bindingIdentityState", () => {
  const verification = {
    state: "signed_in" as const,
    email: "work@example.com"
  };

  it("is unbound without a binding, and when the binding is switched off", () => {
    expect(bindingIdentityState({ boundProfile: profile, verification })).toBe("unbound");
    expect(bindingIdentityState({
      lock: { mode: "off" },
      boundProfile: profile,
      verification
    })).toBe("unbound");
  });

  it("separates a never-verified binding from a broken check", () => {
    expect(bindingIdentityState({
      lock: { mode: "enforce" },
      boundProfile: { expectedIdentity: undefined },
      verification
    })).toBe("unconfirmed");
    expect(bindingIdentityState({
      lock: { mode: "enforce" },
      boundProfile: profile,
      verification: { state: "unavailable" }
    })).toBe("unverifiable");
    expect(bindingIdentityState({
      lock: { mode: "enforce" },
      boundProfile: profile,
      verification: { state: "signed_out" }
    })).toBe("unverifiable");
  });

  it("reports a match and a mismatch", () => {
    expect(bindingIdentityState({
      lock: { mode: "enforce" },
      boundProfile: profile,
      verification
    })).toBe("match");
    expect(bindingIdentityState({
      lock: { mode: "enforce" },
      boundProfile: profile,
      verification: { state: "signed_in", email: "other@example.com" }
    })).toBe("mismatch");
  });

  it("reports a signed-in account with no reported details as its own state", () => {
    // Current Claude Code versions null out email, orgId and orgName whenever
    // CLAUDE_CONFIG_DIR is set, so this is the normal case for a per-workspace account and
    // must never be conflated with a failed check or a mismatch.
    expect(bindingIdentityState({
      lock: { mode: "enforce" },
      boundProfile: profile,
      verification: { state: "signed_in" }
    })).toBe("unidentified");
  });
});

describe("the account a usage surface shows", () => {
  const personal = { id: "personal" };
  const work = { id: "work" };
  const profiles = [personal, work];

  it("shows the workspace's bound account rather than the first one registered", () => {
    // The reported defect, in the configuration that produced it: two accounts, the workspace
    // bound to the second, and no ambient CLAUDE_CONFIG_DIR in the extension host — so the
    // ambient directory matched no profile and the page opened on Personal while the status bar
    // named Work.
    expect(selectUsageAccount({ profiles, inPlay: work })).toBe(work);
  });

  it("prefers the account the user explicitly asked to view", () => {
    expect(selectUsageAccount({ profiles, requestedId: "personal", inPlay: work })).toBe(personal);
  });

  it("ignores a request naming an account that no longer exists", () => {
    // Deleting a profile must not strand the page on it; the account in play takes over.
    expect(selectUsageAccount({ profiles, requestedId: "deleted", inPlay: work })).toBe(work);
  });

  it("falls back to an arbitrary account only when none is in play", () => {
    expect(selectUsageAccount({ profiles })).toBe(personal);
    expect(selectUsageAccount({ profiles: [] })).toBeUndefined();
  });
});
