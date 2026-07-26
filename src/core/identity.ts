import type { AuthVerification, ExpectedIdentity } from "./models.js";

export function normalizeEmail(email: string | undefined): string | undefined {
  const value = email?.trim().toLocaleLowerCase();
  return value || undefined;
}

export type IdentityMatch = "match" | "mismatch" | "unverifiable";

/**
 * What a verification result actually tells us.
 *
 * `signed_in_unidentified` is the normal outcome, not an edge case: Claude Code stops
 * reporting `email`, `orgId` and `orgName` whenever `CLAUDE_CONFIG_DIR` is set — even when it
 * is set to the directory that was already the default — while still reporting `loggedIn:
 * true`. Treating that as a failure is what abandoned account registration, so it is a
 * first-class, usable outcome here and nothing may be gated on it.
 */
export type VerificationClass =
  | "signed_out"
  | "unavailable"
  | "signed_in_unidentified"
  | "signed_in_identified";

export function classifyVerification(
  verification: Pick<AuthVerification, "state" | "email" | "accountId">
): VerificationClass {
  if (verification.state === "signed_out") {
    return "signed_out";
  }
  if (verification.state !== "signed_in") {
    return "unavailable";
  }
  return verification.email || verification.accountId
    ? "signed_in_identified"
    : "signed_in_unidentified";
}

export function compareIdentity(
  expected: ExpectedIdentity | undefined,
  actual: Pick<AuthVerification, "state" | "email" | "accountId" | "organizationId">
): IdentityMatch {
  if (!expected || actual.state !== "signed_in") {
    return "unverifiable";
  }

  if (expected.accountId && actual.accountId) {
    if (expected.accountId !== actual.accountId) {
      return "mismatch";
    }
    if (expected.organizationId && actual.organizationId
      && expected.organizationId !== actual.organizationId) {
      return "mismatch";
    }
    return "match";
  }

  const expectedEmail = normalizeEmail(expected.email);
  const actualEmail = normalizeEmail(actual.email);
  if (!expectedEmail || !actualEmail) {
    return "unverifiable";
  }
  if (expectedEmail !== actualEmail) {
    return "mismatch";
  }
  if (expected.organizationId && actual.organizationId
    && expected.organizationId !== actual.organizationId) {
    return "mismatch";
  }
  return "match";
}
