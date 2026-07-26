import { describe, expect, it } from "vitest";
import type { AccountProfile, WorkspaceLock } from "../../src/core/models.js";
import { resolveLockForPath } from "../../src/core/locks.js";

const profiles = [
  { id: "work", displayName: "Work" },
  { id: "personal", displayName: "Personal" }
] as AccountProfile[];

const lock = (
  profileId: string,
  workspacePathNormalized: string,
  mode: WorkspaceLock["mode"] = "enforce"
): WorkspaceLock => ({
  workspaceUri: `file:///${workspacePathNormalized}`,
  workspacePathNormalized,
  workspaceLabel: "workspace",
  profileId,
  mode,
  createdAt: "2026-07-23T00:00:00Z",
  updatedAt: "2026-07-23T00:00:00Z"
});

describe("workspace lock resolution", () => {
  it("uses the longest matching workspace root", () => {
    const result = resolveLockForPath("C:\\repos\\app\\packages\\api\\src", [
      lock("personal", "c:\\repos\\app"),
      lock("work", "c:\\repos\\app\\packages\\api")
    ], profiles);
    expect(result.profile?.id).toBe("work");
  });

  it("ignores disabled locks", () => {
    expect(resolveLockForPath("C:\\repos\\app", [
      lock("work", "c:\\repos\\app", "off")
    ], profiles).lock).toBeUndefined();
  });

  it("matches every root in a saved multi-root workspace", () => {
    const multiRoot = {
      ...lock("work", "c:\\workspace\\one"),
      workspaceRootPathsNormalized: [
        "c:\\workspace\\one",
        "d:\\workspace\\two"
      ]
    };
    expect(resolveLockForPath("D:\\workspace\\two\\src", [multiRoot], profiles).profile?.id)
      .toBe("work");
  });
});
