import path from "node:path";
import * as vscode from "vscode";
import type { AccountProfile, LockMode, WorkspaceLock } from "../core/models.js";
import {
  canonicalizeWindowsPath,
  normalizeWindowsPath,
  workspaceHash
} from "../core/paths.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";

export interface WorkspaceDescriptor {
  uri: vscode.Uri;
  canonicalPath: string;
  rootPaths: string[];
  label: string;
}

export class WorkspaceLockService {
  public constructor(private readonly registry: ProfileRegistry) {}

  public async currentWorkspace(): Promise<WorkspaceDescriptor | undefined> {
    if (vscode.workspace.workspaceFile) {
      const file = vscode.workspace.workspaceFile;
      const rootPaths = [...new Set((await Promise.all(
        (vscode.workspace.workspaceFolders ?? []).map(async (folder) => [
          await canonicalizeWindowsPath(folder.uri.fsPath),
          normalizeWindowsPath(folder.uri.fsPath)
        ])
      )).flat())];
      return {
        uri: file,
        canonicalPath: await canonicalizeWindowsPath(file.fsPath),
        rootPaths: rootPaths.length > 0
          ? rootPaths
          : [...new Set([
            await canonicalizeWindowsPath(path.dirname(file.fsPath)),
            normalizeWindowsPath(path.dirname(file.fsPath))
          ])],
        label: path.basename(file.fsPath)
      };
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const canonicalPath = await canonicalizeWindowsPath(folder.uri.fsPath);
    return {
      uri: folder.uri,
      canonicalPath,
      rootPaths: [...new Set([canonicalPath, normalizeWindowsPath(folder.uri.fsPath)])],
      label: folder.name
    };
  }

  public async currentLock(): Promise<WorkspaceLock | undefined> {
    const workspace = await this.currentWorkspace();
    if (!workspace) {
      return undefined;
    }
    return (await this.registry.read()).workspaceLocks.find(
      (lock) => lock.workspaceUri === workspace.uri.toString()
    );
  }

  public async lock(profile: AccountProfile, mode: LockMode): Promise<WorkspaceLock> {
    const workspace = await this.currentWorkspace();
    if (!workspace) {
      throw new Error("Open a folder or workspace before creating a lock.");
    }
    const now = new Date().toISOString();
    const existing = await this.currentLock();
    const lock: WorkspaceLock = {
      workspaceUri: workspace.uri.toString(),
      workspaceKey: workspaceHash(workspace.uri.toString()),
      workspacePathNormalized: workspace.rootPaths[0] ?? workspace.canonicalPath,
      workspaceRootPathsNormalized: workspace.rootPaths,
      workspaceLabel: workspace.label,
      profileId: profile.id,
      mode,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await this.registry.upsertWorkspaceLock(lock);
    return lock;
  }

  public async unlock(): Promise<void> {
    const workspace = await this.currentWorkspace();
    if (workspace) {
      await this.registry.deleteWorkspaceLock(workspace.uri.toString());
    }
  }
}
