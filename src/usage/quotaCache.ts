import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AccountQuotaCache,
  QuotaCacheWindow,
  QuotaCreditPool,
  QuotaWindowKey
} from "../core/models.js";

/**
 * Reads one account's quota from `<configDir>\.claude.json`.
 *
 * This is the whole quota source. Claude Code refreshes `cachedUsageUtilization` in the
 * configuration directory it is running under, so binding a workspace to an account also decides
 * whose quota this reads — no session has to be running, nothing has to be installed into the
 * account, and no consent is required, because this only ever reads.
 *
 * Why not the status line, which this replaces: `statusLine` is a terminal-UI hook, and the official
 * extension launches the CLI with `--output-format stream-json`, which renders no status line. On
 * the launch path this product manages, it was never invoked, so quota never arrived.
 *
 * `.claude.json` is not a credential file — credentials live beside it in `.credentials.json`,
 * which this codebase still never opens. Only the fields below are read, and only quota fields are
 * ever stored or displayed; the rest of that file (including the account block Claude keeps there)
 * is left alone. `docs/privacy.md` states this.
 */
export const QUOTA_CACHE_FILE = ".claude.json";

/** Only the shapes this reader consumes; everything else in that file is ignored. */
interface RawUtilizationWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface RawLimit {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  severity?: unknown;
  resets_at?: unknown;
  is_active?: unknown;
  scope?: { model?: { display_name?: unknown; id?: unknown } | null } | null;
}

function percentage(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  // Clamped rather than rejected: a pool that has overspent reports above 100 and is still a
  // true reading, but a bar cannot be more than full.
  return Math.max(0, Math.min(100, value));
}

/** An ISO timestamp, or nothing. A reset time this code cannot parse is worse than none. */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Drop a leading byte-order mark, which `JSON.parse` rejects.
 *
 * Written as a code-point comparison rather than a literal, because a literal BOM in source is an
 * invisible character that the lint rule for irregular whitespace correctly refuses.
 */
function stripByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * How many decimal places `extra_usage`'s amounts carry.
 *
 * `decimal_places` is the field for it, but the same numbers appear again under `spend` as an
 * explicit `{amount_minor, exponent}` money object, so that is the fallback. When neither says,
 * the exponent is unknown and the caller renders no amount — a cap displayed 100× too large is
 * worse than a cap not displayed at all.
 */
function currencyExponent(pool: Record<string, unknown>, spend: unknown): number | undefined {
  const declared = count(pool.decimal_places);
  if (declared !== undefined && Number.isInteger(declared) && declared >= 0 && declared <= 4) {
    return declared;
  }
  const money = typeof spend === "object" && spend !== null
    ? (spend as Record<string, unknown>).used
    : undefined;
  const exponent = typeof money === "object" && money !== null
    ? count((money as Record<string, unknown>).exponent)
    : undefined;
  return exponent !== undefined && Number.isInteger(exponent) && exponent >= 0 && exponent <= 4
    ? exponent
    : undefined;
}

function creditPool(raw: unknown, spend: unknown): QuotaCreditPool | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const pool = raw as Record<string, unknown>;
  const utilization = percentage(pool.utilization);
  const enabled = pool.is_enabled === true;
  // A pool that was never enabled and reports nothing is absent, not zero.
  if (!enabled && utilization === undefined) {
    return undefined;
  }
  return {
    enabled,
    utilization: utilization ?? 0,
    // Minor units, verbatim. The conversion to a displayable amount happens once, at the surface
    // that formats it, using the exponent below.
    limitMinorUnits: count(pool.monthly_limit),
    usedMinorUnits: count(pool.used_credits),
    currencyExponent: currencyExponent(pool, spend),
    currency: text(pool.currency),
    spendLimitReached: pool.spend_limit_reached === true,
    disabledReason: text(pool.disabled_reason)
  };
}

/**
 * The per-model weekly windows, from `limits[]`.
 *
 * `five_hour` and `seven_day` are taken from the dedicated `utilization` members instead, because
 * `limits[]` names the same two windows `session` and `weekly_all` and reporting a window twice
 * under two names would double-count it in the status bar's severity ranking.
 */
