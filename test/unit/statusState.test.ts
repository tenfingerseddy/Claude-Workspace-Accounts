import { describe, expect, it } from "vitest";
import type { AccountProfile, GuardStatusInput } from "../../src/core/models.js";
import {
  bindingIdentityState,
  deriveGuardStatus,
  selectUsage
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
