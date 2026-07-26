import { readFile } from "node:fs/promises";
import { parseAuthStatus } from "../src/auth/authSchema.js";
import { compareIdentity } from "../src/core/identity.js";
import { resolveLockForPath } from "../src/core/locks.js";
import type { AccountProfile, WorkspaceLock } from "../src/core/models.js";
import { normalizeWindowsPath, pathContains, safeProfileId } from "../src/core/paths.js";
import { deriveGuardStatus, selectUsage } from "../src/core/statusState.js";
import { parseDashboardMessage } from "../src/dashboard/dashboardMessages.js";
import { normalizeOtlp, normalizeStatusSnapshot } from "../src/telemetry/normalizers.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  normalizeWindowsPath("C:/Users/Dev/.claude-work/") === "c:\\users\\dev\\.claude-work",
  "Windows path normalization failed."
);
assert(pathContains("C:\\repos\\app", "C:\\repos\\app\\src"), "Path containment failed.");
assert(!pathContains("C:\\repos\\app", "C:\\repos\\application"), "Path boundary failed.");
assert(safeProfileId("Work Account", new Set(["work-account"])) === "work-account-2", "Profile ID failed.");

assert(compareIdentity(
  { email: "old@example.com", accountId: "acct-1", organizationId: "org-1" },
  { state: "signed_in", email: "new@example.com", accountId: "acct-1", organizationId: "org-1" }
) === "match", "Stable identity comparison failed.");
assert(compareIdentity(
  { email: "work@example.com", organizationId: "org-1" },
  { state: "signed_in", email: "work@example.com", organizationId: "org-2" }
) === "mismatch", "Organization drift was not detected.");

const profiles = [
  { id: "work", displayName: "Work" },
  { id: "personal", displayName: "Personal" }
] as AccountProfile[];
const locks = [
  {
    workspaceUri: "file:///c:/repos/app",
    workspacePathNormalized: "c:\\repos\\app",
    workspaceLabel: "app",
    profileId: "personal",
    mode: "enforce"
  },
  {
    workspaceUri: "file:///c:/repos/app/packages/api",
    workspacePathNormalized: "c:\\repos\\app\\packages\\api",
    workspaceLabel: "api",
    profileId: "work",
    mode: "enforce"
  }
].map((lock) => ({
  ...lock,
  createdAt: "2026-07-23T00:00:00Z",
  updatedAt: "2026-07-23T00:00:00Z"
})) as WorkspaceLock[];
assert(
  resolveLockForPath("C:\\repos\\app\\packages\\api\\src", locks, profiles).profile?.id === "work",
  "Longest workspace lock did not win."
);

const usage = selectUsage({ usedPercentage: 42 }, { usedPercentage: 86 }, 70, 90);
assert(usage?.window === "seven_day", "More severe quota window was not selected.");
const workProfile = {
  id: "work",
  displayName: "Work",
  expectedIdentity: { email: "work@example.com" }
} as AccountProfile;
const unavailableStatus = deriveGuardStatus({
  runtime: {
    configDir: "C:\\Users\\Dev\\.claude-work",
    configDirNormalized: "c:\\users\\dev\\.claude-work",
    profile: workProfile
  },
  verification: {
    state: "signed_in",
    checkedAt: "2026-07-23T00:00:00Z",
    email: "work@example.com"
  },
  warningThreshold: 70,
  criticalThreshold: 90,
  showUsage: true,
  verifying: false
});
assert(!unavailableStatus.text.includes("0%"), "Unavailable quota was fabricated as zero.");

const auth = parseAuthStatus(
  await readFile("test/fixtures/auth-status-signed-in.json", "utf8"),
  "2026-07-23T00:00:00Z"
);
assert(auth.state === "signed_in" && auth.accountId === "acct_work_123", "Auth fixture failed.");

const otel = normalizeOtlp(JSON.parse(
  await readFile("test/fixtures/otel-metrics.json", "utf8")
));
assert(otel.metrics.length === 2, "Metric normalization failed.");
assert(!JSON.stringify(otel).includes("must-not-be-retained"), "Unsafe telemetry attribute survived.");
const traces = normalizeOtlp(JSON.parse(
  await readFile("test/fixtures/otel-traces.json", "utf8")
));
assert(
  traces.events[0]?.attributes.duration_ms === 1250
    && traces.events[0]?.attributes.ttft_ms === 275,
  "Trace latency normalization failed."
);
assert(!JSON.stringify(traces).includes("must-not-be-retained"), "Unsafe trace attribute survived.");
const missingQuota = normalizeStatusSnapshot({
  schemaVersion: 1,
  profileId: "work",
  sessionId: "session",
  rateLimits: { fiveHour: { usedPercentage: null } }
});
assert(missingQuota?.rateLimits === undefined, "Missing quota became a value.");

assert(
  parseDashboardMessage({ type: "switchProfile", profileId: "../secret" }) === undefined,
  "Unsafe dashboard message was accepted."
);
assert(
  parseDashboardMessage({ type: "setProfile", profileId: "work-2" })?.type === "setProfile",
  "Valid dashboard message was rejected."
);
assert(
  parseDashboardMessage({
    type: "setCustomRange",
    from: "2026-07-01",
    to: "2026-07-23"
  })?.type === "setCustomRange",
  "Valid dashboard custom range was rejected."
);

console.log("Core policy smoke test: OK");
