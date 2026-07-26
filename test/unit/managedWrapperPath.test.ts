import { describe, expect, it } from "vitest";
import { isManagedWrapperPath } from "../../src/wrapper/wrapperPaths.js";

/**
 * `claudeCode.claudeProcessWrapper` is global, machine-scoped, and deliberately outlives the
 * extension directory. Misjudging whether a value in it belongs to us is the defect that made
 * v0.1.0 unrecoverable without hand-editing settings.json: nothing in the UI would detach a
 * wrapper it did not recognise. These cases pin both directions of that judgement.
 */
describe("isManagedWrapperPath", () => {
  const current = "C:\\Users\\dev\\AppData\\Local\\ClaudeWorkspaceAccounts\\wrapper\\claude-workspace-accounts-wrapper.exe";

  it("recognises the wrapper it currently installs", () => {
    expect(isManagedWrapperPath(current, current)).toBe(true);
  });

  it("recognises our wrapper by filename from any directory", () => {
    expect(
      isManagedWrapperPath("D:\\elsewhere\\claude-workspace-accounts-wrapper.exe", current)
    ).toBe(true);
  });

  it("recognises the pre-rename wrapper, so an upgrade can still be detached", () => {
    // A user upgrading from Claude Account Guard has this in the setting until migration
    // repoints it. If migration has not run, or failed, this must still be removable from
    // the UI rather than being mistaken for a third-party wrapper.
    expect(
      isManagedWrapperPath(
        "C:\\Users\\dev\\AppData\\Local\\ClaudeAccountGuard\\wrapper\\claude-account-guard-wrapper.exe",
        current
      )
    ).toBe(true);
  });

  it("is case- and separator-insensitive, as Windows paths are", () => {
    expect(
      isManagedWrapperPath("c:/USERS/dev/AppData/Local/ClaudeAccountGuard/wrapper/CLAUDE-ACCOUNT-GUARD-WRAPPER.EXE", current)
    ).toBe(true);
  });

  it("does not claim a third-party wrapper", () => {
    // Overwriting or deleting someone else's wrapper would break their tooling, so the
    // false-positive direction matters more than the false-negative one.
    expect(isManagedWrapperPath("C:\\Tools\\other-vendor-wrapper.exe", current)).toBe(false);
    expect(isManagedWrapperPath("C:\\Tools\\claude-wrapper.exe", current)).toBe(false);
    expect(
      isManagedWrapperPath("C:\\Tools\\claude-workspace-accounts-wrapper.cmd", current)
    ).toBe(false);
  });

  it("treats absent, empty, and whitespace values as not configured", () => {
    expect(isManagedWrapperPath(undefined, current)).toBe(false);
    expect(isManagedWrapperPath("", current)).toBe(false);
    expect(isManagedWrapperPath("   ", current)).toBe(false);
  });

  it("still identifies our wrapper when no current path is known", () => {
    // repairIfStale runs before support files are necessarily resolvable.
    expect(isManagedWrapperPath("X:\\claude-workspace-accounts-wrapper.exe")).toBe(true);
    expect(isManagedWrapperPath("X:\\someone-elses.exe")).toBe(false);
  });
});
