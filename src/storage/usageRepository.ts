import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  AttributionDimension,
  AttributionRow,
  AuthVerification,
  CollectionCounter,
  CollectionDegradationReason,
  CollectionHealth,
  CollectionHealthContext,
  CollectionPhase,
  CollectionQuarantineReason,
  CollectionRejectionReason,
  CollectorLifecycleUpdate,
  DashboardDateBounds,
  DashboardRange,
  ReliabilitySummary,
  SharedRegistryDocument,
  StatusSnapshot,
  UsageDailyRow
} from "../core/models.js";
import { workspaceHash } from "../core/paths.js";
import type { NormalizedEvent, NormalizedMetric } from "../telemetry/normalizers.js";
import { canonicalBoolean, localDay, normalizeEventName } from "../telemetry/normalizers.js";

/**
 * The wrapper refuses to inject OTEL when the collector registration is older than this, so a
 * silently failing heartbeat stops telemetry permanently. Collection health reports the age against
 * this window rather than making the dashboard rediscover the wrapper's rule.
 */
export const REGISTRATION_STALE_AFTER_MS = 60_000;

export type StorageFailureCategory =
  | "busy"
  | "locked"
  | "io"
  | "disk_full"
  | "readonly"
  | "corrupt"
  | "constraint"
  | "schema"
  | "unknown";

/**
 * A storage failure, distinguished from bad client data.
 *
 * Every ingest error used to surface as HTTP 400, which Claude's exporter treats as non-retryable —
 * so a five-second SQLite busy timeout permanently destroyed a batch of real usage. `transient` is
 * what decides whether the collector answers 503 (try again) or 500 (this will not get better).
 */
export class StorageWriteError extends Error {
  public constructor(
    public readonly category: StorageFailureCategory,
    public readonly transient: boolean,
    cause: unknown
  ) {
    super(`storage_${category}`);
    this.name = "StorageWriteError";
    this.cause = cause;
  }
}

const TRANSIENT_CATEGORIES = new Set<StorageFailureCategory>([
  "busy",
  "locked",
  "io",
  "disk_full",
  // An unrecognised failure is treated as transient on purpose: retrying costs a duplicate export
  // attempt, whereas guessing "permanent" throws away usage we can never recover.
  "unknown"
]);

/**
 * Map a node:sqlite failure onto a category. node:sqlite surfaces the SQLite result code as
 * `errcode` and the message as `errstr`, but neither is guaranteed, so the message is a fallback.
 */
export function classifyStorageFailure(error: unknown): StorageFailureCategory {
  const candidate = error as { errcode?: unknown; errstr?: unknown; message?: unknown };
  const code = typeof candidate?.errcode === "number" ? candidate.errcode & 0xff : undefined;
  switch (code) {
    case 5: return "busy";
    case 6: return "locked";
    case 8: return "readonly";
    case 10: return "io";
    case 11: return "corrupt";
    case 13: return "disk_full";
    case 14: return "io";
    case 15: return "io";
    case 17: return "schema";
    case 19: return "constraint";
    case 26: return "corrupt";
    default: break;
  }
  const message = `${typeof candidate?.errstr === "string" ? candidate.errstr : ""} ${
    typeof candidate?.message === "string" ? candidate.message : ""
  }`.toLocaleLowerCase();
  if (message.includes("database is locked")) {
    return "locked";
  }
  if (message.includes("busy")) {
    return "busy";
  }
  if (message.includes("readonly") || message.includes("read-only")) {
    return "readonly";
  }
  if (message.includes("disk i/o") || message.includes("unable to open")) {
    return "io";
  }
  if (message.includes("disk is full")) {
    return "disk_full";
  }
  if (message.includes("malformed") || message.includes("not a database")) {
    return "corrupt";
  }
  if (message.includes("constraint")) {
    return "constraint";
  }
  if (message.includes("no such table") || message.includes("no such column")) {
    return "schema";
  }
  return "unknown";
}

function asStorageWriteError(error: unknown): StorageWriteError {
  if (error instanceof StorageWriteError) {
    return error;
  }
  const category = classifyStorageFailure(error);
  return new StorageWriteError(category, TRANSIENT_CATEGORIES.has(category), error);
}

