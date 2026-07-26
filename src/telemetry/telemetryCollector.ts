import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";
import type {
  AccountProfile,
  CollectionQuarantineReason,
  CollectionRejectionReason,
  CollectorRegistration
} from "../core/models.js";
import type { ProfileRegistry } from "../profiles/registryStore.js";
import { StorageWriteError, type UsageRepository } from "../storage/usageRepository.js";
import { normalizeOtlp, normalizeStatusSnapshot, type OtlpSignal } from "./normalizers.js";

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SNAPSHOT_POLL_INTERVAL_MS = 2_000;
/** A claim left behind by a crashed extension host. Long enough that a live host is never robbed. */
const STALE_CLAIM_AFTER_MS = 5 * 60_000;

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

/**
 * The signal each route carries, and the OTLP partial-success field that names what was dropped.
 *
 * `/v1/traces` is deliberately absent. Claude Code only emits spans when
 * CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1, and Workspace Accounts will not opt a user into a beta telemetry
 * mode on their behalf, so traces are not collected and the endpoint says so instead of accepting
 * data it was never going to receive. `normalizeOtlp` still understands `resourceSpans`: re-enabling
 * collection, if spans ever leave beta, is this one line plus the wrapper's exporter variable.
 */
const ROUTES: Record<string, { signal: OtlpSignal; rejectedField: string }> = {
  "/v1/metrics": { signal: "metrics", rejectedField: "rejectedDataPoints" },
  "/v1/logs": { signal: "logs", rejectedField: "rejectedLogRecords" }
};

/** A request the collector refuses, carrying the status code an OTLP exporter should see. */
class RequestRejection extends Error {
  public constructor(
    public readonly reason: CollectionRejectionReason,
    public readonly status: number,
    public readonly detail?: string
  ) {
    super(reason);
    this.name = "RequestRejection";
  }
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0]?.trim().toLocaleLowerCase() ?? "";
}

function contentEncodings(header: string | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value.length > 0 && value !== "identity");
}

