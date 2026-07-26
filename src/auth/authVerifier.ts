import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AccountProfile, AuthVerification } from "../core/models.js";
import { parseAuthStatus } from "./authSchema.js";

interface CacheEntry {
  expiresAt: number;
  verification: AuthVerification;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  processError?: Error;
}

const MAX_CAPTURE_BYTES = 64 * 1024;

function runProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  captureOutput = true
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "ignore"]
    });
    let stdout = "";
    let settled = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) < MAX_CAPTURE_BYTES) {
        stdout += chunk.toString("utf8", 0, MAX_CAPTURE_BYTES - Buffer.byteLength(stdout));
      }
    });
    child.stderr?.resume();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("error", (processError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, timedOut, processError });
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, timedOut });
    });
  });
}

export class ClaudeBinaryResolver {
  public resolve(): string | undefined {
    const extension = vscode.extensions.getExtension("anthropic.claude-code")
      ?? vscode.extensions.getExtension("Anthropic.claude-code");
    if (!extension) {
      return undefined;
    }
    const candidates = process.platform === "win32"
      ? [
          path.join(extension.extensionPath, "resources", "native-binary", "claude.exe"),
          path.join(extension.extensionPath, "resources", "claude.exe")
        ]
      : [
          path.join(extension.extensionPath, "resources", "native-binary", "claude"),
          path.join(extension.extensionPath, "resources", "claude")
        ];
    return candidates.find((candidate) => {
      try {
        return existsSync(candidate);
      } catch {
        return false;
      }
    });
  }

  public installedVersion(): string | undefined {
    return (vscode.extensions.getExtension("anthropic.claude-code")
      ?? vscode.extensions.getExtension("Anthropic.claude-code"))?.packageJSON?.version as string | undefined;
  }
}

export class AuthVerifier {
  private readonly cache = new Map<string, CacheEntry>();

  public constructor(private readonly binaryResolver: ClaudeBinaryResolver) {}

  public async verify(profile: AccountProfile, force = false): Promise<AuthVerification> {
    const cached = this.cache.get(profile.id);
    if (!force && cached && cached.expiresAt > Date.now()) {
      return cached.verification;
    }

    const binary = this.binaryResolver.resolve();
    if (!binary) {
      return {
        state: "unavailable",
        checkedAt: new Date().toISOString(),
        errorCategory: "binary_missing"
      };
    }

    const result = await runProcess(
      binary,
      ["auth", "status"],
      { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir },
      15_000
    );
    let verification: AuthVerification;
    if (result.timedOut) {
      verification = {
        state: "unavailable",
        checkedAt: new Date().toISOString(),
        errorCategory: "timeout"
      };
    } else if (result.processError) {
      verification = {
        state: "unavailable",
        checkedAt: new Date().toISOString(),
        errorCategory: "process_error"
      };
    } else if (result.exitCode !== 0 && !result.stdout.trim()) {
      verification = {
        state: "signed_out",
        checkedAt: new Date().toISOString(),
        errorCategory: "signed_out"
      };
    } else {
      verification = parseAuthStatus(result.stdout);
      if (result.exitCode !== 0 && verification.state === "signed_in") {
        verification = {
          state: "unavailable",
          checkedAt: verification.checkedAt,
          errorCategory: "process_error"
        };
      }
    }

    this.cache.set(profile.id, {
      expiresAt: Date.now() + 30_000,
      verification
    });
    return verification;
  }

  public async login(profile: AccountProfile, token?: vscode.CancellationToken): Promise<void> {
    const binary = this.binaryResolver.resolve();
    if (!binary) {
      throw new Error("The Claude Code VS Code extension and its bundled executable are required.");
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, ["auth", "login"], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir },
        shell: false,
        windowsHide: false,
        stdio: "ignore"
      });
      const cancellation = token?.onCancellationRequested(() => child.kill());
      child.once("error", (error) => {
        cancellation?.dispose();
        reject(error);
      });
      child.once("close", (code) => {
        cancellation?.dispose();
        if (token?.isCancellationRequested) {
          reject(new Error("Sign-in was cancelled."));
        } else if (code === 0) {
          this.cache.delete(profile.id);
          resolve();
        } else {
          reject(new Error(`Claude sign-in exited with code ${code ?? "unknown"}.`));
        }
      });
    });
  }
}
