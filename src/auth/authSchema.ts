import type { AuthVerification } from "../core/models.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringAt(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function booleanAt(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

export function parseAuthStatus(raw: string, checkedAt = new Date().toISOString()): AuthVerification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: "unavailable",
      checkedAt,
      errorCategory: "invalid_json"
    };
  }

  const root = record(parsed);
  if (!root) {
    return {
      state: "unavailable",
      checkedAt,
      errorCategory: "invalid_json"
    };
  }

  const account = record(root.account) ?? record(root.user) ?? {};
  const organization = record(root.organization) ?? record(root.org) ?? {};
  const loggedIn = booleanAt(root.loggedIn, root.authenticated, root.isAuthenticated);
  const email = stringAt(root.email, account.email);
  const accountId = stringAt(
    root.accountId,
    root.account_id,
    root.accountUuid,
    root.account_uuid,
    account.id,
    account.uuid
  );
  const organizationId = stringAt(
    root.organizationId,
    root.organization_id,
    root.orgId,
    organization.id,
    organization.uuid
  );

  if (loggedIn === false) {
    return {
      state: "signed_out",
      checkedAt,
      errorCategory: "signed_out"
    };
  }

  if (loggedIn !== true && !email && !accountId) {
    return {
      state: "unavailable",
      checkedAt,
      errorCategory: "invalid_json"
    };
  }

  return {
    state: "signed_in",
    checkedAt,
    email,
    accountId,
    organizationId,
    organizationName: stringAt(root.organizationName, root.organization_name, organization.name),
    authMethod: stringAt(root.authMethod, root.auth_method),
    provider: stringAt(root.apiProvider, root.provider)
  };
}
