import type { StatusSnapshot } from "../core/models.js";

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

export interface NormalizedOtlp {
  metrics: NormalizedMetric[];
  events: NormalizedEvent[];
}

type JsonRecord = Record<string, unknown>;
type SafeScalar = string | number | boolean;

const SAFE_ATTRIBUTES = new Set([
  "agent.name",
  "agent_id",
  "attempt",
  "cache_creation_tokens",
  "cache_read_tokens",
  "claude.account_guard.profile_id",
  "claude.account_guard.workspace_hash",
  "claude.account_guard.workspace_label",
  "decision",
  "duration_ms",
  "error_category",
  "event.name",
  "input_tokens",
  "model",
  "output_tokens",
  "plugin.name",
  "query_source",
  "server_name",
  "skill.name",
  "source",
  "status",
  "status_code",
  "success",
  "tool_name",
  "type",
  "ttft_ms"
]);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
    if (scalar !== undefined) {
      result[item.key] = typeof scalar === "string" ? scalar.slice(0, 300) : scalar;
    }
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

function timestamp(record: JsonRecord): string {
  const unixNanos = record.timeUnixNano
    ?? record.observedTimeUnixNano
    ?? record.startTimeUnixNano;
  if (typeof unixNanos === "string" && /^\d+$/.test(unixNanos)) {
    try {
      return new Date(Number(BigInt(unixNanos) / 1_000_000n)).toISOString();
    } catch {
      // Fall through to collection time.
    }
  }
  if (typeof unixNanos === "number" && Number.isFinite(unixNanos)) {
    return new Date(unixNanos / 1_000_000).toISOString();
  }
  return new Date().toISOString();
}

function spanDurationMs(record: JsonRecord): number | undefined {
  const start = record.startTimeUnixNano;
  const end = record.endTimeUnixNano;
  if ((typeof start !== "string" && typeof start !== "number")
    || (typeof end !== "string" && typeof end !== "number")) {
    return undefined;
  }
  try {
    const nanoseconds = BigInt(end) - BigInt(start);
    if (nanoseconds < 0n) {
      return undefined;
    }
    return Number(nanoseconds / 1_000_000n);
  } catch {
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
            continue;
          }
          const value = numberValue(point);
          if (value === undefined) {
            continue;
          }
          metrics.push({
            name: metric.name,
            value,
            timestamp: timestamp(point),
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
          continue;
        }
        events.push({
          name,
          timestamp: timestamp(logRecord),
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
          continue;
        }
        const safeAttributes = {
          ...spanResourceAttributes,
          ...attributes(span.attributes)
        };
        const durationMs = spanDurationMs(span);
        if (durationMs !== undefined && safeAttributes.duration_ms === undefined) {
          safeAttributes.duration_ms = durationMs;
        }
        events.push({
          name: span.name.slice(0, 200),
          timestamp: timestamp(span),
          attributes: safeAttributes
        });
      }
    }
  }
  return { metrics, events };
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
