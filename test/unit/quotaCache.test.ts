import { describe, expect, it } from "vitest";
import { parseQuotaCache } from "../../src/usage/quotaCache.js";
import { buildQuotaReport } from "../../src/core/statusState.js";

/**
 * The fixture is the real shape, copied from a live `.claude.json` on a team account with an
 * extra-usage pool and one per-model window. Every field name here is a wire contract with Claude
 * Code, so a hand-simplified stand-in would not have caught the two things this file exists to
 * pin: that the two headline windows come from `utilization`, and that `limits[]` is read for the
 * per-model window only — `session` and `weekly_all` name the same windows again and would
 * otherwise be counted twice.
 */
const LIVE = {
  cachedUsageUtilization: {
    fetchedAtMs: 1785118336468,
    accountUuid: "9ae27bb9-2ad4-4ddb-8c74-d76cbfaa68fe",
    utilization: {
      five_hour: {
        utilization: 5,
        resets_at: "2026-07-27T06:49:59.746345+00:00",
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null
      },
      seven_day: {
        utilization: 12,
        resets_at: "2026-08-02T09:59:59.746368+00:00",
        limit_dollars: null,
        used_dollars: null,
        remaining_dollars: null
      },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 5000,
        used_credits: 5813,
        utilization: 100,
        currency: "AUD",
        decimal_places: 2,
        disabled_reason: null,
        user_disabled: false,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        daily: null,
        weekly: null
      },
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 5,
          severity: "normal",
          resets_at: "2026-07-27T06:49:59.746345+00:00",
          scope: null,
          is_active: false
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 12,
          severity: "normal",
          resets_at: "2026-08-02T09:59:59.746368+00:00",
          scope: null,
          is_active: true
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 0,
          severity: "normal",
          resets_at: null,
          scope: { model: { id: null, display_name: "Fable" }, surface: null },
          is_active: false
        }
      ]
    }
  }
};

