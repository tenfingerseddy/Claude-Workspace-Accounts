import { describe, expect, it } from "vitest";
import { parseDashboardMessage } from "../../src/dashboard/dashboardMessages.js";

describe("dashboard message validation", () => {
  it("accepts only known bounded messages", () => {
    expect(parseDashboardMessage({ type: "setProfile", profileId: "work-2" }))
      .toEqual({ type: "setProfile", profileId: "work-2" });
    expect(parseDashboardMessage({ type: "setRange", range: "forever" })).toBeUndefined();
    expect(parseDashboardMessage({
      type: "setCustomRange",
      from: "2026-07-01",
      to: "2026-07-23"
    })).toEqual({
      type: "setCustomRange",
      from: "2026-07-01",
      to: "2026-07-23"
    });
    expect(parseDashboardMessage({
      type: "setCustomRange",
      from: "2026-02-30",
      to: "2026-07-23"
    })).toBeUndefined();
    expect(parseDashboardMessage({ type: "setThreadScope", threadScope: "main" }))
      .toEqual({ type: "setThreadScope", threadScope: "main" });
    expect(parseDashboardMessage({ type: "setThreadScope", threadScope: "prompts" }))
      .toBeUndefined();
    expect(parseDashboardMessage({ type: "changeLock" })).toEqual({ type: "changeLock" });
    expect(parseDashboardMessage({ type: "switchProfile", profileId: "../secret" })).toBeUndefined();
    expect(parseDashboardMessage({ type: "execute", command: "rm" })).toBeUndefined();
  });

  it("accepts the collection-fix action the empty state offers", () => {
    expect(parseDashboardMessage({ type: "collectionAction" }))
      .toEqual({ type: "collectionAction" });
    expect(parseDashboardMessage({ type: "collectionAction", command: "calc.exe" }))
      .toEqual({ type: "collectionAction" });
    expect(parseDashboardMessage({ type: "retry" })).toEqual({ type: "retry" });
  });
});
