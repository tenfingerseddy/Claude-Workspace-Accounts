import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AttributionDimension,
  AttributionRow,
  AuthVerification,
  DashboardDateBounds,
  DashboardRange,
  ReliabilitySummary,
  SharedRegistryDocument,
  StatusSnapshot,
  UsageDailyRow
} from "../core/models.js";
import { workspaceHash } from "../core/paths.js";
import type { NormalizedEvent, NormalizedMetric } from "../telemetry/normalizers.js";
import { localDay, normalizeEventName } from "../telemetry/normalizers.js";

interface DailyDimensions {
  day: string;
  profileId: string;
  workspaceHash: string;
  workspaceLabel: string;
  model: string;
  querySource: string;
}

const DAILY_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "estimated_cost_usd",
  "active_seconds",
  "sessions",
  "lines_added",
  "lines_removed",
  "commits",
  "pull_requests",
  "requests",
  "errors"
] as const;

type DailyColumn = typeof DAILY_COLUMNS[number];

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function querySource(value: unknown): string {
  const normalized = text(value, "main").toLocaleLowerCase();
  if (normalized.includes("main")) {
    return "main";
  }
  if (normalized.includes("subagent") || normalized.includes("aux")) {
    return "auxiliary";
  }
  return normalized.slice(0, 100);
}