function sameToken(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(`Bearer ${expected}`, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class TelemetryCollector {
  private server?: Server;
  private registration?: CollectorRegistration;
  private heartbeat?: NodeJS.Timeout;
  private snapshotPoll?: NodeJS.Timeout;
  private processingSnapshots = false;
  private heartbeatFailing = false;

  public constructor(
    private readonly registry: ProfileRegistry,
    private readonly repository: UsageRepository,
    private readonly onData: () => void
  ) {}

  private get quarantineDirectory(): string {
    return path.join(this.registry.paths.snapshotInbox, "quarantine");
  }

  public async start(profile: AccountProfile): Promise<CollectorRegistration> {
    if (this.server) {
      throw new Error("The local collector is already running.");
    }
    const token = randomBytes(32).toString("base64url");
    const server = createServer((request, response) => {
      void this.handleRequest(profile.id, token, request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
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
      this.repository.recordCollectorLifecycle({
        profileId: profile.id,
        listening: true,
        port: this.registration.port,
        startedAt: this.registration.updatedAt,
        registrationUpdatedAt: this.registration.updatedAt,
        heartbeatHealthy: true,
        quarantineDirectory: this.quarantineDirectory
      });
    } catch (error) {
      // A bind failure used to leave no trace at all, so the dashboard reported the same
      // "unavailable" it reports for an account that simply has not run Claude yet.
      this.repository.recordCollectorLifecycle({
        profileId: profile.id,
        listening: false,
        stoppedAt: new Date().toISOString(),
        bindError: describeError(error)
      });
      this.server = undefined;
      throw error;
    }
    this.heartbeat = setInterval(() => {
      void this.refreshRegistration();
    }, HEARTBEAT_INTERVAL_MS);
    this.snapshotPoll = setInterval(() => {
      void this.processSnapshotInbox();
    }, SNAPSHOT_POLL_INTERVAL_MS);
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
      this.repository.recordCollectorLifecycle({
        profileId: this.registration.profileId,
        listening: false,
        stoppedAt: new Date().toISOString()
      });
      try {
        await this.registry.removeCollector(this.registration.profileId, this.registration.token);
      } catch (error) {
        // Deregistration can fail for reasons that have nothing to do with the server — a corrupt
        // registry, or another window holding the write lock. Letting that abort disposal would leak
        // the listening socket and the port for the lifetime of the extension host.
        this.repository.recordDegradation(
          this.registration.profileId,
          "registry_write_failed",
          describeError(error)
        );
      }
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
    try {
      const route = this.authorize(expectedToken, request);
      const body = await this.readDecodedBody(request);
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        throw new RequestRejection("malformed_json", 400);
      }
      const normalized = normalizeOtlp(payload);
      if (normalized.signals.length === 0) {
        // Valid JSON that is not an OTLP export request. 400 is correct and non-retryable: no
        // amount of retrying turns this into something the collector can store.
        throw new RequestRejection("unsupported_envelope", 400);
      }
      if (!normalized.signals.includes(route.signal)) {
        this.repository.recordDegradation(
          profileId,
          "signal_envelope_mismatch",
          `${route.signal}:${normalized.signals.join("+")}`
        );
      }
      this.repository.recordDegradations(profileId, normalized.degradations);

      const total = normalized.metrics.length + normalized.events.length;
      if (total === 0) {
        // Understood, acknowledged, and stored nothing. Say so in the OTLP partial-success field and
        // count it, rather than returning a bare 200 that looks exactly like a successful store.
        this.repository.recordBatchAcceptedEmpty(profileId, route.signal);
        this.respond(response, 200, {
          partialSuccess: {
            [route.rejectedField]: "0",
            errorMessage: "No supported Claude Code telemetry in this batch."
          }
        });
        return;
      }
      this.repository.ingestBatch(profileId, normalized.metrics, normalized.events);
      this.repository.recordRequestStored(profileId);
      this.respond(response, 200, {});
      this.onData();
    } catch (error) {
      this.rejectRequest(profileId, response, error);
    }
  }

  /** Everything that can be decided from the request line and headers alone. */
  private authorize(
    expectedToken: string,
    request: IncomingMessage
  ): { signal: OtlpSignal; rejectedField: string } {
    if (request.socket.remoteAddress !== "127.0.0.1"
      && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      throw new RequestRejection("loopback_required", 403);
    }
    const url = request.url ?? "";
    if (request.method !== "POST") {
      throw new RequestRejection("not_found", 404, request.method ?? "unknown");
    }
    if (url === "/v1/traces") {
      throw new RequestRejection("traces_not_collected", 404);
    }
    const route = ROUTES[url];
    if (!route) {
      throw new RequestRejection("not_found", 404);
    }
    if (!sameToken(request.headers.authorization, expectedToken)) {
      throw new RequestRejection("unauthorized", 401);
    }
    const type = mediaType(request.headers["content-type"]);
    if (type === "application/x-protobuf" || type === "application/protobuf") {
      // Named explicitly: an exporter configured for http/protobuf otherwise produced a stream of
      // generic "invalid payload" rejections that read like corrupted data.
      throw new RequestRejection("protobuf_unsupported", 415, type);
    }
    // An absent content type is tolerated; some exporters omit it. Anything present must be JSON.
    if (type && type !== "application/json") {
      throw new RequestRejection("unsupported_content_type", 415, type);
    }
    return route;
  }

  /**
   * Read the body, honouring Content-Encoding. OTLP requires exporters be able to gzip, and
   * `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` in the user's environment turns it on — so a collector that
   * always treated the body as UTF-8 JSON rejected every single request.
   */
  private async readDecodedBody(request: IncomingMessage): Promise<string> {
    const raw = await this.readBody(request);
    const encodings = contentEncodings(request.headers["content-encoding"]);
    if (encodings.length === 0) {
      return raw.toString("utf8");
    }
    if (encodings.length > 1) {
      throw new RequestRejection(
        "unsupported_content_encoding",
        415,
        encodings.join("+")
      );
    }
    const encoding = encodings[0] ?? "";
    // maxOutputLength keeps the 3 MiB cap meaningful after decompression: without it a few kilobytes
    // of crafted gzip expands until the extension host runs out of memory.
    const options = { maxOutputLength: MAX_BODY_BYTES } as const;
    try {
      if (encoding === "gzip" || encoding === "x-gzip") {
        return (await gunzipAsync(raw, options)).toString("utf8");
      }
      if (encoding === "deflate") {
        return (await inflateAsync(raw, options)).toString("utf8");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new RequestRejection("decompressed_too_large", 413);
      }
      throw new RequestRejection("decompression_failed", 400, encoding);
    }
    throw new RequestRejection("unsupported_content_encoding", 415, encoding);
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      request.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) {
          reject(new RequestRejection("payload_too_large", 413));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", () => reject(new RequestRejection("request_aborted", 400)));
    });
  }

  /**
   * Turn a failure into the right status code. The distinction that matters: Claude's exporter treats
   * 400 as non-retryable, so classifying a transient SQLite busy timeout as "invalid payload"
   * permanently destroyed that batch of real usage.
   */
  private rejectRequest(profileId: string, response: ServerResponse, error: unknown): void {
    if (error instanceof RequestRejection) {
      this.repository.recordRequestRejected(profileId, error.reason, error.detail);
      this.respond(response, error.status, { error: error.reason, detail: error.detail });
      return;
    }
    if (error instanceof StorageWriteError) {
      const reason: CollectionRejectionReason = error.transient
        ? "storage_transient"
        : "storage_permanent";
      this.repository.recordRequestRejected(profileId, reason, error.category);
      if (error.transient) {
        // 503 is retryable per OTLP, so the exporter keeps the batch and tries again.
        response.setHeader("retry-after", "5");
        this.respond(response, 503, { error: reason, category: error.category });
      } else {
        this.respond(response, 500, { error: reason, category: error.category });
      }
      this.onData();
      return;
    }
    // Anything unclassified is ours, not the client's: 500, never 400.
    this.repository.recordRequestRejected(profileId, "storage_permanent", describeError(error));
    this.respond(response, 500, { error: "collector_failure" });
  }

  private respond(response: ServerResponse, status: number, payload: unknown): void {
    if (!response.headersSent) {
      response.statusCode = status;
    }
    if (!response.writableEnded) {
      response.end(JSON.stringify(payload));
    }
  }

  /**
   * The wrapper refuses to inject OTEL when this registration is older than 60 seconds, so a
   * heartbeat that rejects its promise into the void stops telemetry permanently and invisibly.
   */
  private async refreshRegistration(): Promise<void> {
    if (!this.registration) {
      return;
    }
    const candidate = {
      ...this.registration,
      updatedAt: new Date().toISOString()
    };
    try {
      await this.registry.registerCollector(candidate);
      this.registration = candidate;
      this.repository.recordCollectorLifecycle({
        profileId: candidate.profileId,
        listening: true,
        registrationUpdatedAt: candidate.updatedAt,
        heartbeatHealthy: true
      });
      if (this.heartbeatFailing) {
        this.heartbeatFailing = false;
        this.onData();
      }
    } catch (error) {
      this.repository.recordCollectorLifecycle({
        profileId: candidate.profileId,
        heartbeatHealthy: false,
        heartbeatError: describeError(error)
      });
      this.repository.recordDegradation(
        candidate.profileId,
        "heartbeat_failed",
        describeError(error)
      );
      if (!this.heartbeatFailing) {
        this.heartbeatFailing = true;
        // Surface the transition immediately; waiting for data that will never arrive is the bug.
        this.onData();
      }
    }
    this.drainRegistryDiagnostics(candidate.profileId);
  }

  /** Move the registry's in-memory contention counters somewhere the diagnostics view can read. */
  private drainRegistryDiagnostics(profileId: string): void {
    for (const [reason, count] of Object.entries(this.registry.drainWriteDiagnostics())) {
      if (count > 0) {
        this.repository.recordDegradations(profileId, { [reason]: count });
      }
    }
  }

  private async processSnapshotInbox(): Promise<void> {
    if (this.processingSnapshots) {
      return;
    }
    this.processingSnapshots = true;
    const profileId = this.registration?.profileId;
    try {
      const entries = await readdir(this.registry.paths.snapshotInbox);
      await this.reclaimStaleClaims(entries, profileId);
      const files = entries.filter((file) => file.endsWith(".json")).slice(0, 100);
      const knownProfiles = new Set((await this.registry.listProfiles()).map((p) => p.id));
      for (const file of files) {
        // One bad file used to abort the whole pass, so a single unparseable snapshot stalled every
        // later one behind it.
        await this.processSnapshotFile(file, knownProfiles, profileId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.repository.recordDegradation(profileId, "inbox_scan_failed", describeError(error));
      }
    } finally {
      this.processingSnapshots = false;
    }
  }

  private async processSnapshotFile(
    file: string,
    knownProfiles: Set<string>,
    profileId: string | undefined
  ): Promise<void> {
    const source = path.join(this.registry.paths.snapshotInbox, file);
    const claimed = path.join(
      this.registry.paths.snapshotInbox,
      `${file}.processing-${process.pid}`
    );
    try {
      await rename(source, claimed);
    } catch (error) {
      // Another host claimed it first, which is normal. Only note genuine failures.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.repository.recordDegradation(profileId, "inbox_claim_failed", describeError(error));
      }
      return;
    }

    let content: string;
    try {
      content = (await readFile(claimed, "utf8")).replace(/^\uFEFF/, "");
    } catch (error) {
      await this.quarantine(claimed, file, "read_failed", describeError(error), profileId);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      await this.quarantine(claimed, file, "malformed_json", undefined, profileId);
      return;
    }

    const snapshot = normalizeStatusSnapshot(parsed);
    if (!snapshot) {
      await this.quarantine(claimed, file, "unsupported_schema", undefined, profileId);
      return;
    }
    if (!knownProfiles.has(snapshot.profileId)) {
      // The profile may be registered a moment from now, and this snapshot is the only copy of that
      // session's quota. Keep it where a human or a later fix can recover it.
      await this.quarantine(claimed, file, "unknown_profile", undefined, profileId);
      return;
    }

    try {
      this.repository.recordStatusSnapshot(snapshot);
    } catch (error) {
      const category = error instanceof StorageWriteError ? error.category : describeError(error);
      await this.quarantine(claimed, file, "storage_failure", category, profileId);
      return;
    }

    // Delete only now: the transaction has committed, so the file is genuinely redundant.
    try {
      await unlink(claimed);
    } catch (error) {
      this.repository.recordDegradation(profileId, "inbox_cleanup_failed", describeError(error));
    }
    this.repository.recordInboxProcessed(snapshot.profileId);
    this.onData();
  }

  /** Move a rejected file aside with a reason. Never delete it — it may be the only copy. */
  private async quarantine(
    claimedPath: string,
    originalName: string,
    reason: CollectionQuarantineReason,
    detail: string | undefined,
    profileId: string | undefined
  ): Promise<void> {
    try {
      await mkdir(this.quarantineDirectory, { recursive: true });
      const target = path.join(this.quarantineDirectory, originalName);
      await rename(claimedPath, target);
      await writeFile(
        `${target}.error.json`,
        `${JSON.stringify({ schemaVersion: 1, reason, detail, at: new Date().toISOString() }, null, 2)}\n`,
        "utf8"
      );
    } catch (error) {
      this.repository.recordDegradation(profileId, "quarantine_failed", describeError(error));
    }
    this.repository.recordInboxQuarantined(profileId, reason, detail ?? originalName);
    this.repository.recordCollectorLifecycle({
      profileId: profileId ?? "",
      quarantineDirectory: this.quarantineDirectory
    });
  }

  /**
   * Return claims abandoned by a crashed extension host. Without this, a host that dies mid-pass
   * leaves snapshots parked under a `.processing-<pid>` name that nothing will ever look at again.
   */
  private async reclaimStaleClaims(
    entries: readonly string[],
    profileId: string | undefined
  ): Promise<void> {
    const claims = entries.filter((entry) => /\.json\.processing-\d+$/.test(entry));
    for (const claim of claims.slice(0, 100)) {
      const claimPath = path.join(this.registry.paths.snapshotInbox, claim);
      try {
        const info = await stat(claimPath);
        if (Date.now() - info.mtimeMs < STALE_CLAIM_AFTER_MS) {
          continue;
        }
        const owner = Number(claim.slice(claim.lastIndexOf("-") + 1));
        if (owner === process.pid || isProcessAlive(owner)) {
          continue;
        }
        await rename(claimPath, claimPath.replace(/\.processing-\d+$/, ""));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.repository.recordDegradation(profileId, "inbox_claim_failed", describeError(error));
        }
      }
    }
  }
}

/** A sanitized cause. Never a path, a payload, or an environment value. */
function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code) {
    return code;
  }
  if (error instanceof Error && error.name && error.name !== "Error") {
    return error.name;
  }
  return "unknown";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else, which still counts as alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
