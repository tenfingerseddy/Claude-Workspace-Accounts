import type { CollectionDegradationReason, StatusSnapshot } from "../core/models.js";

export interface NormalizedMetric {
  name: string;
  value: number;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
}

export interface NormalizedEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, string | number | boolean>;
}

export type OtlpSignal = "metrics" | "logs" | "traces";

export interface NormalizedOtlp {
  metrics: NormalizedMetric[];
  events: NormalizedEvent[];
  /**
   * Which OTLP envelopes the payload actually contained. Empty means the body was valid JSON but was
   * not an OTLP export request at all — the collector must say so rather than answer 200 and drop
   * it, which is how "accepted and silently ignored" used to look identical to "stored".
   */
  signals: OtlpSignal[];
  /** Fidelity losses, by reason. Surfaced through collection health so no fallback stays invisible. */
  degradations: Partial<Record<CollectionDegradationReason, number>>;
}

type JsonRecord = Record<string, unknown>;
type SafeScalar = string | number | boolean;

/**
 * Attribute allowlist, verified against https://code.claude.com/docs/en/monitoring-usage (2026-07).
 *
 * Deliberately absent, and must stay absent: `prompt`, `response`, `body`, `body_ref`, `tool_input`,
 * `tool_parameters`, `message.uuid`, and `error`. `error` is documented as the *full error message*,
 * which routinely contains file paths and command output, so only the categorical `error_type`,
 * `error_code` and `error_category` are retained.
 */
const SAFE_ATTRIBUTES = new Set([
  "action",
  "agent.name",
  "agent_id",
  "attempt",
  "auth_method",
  "cache_creation_tokens",
  "cache_read_tokens",
  "category",
  "claude.account_guard.profile_id",
  "claude.account_guard.workspace_hash",
  "claude.account_guard.workspace_label",
  "cost_usd",
  "decision",
  "decision_source",
  "decision_type",
  "duration_ms",
  "effort",
  "error_category",
  "error_code",
  "error_name",
  "error_type",
  "event.name",
  "from_mode",
  "input_tokens",
  "language",
  "marketplace.name",
  "mcp_server.name",
  "mcp_server_scope",
  "mcp_tool.name",
  "model",
  "output_tokens",
  "plugin.name",
  "plugin.scope",
  "plugin.version",
  "query_source",
  "server_name",
  "server_scope",
  "skill.name",
  "source",
  "speed",
  "start_type",
  "status",
  "status_code",
  "success",
  "to_mode",
  "tool_name",
  "tool_source",
  "transport_type",
  "trigger",
  "ttft_ms",
  "type"
]);

/**
 * Anthropic encodes these as the strings "true"/"false", not as OTLP `boolValue`. Reading them as
 * raw scalars made every failed tool result look successful and made failed auth events vanish,
 * because a non-empty string is truthy and `"false" !== false`.
 */
const BOOLEAN_ATTRIBUTES = new Set([
  "has_category",
  "has_explanation",
  "has_hooks",
  "has_mcp",
  "host_owned_mcp",
  "is_plugin",
  "marketplace.is_official",
  "success"
]);

/**
 * Interpret a boolean-like value from any of the encodings seen on the wire: a real boolean, the
 * strings "true"/"false" that Claude Code actually sends, and the 1/0 forms OTLP `intValue` yields.
 * Returns undefined when the value carries no boolean meaning, so callers can tell "absent" from
 * "false" — a distinction the old `!== false` test destroyed.
 */
