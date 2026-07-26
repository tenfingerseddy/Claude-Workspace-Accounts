import type { AuthVerification, ExpectedIdentity } from "./models.js";

export function normalizeEmail(email: string | undefined): string | undefined {
  const value = email?.trim().toLocaleLowerCase();
  return value || undefined;
}

export type IdentityMatch = "match" | "mismatch" | "unverifiable";

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