describe("the quota cache reader", () => {
  it("reads both headline windows and the per-model window, without double-counting", () => {
    const cache = parseQuotaCache(LIVE);
    expect(cache?.windows.map((entry) => entry.window)).toEqual([
      "five_hour",
      "seven_day",
      "weekly_scoped"
    ]);
    expect(cache?.windows[0]).toMatchObject({ usedPercentage: 5, active: false });
    expect(cache?.windows[1]).toMatchObject({ usedPercentage: 12, active: true });
  });

  it("names the model for a per-model window from display_name, which is where Claude puts it", () => {
    const scoped = parseQuotaCache(LIVE)?.windows.find((entry) => entry.window === "weekly_scoped");
    // `id` is null on a real payload, so reading it alone would leave the window unlabelled.
    expect(scoped?.scopeModel).toBe("Fable");
    expect(scoped?.usedPercentage).toBe(0);
  });

  it("reads the credit pool, including a reached spend limit", () => {
    expect(parseQuotaCache(LIVE)?.creditPool).toMatchObject({
      enabled: true,
      utilization: 100,
      limitMinorUnits: 5000,
      usedMinorUnits: 5813,
      currency: "AUD",
      spendLimitReached: false
    });
  });

  // The amounts are minor units. Read as major units they rendered as "A$5,813 of A$5,000" for a
  // A$50.00 cap with A$58.13 spent — the only figure on the dashboard denominated in the user's
  // own money, wrong by a factor of a hundred. The exponent is what makes them renderable.
  it("carries the currency exponent so the amounts can be scaled out of minor units", () => {
    const pool = parseQuotaCache(LIVE)?.creditPool;
    expect(pool?.currencyExponent).toBe(2);
    expect((pool?.usedMinorUnits ?? 0) / 10 ** (pool?.currencyExponent ?? 0)).toBeCloseTo(58.13, 2);
    expect((pool?.limitMinorUnits ?? 0) / 10 ** (pool?.currencyExponent ?? 0)).toBeCloseTo(50, 2);
  });

  /** The pool with `decimal_places` withheld, optionally beside a `spend` block that states it. */
  const poolWithoutDecimalPlaces = (spend?: unknown) => ({
    cachedUsageUtilization: {
      fetchedAtMs: 1785118336468,
      utilization: {
        five_hour: { utilization: 5, resets_at: "2026-07-27T06:49:59.746345+00:00" },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 5000,
          used_credits: 5813,
          utilization: 100,
          currency: "AUD",
          spend_limit_reached: false
        },
        ...(spend === undefined ? {} : { spend })
      }
    }
  });

  it("falls back to the spend block's exponent when decimal_places is absent", () => {
    const document = poolWithoutDecimalPlaces({
      used: { amount_minor: 5813, currency: "AUD", exponent: 2 },
      limit: { amount_minor: 5000, currency: "AUD", exponent: 2 }
    });
    expect(parseQuotaCache(document)?.creditPool?.currencyExponent).toBe(2);
  });

  // No exponent means no way to know where the decimal point goes, and the dashboard shows no
  // amount at all rather than a plausible wrong one.
  it("reports the exponent as absent when neither source states it", () => {
    const pool = parseQuotaCache(poolWithoutDecimalPlaces())?.creditPool;
    expect(pool?.currencyExponent).toBeUndefined();
    // The raw minor units are still carried; only the scaling is unknown.
    expect(pool?.usedMinorUnits).toBe(5813);
  });

  it("keeps Claude's own timestamp rather than the time it was read", () => {
    expect(parseQuotaCache(LIVE)?.fetchedAt).toBe(new Date(1785118336468).toISOString());
  });

  it("reports an account Claude has never written a reading for as absent", () => {
    // The normal state of a registered account no session has run under. Must not throw, and must
    // not present itself as a reading of zero.
    expect(parseQuotaCache({ oauthAccount: { emailAddress: "someone@example.com" } })).toBeUndefined();
    expect(parseQuotaCache({ cachedUsageUtilization: {} })).toBeUndefined();
    expect(parseQuotaCache(undefined)).toBeUndefined();
    expect(parseQuotaCache("not an object")).toBeUndefined();
  });

  it("survives a torn or partial document", () => {
    // Claude rewrites this file underneath us, so a half-written read is expected.
    expect(parseQuotaCache({ cachedUsageUtilization: { utilization: { five_hour: null } } }))
      .toBeUndefined();
    expect(parseQuotaCache({ cachedUsageUtilization: { utilization: { limits: "nonsense" } } }))
      .toBeUndefined();
  });

  it("discards a percentage that is not a number instead of rendering it as zero", () => {
    expect(parseQuotaCache({
      cachedUsageUtilization: { utilization: { five_hour: { utilization: null } } }
    })).toBeUndefined();
  });
});