function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export class UsageRepository {
  private readonly database: DatabaseSync;

  public constructor(public readonly databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  public mirrorRegistry(document: SharedRegistryDocument): void {
    this.transaction(() => {
      this.database.exec("DELETE FROM profiles; DELETE FROM workspace_locks;");
      const profileStatement = this.database.prepare(`
        INSERT INTO profiles (id, display_name, config_dir_hash, expected_email, account_id, organization_id, last_verified_at)
        VALUES (@id, @displayName, @configDirNormalized, @email, @accountId, @organizationId, @lastVerifiedAt)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          config_dir_hash = excluded.config_dir_hash,
          expected_email = excluded.expected_email,
          account_id = excluded.account_id,
          organization_id = excluded.organization_id,
          last_verified_at = excluded.last_verified_at
      `);
      for (const profile of document.profiles) {
        profileStatement.run({
          id: profile.id,
          displayName: profile.displayName,
          configDirNormalized: workspaceHash(profile.configDirNormalized),
          email: profile.expectedIdentity?.email ?? null,
          accountId: profile.expectedIdentity?.accountId ?? null,
          organizationId: profile.expectedIdentity?.organizationId ?? null,
          lastVerifiedAt: profile.lastVerifiedAt ?? null
        });
      }
      const lockStatement = this.database.prepare(`
        INSERT INTO workspace_locks (workspace_uri, workspace_hash, workspace_label, profile_id, mode, updated_at)
        VALUES (@workspaceUri, @workspacePathNormalized, @workspaceLabel, @profileId, @mode, @updatedAt)
        ON CONFLICT(workspace_uri) DO UPDATE SET
          workspace_hash = excluded.workspace_hash,
          workspace_label = excluded.workspace_label,
          profile_id = excluded.profile_id,
          mode = excluded.mode,
          updated_at = excluded.updated_at
      `);
      for (const lock of document.workspaceLocks) {
        lockStatement.run({
          workspaceUri: workspaceHash(lock.workspaceUri),
          workspacePathNormalized: workspaceHash(lock.workspacePathNormalized),
          workspaceLabel: lock.workspaceLabel,
          profileId: lock.profileId,
          mode: lock.mode,
          updatedAt: lock.updatedAt
        });
      }
    });
  }

  public recordAuthVerification(profileId: string, verification: AuthVerification): void {
    this.database.prepare(`
      INSERT INTO auth_verifications
        (profile_id, checked_at, state, email, account_id, organization_id, auth_method, error_category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profileId,
      verification.checkedAt,
      verification.state,
      verification.email ?? null,
      verification.accountId ?? null,
      verification.organizationId ?? null,
      verification.authMethod ?? null,
      verification.errorCategory ?? null
    );
  }

  public latestAuthVerification(profileId: string): AuthVerification | undefined {
    const row = this.database.prepare(`
      SELECT
        checked_at AS checkedAt,
        state,
        email,
        account_id AS accountId,
        organization_id AS organizationId,
        auth_method AS authMethod,
        error_category AS errorCategory
      FROM auth_verifications
      WHERE profile_id = ?
      ORDER BY checked_at DESC, id DESC
      LIMIT 1
    `).get(profileId) as {
      checkedAt: string;
      state: AuthVerification["state"];
      email: string | null;
      accountId: string | null;
      organizationId: string | null;
      authMethod: string | null;
      errorCategory: AuthVerification["errorCategory"] | null;
    } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      state: row.state,
      checkedAt: row.checkedAt,
      email: row.email ?? undefined,
      accountId: row.accountId ?? undefined,
      organizationId: row.organizationId ?? undefined,
      authMethod: row.authMethod ?? undefined,
      errorCategory: row.errorCategory ?? undefined
    };
  }

  public recordStatusSnapshot(snapshot: StatusSnapshot): void {
    this.database.prepare(`
      INSERT INTO status_snapshots
        (profile_id, session_id, captured_at, workspace_hash, workspace_label, model, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.profileId,
      snapshot.sessionId,
      snapshot.capturedAt,
      snapshot.workspaceHash ?? "",
      snapshot.workspaceLabel ?? "",
      snapshot.modelId ?? snapshot.modelDisplayName ?? "",
      JSON.stringify(snapshot)
    );
    this.database.prepare(`
      INSERT INTO sessions
        (id, profile_id, workspace_hash, workspace_label, model, session_name, started_at, last_event_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model = excluded.model,
        session_name = excluded.session_name,
        last_event_at = excluded.last_event_at
    `).run(
      snapshot.sessionId,
      snapshot.profileId,
      snapshot.workspaceHash ?? "",
      snapshot.workspaceLabel ?? "",
      snapshot.modelId ?? snapshot.modelDisplayName ?? "",
      snapshot.sessionName ?? null,
      snapshot.capturedAt,
      snapshot.capturedAt
    );
    this.database.prepare(`
      INSERT INTO collector_health (profile_id, last_event_at, status, detail)
      VALUES (?, ?, 'active', 'status_snapshot')
      ON CONFLICT(profile_id) DO UPDATE SET
        last_event_at = excluded.last_event_at,
        status = excluded.status,
        detail = excluded.detail
    `).run(snapshot.profileId, snapshot.capturedAt);
  }

  public latestStatusSnapshot(profileId: string): StatusSnapshot | undefined {
    const row = this.database.prepare(`
      SELECT payload_json FROM status_snapshots
      WHERE profile_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(profileId) as { payload_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    try {
      return JSON.parse(row.payload_json) as StatusSnapshot;
    } catch {
      return undefined;
    }
  }

  public ingestMetric(profileId: string, metric: NormalizedMetric): void {
    const dimensions: DailyDimensions = {
      day: localDay(metric.timestamp),
      profileId,
      workspaceHash: text(metric.attributes["claude.account_guard.workspace_hash"]),
      workspaceLabel: text(metric.attributes["claude.account_guard.workspace_label"], "Local"),
      model: text(metric.attributes.model, "unknown"),
      querySource: querySource(metric.attributes.query_source)
    };
    const name = metric.name.toLocaleLowerCase();
    let attributionValue:
      | { tokens?: number; cost?: number; activeSeconds?: number; requests?: number }
      | undefined;
    if (name === "claude_code.token.usage") {
      const type = text(metric.attributes.type).toLocaleLowerCase().replace(/[-.\s]/g, "_");
      const column: DailyColumn | undefined = ({
        input: "input_tokens",
        input_tokens: "input_tokens",
        output: "output_tokens",
        output_tokens: "output_tokens",
        cache_read: "cache_read_tokens",
        cache_read_tokens: "cache_read_tokens",
        cacheread: "cache_read_tokens",
        cache_creation: "cache_creation_tokens",
        cache_creation_tokens: "cache_creation_tokens",
        cachecreation: "cache_creation_tokens"
      } as Record<string, DailyColumn>)[type];
      if (column) {
        this.incrementDaily(dimensions, column, metric.value);
        attributionValue = { tokens: metric.value };
      }
    } else if (name === "claude_code.cost.usage") {
      this.incrementDaily(dimensions, "estimated_cost_usd", metric.value);
      attributionValue = { cost: metric.value };
    } else if (name === "claude_code.active_time.total") {
      this.incrementDaily(dimensions, "active_seconds", metric.value);
      attributionValue = { activeSeconds: metric.value };
    } else if (name === "claude_code.session.count") {
      this.incrementDaily(dimensions, "sessions", metric.value);
    } else if (name === "claude_code.lines_of_code.count") {
      this.incrementDaily(
        dimensions,
        text(metric.attributes.type).toLocaleLowerCase() === "removed" ? "lines_removed" : "lines_added",
        metric.value
      );
    } else if (name === "claude_code.commit.count") {
      this.incrementDaily(dimensions, "commits", metric.value);
    } else if (name === "claude_code.pull_request.count") {
      this.incrementDaily(dimensions, "pull_requests", metric.value);
    }
    if (attributionValue) {
      this.incrementDetailedAttribution(
        localDay(metric.timestamp),
        profileId,
        metric.attributes,
        attributionValue
      );
    }
    this.touchCollector(profileId, metric.timestamp, "metric");
  }

  public ingestEvent(profileId: string, event: NormalizedEvent): void {
    const name = normalizeEventName(event.name);
    const dimensions: DailyDimensions = {
      day: localDay(event.timestamp),
      profileId,
      workspaceHash: text(event.attributes["claude.account_guard.workspace_hash"]),
      workspaceLabel: text(event.attributes["claude.account_guard.workspace_label"], "Local"),
      model: text(event.attributes.model, "unknown"),
      querySource: querySource(event.attributes.query_source)
    };

    if (name === "api_request" || name === "llm_request") {
      const success = event.attributes.success !== false;
      this.database.prepare(`
        INSERT INTO api_requests
          (profile_id, occurred_at, model, query_source, success, duration_ms, ttft_ms, status_code, error_category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profileId,
        event.timestamp,
        dimensions.model,
        dimensions.querySource,
        success ? 1 : 0,
        numeric(event.attributes.duration_ms),
        numeric(event.attributes.ttft_ms) || null,
        numeric(event.attributes.status_code) || null,
        text(event.attributes.error_category) || null
      );
      this.incrementDaily(dimensions, "requests", 1);
      if (!success) {
        this.incrementDaily(dimensions, "errors", 1);
      }
      this.incrementDetailedAttribution(
        localDay(event.timestamp),
        profileId,
        event.attributes,
        { requests: 1 }
      );
    } else if (name === "api_error") {
      this.database.prepare(`
        INSERT INTO api_requests
          (profile_id, occurred_at, model, query_source, success, duration_ms, ttft_ms, status_code, error_category)
        VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)
      `).run(
        profileId,
        event.timestamp,
        dimensions.model,
        dimensions.querySource,
        numeric(event.attributes.duration_ms),
        numeric(event.attributes.status_code) || null,
        text(event.attributes.error_category) || null
      );
      this.incrementDaily(dimensions, "errors", 1);
      this.incrementDetailedAttribution(
        localDay(event.timestamp),
        profileId,
        event.attributes,
        { requests: 1 }
      );
    } else if (name === "tool_result" || name === "tool_execution" || name === "tool") {
      this.database.prepare(`
        INSERT INTO tool_results
          (profile_id, occurred_at, tool_name, success, duration_ms, error_category)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        profileId,
        event.timestamp,
        text(event.attributes.tool_name, "unknown"),
        event.attributes.success === false ? 0 : 1,
        numeric(event.attributes.duration_ms),
        text(event.attributes.error_category) || null
      );
    } else if (name === "tool_decision" || name === "code_edit_tool_decision") {
      this.database.prepare(`
        INSERT INTO permission_decisions
          (profile_id, occurred_at, tool_name, decision, source)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        profileId,
        event.timestamp,
        text(event.attributes.tool_name, "unknown"),
        text(event.attributes.decision, "unknown"),
        text(event.attributes.source, "unknown")
      );
    } else if (name === "auth" && event.attributes.success === false) {
      this.database.prepare(`
        INSERT INTO security_events (profile_id, occurred_at, category, detail)
        VALUES (?, ?, 'auth_failure', ?)
      `).run(profileId, event.timestamp, text(event.attributes.error_category, "unknown"));
    } else if (name === "mcp_server_connection"
      && !["connected", "success"].includes(text(event.attributes.status).toLocaleLowerCase())) {
      this.database.prepare(`
        INSERT INTO security_events (profile_id, occurred_at, category, detail)
        VALUES (?, ?, 'mcp_failure', ?)
      `).run(profileId, event.timestamp, text(event.attributes.server_name, "unknown"));
    }
    this.touchCollector(profileId, event.timestamp, "event");
  }

  public ingestBatch(
    profileId: string,
    metrics: readonly NormalizedMetric[],
    events: readonly NormalizedEvent[]
  ): void {
    this.transaction(() => {
      for (const metric of metrics) {
        this.ingestMetric(profileId, metric);
      }
      for (const event of events) {
        this.ingestEvent(profileId, event);
      }
    });
  }

  public daily(
    profileId: string,
    range: DashboardRange,
    customRange?: DashboardDateBounds
  ): UsageDailyRow[] {
    const bounds = this.bounds(range, customRange);
    return this.database.prepare(`
      SELECT
        day,
        profile_id AS profileId,
        workspace_hash AS workspaceHash,
        workspace_label AS workspaceLabel,
        model,
        query_source AS querySource,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens,
        cache_creation_tokens AS cacheCreationTokens,
        estimated_cost_usd AS estimatedCostUsd,
        active_seconds AS activeSeconds,
        sessions,
        lines_added AS linesAdded,
        lines_removed AS linesRemoved,
        commits,
        pull_requests AS pullRequests,
        requests,
        errors
      FROM usage_daily
      WHERE profile_id = ? AND day >= ? AND day <= ?
      ORDER BY day ASC, model ASC
    `).all(profileId, bounds.from, bounds.to) as unknown as UsageDailyRow[];
  }

  public attribution(
    profileId: string,
    range: DashboardRange,
    threadScope: "main" | "all" = "main",
    customRange?: DashboardDateBounds
  ): AttributionRow[] {
    const bounds = this.bounds(range, customRange);
    const rows = this.daily(profileId, range, customRange)
      .filter((row) => threadScope === "all" || row.querySource === "main");
    const totals = new Map<string, AttributionRow>();
    const add = (
      dimension: AttributionDimension,
      label: string,
      values: Pick<AttributionRow, "tokens" | "cost" | "requests" | "activeSeconds">
    ) => {
      if (!label || label === "unknown") {
        return;
      }
      const key = `${dimension}\0${label}`;
      const current = totals.get(key) ?? {
        dimension,
        label,
        tokens: 0,
        cost: 0,
        requests: 0,
        activeSeconds: 0
      };
      current.tokens += values.tokens;
      current.cost += values.cost;
      current.requests += values.requests;
      current.activeSeconds += values.activeSeconds;
      totals.set(key, current);
    };
    for (const row of rows) {
      const values = {
        tokens: row.inputTokens + row.outputTokens
          + row.cacheReadTokens + row.cacheCreationTokens,
        cost: row.estimatedCostUsd,
        requests: row.requests,
        activeSeconds: row.activeSeconds
      };
      add("model", row.model, values);
      add("workspace", row.workspaceLabel || row.workspaceHash, values);
      add("query_source", row.querySource, values);
    }
    const detailed = this.database.prepare(`
      SELECT
        dimension,
        label,
        SUM(tokens) AS tokens,
        SUM(estimated_cost_usd) AS cost,
        SUM(requests) AS requests,
        SUM(active_seconds) AS activeSeconds
      FROM attribution_daily
      WHERE profile_id = ? AND day >= ? AND day <= ?
        AND (? = 'all' OR query_source = 'main')
      GROUP BY dimension, label
    `).all(
      profileId,
      bounds.from,
      bounds.to,
      threadScope
    ) as unknown as AttributionRow[];
    for (const row of detailed) {
      add(row.dimension, row.label, row);
    }
    const grouped = new Map<AttributionDimension, AttributionRow[]>();
    for (const row of totals.values()) {
      const values = grouped.get(row.dimension) ?? [];
      values.push(row);
      grouped.set(row.dimension, values);
    }
    return [...grouped.values()].flatMap((values) => values
      .sort((left, right) => right.tokens - left.tokens
        || right.cost - left.cost
        || right.requests - left.requests
        || right.activeSeconds - left.activeSeconds)
      .slice(0, 12));
  }

  public reliability(
    profileId: string,
    range: DashboardRange,
    customRange?: DashboardDateBounds
  ): ReliabilitySummary {
    const bounds = this.bounds(range, customRange);
    const since = `${bounds.from}T00:00:00.000Z`;
    const until = `${bounds.to}T23:59:59.999Z`;
    const requests = this.database.prepare(`
      SELECT success, duration_ms, ttft_ms
      FROM api_requests
      WHERE profile_id = ? AND occurred_at >= ? AND occurred_at <= ?
    `).all(profileId, since, until) as Array<{ success: number; duration_ms: number; ttft_ms: number | null }>;
    const tools = this.database.prepare(`
      SELECT tool_name, success, duration_ms
      FROM tool_results
      WHERE profile_id = ? AND occurred_at >= ? AND occurred_at <= ?
    `).all(profileId, since, until) as Array<{ tool_name: string; success: number; duration_ms: number }>;
    const decisions = this.database.prepare(`
      SELECT source, decision, COUNT(*) AS count
      FROM permission_decisions
      WHERE profile_id = ? AND occurred_at >= ? AND occurred_at <= ?
      GROUP BY source, decision
      ORDER BY count DESC
    `).all(profileId, since, until) as Array<{ source: string; decision: string; count: number }>;
    const groupedTools = new Map<string, Array<{ success: number; duration: number }>>();
    for (const tool of tools) {
      const group = groupedTools.get(tool.tool_name) ?? [];
      group.push({ success: tool.success, duration: tool.duration_ms });
      groupedTools.set(tool.tool_name, group);
    }
    const security = this.database.prepare(`
      SELECT category, COUNT(*) AS count
      FROM security_events
      WHERE profile_id = ? AND occurred_at >= ? AND occurred_at <= ?
      GROUP BY category
    `).all(profileId, since, until) as Array<{ category: string; count: number }>;
    return {
      requests: requests.length,
      errors: requests.filter((request) => request.success === 0).length,
      medianRequestMs: percentile(requests.map((request) => request.duration_ms), 0.5),
      p95RequestMs: percentile(requests.map((request) => request.duration_ms), 0.95),
      medianTtftMs: percentile(
        requests.flatMap((request) => request.ttft_ms === null ? [] : [request.ttft_ms]),
        0.5
      ),
      tools: [...groupedTools.entries()]
        .map(([name, values]) => ({
          name,
          requests: values.length,
          successes: values.filter((value) => value.success === 1).length,
          medianDurationMs: percentile(values.map((value) => value.duration), 0.5)
        }))
        .sort((left, right) => (right.medianDurationMs ?? 0) - (left.medianDurationMs ?? 0))
        .slice(0, 10),
      permissionDecisions: decisions,
      authFailures: security.find((row) => row.category === "auth_failure")?.count ?? 0,
      mcpFailures: security.find((row) => row.category === "mcp_failure")?.count ?? 0
    };
  }

  public collectorHealth(profileId: string): { lastEventAt?: string; status?: string } {
    const row = this.database.prepare(`
      SELECT last_event_at AS lastEventAt, status
      FROM collector_health WHERE profile_id = ?
    `).get(profileId) as { lastEventAt: string; status: string } | undefined;
    return row ?? {};
  }

  public deleteUsageData(): void {
    this.transaction(() => {
      for (const table of [
        "auth_verifications",
        "sessions",
        "status_snapshots",
        "usage_daily",
        "attribution_daily",
        "api_requests",
        "tool_results",
        "permission_decisions",
        "security_events",
        "collector_health"
      ]) {
        this.database.prepare(`DELETE FROM ${table}`).run();
      }
    });
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  public deleteProfileMetadata(profileId: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM auth_verifications WHERE profile_id = ?").run(profileId);
      this.database.prepare("DELETE FROM workspace_locks WHERE profile_id = ?").run(profileId);
      this.database.prepare("DELETE FROM profiles WHERE id = ?").run(profileId);
    });
  }

  public exportRows(profileId?: string): Record<string, unknown[]> {
    const where = profileId ? " WHERE profile_id = ?" : "";
    const args: SQLInputValue[] = profileId ? [profileId] : [];
    return {
      statusSnapshots: this.database.prepare(
        `SELECT profile_id, session_id, captured_at, workspace_hash, workspace_label, model, payload_json FROM status_snapshots${where} ORDER BY captured_at`
      ).all(...args),
      usageDaily: this.database.prepare(
        `SELECT * FROM usage_daily${where} ORDER BY day`
      ).all(...args),
      attributionDaily: this.database.prepare(
        `SELECT * FROM attribution_daily${where} ORDER BY day, dimension, label`
      ).all(...args),
      apiRequests: this.database.prepare(
        `SELECT * FROM api_requests${where} ORDER BY occurred_at`
      ).all(...args),
      toolResults: this.database.prepare(
        `SELECT * FROM tool_results${where} ORDER BY occurred_at`
      ).all(...args),
      permissionDecisions: this.database.prepare(
        `SELECT * FROM permission_decisions${where} ORDER BY occurred_at`
      ).all(...args)
    };
  }

  public databaseSize(): number {
    try {
      return statSync(this.databasePath).size;
    } catch {
      return 0;
    }
  }

  public applyRetention(rawRetentionDays: number): void {
    const days = Math.max(1, Math.min(365, Math.floor(rawRetentionDays)));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const aggregateCutoff = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const retentionTables: Array<[string, string]> = [
      ["auth_verifications", "checked_at"],
      ["sessions", "last_event_at"],
      ["api_requests", "occurred_at"],
      ["tool_results", "occurred_at"],
      ["permission_decisions", "occurred_at"],
      ["security_events", "occurred_at"]
    ];
    this.transaction(() => {
      for (const [table, column] of retentionTables) {
        this.database.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
      }
      this.database.prepare("DELETE FROM usage_daily WHERE day < ?").run(aggregateCutoff);
      this.database.prepare("DELETE FROM attribution_daily WHERE day < ?").run(aggregateCutoff);
      this.database.prepare(`
        DELETE FROM status_snapshots
        WHERE captured_at < ?
          AND id NOT IN (
            SELECT MAX(id) FROM status_snapshots
            WHERE captured_at < ?
            GROUP BY profile_id, session_id, substr(captured_at, 1, 13)
          )
      `).run(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString());
      this.database.prepare("DELETE FROM status_snapshots WHERE captured_at < ?")
        .run(new Date(Date.now() - 365 * 86_400_000).toISOString());
    });
  }

  private incrementDaily(
    dimensions: DailyDimensions,
    column: DailyColumn,
    value: number
  ): void {
    if (!DAILY_COLUMNS.includes(column)) {
      return;
    }
    this.database.prepare(`
      INSERT INTO usage_daily
        (day, profile_id, workspace_hash, workspace_label, model, query_source, ${column})
      VALUES (@day, @profileId, @workspaceHash, @workspaceLabel, @model, @querySource, @value)
      ON CONFLICT(day, profile_id, workspace_hash, model, query_source)
      DO UPDATE SET ${column} = ${column} + excluded.${column}
    `).run({ ...dimensions, value });
  }

  private incrementDetailedAttribution(
    day: string,
    profileId: string,
    attributes: Record<string, string | number | boolean>,
    values: {
      tokens?: number;
      cost?: number;
      requests?: number;
      activeSeconds?: number;
    }
  ): void {
    const skill = text(attributes["skill.name"]);
    const plugin = text(attributes["plugin.name"]);
    const agent = text(attributes["agent.name"], text(attributes.agent_id));
    const server = text(attributes.server_name);
    const tool = text(attributes.tool_name);
    const dimensions: Array<[AttributionDimension, string]> = [
      ["skill", skill],
      ["plugin", plugin],
      ["agent", agent],
      ["mcp_tool", server ? `${server}${tool ? ` / ${tool}` : ""}` : ""]
    ];
    const statement = this.database.prepare(`
      INSERT INTO attribution_daily
        (day, profile_id, query_source, dimension, label, tokens, estimated_cost_usd, requests, active_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, profile_id, query_source, dimension, label)
      DO UPDATE SET
        tokens = tokens + excluded.tokens,
        estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd,
        requests = requests + excluded.requests,
        active_seconds = active_seconds + excluded.active_seconds
    `);
    for (const [dimension, label] of dimensions) {
      if (!label) {
        continue;
      }
      statement.run(
        day,
        profileId,
        querySource(attributes.query_source),
        dimension,
        label.slice(0, 300),
        values.tokens ?? 0,
        values.cost ?? 0,
        values.requests ?? 0,
        values.activeSeconds ?? 0
      );
    }
  }

  private touchCollector(profileId: string, timestamp: string, detail: string): void {
    this.database.prepare(`
      INSERT INTO collector_health (profile_id, last_event_at, status, detail)
      VALUES (?, ?, 'active', ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        last_event_at = excluded.last_event_at,
        status = excluded.status,
        detail = excluded.detail
    `).run(profileId, timestamp, detail);
  }

  private bounds(
    range: DashboardRange,
    customRange?: DashboardDateBounds
  ): DashboardDateBounds {
    if (range === "custom" && customRange) {
      return customRange;
    }
    const days = range === "24h" ? 1 : range === "30d" ? 30 : 7;
    return {
      from: localDay(new Date(Date.now() - (days - 1) * 86_400_000).toISOString()),
      to: localDay(new Date().toISOString())
    };
  }

  private transaction(work: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        config_dir_hash TEXT NOT NULL,
        expected_email TEXT,
        account_id TEXT,
        organization_id TEXT,
        last_verified_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workspace_locks (
        workspace_uri TEXT PRIMARY KEY,
        workspace_hash TEXT NOT NULL,
        workspace_label TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        state TEXT NOT NULL,
        email TEXT,
        account_id TEXT,
        organization_id TEXT,
        auth_method TEXT,
        error_category TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        workspace_hash TEXT NOT NULL DEFAULT '',
        workspace_label TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        session_name TEXT,
        started_at TEXT NOT NULL,
        last_event_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS status_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        workspace_hash TEXT NOT NULL DEFAULT '',
        workspace_label TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_status_profile_time
        ON status_snapshots(profile_id, captured_at DESC);
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        workspace_hash TEXT NOT NULL DEFAULT '',
        workspace_label TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        query_source TEXT NOT NULL DEFAULT 'main',
        input_tokens REAL NOT NULL DEFAULT 0,
        output_tokens REAL NOT NULL DEFAULT 0,
        cache_read_tokens REAL NOT NULL DEFAULT 0,
        cache_creation_tokens REAL NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        active_seconds REAL NOT NULL DEFAULT 0,
        sessions REAL NOT NULL DEFAULT 0,
        lines_added REAL NOT NULL DEFAULT 0,
        lines_removed REAL NOT NULL DEFAULT 0,
        commits REAL NOT NULL DEFAULT 0,
        pull_requests REAL NOT NULL DEFAULT 0,
        requests REAL NOT NULL DEFAULT 0,
        errors REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(day, profile_id, workspace_hash, model, query_source)
      );
      CREATE TABLE IF NOT EXISTS attribution_daily (
        day TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        query_source TEXT NOT NULL DEFAULT 'main',
        dimension TEXT NOT NULL,
        label TEXT NOT NULL,
        tokens REAL NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        requests REAL NOT NULL DEFAULT 0,
        active_seconds REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(day, profile_id, query_source, dimension, label)
      );
      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        query_source TEXT NOT NULL DEFAULT 'main',
        success INTEGER NOT NULL,
        duration_ms REAL NOT NULL DEFAULT 0,
        ttft_ms REAL,
        status_code INTEGER,
        error_category TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_profile_time
        ON api_requests(profile_id, occurred_at);
      CREATE TABLE IF NOT EXISTS tool_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms REAL NOT NULL DEFAULT 0,
        error_category TEXT
      );
      CREATE TABLE IF NOT EXISTS permission_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_health (
        profile_id TEXT PRIMARY KEY,
        last_event_at TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
    this.migrateAttributionTable();
    this.database.exec("PRAGMA user_version = 2");
  }

  private migrateAttributionTable(): void {
    const columns = this.database.prepare("PRAGMA table_info(attribution_daily)")
      .all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "query_source")) {
      return;
    }
    this.transaction(() => {
      this.database.exec(`
        ALTER TABLE attribution_daily RENAME TO attribution_daily_v1;
        CREATE TABLE attribution_daily (
          day TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          query_source TEXT NOT NULL DEFAULT 'main',
          dimension TEXT NOT NULL,
          label TEXT NOT NULL,
          tokens REAL NOT NULL DEFAULT 0,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          requests REAL NOT NULL DEFAULT 0,
          active_seconds REAL NOT NULL DEFAULT 0,
          PRIMARY KEY(day, profile_id, query_source, dimension, label)
        );
        INSERT INTO attribution_daily
          (day, profile_id, query_source, dimension, label, tokens, estimated_cost_usd, requests, active_seconds)
        SELECT
          day, profile_id, 'main', dimension, label, tokens,
          estimated_cost_usd, requests, active_seconds
        FROM attribution_daily_v1;
        DROP TABLE attribution_daily_v1;
      `);
    });
  }
}
