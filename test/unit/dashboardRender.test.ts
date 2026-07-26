import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { QuotaReport, RateLimitWindow } from "../../src/core/models.js";
import { buildQuotaReport } from "../../src/core/statusState.js";

/**
 * The dashboard's renderer runs inside a webview, as a script embedded in a template literal, so
 * nothing else in this suite reaches it. That is exactly the presentation glue where an absent
 * figure quietly became `0%` and where the page's order — what the user reads first — lives.
 *
 * The script is extracted, parsed, and driven against a stub DOM. It also catches a template-literal
 * escaping slip, which would otherwise ship as a blank panel discoverable only by hand.
 */
const BACKSLASH = String.fromCharCode(92);

function webviewScript(): string {
  const source = readFileSync(
    new URL("../../src/dashboard/dashboardProvider.ts", import.meta.url),
    "utf8"
  );
  const match = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/);
  if (!match?.[1]) {
    throw new Error("The dashboard webview script could not be located.");
  }
  // Undo the escaping the TypeScript template literal required, yielding the script the webview
  // actually receives.
  return match[1]
    .split(`${BACKSLASH}\``).join("`")
    .split(`${BACKSLASH}\${`).join("${")
    .split("${nonce}").join("test-nonce");
}

interface StubElement {
  innerHTML: string;
  addEventListener: () => void;
  dataset: Record<string, string>;
  value: string;
  style: Record<string, string>;
}

function stubElement(): StubElement {
  return { innerHTML: "", addEventListener: () => undefined, dataset: {}, value: "", style: {} };
}

/** Load the renderer once and return a function that renders a payload to HTML. */
function loadRenderer(): (payload: unknown) => string {
  const app = stubElement();
  const handlers: Array<(event: { data: unknown }) => void> = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      getElementById: (id: string) => (id === "app" ? app : stubElement()),
      querySelectorAll: () => []
    },
    window: {
      addEventListener: (_type: string, handler: (event: { data: unknown }) => void) =>
        handlers.push(handler)
    },
    Intl,
    Date,
    Math,
    Number,
    Set,
    Map,
    JSON,
    String,
    console,
    HTMLElement: class {}
  };
  vm.createContext(sandbox);
  vm.runInContext(webviewScript(), sandbox);
  const receive = handlers[0];
  if (!receive) {
    throw new Error("The webview script registered no message handler.");
  }
  return (payload: unknown) => {
    app.innerHTML = "";
    receive({ data: { type: "dashboardData", payload } });
    return app.innerHTML;
  };
}

const render = loadRenderer();

function payload(options: {
  rateLimits?: { fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow };
  capturedAt?: string;
  storageFailing?: boolean;
} = {}): Record<string, unknown> {
  const snapshot = options.capturedAt
    ? {
        schemaVersion: 1 as const,
        capturedAt: options.capturedAt,
        profileId: "work",
        sessionId: "session",
        rateLimits: options.rateLimits
      }
    : undefined;
  const quota: QuotaReport = buildQuotaReport({
    snapshot,
    warningThreshold: 70,
    criticalThreshold: 90
  });
  return {
    generatedAt: new Date().toISOString(),
    timezone: "Australia/Sydney",
    selectedProfileId: "work",
    runtimeProfileId: "work",
    range: "7d",
    customRange: { from: "2026-07-21", to: "2026-07-27" },
    threadScope: "main",
    thresholds: { usageWarning: 70, usageCritical: 90, contextWarning: 80 },
    profiles: [{ id: "work", displayName: "Work", marker: "W" }],
    current: snapshot,
    daily: [],
    attribution: [],
    reliability: {
      requests: 0,
      errors: 0,
      tools: [],
      permissionDecisions: [],
      authFailures: 0,
      mcpFailures: 0
    },
    collection: { status: "active", source: "Local status snapshots" },
    quota,
    storage: options.storageFailing
      ? { failing: true, category: "disk_full", lastFailureAt: new Date().toISOString() }
      : { failing: false },
    setup: {
      identityState: "unidentified",
      boundProfileName: "Work",
      runtimeRegistered: true,
      runtimeConfigDir: "C:\\Users\\dev\\.claude-work",
      wrapperState: "guard",
      profileTelemetryEnabled: true,
      collection: {
        state: "active",
        headline: "Collecting locally",
        detail: "Status snapshots are arriving.",
        action: "none"
      }
    }
  };
}

