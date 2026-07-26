export const REGISTRY_SCHEMA_VERSION = 1;

export type LockMode = "enforce" | "warn" | "off";

export interface ExpectedIdentity {
  email?: string;
  accountId?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface AccountProfile {
  id: string;
  displayName: string;
  marker: string;
  configDir: string;
  configDirNormalized: string;
  vsCodeUserDataDir: string;
  expectedIdentity?: ExpectedIdentity;
  authMethod?: string;
  telemetryEnabled?: boolean;
  createdAt: string;
  lastVerifiedAt?: string;
}

export interface WorkspaceLock {
  workspaceUri: string;
  workspaceKey?: string;
  workspacePathNormalized: string;
  workspaceRootPathsNormalized?: string[];
  workspaceLabel: string;
  profileId: string;
  mode: LockMode;
  createdAt: string;
  updatedAt: string;
}

export interface CollectorRegistration {
  profileId: string;
  port: number;
  token: string;
  pid: number;
  updatedAt: string;
}

export interface WrapperIntegration {
  wrapperPath?: string;
  upstreamWrapper?: string;
  configuredAt?: string;
  version?: string;
  telemetryEnabled?: boolean;
  collectWorkspacePath?: boolean;
}

export interface SharedRegistryDocument {
  schemaVersion: number;
  revision: number;
  profiles: AccountProfile[];
  workspaceLocks: WorkspaceLock[];
  collectors: Record<string, CollectorRegistration>;
  integration: WrapperIntegration;
  updatedAt: string;
}

export type AuthenticationState = "signed_in" | "signed_out" | "unavailable";

export interface AuthVerification {
  state: AuthenticationState;
  checkedAt: string;
  email?: string;
  accountId?: string;
  organizationId?: string;
  organizationName?: string;
  authMethod?: string;
  provider?: string;
  errorCategory?: "binary_missing" | "timeout" | "process_error" | "invalid_json" | "signed_out";
}

export interface RuntimeProfile {
  configDir: string;
  configDirNormalized: string;
  profile?: AccountProfile;
}

export interface RateLimitWindow {
  usedPercentage: number;
  resetsAt?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface StatusSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  profileId: string;
  sessionId: string;
  sessionName?: string;
  workspaceHash?: string;
  workspaceLabel?: string;
  workspacePath?: string;
  modelId?: string;
  modelDisplayName?: string;
  effort?: string;
  thinkingEnabled?: boolean;
  fastMode?: boolean;
  costUsd?: number;
  durationMs?: number;
  apiDurationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  contextWindow?: {
    usedPercentage?: number;
    remainingPercentage?: number;
    size?: number;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    currentUsage?: TokenUsage;
  };
  rateLimits?: {
    fiveHour?: RateLimitWindow;
    sevenDay?: RateLimitWindow;
  };
}

/**
 * Quota, as Claude reports it.
 *
 * These are the only plan-headroom figures any third party can obtain: the status-line payload
 * carries `rate_limits.five_hour` and `rate_limits.seven_day`, each with a `used_percentage` and a
 * `resets_at` in Unix epoch seconds. Verified against the schema embedded in Claude Code 2.1.220's
 * own binary. Per-model windows (`seven_day_sonnet`, `seven_day_opus`) and the `extra_usage` credit
 * pool exist, but only in the response of the private `/api/oauth/usage` endpoint the official
 * extension calls — they never reach a status line, so nothing here may pretend to know them.
 */
export type QuotaWindowKey = "five_hour" | "seven_day";

export interface QuotaWindowReading {
  window: QuotaWindowKey;
  /** "5-hour window" — for headings. */
  label: string;
  /** "5h" — for the status bar, where every character costs. */
  shortLabel: string;
  usedPercentage: number;
  /** What is left. The number the user actually acts on. */
  remainingPercentage: number;
  severity: "normal" | "warning" | "critical";
  /** Exactly as Claude reported it: Unix epoch seconds. */
  resetsAt?: number;
  resetsAtIso?: string;
  /** "in 2h 40m", or "due now". Absent when Claude reported no reset time. */
  resetsInLabel?: string;
  /**
   * The reset time has already passed, so this percentage describes a window that no longer
   * exists. Showing it as current headroom would be actively misleading.
   */
  expired: boolean;
}

/** Why a window has no figure. Absence is always explained; it is never rendered as 0%. */
export type QuotaAbsence =
  /** No status snapshot at all: no Claude session has run under this account. */
  | "no_session"
  /** A snapshot exists and carries no quota at all — normal for plans Claude does not report. */
  | "not_reported_for_account"
  /** A snapshot exists, the other window was reported, this one was not. Independently optional. */
  | "window_not_reported";

export interface QuotaAbsentWindow {
  window: QuotaWindowKey;
  label: string;
  reason: QuotaAbsence;
  /** The one sentence every surface shows for this absence. */
  detail: string;
}

export interface QuotaReport {
  /** Reported windows, five-hour first. */
  windows: QuotaWindowReading[];
  /** Windows with no figure, each carrying the reason. */
  absent: QuotaAbsentWindow[];
  /** When Claude produced the reading. A percentage without this is not interpretable. */
  capturedAt?: string;
  ageMs?: number;
  ageLabel?: string;
  freshness: "fresh" | "stale" | "none";
  /** The window that decides the status bar's severity. */
  worst?: QuotaWindowReading;
}

export interface GuardStatusInput {
  runtime: RuntimeProfile;
  verification?: AuthVerification;
  lock?: WorkspaceLock;
  requiredProfile?: AccountProfile;
  snapshot?: StatusSnapshot;
  warningThreshold: number;
  criticalThreshold: number;
  showUsage: boolean;
  verifying: boolean;
  /**
   * The collection phase, when it could be read.
   *
   * The status bar used to ignore collection health entirely, so a database that had gone locked,
   * full, read-only or corrupt after one successful write left the last quota figure on screen
   * indefinitely with nothing to say it had stopped moving.
   */
  collectionPhase?: CollectionPhase;
  /** A sanitized category from the health record — never payload content, never a path. */
  collectionDetail?: string;
}

export type GuardStatusKind =
  | "locked_valid"
  | "valid_unlocked"
  | "wrong_account"
  | "wrong_account_warning"
  | "signed_out"
  | "verifying"
  | "usage_unavailable"
  | "limit_warning"
  | "unregistered";

export interface GuardStatus {
  kind: GuardStatusKind;
  text: string;
  severity: "normal" | "warning" | "error";
  usageLabel?: string;
  usagePercentage?: number;
  usageWindow?: QuotaWindowKey;
  /** Everything known about plan headroom, so no consumer has to re-derive it. */
  quota?: QuotaReport;
  /**
   * Set when local usage storage is failing. Rendered by the status bar rather than only
   * recorded, because a frozen quota figure that looks healthy is worse than no figure.
   */
  collectionWarning?: string;
  /**
   * True when the bound account's identity can no longer be compared with the one recorded, so
   * drift detection is inactive.
   *
   * A flag rather than a state three consumers each rediscovered by testing whether the rendered
   * status text contained the word "unverified" — the same substring-matching-a-string-we-built
   * pattern that has already caused two defects in this codebase.
   */
  identityCheckInactive?: boolean;
  detail: string;
}

export interface UsageDailyRow {
  day: string;
  profileId: string;
  workspaceHash: string;
  workspaceLabel: string;
  model: string;
  querySource: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  activeSeconds: number;
  sessions: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pullRequests: number;
  requests: number;
  errors: number;
}

export interface ReliabilitySummary {
  requests: number;
  errors: number;
  medianRequestMs?: number;
  p95RequestMs?: number;
  medianTtftMs?: number;
  tools: Array<{
    name: string;
    requests: number;
    successes: number;
    medianDurationMs?: number;
  }>;
  permissionDecisions: Array<{
    source: string;
    decision: string;
    count: number;
  }>;
  authFailures: number;
  mcpFailures: number;
}

export type DashboardRange = "24h" | "7d" | "30d" | "custom";
export interface DashboardDateBounds {
  from: string;
  to: string;
}
export type AttributionDimension =
  | "model"
  | "workspace"
  | "query_source"
  | "skill"
  | "plugin"
  | "agent"
  | "mcp_tool";

export interface AttributionRow {
  label: string;
  dimension: AttributionDimension;
  tokens: number;
  cost: number;
  requests: number;
  activeSeconds: number;
}

export interface DashboardData {
  generatedAt: string;
  timezone: string;
  selectedProfileId?: string;
  runtimeProfileId?: string;
  range: DashboardRange;
  customRange: DashboardDateBounds;
  threadScope: "main" | "all";
  thresholds: {
    usageWarning: number;
    usageCritical: number;
    contextWarning: number;
  };
  profiles: Array<{
    id: string;
    displayName: string;
    marker: string;
    email?: string;
    organization?: string;
    authMethod?: string;
    lastVerifiedAt?: string;
  }>;
  lock?: {
    mode: LockMode;
    profileId: string;
    profileName?: string;
    requiredEmail?: string;
    requiredOrganization?: string;
    runtimeProfileName?: string;
    runtimeEmail?: string;
    runtimeOrganization?: string;
    workspaceLabel: string;
    compatible: boolean;
  };
  current?: StatusSnapshot;
  daily: UsageDailyRow[];
  attribution: AttributionRow[];
  reliability: ReliabilitySummary;
  collection: {
    status: "active" | "inactive" | "awaiting_data";
    lastEventAt?: string;
    source: string;
  };
}

/**
 * Collection health.
 *
 * The dashboard used to infer everything from `collector_health`, which is only written after a
 * batch has already been stored — so a bind failure, a stale registration, a rejected content type
 * and a genuinely idle account all rendered identically as "unavailable". These types describe the
 * persisted state that distinguishes them. Every failure mode the pipeline has must map to exactly
 * one `CollectionPhase` plus a counter that names the cause.
 */
export type CollectionPhase =
  /** The active CLAUDE_CONFIG_DIR is not one of the registered profiles. Nothing can be collected. */
  | "no_runtime_profile"
  /** Collection is switched off, globally or for this profile. */
  | "telemetry_disabled"
  /** No collector has ever run for this profile, or the last one shut down cleanly. */
  | "collector_stopped"
  /** The collector could not bind a loopback port. `collector.bindError` says why. */
  | "port_bind_failed"
  /** The registration is older than the window the wrapper accepts, so injection has stopped. */
  | "registration_stale"
  /** The collector is listening but turning requests away. `requests.rejections` says why. */
  | "rejecting"
  /** Batches are arriving and being acknowledged, but normalise to nothing storable. */
  | "accepted_empty"
  /**
   * The most recent storage event was a failure: the database is locked, full, read-only, corrupt
   * or otherwise refusing writes, and nothing has been written since.
   *
   * This has to outrank `collecting`, because it did not: one successful write early on left
   * `lastSuccessfulWriteAt` set forever, so a database that went bad afterwards reported
   * "collecting" on every surface while every OTLP request failed. It clears itself the moment a
   * write succeeds again, which is why it compares the two timestamps rather than a wall clock.
   */
  | "storage_failed"
  /** Everything is configured and nothing has failed; no data has arrived yet. */
  | "awaiting_data"
  /** Data has been stored. */
  | "collecting";

/** Why a request was turned away. Never includes payload content. */
export type CollectionRejectionReason =
  | "loopback_required"
  | "unauthorized"
  | "not_found"
  | "traces_not_collected"
  | "unsupported_content_type"
  | "protobuf_unsupported"
  | "unsupported_content_encoding"
  | "decompression_failed"
  | "decompressed_too_large"
  | "payload_too_large"
  | "request_aborted"
  | "malformed_json"
  | "unsupported_envelope"
  | "normalization_failed"
  | "storage_transient"
  | "storage_permanent";

/** Why an inbox file was moved aside instead of stored. The file is kept, never deleted. */
export type CollectionQuarantineReason =
  | "read_failed"
  | "malformed_json"
  | "unsupported_schema"
  | "unknown_profile"
  | "storage_failure";

/**
 * A fallback that kept the pipeline running but lost fidelity. These are acceptable only because
 * they are counted here: a fallback nobody can see is indistinguishable from correct behaviour.
 */
export type CollectionDegradationReason =
  | "metric_timestamp_fallback"
  | "event_timestamp_fallback"
  | "span_duration_unusable"
  | "signal_envelope_mismatch"
  | "dropped_metric_point"
  | "dropped_log_record"
  | "dropped_span"
  | "snapshot_payload_corrupt"
  | "database_size_unavailable"
  | "database_open_retried"
  | "journal_mode_unavailable"
  | "inbox_scan_failed"
  | "inbox_claim_failed"
  | "inbox_cleanup_failed"
  | "quarantine_failed"
  | "heartbeat_failed"
  | "registry_lock_contended"
  | "registry_lock_stolen"
  | "registry_write_conflict"
  | "registry_write_retried"
  | "registry_write_failed"
  | "status_line_backup_missing"
  | "status_line_backup_invalid";

export interface CollectionCounter {
  reason: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** A sanitized category or file name. Never payload content, never a user path. */
  lastDetail?: string;
}

/**
 * The two facts only the extension host knows: the VS Code setting and whether the running
 * config directory is registered. Everything else in `CollectionHealth` is persisted.
 */
export interface CollectionHealthContext {
  telemetryEnabled?: boolean;
  runtimeProfileRegistered?: boolean;
}

export interface CollectionHealth {
  schemaVersion: 1;
  readAt: string;
  profileId?: string;
  phase: CollectionPhase;
  collector: {
    listening: boolean;
    port?: number;
    startedAt?: string;
    stoppedAt?: string;
    /** Present when `start` failed to bind. Sanitized to an errno-style code plus message. */
    bindError?: string;
    /** When the shared registry entry the wrapper reads was last refreshed. */
    registrationUpdatedAt?: string;
    registrationAgeMs?: number;
    /** True once the age exceeds the window the wrapper requires before it will inject OTEL. */
    registrationStale: boolean;
    registrationStaleAfterMs: number;
    heartbeatFailures: number;
    heartbeatFailingSince?: string;
    heartbeatError?: string;
  };
  requests: {
    total: number;
    /** Understood and stored. */
    stored: number;
    /** Acknowledged, but nothing in the batch was storable. */
    acceptedEmpty: number;
    rejected: number;
    lastStoredAt?: string;
    lastAcceptedEmptyAt?: string;
    lastRejectedAt?: string;
    rejections: CollectionCounter[];
  };
  inbox: {
    processed: number;
    quarantined: number;
    lastProcessedAt?: string;
    lastQuarantinedAt?: string;
    quarantineDirectory?: string;
    quarantines: CollectionCounter[];
  };
  storage: {
    lastSuccessfulWriteAt?: string;
    lastSuccessfulWriteSource?: string;
    lastFailureAt?: string;
    lastFailureCategory?: string;
    /** Absent, not zero, when the file could not be stat'd. */
    databaseSizeBytes?: number;
    databaseSizeError?: string;
  };
  degradations: CollectionCounter[];
}

/** What the collector reports about itself. Every field is optional so partial updates are cheap. */
export interface CollectorLifecycleUpdate {
  profileId: string;
  listening?: boolean;
  port?: number;
  startedAt?: string;
  stoppedAt?: string;
  bindError?: string;
  registrationUpdatedAt?: string;
  heartbeatError?: string;
  /** True to zero the heartbeat failure streak, false to extend it. */
  heartbeatHealthy?: boolean;
  quarantineDirectory?: string;
}

export function createEmptyRegistry(now = new Date().toISOString()): SharedRegistryDocument {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    revision: 0,
    profiles: [],
    workspaceLocks: [],
    collectors: {},
    integration: {},
    updatedAt: now
  };
}