/**
 * A real synchronous pause. The repository is constructed synchronously before any telemetry service
 * exists, so there is nowhere to await; without this, contention with another extension host's
 * writer throws straight out of `activate`.
 */
function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

const SCHEMA_VERSION = 3;
const OPEN_RETRY_DELAYS_MS = [40, 90, 180, 360, 720];

/** Interpret a boolean-like attribute, defaulting to `fallback` when the attribute is absent. */
function flag(value: unknown, fallback: boolean): boolean {
  return canonicalBoolean(value) ?? fallback;
}

/**
 * Reduce the persisted facts to one phase, most-blocking first. The order is the diagnosis order: a
 * collector that cannot bind is not "awaiting data", and a stale registration outranks a rejection
 * because the wrapper has already stopped sending.
 */
type RequestOutcome = "stored" | "rejected" | "accepted_empty";

function derivePhase(input: {
  context: CollectionHealthContext;
  collector: CollectionHealth["collector"];
  lastOutcome?: RequestOutcome;
  storage: CollectionHealth["storage"];
}): CollectionPhase {
  if (input.context.runtimeProfileRegistered === false) {
    return "no_runtime_profile";
  }
  if (input.context.telemetryEnabled === false) {
    return "telemetry_disabled";
  }
  if (input.collector.bindError && !input.collector.listening) {
    return "port_bind_failed";
  }
  if (!input.collector.listening) {
    return "collector_stopped";
  }
  if (input.collector.registrationStale || input.collector.heartbeatFailures > 0) {
    return "registration_stale";
  }
  // Only the *most recent* request outcome is a diagnosis: a 401 during startup that was followed by
  // successful stores is history. This reads a recorded outcome rather than comparing timestamps,
  // because two outcomes in the same millisecond would otherwise order arbitrarily.
  if (input.lastOutcome === "rejected") {
    return "rejecting";
  }
  if (input.lastOutcome === "accepted_empty") {
    return "accepted_empty";
  }
  if (input.storage.lastSuccessfulWriteAt) {
    return "collecting";
  }
  return "awaiting_data";
}

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
  /** Deferred because the counters table does not exist until `migrate` has run. */
  private readonly startupDegradations: Array<[CollectionDegradationReason, string]> = [];
  /** Survives a database that is too locked to record its own unavailability. */
  private lastStorageFailure?: { at: string; category: StorageFailureCategory };
  private readonly busyTimeoutMs: number;

  public constructor(
    public readonly databasePath: string,
    options: { busyTimeoutMs?: number } = {}
  ) {
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = this.open();
    this.applyPragmas();
    this.migrateWithRetry();
    for (const [reason, detail] of this.startupDegradations.splice(0)) {
      this.recordDegradation(undefined, reason, detail);
    }
  }

  /**
   * Opening can fail transiently while another extension host holds the file. Retry with backoff
   * rather than letting the throw escape into `activate`.
   */
  private open(): DatabaseSync {
    let lastError: unknown;
    for (let attempt = 0; attempt <= OPEN_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const database = new DatabaseSync(this.databasePath, { timeout: this.busyTimeoutMs });
        if (attempt > 0) {
          this.startupDegradations.push(["database_open_retried", `open_attempts=${attempt + 1}`]);
        }
        return database;
      } catch (error) {
        lastError = error;
        const category = classifyStorageFailure(error);
        if (!TRANSIENT_CATEGORIES.has(category) || attempt === OPEN_RETRY_DELAYS_MS.length) {
          break;
        }
        sleepSync(OPEN_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
    throw asStorageWriteError(lastError);
  }

  private applyPragmas(): void {
    // busy_timeout first: it is what makes the remaining pragmas and the migration wait rather than
    // fail the moment another window is mid-write.
    this.database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    this.database.exec("PRAGMA synchronous = NORMAL");
    // Switching to WAL needs a brief exclusive moment. If another host is writing we may not get it,
    // but WAL is a persistent property of the file — whoever set it first set it for everyone — so a
    // failure here is a note, never a fatal error.
    for (let attempt = 0; attempt <= OPEN_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        this.database.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (error) {
        if (attempt === OPEN_RETRY_DELAYS_MS.length) {
          this.startupDegradations.push([
            "journal_mode_unavailable",
            classifyStorageFailure(error)
          ]);
          return;
        }
        sleepSync(OPEN_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
  }

  /**
   * Skip the migration entirely when the schema is already current — that removes the common
   * contention case, because the second and later windows never need to write at all. When a
   * migration really is required, retry it; only give up if the schema stays unusable.
   */
  private migrateWithRetry(): void {
    if (this.schemaIsCurrent()) {
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= OPEN_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        this.migrate();
        if (attempt > 0) {
          this.startupDegradations.push([
            "database_open_retried",
            `migrate_attempts=${attempt + 1}`
          ]);
        }
        return;
      } catch (error) {
        lastError = error;
        // Another host may have completed the same idempotent migration while we waited.
        if (this.schemaIsCurrent()) {
          return;
        }
        if (attempt === OPEN_RETRY_DELAYS_MS.length) {
          break;
        }
        sleepSync(OPEN_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
    throw asStorageWriteError(lastError);
  }

  private schemaIsCurrent(): boolean {
    try {
      const version = this.database.prepare("PRAGMA user_version").get() as
        { user_version?: number } | undefined;
      if (version?.user_version !== SCHEMA_VERSION) {
        return false;
      }
      // user_version alone is not proof: a half-applied migration could have set it. Confirm the
      // youngest tables exist before trusting it.
      const present = this.database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN ('usage_daily', 'collection_state', 'collection_counters')
      `).get() as { count: number } | undefined;
      return present?.count === 3;
    } catch {
      return false;
    }
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

  /**
   * One transaction. These were three autocommit writes, so a failure between them left a snapshot
   * row with no session and no health update — and the caller deleted the inbox file regardless.
   */
  public recordStatusSnapshot(snapshot: StatusSnapshot): void {
    this.write(() => {
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
      this.touchCollector(snapshot.profileId, snapshot.capturedAt, "status_snapshot");
    }, snapshot.profileId);
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
    } catch (error) {
      // A stored row we cannot parse is a defect, not an absence of data. Returning undefined is
      // still the right behaviour for callers, but it must not be indistinguishable from "no
      // snapshot yet" in the health state.
      this.recordDegradation(profileId, "snapshot_payload_corrupt", classifyStorageFailure(error));
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
      const success = flag(event.attributes.success, true);
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
      // When `success` is absent entirely, a categorical error is the only evidence available, and
      // it is better evidence than an optimistic default.
      const succeeded = canonicalBoolean(event.attributes.success)
        ?? !text(event.attributes.error_category);
      this.database.prepare(`
        INSERT INTO tool_results
          (profile_id, occurred_at, tool_name, success, duration_ms, error_category)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        profileId,
        event.timestamp,
        text(event.attributes.tool_name, "unknown"),
        succeeded ? 1 : 0,
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
        text(event.attributes.source, text(event.attributes.tool_source, "unknown"))
      );
    } else if (name === "auth" && flag(event.attributes.success, true) === false) {
      this.database.prepare(`
        INSERT INTO security_events (profile_id, occurred_at, category, detail)
        VALUES (?, ?, 'auth_failure', ?)
      `).run(profileId, event.timestamp, text(event.attributes.error_category, "unknown"));
    } else if (name === "mcp_server_connection"
      && !["connected", "success"].includes(text(event.attributes.status).toLocaleLowerCase())) {
      this.database.prepare(`
        INSERT INTO security_events (profile_id, occurred_at, category, detail)
        VALUES (?, ?, 'mcp_failure', ?)
      `).run(
        profileId,
        event.timestamp,
        text(
          event.attributes["mcp_server.name"],
          text(event.attributes.server_name, "unknown")
        )
      );
    }
    this.touchCollector(profileId, event.timestamp, "event");
  }

  public ingestBatch(
    profileId: string,
    metrics: readonly NormalizedMetric[],
    events: readonly NormalizedEvent[]
  ): void {
    this.write(() => {
      for (const metric of metrics) {
        this.ingestMetric(profileId, metric);
      }
      for (const event of events) {
        this.ingestEvent(profileId, event);
      }
    }, profileId);
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

  // ---------------------------------------------------------------------------
  // Collection health
  //
  // `collector_health` is only written after a batch has already been stored, so it can only ever
  // say "data arrived" or nothing at all. Everything below records the states in between, so that a
  // bind failure, a stale registration, a rejected content type, a quarantined snapshot and a
  // genuinely idle account stop rendering identically.
  // ---------------------------------------------------------------------------

  /** Record what the collector is doing. Never throws: diagnostics must not break the pipeline. */
  public recordCollectorLifecycle(update: CollectorLifecycleUpdate): void {
    this.safely(() => {
      const now = new Date().toISOString();
      this.ensureCollectionState(update.profileId);
      const heartbeatFailed = update.heartbeatHealthy === false;
      this.database.prepare(`
        UPDATE collection_state SET
          updated_at = @now,
          listening = COALESCE(@listening, listening),
          port = COALESCE(@port, port),
          started_at = COALESCE(@startedAt, started_at),
          stopped_at = COALESCE(@stoppedAt, stopped_at),
          bind_error = CASE WHEN @clearBindError = 1 THEN NULL
            ELSE COALESCE(@bindError, bind_error) END,
          registration_updated_at =
            COALESCE(@registrationUpdatedAt, registration_updated_at),
          quarantine_directory = COALESCE(@quarantineDirectory, quarantine_directory),
          heartbeat_failures = CASE
            WHEN @heartbeatHealthy = 1 THEN 0
            WHEN @heartbeatFailed = 1 THEN heartbeat_failures + 1
            ELSE heartbeat_failures END,
          heartbeat_failing_since = CASE
            WHEN @heartbeatHealthy = 1 THEN NULL
            WHEN @heartbeatFailed = 1 THEN COALESCE(heartbeat_failing_since, @now)
            ELSE heartbeat_failing_since END,
          heartbeat_error = CASE
            WHEN @heartbeatHealthy = 1 THEN NULL
            WHEN @heartbeatFailed = 1 THEN COALESCE(@heartbeatError, heartbeat_error)
            ELSE heartbeat_error END
        WHERE profile_id = @profileId
      `).run({
        profileId: update.profileId,
        now,
        listening: update.listening === undefined ? null : update.listening ? 1 : 0,
        port: update.port ?? null,
        startedAt: update.startedAt ?? null,
        stoppedAt: update.stoppedAt ?? null,
        bindError: update.bindError ?? null,
        // A successful bind must erase the previous failure, otherwise the dashboard keeps blaming a
        // port conflict that has already been resolved by a reload.
        clearBindError: update.listening === true && update.bindError === undefined ? 1 : 0,
        registrationUpdatedAt: update.registrationUpdatedAt ?? null,
        quarantineDirectory: update.quarantineDirectory ?? null,
        heartbeatHealthy: update.heartbeatHealthy === true ? 1 : 0,
        heartbeatFailed: heartbeatFailed ? 1 : 0,
        heartbeatError: update.heartbeatError ?? null
      });
    });
  }

  /** A request the collector turned away, with the reason but never the payload. */
  public recordRequestRejected(
    profileId: string | undefined,
    reason: CollectionRejectionReason,
    detail?: string
  ): void {
    this.safely(() => {
      const now = new Date().toISOString();
      this.ensureCollectionState(profileId);
      this.database.prepare(`
        UPDATE collection_state
        SET updated_at = ?, requests_total = requests_total + 1,
            requests_rejected = requests_rejected + 1, last_rejected_at = ?,
            last_outcome = 'rejected'
        WHERE profile_id = ?
      `).run(now, now, this.stateKey(profileId));
      this.bumpCounter(profileId, "rejection", reason, detail);
    });
  }

  /**
   * A batch that parsed and was acknowledged but yielded nothing storable. Answering 200 for this
   * is correct at the protocol level and dishonest at the product level unless it is counted.
   */
  public recordBatchAcceptedEmpty(profileId: string, detail?: string): void {
    this.safely(() => {
      const now = new Date().toISOString();
      this.ensureCollectionState(profileId);
      this.database.prepare(`
        UPDATE collection_state
        SET updated_at = ?, requests_total = requests_total + 1,
            requests_accepted_empty = requests_accepted_empty + 1, last_accepted_empty_at = ?,
            last_outcome = 'accepted_empty'
        WHERE profile_id = ?
      `).run(now, now, profileId);
      if (detail) {
        this.bumpCounter(profileId, "empty", detail, undefined);
      }
    });
  }

  /** A batch that was understood and committed. */
  public recordRequestStored(profileId: string): void {
    this.safely(() => {
      const now = new Date().toISOString();
      this.ensureCollectionState(profileId);
      this.database.prepare(`
        UPDATE collection_state
        SET updated_at = ?, requests_total = requests_total + 1,
            requests_stored = requests_stored + 1, last_stored_at = ?,
            last_outcome = 'stored'
        WHERE profile_id = ?
      `).run(now, now, profileId);
    });
  }

  public recordStorageFailure(
    profileId: string | undefined,
    category: StorageFailureCategory
  ): void {
    const now = new Date().toISOString();
    // In memory first, and unconditionally. The failure we most need to report is the database being
    // unavailable — and in exactly that case the database cannot accept the record of it.
    this.lastStorageFailure = { at: now, category };
    if (category === "busy" || category === "locked") {
      // Writing would block on the same lock that just failed, for the full busy timeout again.
      return;
    }
    this.safely(() => {
      this.ensureCollectionState(profileId);
      this.database.prepare(`
        UPDATE collection_state
        SET updated_at = ?, last_failure_at = ?, last_failure_category = ?
        WHERE profile_id = ?
      `).run(now, now, category, this.stateKey(profileId));
    });
  }

  public recordInboxProcessed(profileId: string): void {
    this.safely(() => {
      const now = new Date().toISOString();
      this.ensureCollectionState(profileId);
      this.database.prepare(`
        UPDATE collection_state
        SET updated_at = ?, inbox_processed = inbox_processed + 1, last_inbox_processed_at = ?
        WHERE profile_id = ?
      `).run(now, now, profileId);
    });
  }

  public recordInboxQuarantined(
    profileId: string | undefined,
    reason: CollectionQuarantineReason,
    detail?: string
  ): void {
    this.safely(() => {
      const now = new Date().toISOString();
      this.ensureCollectionState(profileId);
      this.database.prepare(`
        UPDATE collection_state
        SET updated_at = ?, inbox_quarantined = inbox_quarantined + 1, last_quarantined_at = ?
        WHERE profile_id = ?
      `).run(now, now, this.stateKey(profileId));
      this.bumpCounter(profileId, "quarantine", reason, detail);
    });
  }

  public recordDegradation(
    profileId: string | undefined,
    reason: CollectionDegradationReason,
    detail?: string
  ): void {
    this.safely(() => {
      this.ensureCollectionState(profileId);
      this.bumpCounter(profileId, "degradation", reason, detail);
    });
  }

  /** Bulk-apply the fidelity losses a normalization pass reported. */
  public recordDegradations(
    profileId: string | undefined,
    degradations: Partial<Record<CollectionDegradationReason, number>>
  ): void {
    this.safely(() => {
      this.ensureCollectionState(profileId);
      for (const [reason, count] of Object.entries(degradations)) {
        if (typeof count === "number" && count > 0) {
          this.bumpCounter(
            profileId,
            "degradation",
            reason as CollectionDegradationReason,
            undefined,
            count
          );
        }
      }
    });
  }

  /**
   * The single read the dashboard, diagnostics view and status bar should use.
   *
   * `context` carries the only two facts that are not persisted, because only the extension host
   * knows them: the VS Code setting and whether the running config directory is a registered
   * profile. Omit it and those phases simply are not reported.
   */
  public collectionHealth(
    profileId: string | undefined,
    context: CollectionHealthContext = {}
  ): CollectionHealth {
    const readAt = new Date().toISOString();
    const key = this.stateKey(profileId);
    const row = this.safely(() => this.database.prepare(`
      SELECT * FROM collection_state WHERE profile_id = ?
    `).get(key) as Record<string, unknown> | undefined) ?? undefined;
    const counters = this.safely(() => this.database.prepare(`
      SELECT kind, reason, count, first_at AS firstAt, last_at AS lastAt,
             last_detail AS lastDetail
      FROM collection_counters WHERE profile_id = ?
      ORDER BY count DESC, reason ASC
    `).all(key) as unknown as Array<CollectionCounter & { kind: string }>) ?? [];
    const byKind = (kind: string): CollectionCounter[] => counters
      .filter((counter) => counter.kind === kind)
      .map(({ reason, count, firstAt, lastAt, lastDetail }) => ({
        reason,
        count,
        firstAt,
        lastAt,
        lastDetail: lastDetail ?? undefined
      }));

    const optionalText = (field: string): string | undefined => {
      const value = row?.[field];
      return typeof value === "string" && value ? value : undefined;
    };
    const count = (field: string): number => {
      const value = row?.[field];
      return typeof value === "number" ? value : 0;
    };

    const registrationUpdatedAt = optionalText("registration_updated_at");
    const registrationParsed = registrationUpdatedAt
      ? Date.parse(registrationUpdatedAt)
      : Number.NaN;
    const registrationAgeMs = Number.isNaN(registrationParsed)
      ? undefined
      : Math.max(0, Date.parse(readAt) - registrationParsed);
    const listening = row?.listening === 1;
    const bindError = optionalText("bind_error");
    const size = this.databaseSizeResult();

    const collector: CollectionHealth["collector"] = {
      listening,
      port: typeof row?.port === "number" ? row.port : undefined,
      startedAt: optionalText("started_at"),
      stoppedAt: optionalText("stopped_at"),
      bindError,
      registrationUpdatedAt,
      registrationAgeMs,
      registrationStale: listening
        && registrationAgeMs !== undefined
        && registrationAgeMs > REGISTRATION_STALE_AFTER_MS,
      registrationStaleAfterMs: REGISTRATION_STALE_AFTER_MS,
      heartbeatFailures: count("heartbeat_failures"),
      heartbeatFailingSince: optionalText("heartbeat_failing_since"),
      heartbeatError: optionalText("heartbeat_error")
    };
    const requests: CollectionHealth["requests"] = {
      total: count("requests_total"),
      stored: count("requests_stored"),
      acceptedEmpty: count("requests_accepted_empty"),
      rejected: count("requests_rejected"),
      lastStoredAt: optionalText("last_stored_at"),
      lastAcceptedEmptyAt: optionalText("last_accepted_empty_at"),
      lastRejectedAt: optionalText("last_rejected_at"),
      rejections: byKind("rejection")
    };
    const inbox: CollectionHealth["inbox"] = {
      processed: count("inbox_processed"),
      quarantined: count("inbox_quarantined"),
      lastProcessedAt: optionalText("last_inbox_processed_at"),
      lastQuarantinedAt: optionalText("last_quarantined_at"),
      quarantineDirectory: optionalText("quarantine_directory"),
      quarantines: byKind("quarantine")
    };
    // Every read here goes through `safely`: this method is the one thing the dashboard, the
    // diagnostics view and the status bar all call to find out what is wrong, so it must never be
    // the thing that throws — including when what is wrong is the database itself.
    const lastWrite = profileId
      ? this.safely(() => this.database.prepare(
        "SELECT last_event_at AS lastEventAt, detail FROM collector_health WHERE profile_id = ?"
      ).get(profileId) as { lastEventAt?: string; detail?: string } | undefined)
      : undefined;
    const storage: CollectionHealth["storage"] = {
      lastSuccessfulWriteAt: lastWrite?.lastEventAt,
      lastSuccessfulWriteSource: lastWrite?.detail,
      lastFailureAt: optionalText("last_failure_at"),
      lastFailureCategory: optionalText("last_failure_category"),
      databaseSizeBytes: size.bytes,
      databaseSizeError: size.error
    };
    // Prefer whichever record is newer. The in-memory copy is the only one that exists when the
    // failure was the database refusing writes in the first place.
    if (this.lastStorageFailure
      && (!storage.lastFailureAt || this.lastStorageFailure.at > storage.lastFailureAt)) {
      storage.lastFailureAt = this.lastStorageFailure.at;
      storage.lastFailureCategory = this.lastStorageFailure.category;
    }

    const recordedOutcome = optionalText("last_outcome");
    return {
      schemaVersion: 1,
      readAt,
      profileId,
      phase: derivePhase({
        context,
        collector,
        lastOutcome: recordedOutcome === "stored"
          || recordedOutcome === "rejected"
          || recordedOutcome === "accepted_empty"
          ? recordedOutcome
          : undefined,
        storage
      }),
      collector,
      requests,
      inbox,
      storage,
      degradations: byKind("degradation")
    };
  }

  private stateKey(profileId: string | undefined): string {
    // Failures that happen before a profile is known still have to be recorded somewhere.
    return profileId ?? "";
  }

  private ensureCollectionState(profileId: string | undefined): void {
    this.database.prepare(`
      INSERT INTO collection_state (profile_id, updated_at) VALUES (?, ?)
      ON CONFLICT(profile_id) DO NOTHING
    `).run(this.stateKey(profileId), new Date().toISOString());
  }

  private bumpCounter(
    profileId: string | undefined,
    kind: string,
    reason: string,
    detail: string | undefined,
    increment = 1
  ): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO collection_counters
        (profile_id, kind, reason, count, first_at, last_at, last_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, kind, reason) DO UPDATE SET
        count = count + excluded.count,
        last_at = excluded.last_at,
        last_detail = COALESCE(excluded.last_detail, last_detail)
    `).run(
      this.stateKey(profileId),
      kind,
      reason.slice(0, 100),
      increment,
      now,
      now,
      detail ? detail.slice(0, 200) : null
    );
  }

  /**
   * Health bookkeeping must never be the reason a write fails or a read throws. A lost counter is a
   * far smaller problem than an ingest path that dies while recording that it died.
   */
  private safely<T>(work: () => T): T | undefined {
    try {
      return work();
    } catch {
      return undefined;
    }
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
        "collector_health",
        // Health counters are the user's local data too. A live collector re-asserts its state on
        // the next heartbeat, so clearing these costs at most one heartbeat interval of detail.
        "collection_state",
        "collection_counters"
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

  /**
   * Kept returning a plain number for existing callers, but a failed stat no longer masquerades as a
   * genuinely empty database — the failure is counted and `collectionHealth().storage` reports the
   * size as absent rather than zero. Prefer `collectionHealth()` for anything user-facing.
   */
  public databaseSize(): number {
    return this.databaseSizeResult().bytes ?? 0;
  }

  private databaseSizeResult(): { bytes?: number; error?: string } {
    try {
      return { bytes: statSync(this.databasePath).size };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      this.recordDegradation(undefined, "database_size_unavailable", code);
      return { error: code };
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
    // Current Anthropic metrics carry the dotted `mcp_server.name` / `mcp_tool.name`. `server_name`
    // only appears on mcp_server_connection events and only when tool details are enabled, which
    // Account Guard forces off — so reading it alone left MCP attribution permanently empty.
    const server = text(attributes["mcp_server.name"], text(attributes.server_name));
    const tool = text(attributes["mcp_tool.name"], text(attributes.tool_name));
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
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // A failed rollback (the transaction was already aborted by SQLite) must not replace the
        // original cause, which is what the caller needs to classify the failure.
      }
      throw error;
    }
  }

  /**
   * A transaction whose failures arrive as a classified `StorageWriteError`. Callers on the HTTP path
   * need to know whether to answer "try again" or "this is broken"; they must never be left guessing
   * and defaulting to "your data was invalid".
   */
  private write(work: () => void, profileId?: string): void {
    try {
      this.transaction(work);
    } catch (error) {
      const failure = asStorageWriteError(error);
      this.recordStorageFailure(profileId, failure.category);
      throw failure;
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
      CREATE TABLE IF NOT EXISTS collection_state (
        profile_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        listening INTEGER NOT NULL DEFAULT 0,
        port INTEGER,
        started_at TEXT,
        stopped_at TEXT,
        bind_error TEXT,
        registration_updated_at TEXT,
        quarantine_directory TEXT,
        heartbeat_failures INTEGER NOT NULL DEFAULT 0,
        heartbeat_failing_since TEXT,
        heartbeat_error TEXT,
        requests_total INTEGER NOT NULL DEFAULT 0,
        requests_stored INTEGER NOT NULL DEFAULT 0,
        requests_accepted_empty INTEGER NOT NULL DEFAULT 0,
        requests_rejected INTEGER NOT NULL DEFAULT 0,
        last_stored_at TEXT,
        last_accepted_empty_at TEXT,
        last_rejected_at TEXT,
        inbox_processed INTEGER NOT NULL DEFAULT 0,
        inbox_quarantined INTEGER NOT NULL DEFAULT 0,
        last_inbox_processed_at TEXT,
        last_quarantined_at TEXT,
        last_failure_at TEXT,
        last_failure_category TEXT,
        last_outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS collection_counters (
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        last_detail TEXT,
        PRIMARY KEY(profile_id, kind, reason)
      );
    `);
    this.migrateAttributionTable();
    this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
