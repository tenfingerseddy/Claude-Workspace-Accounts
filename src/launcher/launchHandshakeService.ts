import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupportPaths } from "../profiles/registryStore.js";

export interface LaunchReadiness {
  launchId: string;
  ready: boolean;
  profileId?: string;
  workspace?: string;
  detail?: string;
  completedAt: string;
}

function validLaunchId(value: string | undefined): value is string {
  return Boolean(value && /^[a-f0-9-]{36}$/i.test(value));
}

export class LaunchHandshakeService {
  public constructor(private readonly paths: SupportPaths) {}

  public createId(): string {
    return randomUUID();
  }

  public async completeFromEnvironment(result: Omit<LaunchReadiness, "launchId" | "completedAt">): Promise<void> {
    const launchId = process.env.CLAUDE_ACCOUNT_GUARD_LAUNCH_ID;
    if (!validLaunchId(launchId)) {
      return;
    }
    const target = path.join(this.paths.handoffs, `${launchId}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    const payload: LaunchReadiness = {
      launchId,
      ...result,
      completedAt: new Date().toISOString()
    };
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(temporary, target);
  }

  public async waitFor(launchId: string, timeoutMs = 30_000): Promise<LaunchReadiness | undefined> {
    if (!validLaunchId(launchId)) {
      return undefined;
    }
    const target = path.join(this.paths.handoffs, `${launchId}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const result = JSON.parse(await readFile(target, "utf8")) as LaunchReadiness;
        await unlink(target).catch(() => undefined);
        return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return undefined;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return undefined;
  }
}
