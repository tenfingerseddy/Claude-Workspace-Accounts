import type { DashboardRange } from "../core/models.js";

export type DashboardMessage =
  | { type: "setProfile"; profileId: string }
  | { type: "setRange"; range: DashboardRange }
  | { type: "setCustomRange"; from: string; to: string }
  | { type: "setThreadScope"; threadScope: "main" | "all" }
  | { type: "switchProfile"; profileId: string }
  | { type: "changeLock" }
  | { type: "refresh" }
  | { type: "export"; profileId?: string }
  /** Run the single fix the dashboard's collection diagnosis is offering. */
  | { type: "collectionAction" }
  /** Rebuild the panel after a failure, without re-verifying the account. */
  | { type: "retry" };

function validProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function validDateRange(from: unknown, to: unknown): from is string {
  if (typeof from !== "string"
    || typeof to !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(from)
    || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return false;
  }
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(start)
    && Number.isFinite(end)
    && new Date(start).toISOString().slice(0, 10) === from
    && new Date(end).toISOString().slice(0, 10) === to
    && start <= end
    && end - start <= 366 * 86_400_000;
}

export function parseDashboardMessage(value: unknown): DashboardMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const message = value as Record<string, unknown>;
  if (message.type === "setProfile" && validProfileId(message.profileId)) {
    return { type: "setProfile", profileId: message.profileId };
  }
  if (message.type === "setRange"
    && ["24h", "7d", "30d", "custom"].includes(String(message.range))) {
    return { type: "setRange", range: message.range as DashboardRange };
  }
  if (message.type === "setCustomRange" && validDateRange(message.from, message.to)) {
    return { type: "setCustomRange", from: message.from, to: message.to as string };
  }
  if (message.type === "setThreadScope"
    && ["main", "all"].includes(String(message.threadScope))) {
    return {
      type: "setThreadScope",
      threadScope: message.threadScope as "main" | "all"
    };
  }
  if (message.type === "switchProfile" && validProfileId(message.profileId)) {
    return { type: "switchProfile", profileId: message.profileId };
  }
  if (message.type === "changeLock") {
    return { type: "changeLock" };
  }
  if (message.type === "refresh") {
    return { type: "refresh" };
  }
  if (message.type === "collectionAction") {
    return { type: "collectionAction" };
  }
  if (message.type === "retry") {
    return { type: "retry" };
  }
  if (message.type === "export"
    && (message.profileId === undefined || validProfileId(message.profileId))) {
    return { type: "export", profileId: message.profileId };
  }
  return undefined;
}
