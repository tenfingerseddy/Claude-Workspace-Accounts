import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAuthStatus } from "../../src/auth/authSchema.js";
import { shouldInheritAmbientConfig } from "../../src/auth/authEnvironment.js";
import { classifyVerification, compareIdentity } from "../../src/core/identity.js";

/**
 * Claude Code reports `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is
 * set — even when it is set to the directory that was already the default — while still
 * reporting `loggedIn: true` and exiting 0. Every assertion below pins behaviour that must
 * hold in that world, because gating on identity abandoned account registration entirely.
 */
const IDENTITY_FREE_RESPONSE = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: null,
  orgId: null,
  orgName: null,
  subscriptionType: "team"
});

describe("auth status parsing when the CLI reports no identity", () => {
  it("is a signed-in result, not a failure", () => {
    const verification = parseAuthStatus(IDENTITY_FREE_RESPONSE);
    expect(verification.state).toBe("signed_in");
    expect(verification.email).toBeUndefined();
    expect(verification.accountId).toBeUndefined();
    expect(verification.organizationId).toBeUndefined();
    expect(verification.authMethod).toBe("claude.ai");
  });

  it("still reads a full identity when the CLI supplies one", () => {
    const verification = parseAuthStatus(
      readFileSync("test/fixtures/auth-status-signed-in.json", "utf8")
    );
    expect(verification.state).toBe("signed_in");
    expect(verification.email).toBe("developer@example.com");
    expect(verification.accountId).toBe("acct_work_123");
    expect(verification.organizationId).toBe("org_456");
  });
});

describe("classifyVerification", () => {
  it("separates a usable identity-free sign-in from a real failure", () => {
    expect(classifyVerification(parseAuthStatus(IDENTITY_FREE_RESPONSE)))
      .toBe("signed_in_unidentified");
    expect(classifyVerification({ state: "signed_in", email: "dev@example.com" }))
      .toBe("signed_in_identified");
    expect(classifyVerification({ state: "signed_out" })).toBe("signed_out");
    expect(classifyVerification({ state: "unavailable" })).toBe("unavailable");
  });

  it("keeps the comparison machinery intact for when the fields return", () => {
    expect(compareIdentity({ email: "dev@example.com" }, {
      state: "signed_in",
      email: "dev@example.com"
    })).toBe("match");
    expect(compareIdentity({ email: "dev@example.com" }, {
      state: "signed_in",
      email: "other@example.com"
    })).toBe("mismatch");
    // Identity-free responses cannot be compared, and must not read as a mismatch.
    expect(compareIdentity({ email: "dev@example.com" }, parseAuthStatus(IDENTITY_FREE_RESPONSE)))
      .toBe("unverifiable");
  });
});

describe("shouldInheritAmbientConfig", () => {
  const DEFAULT = "c:\\users\\dev\\.claude";

  it("probes the default account without the variable, so identity survives", () => {
    expect(shouldInheritAmbientConfig({
      profileConfigDirNormalized: DEFAULT,
      defaultConfigDirNormalized: DEFAULT
    })).toBe(true);
  });

  it("sets the variable for any other account, accepting the identity loss", () => {
    expect(shouldInheritAmbientConfig({
      profileConfigDirNormalized: "c:\\users\\dev\\.claude-work",
      defaultConfigDirNormalized: DEFAULT
    })).toBe(false);
  });

  it("claims nothing about the ambient account when the host already has one set", () => {
    expect(shouldInheritAmbientConfig({
      profileConfigDirNormalized: DEFAULT,
      ambientConfigDir: "C:\\Users\\dev\\.claude-personal",
      defaultConfigDirNormalized: DEFAULT
    })).toBe(false);
    expect(shouldInheritAmbientConfig({
      profileConfigDirNormalized: DEFAULT,
      ambientConfigDir: "   ",
      defaultConfigDirNormalized: DEFAULT
    })).toBe(true);
  });
});