/** Just the quota block, so an assertion cannot be satisfied by the local-detail section. */
function quotaSection(html: string): string {
  const start = html.indexOf("Plan quota, as reported by Claude");
  const end = html.indexOf("</section>", html.indexOf("Per-model quotas"));
  expect(start, "the quota section is missing").toBeGreaterThan(-1);
  return html.slice(start, end);
}

const fresh = () => new Date().toISOString();
const inTwoHoursForty = () => Math.floor(Date.now() / 1000) + 9_600;

describe("the dashboard's rendered output", () => {
  it("leads with quota and demotes locally accumulated numbers", () => {
    // The owner's verdict was that the page led with numbers that begin when the extension is
    // installed and say nothing about plan headroom.
    const html = render(payload({
      capturedAt: fresh(),
      rateLimits: {
        fiveHour: { usedPercentage: 42, resetsAt: inTwoHoursForty() },
        sevenDay: { usedPercentage: 86 }
      }
    }));
    expect(html).toContain("Plan quota, as reported by Claude");
    expect(html.indexOf("Plan quota, as reported by Claude"))
      .toBeLessThan(html.indexOf("Usage over time"));
    expect(html.indexOf("Plan quota, as reported by Claude"))
      .toBeLessThan(html.indexOf("Current session context"));
    // The local history is behind one collapsed disclosure that says what it is not.
    expect(html).toContain("Locally collected detail");
    expect(html).toContain("None of the numbers below measure plan headroom");
  });

  it("shows used, remaining, the reset, and the reading's age for each window", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: {
        fiveHour: { usedPercentage: 42, resetsAt: inTwoHoursForty() },
        sevenDay: { usedPercentage: 86 }
      }
    })));
    expect(section).toContain("5-hour window");
    expect(section).toContain("42% used");
    expect(section).toContain("58% left");
    expect(section).toContain("7-day window");
    expect(section).toContain("86% used");
    expect(section).toContain("14% left");
    expect(section).toContain("in 2h 40m");
    expect(section).toContain("Reading taken");
    expect(section).toContain("Reported by Claude");
  });

  it("says what is not exposed instead of leaving the user to wonder", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 10 } }
    })));
    expect(section).toContain("Per-model quotas");
    expect(section).toContain("credit pools");
    expect(section).toContain("will not guess");
  });

  it("never renders an absent window as zero", () => {
    // `0%` and `not reported` are opposite claims, and the first one is a lie about the account.
    for (const html of [
      render(payload()),
      render(payload({ capturedAt: fresh() })),
      render(payload({ capturedAt: fresh(), rateLimits: { sevenDay: { usedPercentage: 12 } } }))
    ]) {
      const section = quotaSection(html);
      expect(section).not.toMatch(/>\s*0% used\s*</);
      expect(section).not.toMatch(/>\s*0% left\s*</);
      expect(section).toContain("Not reported");
    }
  });

  it("distinguishes the three reasons a window can be missing", () => {
    expect(quotaSection(render(payload())))
      .toContain("No Claude Code session has run under this account yet");
    expect(quotaSection(render(payload({ capturedAt: fresh() }))))
      .toContain("Claude.ai subscription accounts");
    expect(quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 10 } }
    })))).toContain("independently optional");
  });

  it("labels a reading Claude has not refreshed as stale rather than as current headroom", () => {
    const section = quotaSection(render(payload({
      capturedAt: "2026-07-20T00:00:00Z",
      rateLimits: { fiveHour: { usedPercentage: 42 } }
    })));
    expect(section).toContain("Stale reading");
    expect(section).toContain("may not be current headroom");
  });

  it("marks a window whose reset time has passed instead of presenting an obsolete figure", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: {
        fiveHour: { usedPercentage: 95, resetsAt: Math.floor(Date.now() / 1000) - 120 }
      }
    })));
    expect(section).toContain("Window has reset");
    expect(section).toContain("due now");
  });

  it("says storage is failing above the figures it may have frozen", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 42 } },
      storageFailing: true
    })));
    expect(section).toContain("Local usage storage is failing");
    expect(section).toContain("disk_full");
    expect(section).toContain("may be frozen");
    expect(section.indexOf("Local usage storage is failing"))
      .toBeLessThan(section.indexOf("42% used"));
  });

  it("explains an empty panel as an empty history rather than as breakage", () => {
    const empty = { ...payload(), profiles: [], selectedProfileId: undefined };
    const html = render(empty);
    expect(html).toContain("Claude has not reported any quota yet");
    expect(html).not.toMatch(/0%/);
  });
});
