import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CollectionDegradationReason } from "../core/models.js";
import type {
  AccountProfile,
  CollectorRegistration,
  SharedRegistryDocument,
  WorkspaceLock,
  WrapperIntegration
} from "../core/models.js";
import { createEmptyRegistry, REGISTRY_SCHEMA_VERSION } from "../core/models.js";
import { normalizeWindowsPath, pathContains } from "../core/paths.js";

export interface SupportPaths {
  root: string;
  registry: string;
  database: string;
  wrapperDirectory: string;
  snapshotInbox: string;
  handoffs: string;
}

export interface SupportPathOptions {
  /** Only consulted when %LOCALAPPDATA% is unavailable, which on Windows is essentially never. */
  fallbackRoot: string;
  /**
   * An explicit support root, overriding %LOCALAPPDATA%.
   *
   * Anything that must not touch a real installation has to pass this. The earlier signature took
   * only a fallback root and silently discarded it whenever %LOCALAPPDATA% was set, so a test that
   * passed a temporary directory still resolved to the developer's own registry — and duly
   * corrupted it. Requiring the override to be named makes that mistake impossible to make quietly.
   */
  root?: string;
}

export function resolveSupportPaths(options: SupportPathOptions): SupportPaths {
  const localAppData = process.env.LOCALAPPDATA;
  const root = options.root
    ?? (localAppData
      ? path.join(localAppData, "ClaudeWorkspaceAccounts")
      : path.join(options.fallbackRoot, "shared"));
  return {
    root,
    registry: path.join(root, "registry.json"),
    database: path.join(root, "usage.sqlite3"),
    wrapperDirectory: path.join(root, "wrapper"),
    snapshotInbox: path.join(root, "snapshots"),
    handoffs: path.join(root, "handoffs")
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PROFILE_FIELDS = new Set([
  "id",
  "displayName",
  "marker",
  "configDir",
  "configDirNormalized",
  "vsCodeUserDataDir",
  "expectedIdentity",
  "authMethod",
  "telemetryEnabled",
  "createdAt",
  "lastVerifiedAt"
]);
const IDENTITY_FIELDS = new Set([
  "email",
  "accountId",
  "organizationId",
  "organizationName"
]);
const LOCK_FIELDS = new Set([
  "workspaceUri",
  "workspaceKey",
  "workspacePathNormalized",
  "workspaceRootPathsNormalized",
  "workspaceLabel",
  "profileId",
  "mode",
  "createdAt",
  "updatedAt"
]);
const INTEGRATION_FIELDS = new Set([
  "wrapperPath",
  "upstreamWrapper",
  "configuredAt",
  "version",
  "telemetryEnabled",
  "collectWorkspacePath"
]);

function validateRegistry(value: unknown): SharedRegistryDocument {
  if (!isRecord(value)
    || value.schemaVersion !== REGISTRY_SCHEMA_VERSION
    || typeof value.revision !== "number"
    || !Array.isArray(value.profiles)
    || !Array.isArray(value.workspaceLocks)
    || !isRecord(value.collectors)
    || !isRecord(value.integration)
    || typeof value.updatedAt !== "string") {
    throw new Error("Unsupported or invalid registry schema.");
  }
  const profileIds = new Set<string>();
  const configDirectories = new Set<string>();
  const vsCodeDirectories = new Set<string>();
  const isolationDirectories: string[] = [];
  for (const candidate of value.profiles) {
    if (!isRecord(candidate)
      || Object.keys(candidate).some((field) => !PROFILE_FIELDS.has(field))
      || typeof candidate.id !== "string"
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate.id)
      || typeof candidate.displayName !== "string"
      || !candidate.displayName.trim()
      || typeof candidate.marker !== "string"
      || !candidate.marker
      || typeof candidate.configDir !== "string"
      || !path.isAbsolute(candidate.configDir)
      || candidate.configDir.toLocaleLowerCase().endsWith(".credentials.json")
      || typeof candidate.configDirNormalized !== "string"
      || candidate.configDirNormalized !== normalizeWindowsPath(candidate.configDir)
      || typeof candidate.vsCodeUserDataDir !== "string"
      || !path.isAbsolute(candidate.vsCodeUserDataDir)
      || candidate.vsCodeUserDataDir.toLocaleLowerCase().endsWith(".credentials.json")
      || typeof candidate.createdAt !== "string"
      || (candidate.authMethod !== undefined && typeof candidate.authMethod !== "string")
      || (candidate.telemetryEnabled !== undefined
        && typeof candidate.telemetryEnabled !== "boolean")
      || (candidate.lastVerifiedAt !== undefined
        && typeof candidate.lastVerifiedAt !== "string")
      || (candidate.expectedIdentity !== undefined
        && (!isRecord(candidate.expectedIdentity)
          || Object.keys(candidate.expectedIdentity).some(
            (field) => !IDENTITY_FIELDS.has(field)
          )
          || Object.values(candidate.expectedIdentity).some(
            (field) => field !== undefined && typeof field !== "string"
          )))) {
      throw new Error("The registry contains an invalid account profile.");
    }
    const configDirectory = candidate.configDirNormalized;
    const vsCodeDirectory = normalizeWindowsPath(candidate.vsCodeUserDataDir);
    if (profileIds.has(candidate.id)
      || configDirectories.has(configDirectory)
      || vsCodeDirectories.has(vsCodeDirectory)
      || pathContains(configDirectory, vsCodeDirectory)
      || pathContains(vsCodeDirectory, configDirectory)
      || isolationDirectories.some((directory) =>
        pathContains(directory, configDirectory)
        || pathContains(configDirectory, directory)
        || pathContains(directory, vsCodeDirectory)
        || pathContains(vsCodeDirectory, directory))) {
      throw new Error("The registry contains duplicate account profile metadata.");
    }
    profileIds.add(candidate.id);
    configDirectories.add(configDirectory);
    vsCodeDirectories.add(vsCodeDirectory);
    isolationDirectories.push(configDirectory, vsCodeDirectory);
  }
  const workspaceUris = new Set<string>();
  for (const candidate of value.workspaceLocks) {
    if (!isRecord(candidate)
      || Object.keys(candidate).some((field) => !LOCK_FIELDS.has(field))
      || typeof candidate.workspaceUri !== "string"
      || !candidate.workspaceUri
      || (candidate.workspaceKey !== undefined
        && (typeof candidate.workspaceKey !== "string"
          || !/^[a-f0-9]{16}$/.test(candidate.workspaceKey)))
      || typeof candidate.workspacePathNormalized !== "string"
      || !candidate.workspacePathNormalized
      || typeof candidate.workspaceLabel !== "string"
      || typeof candidate.profileId !== "string"
      || !profileIds.has(candidate.profileId)
      || !["enforce", "warn", "off"].includes(String(candidate.mode))
      || typeof candidate.createdAt !== "string"
      || typeof candidate.updatedAt !== "string"
      || (candidate.workspaceRootPathsNormalized !== undefined
        && (!Array.isArray(candidate.workspaceRootPathsNormalized)
          || candidate.workspaceRootPathsNormalized.some(
            (root) => typeof root !== "string" || !root
          )))
      || workspaceUris.has(candidate.workspaceUri)) {
      throw new Error("The registry contains an invalid workspace lock.");
    }
    workspaceUris.add(candidate.workspaceUri);
  }
  for (const [profileId, candidate] of Object.entries(value.collectors)) {
    if (!isRecord(candidate)
      || candidate.profileId !== profileId
      || typeof candidate.port !== "number"
      || !Number.isInteger(candidate.port)
      || candidate.port < 1
      || candidate.port > 65_535
      || typeof candidate.token !== "string"
      || candidate.token.length < 32
      || candidate.token.length > 256
      || typeof candidate.pid !== "number"
      || !Number.isInteger(candidate.pid)
      || typeof candidate.updatedAt !== "string") {
      throw new Error("The registry contains an invalid collector registration.");
    }
  }
  for (const field of ["wrapperPath", "upstreamWrapper"] as const) {
    const candidate = value.integration[field];
    if (candidate !== undefined
      && (typeof candidate !== "string" || !path.isAbsolute(candidate))) {
      throw new Error("The registry contains an invalid wrapper integration path.");
    }
  }
  if (value.integration.telemetryEnabled !== undefined
    && typeof value.integration.telemetryEnabled !== "boolean") {
    throw new Error("The registry contains an invalid telemetry integration state.");
  }
  if (value.integration.collectWorkspacePath !== undefined
    && typeof value.integration.collectWorkspacePath !== "boolean") {
    throw new Error("The registry contains an invalid workspace privacy state.");
  }
  if (Object.keys(value.integration).some((field) => !INTEGRATION_FIELDS.has(field))) {
    throw new Error("The registry contains unsupported wrapper integration metadata.");
  }
  return value as unknown as SharedRegistryDocument;
}

/**
 * The same validation `read` applies, for callers that must decide whether a registry is usable
 * before anything acts on it.
 *
 * The rename migration needs exactly this and nothing else from here: it has to know whether the
 * registry it just copied is one the extension host can actually load, because `activate` refuses
 * to continue on an invalid one. Repointing Claude Code at the new wrapper first and discovering
 * the registry is unusable second leaves a global setting applying no bindings and no UI left to
 * manage it. Exported rather than duplicated so the two can never disagree about "usable".
 */
export function assertValidRegistry(value: unknown): SharedRegistryDocument {
  return validateRegistry(value);
}

/**
 * Cross-process write coordination.
 *
 * The in-process queue only serialises writers inside one extension host. Multiple VS Code windows
 * read-modify-write the whole document, so an older read could clobber a newer collector
 * registration or profile edit — atomic rename protects a reader from half-written JSON but does
 * nothing about a lost update, and the wrapper then finds no collector or a stale one.
 *
 * Two defences, in order. A lock file makes the read-modify-write sequence mutually exclusive; a
 * revision check catches the lost update anyway if the lock had to be bypassed. Both are bounded:
 * contention must never be able to stop the extension from activating, so every path here fails
 * open and proceeds rather than throwing.
 */
const LOCK_STALE_AFTER_MS = 5_000;
const LOCK_MAX_WAIT_MS = 2_000;
const LOCK_RETRY_DELAY_MS = 25;
const MUTATE_MAX_ATTEMPTS = 5;

type WriteDiagnostics = Partial<Record<CollectionDegradationReason, number>>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type CreateProfileOutcome = "created" | "duplicate_id" | "duplicate_config_dir";

export class ProfileRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly diagnostics: WriteDiagnostics = {};

  public constructor(public readonly paths: SupportPaths) {}

  private get lockPath(): string {
    return `${this.paths.registry}.lock`;
  }

  private note(reason: CollectionDegradationReason): void {
    this.diagnostics[reason] = (this.diagnostics[reason] ?? 0) + 1;
  }

  /**
   * Hand over the contention counters and reset them. The collector mirrors these into the usage
   * database on each heartbeat so that lock contention and lost updates are visible in diagnostics
   * instead of being absorbed silently.
   */
  public drainWriteDiagnostics(): WriteDiagnostics {
    const drained = { ...this.diagnostics };
    for (const key of Object.keys(this.diagnostics)) {
      delete this.diagnostics[key as CollectionDegradationReason];
    }
    return drained;
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.root, { recursive: true }),
      mkdir(this.paths.wrapperDirectory, { recursive: true }),
      mkdir(this.paths.snapshotInbox, { recursive: true }),
      mkdir(this.paths.handoffs, { recursive: true })
    ]);
    await this.read();
  }

  public async read(): Promise<SharedRegistryDocument> {
    try {
      return validateRegistry(JSON.parse(await readFile(this.paths.registry, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const empty = createEmptyRegistry();
        await this.write(empty);
        return empty;
      }
      throw error;
    }
  }

  public async listProfiles(): Promise<AccountProfile[]> {
    return (await this.read()).profiles;
  }

  public async getProfile(profileId: string): Promise<AccountProfile | undefined> {
    return (await this.read()).profiles.find((profile) => profile.id === profileId);
  }

  public async upsertProfile(profile: AccountProfile): Promise<void> {
    await this.mutate((document) => {
      const index = document.profiles.findIndex((candidate) => candidate.id === profile.id);
      if (index >= 0) {
        document.profiles[index] = profile;
      } else {
        document.profiles.push(profile);
      }
    });
  }

  /**
   * Create a profile, refusing duplicates inside the mutation lock.
   *
   * Uniqueness has to be decided here rather than by the caller: a caller checks, then puts
   * prompts and a `claude auth status` probe between the check and the write, which is long
   * enough for another window to register the same configuration directory.
   */
  public async createProfile(profile: AccountProfile): Promise<CreateProfileOutcome> {
    let outcome: CreateProfileOutcome = "created";
    await this.mutate((document) => {
      outcome = "created";
      if (document.profiles.some((candidate) => candidate.id === profile.id)) {
        outcome = "duplicate_id";
        return;
      }
      const existing = document.profiles.find((candidate) =>
        candidate.configDirNormalized === profile.configDirNormalized);
      if (existing) {
        outcome = "duplicate_config_dir";
        return;
      }
      document.profiles.push(profile);
    });
    return outcome;
  }

  /**
   * Merge a few fields into one stored profile, inside the mutation lock.
   *
   * Whole-object upserts of a profile read before a prompt silently discarded whatever
   * another window wrote in the meantime — identity confirmation and telemetry enablement
   * erased each other. Only the named fields are touched here.
   */
  public async patchProfile(
    profileId: string,
    patch: Partial<Omit<AccountProfile, "id">>
  ): Promise<boolean> {
    let applied = false;
    await this.mutate((document) => {
      applied = false;
      const index = document.profiles.findIndex((candidate) => candidate.id === profileId);
      const current = document.profiles[index];
      if (index < 0 || !current) {
        return;
      }
      const next: AccountProfile = { ...current, ...patch, id: current.id };
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete (next as unknown as Record<string, unknown>)[field];
        }
      }
      document.profiles[index] = next;
      applied = true;
    });
    return applied;
  }

  /** Merge a few integration fields, inside the mutation lock, for the same reason. */
  public async patchIntegration(patch: Partial<WrapperIntegration>): Promise<void> {
    await this.mutate((document) => {
      const next: WrapperIntegration = { ...document.integration, ...patch };
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete (next as unknown as Record<string, unknown>)[field];
        }
      }
      document.integration = next;
    });
  }

  public async upsertProfiles(profiles: readonly AccountProfile[]): Promise<void> {
    await this.mutate((document) => {
      for (const profile of profiles) {
        const index = document.profiles.findIndex((candidate) => candidate.id === profile.id);
        if (index >= 0) {
          document.profiles[index] = profile;
        } else {
          document.profiles.push(profile);
        }
      }
    });
  }

  public async deleteProfile(profileId: string): Promise<void> {
    await this.mutate((document) => {
      document.profiles = document.profiles.filter((profile) => profile.id !== profileId);
      document.workspaceLocks = document.workspaceLocks.filter((lock) => lock.profileId !== profileId);
      delete document.collectors[profileId];
    });
  }

  public async upsertWorkspaceLock(lock: WorkspaceLock): Promise<void> {
    await this.mutate((document) => {
      const index = document.workspaceLocks.findIndex(
        (candidate) => candidate.workspaceUri === lock.workspaceUri
      );
      if (index >= 0) {
        document.workspaceLocks[index] = lock;
      } else {
        document.workspaceLocks.push(lock);
      }
    });
  }

  public async deleteWorkspaceLock(workspaceUri: string): Promise<void> {
    await this.mutate((document) => {
      document.workspaceLocks = document.workspaceLocks.filter(
        (lock) => lock.workspaceUri !== workspaceUri
      );
    });
  }

  public async registerCollector(registration: CollectorRegistration): Promise<void> {
    await this.mutate((document) => {
      document.collectors[registration.profileId] = registration;
    });
  }

  public async removeCollector(profileId: string, token: string): Promise<void> {
    await this.mutate((document) => {
      if (document.collectors[profileId]?.token === token) {
        delete document.collectors[profileId];
      }
    });
  }

  public async setIntegration(integration: WrapperIntegration): Promise<void> {
    await this.mutate((document) => {
      document.integration = integration;
    });
  }

  private async mutate(mutator: (document: SharedRegistryDocument) => void): Promise<void> {
    const operation = this.queue.then(() => this.mutateAcrossProcesses(mutator));
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private async mutateAcrossProcesses(
    mutator: (document: SharedRegistryDocument) => void
  ): Promise<void> {
    for (let attempt = 1; attempt <= MUTATE_MAX_ATTEMPTS; attempt += 1) {
      const lock = await this.acquireLock();
      try {
        const document = await this.read();
        const baseRevision = document.revision;
        mutator(document);
        document.revision = baseRevision + 1;
        document.updatedAt = new Date().toISOString();
        await this.write(document);
        // Confirm our revision is the one on disk. Under the lock this always holds; when the lock
        // had to be bypassed, this is what turns a silent lost update into a retry.
        if ((await this.read()).revision === document.revision) {
          return;
        }
        this.note("registry_write_conflict");
      } finally {
        // Validation and I/O failures propagate through here untouched: a malformed registry must
        // stay fail-closed, and retrying an invalid mutation five times would only delay the error.
        await lock.release();
      }
      if (attempt < MUTATE_MAX_ATTEMPTS) {
        this.note("registry_write_retried");
        await delay(LOCK_RETRY_DELAY_MS * attempt + Math.floor(Math.random() * 20));
      }
    }
    this.note("registry_write_failed");
    throw new Error(
      "The shared registry is being changed by another VS Code window; the update was not applied."
    );
  }

  /**
   * Take the cross-process lock, or give up and proceed without it.
   *
   * `held: false` is a deliberate outcome, not a failure: blocking activation on a lock another
   * process may never release would be far worse than one racy write that the revision check will
   * catch and retry.
   */
  private async acquireLock(): Promise<{ held: boolean; release: () => Promise<void> }> {
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    let contended = false;
    for (;;) {
      try {
        // "wx" fails if the file exists, which is the atomic test-and-set this needs.
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
            "utf8"
          );
        } finally {
          await handle.close();
        }
        if (contended) {
          this.note("registry_lock_contended");
        }
        return {
          held: true,
          release: async () => {
            await rm(this.lockPath, { force: true }).catch(() => undefined);
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          // Cannot create a lock at all (read-only directory, antivirus). Proceed unlocked.
          return { held: false, release: async () => undefined };
        }
        contended = true;
        if (await this.stealIfStale()) {
          continue;
        }
        if (Date.now() >= deadline) {
          this.note("registry_lock_contended");
          return { held: false, release: async () => undefined };
        }
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }
  }

  /** Reclaim a lock whose owner has died or which is old enough that no live holder can be waiting. */
  private async stealIfStale(): Promise<boolean> {
    try {
      const info = await stat(this.lockPath);
      let owner: unknown;
      try {
        owner = (JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: unknown }).pid;
      } catch {
        owner = undefined;
      }
      const expired = Date.now() - info.mtimeMs > LOCK_STALE_AFTER_MS;
      const ownerGone = owner !== undefined && owner !== process.pid && !isProcessAlive(owner);
      if (!expired && !ownerGone) {
        return false;
      }
      await rm(this.lockPath, { force: true });
      this.note("registry_lock_stolen");
      return true;
    } catch {
      // Someone else won the race to remove it; retrying the create is the correct next step.
      return false;
    }
  }

  private async write(document: SharedRegistryDocument): Promise<void> {
    validateRegistry(document);
    const temporary = `${this.paths.registry}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.paths.registry);
  }
}
