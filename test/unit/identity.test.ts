import { describe, expect, it } from "vitest";
import { compareIdentity } from "../../src/core/identity.js";

describe("identity comparison", () => {
  it("prefers stable account IDs", () => {
    expect(compareIdentity(
      { email: "old@example.com", accountId: "acct-1", organizationId: "org-1" },
      { state: "signed_in", email: "new@example.com", accountId: "acct-1", organizationId: "org-1" }
    )).toBe("match");
  });

  it("falls back to normalized email", () => {
    expect(compareIdentity(
      { email: "Work@Example.com" },
      { state: "signed_in", email: "work@example.com" }
    )).toBe("match");
  });

  it("fails on organization drift and never treats missing data as a match", () => {
    expect(compareIdentity(
      { email: "work@example.com", organizationId: "org-1" },
      { state: "signed_in", email: "work@example.com", organizationId: "org-2" }
    )).toBe("mismatch");
    expect(compareIdentity(undefined, { state: "signed_in", email: "work@example.com" }))
      .toBe("unverifiable");
  });
});
