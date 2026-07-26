import { describe, expect, it } from "vitest";
import type { CollectionInput, MenuState } from "../../src/commands/uxModel.js";
import {
  buildAccountMenu,
  describeBinding,
  describeWrapper,
  diagnoseCollection,
  planFirstRun,
  planWrapperConsent
} from "../../src/commands/uxModel.js";

const WRAPPER_PATH = "C:\\Users\\dev\\AppData\\Local\\ClaudeWorkspaceAccounts\\wrapper\\claude-workspace-accounts-wrapper.exe";
const DEFAULT_CONFIG_DIR = "C:\\Users\\dev\\.claude";

function collection(overrides: Partial<CollectionInput> = {}): CollectionInput {
  return {
    telemetryEnabledSetting: true,
    runtimeRegistered: true,
    runtimeConfigDir: DEFAULT_CONFIG_DIR,
    selectedIsRuntime: true,
    profileTelemetryEnabled: true,
    wrapperState: "guard",
    foreignOtelExporter: false,
    collectorRegistered: true,
    snapshotSeen: true,
    ...overrides
  };
}

/** A workspace bound to "Work", with the integration connected. */
function menuState(overrides: Partial<MenuState> = {}): MenuState {
  return {
    hasWorkspace: true,
    workspaceLabel: "api",
    boundProfileName: "Work",
    boundMode: "enforce",
    accountName: "Work",
    runtimeConfigDir: DEFAULT_CONFIG_DIR,
    runtimeRegistered: true,
    identityLabel: "dev@example.com",
    authState: "signed_in",
    profileCount: 2,
    wrapper: { state: "guard", configuredPath: WRAPPER_PATH, wrapperPath: WRAPPER_PATH },
    terminalBinding: "not_applied",
    collection: diagnoseCollection(collection()),
    ...overrides
  };
}

const unbound = (overrides: Partial<MenuState> = {}): MenuState => menuState({
  boundProfileName: undefined,
  boundMode: undefined,
  terminalBinding: "unsupported",
  ...overrides
});

const actions = (state: MenuState): (string | undefined)[] =>
  buildAccountMenu(state).filter((entry) => entry.kind === "item").map((entry) => entry.action);

describe("planWrapperConsent", () => {
  it("never re-asks when Workspace Accounts is already the configured wrapper", () => {
    expect(planWrapperConsent({
      autoConfigure: true,
      configuredWrapper: WRAPPER_PATH,
      configuredIsGuard: true,
      userInitiated: false
    })).toEqual({ kind: "already_configured" });
  });

  it("refuses to write the setting when auto-configure is turned off", () => {
    expect(planWrapperConsent({
      autoConfigure: false,
      configuredIsGuard: false,
      userInitiated: true
    })).toEqual({ kind: "blocked_by_setting" });
  });

  it("asks for consent on a first, unconfigured run", () => {
    expect(planWrapperConsent({
      autoConfigure: true,
      configuredIsGuard: false,
      userInitiated: false
    })).toEqual({ kind: "ask" });
  });

  it("stays silent in the background once the user declined", () => {
    expect(planWrapperConsent({
      autoConfigure: true,
      storedConsent: "declined",
      configuredIsGuard: false,
      userInitiated: false
    })).toEqual({ kind: "previously_declined" });
  });

  it("asks again when the user explicitly invokes the command after declining", () => {
    expect(planWrapperConsent({
      autoConfigure: true,
      storedConsent: "declined",
      configuredIsGuard: false,
      userInitiated: true
    })).toEqual({ kind: "ask" });
  });

  it("reconfigures without a prompt when consent was already granted", () => {
    expect(planWrapperConsent({
      autoConfigure: true,
      storedConsent: "granted",
      configuredIsGuard: false,
      userInitiated: false
    })).toEqual({ kind: "configure" });
  });

  it("asks before chaining somebody else's wrapper, even with prior consent", () => {
    expect(planWrapperConsent({
      autoConfigure: true,
      storedConsent: "granted",
      configuredWrapper: "C:\\tools\\other-wrapper.exe",
      configuredIsGuard: false,
      userInitiated: false
    })).toEqual({ kind: "ask_chain", foreignWrapper: "C:\\tools\\other-wrapper.exe" });
  });
});

