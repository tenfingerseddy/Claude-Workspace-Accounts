import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { AccountProfile, CollectorRegistration } from "../core/models.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import type { UsageRepository } from "../storage/usageRepository.js";
import { normalizeOtlp, normalizeStatusSnapshot } from "./normalizers.js";

const MAX_BODY_BYTES = 3 * 1024 * 1024;

export class TelemetryCollector {
  private server?: Server;
  private registration?: CollectorRegistration;
  private heartbeat?: NodeJS.Timeout;
  private snapshotPoll?: NodeJS.Timeout;
  private processingSnapshots = false;

  public constructor(
    private readonly registry: ProfileRegistry,
    private readonly repository: UsageRepository,
    private readonly onData: () => void
  ) {}

  public async start(profile: AccountProfile): Promise<CollectorRegistration> {
    if (this.server) {
      throw new Error("The local collector is already running.");
    }
    const token = randomBytes(32).toString("base64url");
    this.server = createServer((request, response) => {
      void this.handleRequest(profile.id, token, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("The collector did not receive a loopback TCP port.");
    }
    this.registration = {
      profileId: profile.id,
      port: address.port,
      token,
      pid: process.pid,
      updatedAt: new Date().toISOString()
    };
    await this.registry.registerCollector(this.registration);
    this.heartbeat = setInterval(() => {
      void this.refreshRegistration();
    }, 20_000);
    this.snapshotPoll = setInterval(() => {
      void this.processSnapshotInbox();
    }, 2_000);
    await this.processSnapshotInbox();
    return this.registration;
  }

  public async dispose(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    if (this.snapshotPoll) {
      clearInterval(this.snapshotPoll);
    }
    if (this.registration) {
      await this.registry.removeCollector(this.registration.profileId, this.registration.token);
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    }
    this.server = undefined;
    this.registration = undefined;
  }

  private async handleRequest(
    profileId: string,
    expectedToken: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.socket.remoteAddress !== "127.0.0.1"
      && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      this.respond(response, 403, { error: "loopback_required" });
      request.resume();
      return;
    }
    if (request.method !== "POST"
      || !["/v1/metrics", "/v1/logs", "/v1/traces"].includes(request.url ?? "")) {
      this.respond(response, 404, { error: "not_found" });
      request.resume();
      return;
    }
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      this.respond(response, 401, { error: "unauthorized" });
      request.resume();
      return;
    }

    try {
      const body = await this.readBody(request);
      const payload = JSON.parse(body) as unknown;
      const normalized = normalizeOtlp(payload);
      this.repository.ingestBatch(profileId, normalized.metrics, normalized.events);
      this.respond(response, 200, {});
      if (normalized.metrics.length > 0 || normalized.events.length > 0) {
        this.onData();
      }
    } catch (error) {
      const category = (error as Error).message === "payload_too_large"
        ? "payload_too_large"
        : "invalid_payload";
      this.respond(response, category === "payload_too_large" ? 413 : 400, { error: category });
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      request.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) {
          reject(new Error("payload_too_large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  private respond(response: ServerResponse, status: number, payload: unknown): void {
    if (!response.headersSent) {
      response.statusCode = status;
    }
    if (!response.writableEnded) {
      response.end(JSON.stringify(payload));
    }
  }

  private async refreshRegistration(): Promise<void> {
    if (!this.registration) {
      return;
    }
    this.registration = {
      ...this.registration,
      updatedAt: new Date().toISOString()
    };
    await this.registry.registerCollector(this.registration);
  }

  private async processSnapshotInbox(): Promise<void> {
    if (this.processingSnapshots) {
      return;
    }
    this.processingSnapshots = true;
    try {
      const files = (await readdir(this.registry.paths.snapshotInbox))
        .filter((file) => file.endsWith(".json"))
        .slice(0, 100);
      const knownProfiles = new Set((await this.registry.listProfiles()).map((profile) => profile.id));
      for (const file of files) {
        const source = path.join(this.registry.paths.snapshotInbox, file);
        const claimed = path.join(
          this.registry.paths.snapshotInbox,
          `${file}.processing-${process.pid}`
        );
        try {
          await rename(source, claimed);
        } catch {
          continue;
        }
        try {
          const content = (await readFile(claimed, "utf8")).replace(/^\uFEFF/, "");
          const snapshot = normalizeStatusSnapshot(JSON.parse(content));
          if (snapshot && knownProfiles.has(snapshot.profileId)) {
            this.repository.recordStatusSnapshot(snapshot);
            this.onData();
          }
        } finally {
          await unlink(claimed).catch(() => undefined);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Collector health is surfaced through diagnostics; snapshot failure never affects Claude.
      }
    } finally {
      this.processingSnapshots = false;
    }
  }
}