function scopedWindows(raw: unknown): QuotaCacheWindow[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const windows: QuotaCacheWindow[] = [];
  for (const entry of raw as RawLimit[]) {
    if (entry?.kind !== "weekly_scoped") {
      continue;
    }
    const used = percentage(entry.percent);
    if (used === undefined) {
      continue;
    }
    windows.push({
      window: "weekly_scoped",
      usedPercentage: used,
      resetsAt: timestamp(entry.resets_at),
      // Claude leaves `id` null and names the model only in `display_name`.
      scopeModel: text(entry.scope?.model?.display_name) ?? text(entry.scope?.model?.id),
      reportedSeverity: text(entry.severity),
      active: entry.is_active === true
    });
  }
  return windows;
}

function namedWindow(
  key: QuotaWindowKey,
  raw: unknown,
  limits: readonly RawLimit[]
): QuotaCacheWindow | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const value = raw as RawUtilizationWindow;
  const used = percentage(value.utilization);
  if (used === undefined) {
    return undefined;
  }
  // The severity and active flag for these two live in `limits[]` under different names, so they
  // are matched across rather than invented here.
  const matching = limits.find((limit) => limit.kind === (key === "five_hour" ? "session" : "weekly_all"));
  return {
    window: key,
    usedPercentage: used,
    resetsAt: timestamp(value.resets_at),
    reportedSeverity: text(matching?.severity),
    active: matching?.is_active === true
  };
}

/**
 * Turn the raw contents of `.claude.json` into a quota reading, or nothing.
 *
 * Separated from the file read so the parse is testable against real payloads without a filesystem,
 * and so a malformed or unexpected document degrades to "no reading" instead of throwing into a
 * status-bar refresh.
 */
export function parseQuotaCache(document: unknown): AccountQuotaCache | undefined {
  if (typeof document !== "object" || document === null) {
    return undefined;
  }
  const cached = (document as Record<string, unknown>).cachedUsageUtilization;
  if (typeof cached !== "object" || cached === null) {
    return undefined;
  }
  const block = cached as Record<string, unknown>;
  const fetchedAtMs = count(block.fetchedAtMs);
  const utilization = typeof block.utilization === "object" && block.utilization !== null
    ? block.utilization as Record<string, unknown>
    : undefined;
  if (!utilization) {
    return undefined;
  }
  const limits: readonly RawLimit[] = Array.isArray(utilization.limits)
    ? utilization.limits as RawLimit[]
    : [];
  const windows: QuotaCacheWindow[] = [];
  const fiveHour = namedWindow("five_hour", utilization.five_hour, limits);
  if (fiveHour) {
    windows.push(fiveHour);
  }
  const sevenDay = namedWindow("seven_day", utilization.seven_day, limits);
  if (sevenDay) {
    windows.push(sevenDay);
  }
  windows.push(...scopedWindows(utilization.limits));
  const pool = creditPool(utilization.extra_usage, utilization.spend);
  if (windows.length === 0 && !pool) {
    return undefined;
  }
  return {
    // An absent timestamp is reported as the epoch rather than as "now": treating an undated
    // reading as fresh is how a stale percentage passes for current headroom.
    fetchedAt: new Date(fetchedAtMs ?? 0).toISOString(),
    windows,
    creditPool: pool
  };
}

/**
 * Read the quota cache for one account's configuration directory.
 *
 * Every failure is absence. A missing file is the normal state for an account no session has run
 * under yet, and an unreadable or half-written one must never break a refresh — Claude rewrites
 * this file underneath us, so a torn read is expected rather than exceptional.
 */
export async function readQuotaCache(configDir: string): Promise<AccountQuotaCache | undefined> {
  try {
    const raw = await readFile(path.join(configDir, QUOTA_CACHE_FILE), "utf8");
    return parseQuotaCache(JSON.parse(stripByteOrderMark(raw)));
  } catch {
    return undefined;
  }
}
