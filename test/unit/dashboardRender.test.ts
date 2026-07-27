import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import type { QuotaCreditPool, QuotaReport, RateLimitWindow } from "../../src/core/models.js";
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
  const script = match[1]
    .split(`${BACKSLASH}\``).join("`")
    .split(`${BACKSLASH}\${`).join("${")
    .split("${nonce}").join("test-nonce");
  // Only those two escapes are undone, so any other backslash reaches these tests as a literal one
  // even though TypeScript would have collapsed it before the browser parsed it. That divergence
  // is silent and misleading — a `\\u2019` written for a typographic apostrophe renders correctly
  // in the webview and shows up here as the six characters `’`. Rather than partially undo
  // the rest and get a different kind of wrong, the script is kept free of them.
  expect(
    script.split(`${BACKSLASH}\``).join("").includes(BACKSLASH + BACKSLASH),
    "the webview script must avoid escaped backslashes; this harness cannot reproduce them faithfully"
  ).toBe(false);
  return script;
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
  creditPool?: QuotaCreditPool;
  daily?: ReadonlyArray<Record<string, unknown>>;
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
  const quota: QuotaReport = {
    ...buildQuotaReport({ snapshot, warningThreshold: 70, criticalThreshold: 90 }),
    ...(options.creditPool ? { creditPool: options.creditPool } : {})
  };
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
    daily: options.daily ?? [],
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
  const start = html.indexOf('aria-label="Plan quota, as reported by Claude"');
  const anchor = html.indexOf('class="provenance-line"', start);
  // The section is named rather than headed — the cards title themselves — so both anchors are
  // structural. A missing anchor used to slice the section down to the first `</section>` in the
  // document, which passed `toBeGreaterThan(-1)` and then quietly made four `toContain`
  // assertions unsatisfiable for a reason none of them named.
  expect(start, "the quota section is missing").toBeGreaterThan(-1);
  expect(anchor, "the quota provenance line is missing").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", anchor));
}

const fresh = () => new Date().toISOString();
const inTwoHoursForty = () => Math.floor(Date.now() / 1000) + 9_600;

/**
 * One day of locally collected tokens. The default proportions are the real ones measured on this
 * project — cache reads at 97% of all tokens and roughly 4,000x input — because that ratio is the
 * whole reason the chart cannot put these four series on one axis.
 */
function usageDay(
  day: string,
  tokens: { input: number; output: number; read: number; create: number }
): Record<string, unknown> {
  return {
    day,
    profileId: "work",
    workspaceHash: "hash",
    workspaceLabel: "Account Switch Extension",
    model: "claude-opus-5",
    querySource: "main",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.read,
    cacheCreationTokens: tokens.create,
    estimatedCostUsd: 9.86,
    activeSeconds: 1_410,
    sessions: 13,
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    pullRequests: 0,
    requests: 111,
    errors: 0
  };
}

/** The one small-multiple row for a series: its stated peak, and each day's bar height in px. */
function sparkRow(html: string, label: string): {
  peak: string;
  heights: number[];
  maxWidth: string | undefined;
} {
  const marker = `<span class="spark-name">${label}</span>`;
  const start = html.indexOf(marker);
  expect(start, `the ${label} row is missing`).toBeGreaterThan(-1);
  // Bounded by whichever comes first: the next series' row, or the shared axis under the last one.
  const nextRow = html.indexOf('<span class="spark-name">', start + marker.length);
  const axis = html.indexOf('class="spark-axis"', start);
  const ends = [nextRow, axis].filter((index) => index > -1);
  const section = html.slice(start, ends.length ? Math.min(...ends) : html.length);
  return {
    peak: /<span class="spark-peak">([^<]*)<\/span>/.exec(section)?.[1] ?? "",
    heights: [...section.matchAll(/data-height="([\d.]+)"/g)].map((match) => Number(match[1])),
    maxWidth: /data-maxwidth="(\d+)"/.exec(section)?.[1]
  };
}

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
    expect(html).toContain('aria-label="Plan quota, as reported by Claude"');
    expect(html.indexOf('aria-label="Plan quota, as reported by Claude"'))
      .toBeLessThan(html.indexOf("Usage over time"));
    expect(html.indexOf('aria-label="Plan quota, as reported by Claude"'))
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
    expect(section).toContain("2h 40m");
    expect(section).toContain("Claude's own reading, taken");
  });

  // Every card came from one reading, so the age, the provenance and the threshold note were
  // identical on all of them. Stated four times they were the bulk of the section's text.
  it("states the reading's provenance and age once for the section, not once per card", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: {
        fiveHour: { usedPercentage: 42, resetsAt: inTwoHoursForty() },
        sevenDay: { usedPercentage: 86 }
      }
    })));
    expect(section.match(/Claude's own reading, taken/g)).toHaveLength(1);
    expect(section).not.toContain("Reading taken");
    expect(section).not.toContain("Reported by Claude");
  });

  /*
   * The credit pool is the one figure on this page denominated in the user's own money, and it was
   * off by a factor of a hundred: Claude reports minor units, so a A$50.00 cap with A$58.13 spent
   * rendered as "A$5,813 of A$5,000". The owner spotted it on sight, which is the point — a wrong
   * amount of money is the one error a glance at this page will catch, and the one it must not
   * have to.
   */
  it("scales credit amounts out of minor units before showing them", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 10 } },
      creditPool: {
        enabled: true,
        utilization: 100,
        limitMinorUnits: 5000,
        usedMinorUnits: 5813,
        currencyExponent: 2,
        currency: "AUD",
        spendLimitReached: false
      }
    })));
    expect(section).toContain("58.13");
    expect(section).toContain("50.00");
    expect(section).not.toContain("5,813");
    expect(section).not.toContain("5,000");
  });

  it("shows no credit amount at all when Claude did not say where the decimal point goes", () => {
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 10 } },
      creditPool: {
        enabled: true,
        utilization: 42,
        limitMinorUnits: 5000,
        usedMinorUnits: 2100,
        currency: "AUD",
        spendLimitReached: false
      }
    })));
    expect(section).toContain("Extra usage credits");
    expect(section).toContain("42% used");
    // Neither the minor-unit figure nor a guessed major-unit one.
    expect(section).not.toContain("5000");
    expect(section).not.toContain("5,000");
    expect(section).not.toContain("2100");
  });

  it("says where every figure came from, and that none of it is inferred", () => {
    // This replaced an assertion that the page disclaims per-model quotas and credit pools as
    // unreachable by a third party. They are both in the reading Claude writes to the account's
    // configuration directory, so the page said it could not know something it can read.
    const section = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 10 } }
    })));
    expect(section).toContain("Claude's own reading");
    expect(section).toContain("Never calculated or inferred here");
  });

  // The thresholds are this extension's preference, and saying so matters only when one of them
  // has actually coloured something. On an unflagged page it was a disclaimer about nothing.
  it("names the local thresholds only when one of them has fired", () => {
    const quiet = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 10 } }
    })));
    expect(quiet).not.toContain("not Anthropic policy");
    const loud = quotaSection(render(payload({
      capturedAt: fresh(),
      rateLimits: { fiveHour: { usedPercentage: 95 } }
    })));
    expect(loud).toContain("not Anthropic policy");
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
      .toContain("has not recorded a quota reading for this account yet");
    expect(quotaSection(render(payload({ capturedAt: fresh() }))))
      .toContain("a fact about the plan");
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
    expect(section).toContain("Reset due now");
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