describe("diagnoseCollection", () => {
  it("blames the setting when telemetry is turned off", () => {
    const diagnosis = diagnoseCollection(collection({ telemetryEnabledSetting: false }));
    expect(diagnosis.state).toBe("blocked");
    expect(diagnosis.action).toBe("open_settings");
  });

  it("names the untracked account directory before anything else", () => {
    const diagnosis = diagnoseCollection(collection({
      runtimeRegistered: false,
      profileTelemetryEnabled: false,
      collectorRegistered: false,
      snapshotSeen: false
    }));
    expect(diagnosis.state).toBe("blocked");
    expect(diagnosis.action).toBe("register_runtime");
    expect(diagnosis.detail).toContain(DEFAULT_CONFIG_DIR);
  });

  it("explains that a non-active account never collects", () => {
    expect(diagnoseCollection(collection({ selectedIsRuntime: false })).action)
      .toBe("select_runtime_profile");
  });

  it("offers to install the status-line bridge when the account opted out", () => {
    const diagnosis = diagnoseCollection(collection({
      profileTelemetryEnabled: false,
      snapshotSeen: false
    }));
    expect(diagnosis.action).toBe("enable_profile_usage");
    expect(diagnosis.detail).toContain("settings.json");
  });

  it("reports partial collection when the wrapper is not connected", () => {
    const diagnosis = diagnoseCollection(collection({ wrapperState: "none" }));
    expect(diagnosis.state).toBe("partial");
    expect(diagnosis.action).toBe("configure_wrapper");
  });

  it("says it deliberately will not override a user's own OTLP exporter", () => {
    const diagnosis = diagnoseCollection(collection({ foreignOtelExporter: true }));
    expect(diagnosis.state).toBe("partial");
    expect(diagnosis.action).toBe("none");
  });

  it("suggests a reload when the collector never registered", () => {
    expect(diagnoseCollection(collection({
      collectorRegistered: false,
      snapshotSeen: false
    })).action).toBe("reload_window");
  });

  it("defers to the telemetry layer's phase for collector-side failures", () => {
    const bind = diagnoseCollection(collection({
      phase: "port_bind_failed",
      phaseDetail: "EADDRINUSE",
      snapshotSeen: false
    }));
    expect(bind.state).toBe("blocked");
    expect(bind.detail).toContain("EADDRINUSE");
    expect(bind.action).toBe("reload_window");
    expect(diagnoseCollection(collection({ phase: "registration_stale" })).state).toBe("blocked");
    expect(diagnoseCollection(collection({
      phase: "rejecting",
      phaseDetail: "unauthorized (4)"
    })).detail).toContain("unauthorized (4)");
    expect(diagnoseCollection(collection({ phase: "accepted_empty" })).state).toBe("partial");
    expect(diagnoseCollection(collection({ phase: "collecting", snapshotSeen: false })).state)
      .toBe("active");
  });

  it("still reports setup blockers ahead of any reported phase", () => {
    expect(diagnoseCollection(collection({
      runtimeRegistered: false,
      phase: "port_bind_failed"
    })).action).toBe("register_runtime");
  });

  it("distinguishes awaiting data from blocked", () => {
    expect(diagnoseCollection(collection({ snapshotSeen: false })).state).toBe("awaiting_data");
    expect(diagnoseCollection(collection()).state).toBe("active");
  });
});

describe("describeBinding", () => {
  it("names the account this workspace uses", () => {
    expect(describeBinding(menuState())).toBe("Uses Work");
  });

  it("says plainly when a binding exists but cannot be applied", () => {
    const detached = menuState({ wrapper: { state: "none", wrapperPath: WRAPPER_PATH } });
    expect(describeBinding(detached)).toContain("not applied yet");
    expect(describeWrapper(detached)).toContain("per-workspace accounts are not applied");
  });

  it("treats an unbound workspace as normal, not broken", () => {
    expect(describeBinding(unbound())).toBe("Uses your default Claude account");
  });

  it("marks a warn-only binding as never blocking", () => {
    expect(describeBinding(menuState({ boundMode: "warn" }))).toContain("never blocked");
  });

  it("treats mode off as no binding at all", () => {
    expect(describeBinding(menuState({ boundMode: "off" })))
      .toBe("Uses your default Claude account");
  });
});

