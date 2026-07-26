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
  usageWindow?: "five_hour" | "seven_day";
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
