import { describe, expect, it } from "vitest";
import {
  normalizeWindowsPath,
  pathContains,
  profileMarker,
  safeProfileId
} from "../../src/core/paths.js";

describe("Windows path policy", () => {
  it("normalizes case, separators, and trailing separators", () => {
    expect(normalizeWindowsPath("C:/Users/Kane/.claude-work/"))
      .toBe("c:\\users\\kane\\.claude-work");
  });

  it("matches only path-segment descendants", () => {
    expect(pathContains("C:\\repos\\app", "C:\\repos\\app\\src")).toBe(true);
    expect(pathContains("C:\\repos\\app", "C:\\repos\\application")).toBe(false);
  });
});

describe("profile identifiers", () => {
  it("creates stable non-color markers and unique slugs", () => {
    expect(profileMarker(" Work")).toBe("W");
    expect(safeProfileId("Work Account", new Set())).toBe("work-account");
    expect(safeProfileId("Work Account", new Set(["work-account"]))).toBe("work-account-2");
  });
});
