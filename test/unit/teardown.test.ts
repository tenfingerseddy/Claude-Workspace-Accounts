import { describe, expect, it } from "vitest";
import type { TeardownStep } from "../../src/commands/uxModel.js";
import {
  planStatusLineTeardown,
  planSupportFileRemoval,
  requiresBindingCacheInvalidation,
  summarizeTeardown
} from "../../src/commands/uxModel.js";

const WRAPPER = "C:\\Users\\dev\\AppData\\Local\\ClaudeAccountGuard\\wrapper\\claude-account-guard-wrapper.exe";

/**
 * Every rule here encodes a way cleanup once left a user unable to start Claude Code. They are
 * regression tests in the strict sense: each assertion corresponds to a reported defect.
 */
describe("support file removal (finding 1)", () => {
  it("never deletes the wrapper while the setting still points at it", () => {
    const plan = planSupportFileRemoval({
      disableOutcome: "cleared",
      settingStillReferencesGuard: true,
      wrapperPath: WRAPPER
    });
    expect(plan.remove).toBe(false);
    expect(plan.state).toBe("kept");
    expect(plan.manual).toContain("claudeCode.claudeProcessWrapper");
    expect(plan.manual).toContain(WRAPPER);
  });

  it("never deletes the wrapper when detaching threw", () => {
    const plan = planSupportFileRemoval({
      disableError: "EPERM: settings.json is read-only",
      settingStillReferencesGuard: false,
      wrapperPath: WRAPPER
    });
    expect(plan.remove).toBe(false);
    expect(plan.detail).toContain("could not confirm");
    expect(plan.manual).toBeTruthy();
  });

  it("removes the wrapper only after a verified detach", () => {
    for (const outcome of ["cleared", "restored_upstream", "not_configured"] as const) {
      const plan = planSupportFileRemoval({
        disableOutcome: outcome,
        settingStillReferencesGuard: false,
        wrapperPath: WRAPPER
      });
      expect(plan.remove, outcome).toBe(true);
      expect(plan.manual, outcome).toBeUndefined();
    }
  });
});

describe("status line teardown (finding 2)", () => {
  const base = { profileName: "Work", configDir: "C:\\Users\\dev\\.claude-work" };

  it("treats a non-throwing 'unchanged' with a lost backup as work still to do", () => {
    const plan = planStatusLineTeardown({
      ...base,
      restored: "unchanged",
      backupState: "corrupt",
      guardCommandRemains: true
    });
    expect(plan.state).toBe("kept");
    expect(plan.safeToForgetProfile).toBe(false);
    expect(plan.detail).toContain("corrupt");
    expect(plan.manual).toContain("settings.json");
  });

  it("keeps the account when an Account Guard status line is still installed", () => {
    const plan = planStatusLineTeardown({
      ...base,
      restored: "unchanged",
      backupState: "missing",
      guardCommandRemains: true
    });
    // Forgetting the account would remove the only route back out of that status line.
    expect(plan.safeToForgetProfile).toBe(false);
  });

  it("reports a throw as failed, and still keeps the account", () => {
    const plan = planStatusLineTeardown({
      ...base,
      guardCommandRemains: false,
      error: "EBUSY"
    });
    expect(plan.state).toBe("failed");
    expect(plan.safeToForgetProfile).toBe(false);
    expect(plan.manual).toContain("settings.json");
  });

  it("is done when the command is gone, however it got there", () => {
    for (const restored of ["previous_status_line", "previous_command", "claude_default", "unchanged"] as const) {
      const plan = planStatusLineTeardown({
        ...base,
        restored,
        backupState: restored === "claude_default" ? "none_recorded" : "valid",
        guardCommandRemains: false
      });
      expect(plan.state, restored).toBe("removed");
      expect(plan.safeToForgetProfile, restored).toBe(true);
      expect(plan.manual, restored).toBeUndefined();
    }
  });
});

describe("binding cache invalidation (finding 4)", () => {
  it("invalidates on every change of which account a workspace uses", () => {
    // A surviving cache entry lets the wrapper fall back to the account the user just
    // stopped using, which is a silent violation of the one promise this extension makes.
    for (const change of [
      "bind",
      "rebind",
      "unbind",
      "mode_change",
      "profile_delete",
      "data_removal"
    ] as const) {
      expect(requiresBindingCacheInvalidation(change), change).toBe(true);
    }
  });
});

describe("teardown reporting (finding 5)", () => {
  it("never claims completeness when an artifact was kept or failed", () => {
    const steps: TeardownStep[] = [
      { artifact: "Collected usage", state: "removed" },
      {
        artifact: "Account Guard wrapper files",
        state: "kept",
        detail: "The setting still points at Account Guard.",
        manual: "Clear the setting, then delete the folder."
      }
    ];
    const summary = summarizeTeardown(steps);
    expect(summary.complete).toBe(false);
    expect(summary.headline).toContain("need");
    expect(summary.manual).toHaveLength(1);
    expect(summary.manual[0]).toContain("Account Guard wrapper files");
  });

  it("counts failures as well as retentions", () => {
    const summary = summarizeTeardown([
      { artifact: "Account registry", state: "failed", manual: "Delete registry.json." },
      { artifact: "Terminal variable (other workspaces)", state: "kept", manual: "Edit them." }
    ]);
    expect(summary.complete).toBe(false);
    expect(summary.manual).toHaveLength(2);
  });

  it("reports completeness only when everything is removed or absent", () => {
    const summary = summarizeTeardown([
      { artifact: "Collected usage", state: "removed" },
      { artifact: "Workspace binding cache", state: "not_present" }
    ]);
    expect(summary.complete).toBe(true);
    expect(summary.manual).toHaveLength(0);
    expect(summary.headline).toContain("removed everything");
  });
});
