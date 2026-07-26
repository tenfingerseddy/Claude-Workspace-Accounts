import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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

export function resolveSupportPaths(fallbackRoot: string): SupportPaths {
  const localAppData = process.env.LOCALAPPDATA;
  const root = localAppData
    ? path.join(localAppData, "ClaudeAccountGuard")
    : path.join(fallbackRoot, "shared");
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

export class ProfileRegistry {
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(public readonly paths: SupportPaths) {}

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
    const operation = this.queue.then(async () => {
      const document = await this.read();
      mutator(document);
      document.revision += 1;
      document.updatedAt = new Date().toISOString();
      await this.write(document);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
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
