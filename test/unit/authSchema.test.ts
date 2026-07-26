import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAuthStatus } from "../../src/auth/authSchema.js";

describe("auth status parsing", () => {
  it("retains only comparison and display metadata while tolerating extra fields", () => {
    const raw = readFileSync("test/fixtures/auth-status-signed-in.json", "utf8");
    expect(parseAuthStatus(raw, "2026-07-23T00:00:00Z")).toEqual({
      state: "signed_in",
      checkedAt: "2026-07-23T00:00:00Z",
      email: "developer@example.com",
      accountId: "acct_work_123",
      organizationId: "org_456",
      organizationName: "Example Engineering",
      authMethod: "claude.ai",
      provider: "firstParty"
    });
  });

  it("fails safely on malformed JSON", () => {
    expect(parseAuthStatus("{secret")).toMatchObject({
      state: "unavailable",
      errorCategory: "invalid_json"
    });
  });
});