/**
 * These four series differ by three to four orders of magnitude, so a shared linear axis drew one
 * solid block of the cache-read colour with the other three at the minimum-height floor — the same
 * picture whatever the days contained. Each series now has its own scale.
 */
describe("the usage-over-time small multiples", () => {
  const render = loadRenderer();
  const busyDay = usageDay("2026-07-26", {
    input: 5_309, output: 171_104, read: 21_248_917, create: 481_214
  });
  // Exactly half of it, so a row's second bar should be half the height of its first.
  const halfDay = usageDay("2026-07-27", {
    input: 2_654, output: 85_552, read: 10_624_458, create: 240_607
  });
  const twoDays = [busyDay, halfDay];

  it("scales each series to its own peak, so cache reads cannot crush input", () => {
    const html = render(payload({ daily: twoDays }));
    const input = sparkRow(html, "Input");
    const read = sparkRow(html, "Cache read");

    // Input is 0.02% of all tokens. On one shared axis its bar was 1px — the floor — no matter how
    // much of it there was. On its own scale, its biggest day is a full-height bar like any other.
    expect(input.heights[0]).toBe(42);
    expect(read.heights[0]).toBe(42);
    // And within a row, half the tokens is still half the bar.
    expect(input.heights[1]).toBeCloseTo(21, 1);
    expect(read.heights[1]).toBeCloseTo(21, 1);
  });

  it("states each row's own peak, and that rows are not comparable with each other", () => {
    const html = render(payload({ daily: twoDays }));
    expect(sparkRow(html, "Input").peak).toBe("peak 5,309/day");
    // Abbreviated at this magnitude; the exact figure stays in the accessible table below.
    expect(sparkRow(html, "Cache read").peak).toBe("peak 21.2M/day");
    // Independent scales are only honest if the reader is told they are independent.
    expect(html).toContain("Heights compare within a row, never between rows");
  });

  it("keeps a single day a bar rather than stretching it across the panel", () => {
    const one = render(payload({ daily: [busyDay] }));
    expect(sparkRow(one, "Input").maxWidth).toBe("26");
    // Thirty days may fill the card; one day may not.
    const many = render(payload({
      daily: Array.from({ length: 30 }, (_, index) =>
        usageDay(`2026-07-${String(index + 1).padStart(2, "0")}`, {
          input: 1_000, output: 2_000, read: 3_000, create: 4_000
        }))
    }));
    expect(sparkRow(many, "Input").maxWidth).toBe("780");
  });

  it("distinguishes a series with nothing in it from one with very little", () => {
    const html = render(payload({
      daily: [
        usageDay("2026-07-26", { input: 0, output: 10, read: 1_000_000, create: 0 }),
        usageDay("2026-07-27", { input: 1, output: 10, read: 1_000_000, create: 0 })
      ]
    }));
    // A series that never fired says so, instead of drawing a flat row of nothing.
    expect(sparkRow(html, "Cache creation").peak).toBe("none in this range");
    // Within a series that did fire, a zero day draws nothing while a tiny day keeps a 2px floor.
    const input = sparkRow(html, "Input");
    expect(input.heights[0]).toBe(0);
    expect(input.heights[1]).toBe(42);
  });

  it("still reports an entirely empty range as empty", () => {
    expect(render(payload({ daily: [] }))).toContain("No local token activity in this range.");
  });
});