export function canonicalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLocaleLowerCase();
  if (["true", "1", "yes", "y", "ok", "success"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "failure", "failed", "error"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Accumulates fidelity losses so the collector can persist them as counters. */
class DegradationLog {
  private readonly counts = new Map<CollectionDegradationReason, number>();

  public note(reason: CollectionDegradationReason): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  public snapshot(): Partial<Record<CollectionDegradationReason, number>> {
    return Object.fromEntries(this.counts) as Partial<Record<CollectionDegradationReason, number>>;
  }
}

function scalarFromOtlpValue(value: unknown): SafeScalar | undefined {
  if (!isRecord(value)) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : undefined;
  }
  for (const key of ["stringValue", "boolValue", "intValue", "doubleValue"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      if (key === "intValue" || key === "doubleValue") {
        const numeric = Number(candidate);
        return Number.isFinite(numeric) ? numeric : candidate;
      }
      return candidate;
    }
    if (typeof candidate === "number" || typeof candidate === "boolean") {
      return candidate;
    }
  }
  return undefined;
}

function attributes(value: unknown): Record<string, SafeScalar> {
  const result: Record<string, SafeScalar> = {};
  for (const item of array(value)) {
    if (!isRecord(item) || typeof item.key !== "string" || !SAFE_ATTRIBUTES.has(item.key)) {
      continue;
    }
    const scalar = scalarFromOtlpValue(item.value);
    if (scalar === undefined) {
      continue;
    }
    if (BOOLEAN_ATTRIBUTES.has(item.key)) {
      const canonical = canonicalBoolean(scalar);
      if (canonical !== undefined) {
        result[item.key] = canonical;
        continue;
      }
    }
    result[item.key] = typeof scalar === "string" ? scalar.slice(0, 300) : scalar;
  }
  // `error_type` is the documented categorical key on tool_result; `error_category` only exists on
  // auth events. Storage reads one column, so alias rather than teaching every call site both.
  if (result.error_category === undefined && typeof result.error_type === "string") {
    result.error_category = result.error_type;
  }
  return result;
}

function numberValue(record: JsonRecord): number | undefined {
  for (const key of ["asDouble", "asInt", "value"] as const) {
    const value = record[key];
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

/**
 * Substituting collection time for a malformed export timestamp is the right fallback — dropping the
 * point would lose real usage — but it silently misattributes the day, so every substitution is
 * counted under `fallbackReason`.
 */
function timestamp(
  record: JsonRecord,
  degradations: DegradationLog,
  fallbackReason: CollectionDegradationReason
): string {
  const unixNanos = record.timeUnixNano
    ?? record.observedTimeUnixNano
    ?? record.startTimeUnixNano;
  if (typeof unixNanos === "string" && /^\d+$/.test(unixNanos)) {
    const parsed = new Date(Number(BigInt(unixNanos) / 1_000_000n));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (typeof unixNanos === "number" && Number.isFinite(unixNanos)) {
    const parsed = new Date(unixNanos / 1_000_000);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  degradations.note(fallbackReason);
  return new Date().toISOString();
}

function spanDurationMs(record: JsonRecord, degradations: DegradationLog): number | undefined {
  const start = record.startTimeUnixNano;
  const end = record.endTimeUnixNano;
  if ((typeof start !== "string" && typeof start !== "number")
    || (typeof end !== "string" && typeof end !== "number")) {
    degradations.note("span_duration_unusable");
    return undefined;
  }
  try {
    const nanoseconds = BigInt(end) - BigInt(start);
    if (nanoseconds < 0n) {
      degradations.note("span_duration_unusable");
      return undefined;
    }
    return Number(nanoseconds / 1_000_000n);
  } catch {
    degradations.note("span_duration_unusable");
    return undefined;
  }
}

function bodyName(body: unknown): string | undefined {
  const scalar = scalarFromOtlpValue(body);
  if (typeof scalar === "string") {
    return scalar;
  }
  return undefined;
}

export function normalizeOtlp(payload: unknown): NormalizedOtlp {
  const root = isRecord(payload) ? payload : {};
  const metrics: NormalizedMetric[] = [];
  const events: NormalizedEvent[] = [];
  const degradations = new DegradationLog();
  const signals: OtlpSignal[] = [];
  if (Array.isArray(root.resourceMetrics)) {
    signals.push("metrics");
  }
  if (Array.isArray(root.resourceLogs)) {
    signals.push("logs");
  }
  if (Array.isArray(root.resourceSpans)) {
    signals.push("traces");
  }

  for (const resourceMetric of array(root.resourceMetrics)) {
    if (!isRecord(resourceMetric)) {
      continue;
    }
    const metricResourceAttributes = attributes(
      isRecord(resourceMetric.resource) ? resourceMetric.resource.attributes : undefined
    );
    for (const scopeMetric of array(resourceMetric.scopeMetrics)) {
      if (!isRecord(scopeMetric)) {
        continue;
      }
      for (const metric of array(scopeMetric.metrics)) {
        if (!isRecord(metric) || typeof metric.name !== "string") {
          continue;
        }
        const pointGroups = [
          ...array(isRecord(metric.sum) ? metric.sum.dataPoints : undefined),
          ...array(isRecord(metric.gauge) ? metric.gauge.dataPoints : undefined)
        ];
        for (const point of pointGroups) {
          if (!isRecord(point)) {
            degradations.note("dropped_metric_point");
            continue;
          }
          const value = numberValue(point);
          if (value === undefined) {
            degradations.note("dropped_metric_point");
            continue;
          }
          metrics.push({
            name: metric.name,
            value,
            timestamp: timestamp(point, degradations, "metric_timestamp_fallback"),
            attributes: {
              ...metricResourceAttributes,
              ...attributes(point.attributes)
            }
          });
        }
      }
    }
  }

  for (const resourceLog of array(root.resourceLogs)) {
    if (!isRecord(resourceLog)) {
      continue;
    }
    const logResourceAttributes = attributes(
      isRecord(resourceLog.resource) ? resourceLog.resource.attributes : undefined
    );
    for (const scopeLog of array(resourceLog.scopeLogs)) {
      if (!isRecord(scopeLog)) {
        continue;
      }
      for (const logRecord of array(scopeLog.logRecords)) {
        if (!isRecord(logRecord)) {
          degradations.note("dropped_log_record");
          continue;
        }
        const safeAttributes = {
          ...logResourceAttributes,
          ...attributes(logRecord.attributes)
        };
        const name = typeof safeAttributes["event.name"] === "string"
          ? safeAttributes["event.name"]
          : bodyName(logRecord.body);
        if (!name) {
          degradations.note("dropped_log_record");
          continue;
        }
        events.push({
          name,
          timestamp: timestamp(logRecord, degradations, "event_timestamp_fallback"),
          attributes: safeAttributes
        });
      }
    }
  }

  for (const resourceSpan of array(root.resourceSpans)) {
    if (!isRecord(resourceSpan)) {
      continue;
    }
    const spanResourceAttributes = attributes(
      isRecord(resourceSpan.resource) ? resourceSpan.resource.attributes : undefined
    );
    for (const scopeSpan of array(resourceSpan.scopeSpans)) {
      if (!isRecord(scopeSpan)) {
        continue;
      }
      for (const span of array(scopeSpan.spans)) {
        if (!isRecord(span) || typeof span.name !== "string" || !span.name) {
          degradations.note("dropped_span");
          continue;
        }
        const safeAttributes = {
          ...spanResourceAttributes,
          ...attributes(span.attributes)
        };
        const durationMs = spanDurationMs(span, degradations);
        if (durationMs !== undefined && safeAttributes.duration_ms === undefined) {
          safeAttributes.duration_ms = durationMs;
        }
        events.push({
          name: span.name.slice(0, 200),
          timestamp: timestamp(span, degradations, "event_timestamp_fallback"),
          attributes: safeAttributes
        });
      }
    }
  }
  return { metrics, events, signals, degradations: degradations.snapshot() };
}

export function localDay(timestampValue: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestampValue));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeEventName(name: string): string {
  return name
    .toLocaleLowerCase()
    .replace(/^claude_code[._]/, "")
    .replace(/[.\s-]+/g, "_");
}

function finite(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function boundedPercentage(value: unknown): number | undefined {
  const number = finite(value);
  return number === undefined ? undefined : Math.max(0, Math.min(100, number));
}

export function normalizeStatusSnapshot(value: unknown): StatusSnapshot | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.profileId !== "string"
    || typeof value.sessionId !== "string"
    || !value.profileId
    || !value.sessionId) {
    return undefined;
  }
  const context = isRecord(value.contextWindow) ? value.contextWindow : {};
  const currentUsage = isRecord(context.currentUsage) ? context.currentUsage : {};
  const rateLimits = isRecord(value.rateLimits) ? value.rateLimits : {};
  const fiveHour = isRecord(rateLimits.fiveHour) ? rateLimits.fiveHour : {};
  const sevenDay = isRecord(rateLimits.sevenDay) ? rateLimits.sevenDay : {};
  const fiveHourPercentage = boundedPercentage(fiveHour.usedPercentage);
  const sevenDayPercentage = boundedPercentage(sevenDay.usedPercentage);
  const usedPercentage = boundedPercentage(context.usedPercentage);
  const remainingPercentage = boundedPercentage(context.remainingPercentage);
  const currentUsageValues = {
    input: finite(currentUsage.input) ?? 0,
    output: finite(currentUsage.output) ?? 0,
    cacheRead: finite(currentUsage.cacheRead) ?? 0,
    cacheCreation: finite(currentUsage.cacheCreation) ?? 0
  };
  const hasCurrentUsage = Object.values(currentUsage).some((candidate) => finite(candidate) !== undefined);
  return {
    schemaVersion: 1,
    capturedAt: typeof value.capturedAt === "string" && !Number.isNaN(Date.parse(value.capturedAt))
      ? value.capturedAt
      : new Date().toISOString(),
    profileId: value.profileId,
    sessionId: value.sessionId,
    sessionName: typeof value.sessionName === "string" && value.sessionName ? value.sessionName : undefined,
    workspaceHash: typeof value.workspaceHash === "string" ? value.workspaceHash.slice(0, 64) : undefined,
    workspaceLabel: typeof value.workspaceLabel === "string" ? value.workspaceLabel.slice(0, 200) : undefined,
    workspacePath: typeof value.workspacePath === "string" ? value.workspacePath.slice(0, 2_000) : undefined,
    modelId: typeof value.modelId === "string" ? value.modelId.slice(0, 200) : undefined,
    modelDisplayName: typeof value.modelDisplayName === "string"
      ? value.modelDisplayName.slice(0, 200)
      : undefined,
    effort: typeof value.effort === "string" ? value.effort.slice(0, 30) : undefined,
    thinkingEnabled: typeof value.thinkingEnabled === "boolean" ? value.thinkingEnabled : undefined,
    fastMode: typeof value.fastMode === "boolean" ? value.fastMode : undefined,
    costUsd: finite(value.costUsd),
    durationMs: finite(value.durationMs),
    apiDurationMs: finite(value.apiDurationMs),
    linesAdded: finite(value.linesAdded),
    linesRemoved: finite(value.linesRemoved),
    contextWindow: Object.keys(context).length > 0 ? {
      usedPercentage,
      remainingPercentage,
      size: finite(context.size),
      totalInputTokens: finite(context.totalInputTokens),
      totalOutputTokens: finite(context.totalOutputTokens),
      currentUsage: hasCurrentUsage ? currentUsageValues : undefined
    } : undefined,
    rateLimits: fiveHourPercentage !== undefined || sevenDayPercentage !== undefined ? {
      fiveHour: fiveHourPercentage === undefined ? undefined : {
        usedPercentage: fiveHourPercentage,
        resetsAt: finite(fiveHour.resetsAt)
      },
      sevenDay: sevenDayPercentage === undefined ? undefined : {
        usedPercentage: sevenDayPercentage,
        resetsAt: finite(sevenDay.resetsAt)
      }
    } : undefined
  };
}