describe("the quota report built from a cache", () => {
  const now = Date.parse("2026-07-27T02:20:00.000Z");

  it("leads with Claude's figures and carries the reading's age", () => {
    const report = buildQuotaReport({
      cache: parseQuotaCache(LIVE),
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.windows).toHaveLength(3);
    expect(report.freshness).toBe("fresh");
    expect(report.capturedAt).toBe(new Date(1785118336468).toISOString());
    expect(report.absent).toEqual([]);
    expect(report.creditPool?.utilization).toBe(100);
  });

  it("labels the per-model window with its model so two weekly cards are distinguishable", () => {
    const report = buildQuotaReport({
      cache: parseQuotaCache(LIVE),
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    const scoped = report.windows.find((entry) => entry.window === "weekly_scoped");
    expect(scoped?.label).toBe("Fable weekly window");
    expect(scoped?.shortLabel).toBe("7d Fable");
  });

  it("converts the cache's ISO reset times into the epoch seconds the reading is documented in", () => {
    const report = buildQuotaReport({
      cache: parseQuotaCache(LIVE),
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    const fiveHour = report.windows[0];
    expect(fiveHour?.resetsAtIso).toBe("2026-07-27T06:49:59.746Z");
    expect(fiveHour?.resetsAt).toBe(Math.floor(Date.parse("2026-07-27T06:49:59.746345+00:00") / 1000));
    expect(fiveHour?.expired).toBe(false);
  });

  it("does not report a per-model window as missing, since most accounts have none", () => {
    const report = buildQuotaReport({
      cache: {
        fetchedAt: new Date(now).toISOString(),
        windows: [{ window: "five_hour", usedPercentage: 5 }]
      },
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.absent.map((entry) => entry.window)).toEqual(["seven_day"]);
    expect(report.absent[0]?.reason).toBe("window_not_reported");
  });

  it("keeps reporting Claude's severity separately from this extension's thresholds", () => {
    // The UI states that the thresholds are its own preference and not Anthropic policy, so a
    // local threshold firing must never be presented as Claude's own verdict.
    const report = buildQuotaReport({
      cache: {
        fetchedAt: new Date(now).toISOString(),
        windows: [{ window: "five_hour", usedPercentage: 95, reportedSeverity: "normal" }]
      },
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.windows[0]?.severity).toBe("critical");
    expect(report.windows[0]?.reportedSeverity).toBe("normal");
  });

  it("prefers the cache over a status-line snapshot when both exist", () => {
    const report = buildQuotaReport({
      cache: {
        fetchedAt: new Date(now).toISOString(),
        windows: [{ window: "five_hour", usedPercentage: 5 }]
      },
      snapshot: {
        capturedAt: new Date(now - 3_600_000).toISOString(),
        rateLimits: { fiveHour: { usedPercentage: 88 } }
      },
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.windows[0]?.usedPercentage).toBe(5);
  });

  it("still reads a status-line snapshot when there is no cache, for terminal sessions", () => {
    const report = buildQuotaReport({
      snapshot: {
        capturedAt: new Date(now).toISOString(),
        rateLimits: { fiveHour: { usedPercentage: 42, resetsAt: 1784080800 } }
      },
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.windows[0]?.usedPercentage).toBe(42);
    expect(report.windows[0]?.resetsAt).toBe(1784080800);
  });
});

describe("how old a cached reading may be before it is distrusted", () => {
  const now = Date.parse("2026-07-27T03:00:00.000Z");
  const at = (minutesAgo: number) => buildQuotaReport({
    cache: {
      fetchedAt: new Date(now - minutesAgo * 60_000).toISOString(),
      windows: [{ window: "five_hour", usedPercentage: 5 }]
    },
    warningThreshold: 70,
    criticalThreshold: 90,
    now
  });

  it("treats a reading Claude simply has not refreshed yet as current", () => {
    // Measured against a live account: 35 minutes old with two sessions launched in between, so
    // the status line's 15-minute rule would have called a perfectly good reading stale.
    expect(at(35).freshness).toBe("fresh");
    expect(at(35).ageLabel).toBe("35 minutes ago");
  });

  it("still distrusts a reading old enough to describe a window that has moved", () => {
    expect(at(120).freshness).toBe("stale");
  });

  it("keeps the tighter rule for a status-line snapshot, which refreshes every few seconds", () => {
    const report = buildQuotaReport({
      snapshot: {
        capturedAt: new Date(now - 35 * 60_000).toISOString(),
        rateLimits: { fiveHour: { usedPercentage: 5 } }
      },
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.freshness).toBe("stale");
  });

  it("never treats an undated reading as fresh", () => {
    // `fetchedAtMs` absent yields the epoch, which must read as ancient rather than as now.
    const report = buildQuotaReport({
      cache: { fetchedAt: new Date(0).toISOString(), windows: [{ window: "five_hour", usedPercentage: 5 }] },
      warningThreshold: 70,
      criticalThreshold: 90,
      now
    });
    expect(report.freshness).toBe("stale");
  });
});