describe("buildAccountMenu", () => {
  it("leads with choosing this workspace's account", () => {
    const first = buildAccountMenu(unbound()).filter((entry) => entry.kind === "item")[1];
    expect(first?.action).toBe("bind");
    expect(first?.label).toContain("Use a specific Claude account in this workspace");
  });

  it("explains that the first account will be created when none exist", () => {
    const entries = buildAccountMenu(unbound({ profileCount: 0 }));
    const bind = entries.find((entry) => entry.action === "bind");
    expect(bind?.detail).toContain("add one first");
  });

  it("offers exactly one binding action per state", () => {
    expect(actions(unbound())).toContain("bind");
    expect(actions(unbound())).not.toContain("unbind");
    const bound = actions(menuState());
    expect(bound).toContain("bind");
    expect(bound).toContain("unbind");
  });

  it("offers the terminal opt-in only when it is available and unused", () => {
    expect(actions(menuState({ terminalBinding: "not_applied" }))).toContain("bindTerminal");
    expect(actions(menuState({ terminalBinding: "applied" }))).toContain("unbindTerminal");
    const unsupported = actions(menuState({ terminalBinding: "unsupported" }));
    expect(unsupported).not.toContain("bindTerminal");
    expect(unsupported).not.toContain("unbindTerminal");
  });

  it("always offers adding an account, and never asks for a directory", () => {
    const add = buildAccountMenu(menuState()).find((entry) => entry.action === "addProfile");
    expect(add?.detail).toContain("No new VS Code window");
  });

  it("shows the escape hatch when connected and the on-ramp when not", () => {
    expect(actions(menuState())).toContain("disableWrapper");
    expect(buildAccountMenu(menuState()).find((entry) => entry.action === "disableWrapper")?.detail)
      .toContain("claudeCode.claudeProcessWrapper");
    const detached = menuState({
      wrapper: { state: "none", wrapperPath: WRAPPER_PATH },
      collection: diagnoseCollection(collection({ wrapperState: "none" }))
    });
    expect(actions(detached)).toContain("configureWrapper");
    expect(actions(detached)).not.toContain("disableWrapper");
  });

  it("warns in the disconnect row that per-workspace accounts stop", () => {
    expect(buildAccountMenu(menuState()).find((entry) => entry.action === "disableWrapper")?.detail)
      .toContain("Per-workspace accounts stop being applied");
  });

  it("offers to track the default account only when it is untracked", () => {
    expect(actions(menuState({ runtimeRegistered: false }))).toContain("registerCurrent");
    expect(actions(menuState())).not.toContain("registerCurrent");
  });

  it("hides sign-in once the account is signed in", () => {
    expect(actions(menuState({ authState: "signed_out" }))).toContain("login");
    expect(actions(menuState())).not.toContain("login");
  });

  it("leads with the recovery when the bound identity mismatches", () => {
    const entries = buildAccountMenu(menuState({ identity: "mismatch" }));
    const items = entries.filter((entry) => entry.kind === "item");
    // Row 0 is the status header; the mismatch recovery must come before anything else.
    expect(items[1]?.action).toBe("bind");
    expect(items[2]?.action).toBe("updateIdentity");
    expect(items[2]?.detail).toContain("warn-only");
  });

  it("offers to re-check a binding whose last probe did not complete", () => {
    const entries = buildAccountMenu(menuState({ identity: "unverifiable" }));
    const row = entries.find((entry) => entry.action === "updateIdentity");
    expect(row?.label).toContain("Check the sign-in state");
    expect(row?.detail).toContain("launches are allowed");
  });

  it("presents a signed-in-but-unidentifiable account as working, not broken", () => {
    // The CLI reports no account details whenever a per-workspace account is in use, so this
    // must not offer a fix that cannot exist, and must not read as an error.
    const entries = buildAccountMenu(menuState({ identity: "unidentified" }));
    expect(actions(menuState({ identity: "unidentified" }))).not.toContain("updateIdentity");
    const row = entries.find((entry) => entry.label.includes("is signed in"));
    expect(row?.description).toContain("not reported by this Claude version");
    expect(row?.detail).toContain("cannot warn you");
  });

  it("treats a never-verified binding as optional, not broken", () => {
    const entries = buildAccountMenu(menuState({ identity: "unconfirmed" }));
    const row = entries.find((entry) => entry.action === "verify");
    expect(row?.description).toBe("Optional");
    expect(actions(menuState({ identity: "unconfirmed" }))).not.toContain("updateIdentity");
  });

  it("offers no identity row when the bound identity matches", () => {
    expect(actions(menuState({ identity: "match" }))).not.toContain("updateIdentity");
  });

  it("always offers a way to remove everything", () => {
    expect(actions(menuState())).toContain("removeAllData");
  });

  it("surfaces enabling usage only when that is the actual blocker", () => {
    expect(actions(menuState())).not.toContain("enableUsage");
    expect(actions(menuState({
      collection: diagnoseCollection(collection({
        profileTelemetryEnabled: false,
        snapshotSeen: false
      }))
    }))).toContain("enableUsage");
  });

  it("gives every selectable row an explanation", () => {
    for (const entry of buildAccountMenu(menuState())) {
      if (entry.kind === "item") {
        expect(entry.detail, entry.label).toBeTruthy();
      }
    }
  });

  it("does not offer workspace actions without a workspace", () => {
    const noFolder = actions(unbound({ hasWorkspace: false, workspaceLabel: undefined }));
    expect(noFolder).not.toContain("bind");
    expect(noFolder).not.toContain("unbind");
  });
});

describe("planFirstRun", () => {
  const base = {
    onboarded: true,
    hasWorkspace: true,
    boundToProfile: false,
    profileCount: 1,
    runtimeRegistered: false,
    noticeSeenForConfigDir: false
  };

  it("stays quiet without a workspace", () => {
    expect(planFirstRun({ ...base, onboarded: false, hasWorkspace: false })).toBe("none");
  });

  it("introduces itself once", () => {
    expect(planFirstRun({ ...base, onboarded: false })).toBe("onboarding");
  });

  it("mentions an untracked default account once per directory", () => {
    expect(planFirstRun(base)).toBe("register_runtime_notice");
    expect(planFirstRun({ ...base, noticeSeenForConfigDir: true })).toBe("none");
  });

  it("says nothing when this workspace already uses a known account", () => {
    expect(planFirstRun({ ...base, boundToProfile: true })).toBe("none");
    expect(planFirstRun({ ...base, runtimeRegistered: true })).toBe("none");
  });

  it("says nothing before any account exists — onboarding already covered it", () => {
    expect(planFirstRun({ ...base, profileCount: 0 })).toBe("none");
  });
});
