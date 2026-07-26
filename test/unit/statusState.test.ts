import { describe, expect, it } from "vitest";
import type { AccountProfile, GuardStatusInput } from "../../src/core/models.js";
import { deriveGuardStatus, selectUsage } from "../../src/core/statusState.js";

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
  it("blocks an enforced runtime mismatch", () => {
    const result = deriveGuardStatus({
      ...base,
      lock: {
        workspaceUri: "file:///c:/repo",
        workspacePathNormalized: "c:\\repo",
        workspaceLabel: "repo",
        profileId: "personal",
        mode: "enforce",
        createdAt: "",
        updatedAt: ""
      },
      requiredProfile: { ...profile, id: "personal", displayName: "Personal" }
    });
    expect(result.kind).toBe("wrong_account");
    expect(result.severity).toBe("error");
  });

  it("shows but does not block a warning-only mismatch", () => {
    const result = deriveGuardStatus({
      ...base,
      lock: {
        workspaceUri: "file:///c:/repo",
        workspacePathNormalized: "c:\\repo",
        workspaceLabel: "repo",
        profileId: "personal",
        mode: "warn",
        createdAt: "",
        updatedAt: ""
      },
      requiredProfile: { ...profile, id: "personal", displayName: "Personal" }
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
