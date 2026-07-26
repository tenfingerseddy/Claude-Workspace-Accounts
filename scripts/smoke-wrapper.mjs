// Guard-behaviour smoke test for the Claude process wrapper.
//
// The companion gate (`smoke-wrapper-args.mjs`) proves the wrapper is transparent. This one
// proves it does its job: that a workspace bound to an account launches Claude against that
// account's isolated configuration directory whatever the ambient environment says, that two
// workspaces bound to two accounts stay on two accounts, that an unbound workspace is left
// completely alone, and that every fault forwards the launch instead of refusing it.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { FOREIGN_OTEL_VARIABLES } from "../src/telemetry/otelEnvironment.ts";

const WRAPPER = path.resolve("bin/native/win-x64/claude-workspace-accounts-wrapper.exe");
const CLI_SCRIPT = path.resolve("test/fixtures/fake-claude-cli.js");
const CLI_BATCH = path.resolve("test/fixtures/fake-claude.cmd");

/** The hosted-JavaScript CLI prefix, i.e. Claude Code's `[node.exe, cli.js]` shape. */
const scriptPrefix = [process.execPath, CLI_SCRIPT];

const WORK_CONFIG_DIR = "C:\\profiles\\work";
const PERSONAL_CONFIG_DIR = "C:\\profiles\\personal";
const AMBIENT_CONFIG_DIR = "C:\\profiles\\ambient";

const failures = [];
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) {
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  }
}

// The canonical long form, because Windows expands 8.3 short names when it sets a process's
// working directory - and a binding that compared against the short form would never match.
const directory = realpathSync.native(
  await mkdtemp(path.join(os.tmpdir(), "claude-workspace-accounts-wrapper-"))
);
const supportRoot = path.join(directory, "ClaudeWorkspaceAccounts");
await mkdir(supportRoot, { recursive: true });
const registryPath = path.join(supportRoot, "registry.json");
const healthPath = path.join(supportRoot, "wrapper-health.json");

// Real directories, because binding resolves against the launch's working directory.
const parentWorkspace = path.join(directory, "parent");
const childWorkspace = path.join(parentWorkspace, "child");
const unboundWorkspace = path.join(directory, "unbound");
await mkdir(childWorkspace, { recursive: true });
await mkdir(unboundWorkspace, { recursive: true });

const normalize = (value) =>
  path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();

const workProfile = {
  id: "work",
  displayName: "Work",
  configDir: WORK_CONFIG_DIR,
  configDirNormalized: normalize(WORK_CONFIG_DIR),
  telemetryEnabled: true,
  expectedIdentity: {
    email: "work@example.com",
    accountId: "acct-work",
    organizationId: "org-work"
  }
};

// A profile with no recorded identity: it binds, but there is nothing to verify against.
const personalProfile = {
  id: "personal",
  displayName: "Personal",
  configDir: PERSONAL_CONFIG_DIR,
  configDirNormalized: normalize(PERSONAL_CONFIG_DIR)
};

function lock(workspacePath, profileId, mode, workspaceKey) {
  return {
    workspaceUri: `file:///${profileId}-${mode}`,
    workspaceKey,
    workspacePathNormalized: normalize(workspacePath),
    workspaceLabel: path.basename(workspacePath),
    profileId,
    mode
  };
}

function registryDocument(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    profiles: [workProfile, personalProfile],
    workspaceLocks: [
      lock(process.cwd(), "work", "enforce", "0123456789abcdef"),
      lock(parentWorkspace, "work", "enforce"),
      lock(childWorkspace, "personal", "enforce")
    ],
    collectors: {},
    integration: {},
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

async function useRegistry(content) {
  await writeFile(registryPath, content, "utf8");
}

/**
 * The environment a launch starts from. Exporter variables and the config directory are
 * cleared explicitly so the binding and telemetry checks measure the guard rather than the
 * developer's shell.
 */
function baseEnvironment() {
  return {
    ...process.env,
    LOCALAPPDATA: directory,
    CLAUDE_CONFIG_DIR: undefined,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    CLAUDE_WORKSPACE_ACCOUNTS_DISABLE: undefined,
    CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY: undefined,
    CLAUDE_CODE_ENABLE_TELEMETRY: undefined,
    OTEL_RESOURCE_ATTRIBUTES: undefined,
    // Every variable the guard treats as somebody else's exporter, so the injection checks
    // measure the guard rather than the developer's shell.
    ...Object.fromEntries(FOREIGN_OTEL_VARIABLES.map((name) => [name, undefined])),
    FAKE_EMAIL: "work@example.com",
    FAKE_ACCOUNT_ID: "acct-work",
    FAKE_ORG_ID: "org-work"
  };
}

/** Launch the wrapper the way Claude Code does: CLI prefix first, Claude's arguments after. */
function launch(prefix, claudeArguments, options = {}) {
  return spawnSync(WRAPPER, [...prefix, ...claudeArguments], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...baseEnvironment(), ...options.env },
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
}

async function readJson(file) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

const readHealth = () => readJson(healthPath);

let capture = 0;
/** Launch and return the CLAUDE_* / OTEL_* environment the CLI actually received. */
async function launchAndCaptureEnvironment(options = {}) {
  capture += 1;
  const environmentPath = path.join(directory, `child-env-${capture}.json`);
  const result = launch(scriptPrefix, ["--print"], {
    ...options,
    env: { ...options.env, GUARD_ENVIRONMENT_OUT: environmentPath }
  });
  return { result, environment: (await readJson(environmentPath)) ?? {} };
}

try {
  // ================================================================ binding
  await useRegistry(registryDocument());

  const bound = await launchAndCaptureEnvironment({
    env: {
      CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR,
      CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY: "0123456789abcdef"
    }
  });
  check(
    "a bound workspace overrides an ambient config directory",
    bound.result.status === 0
      && bound.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR,
    `status ${bound.result.status}, `
      + `CLAUDE_CONFIG_DIR ${JSON.stringify(bound.environment.CLAUDE_CONFIG_DIR)}, `
      + `stderr ${JSON.stringify(bound.result.stderr)}`
  );

  const boundWithoutAmbient = await launchAndCaptureEnvironment({
    env: { CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY: "0123456789abcdef" }
  });
  check(
    "a bound workspace sets a config directory where there was none",
    boundWithoutAmbient.result.status === 0
      && boundWithoutAmbient.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR,
    JSON.stringify(boundWithoutAmbient.environment.CLAUDE_CONFIG_DIR)
  );

  // The core product promise: two workspaces, two accounts, neither switching the other.
  const inParent = await launchAndCaptureEnvironment({ cwd: parentWorkspace });
  const inChild = await launchAndCaptureEnvironment({ cwd: childWorkspace });
  check(
    "two bound workspaces resolve to two different accounts",
    inParent.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR
      && inChild.environment.CLAUDE_CONFIG_DIR === PERSONAL_CONFIG_DIR
      && inParent.environment.CLAUDE_CONFIG_DIR !== inChild.environment.CLAUDE_CONFIG_DIR,
    `parent ${JSON.stringify(inParent.environment.CLAUDE_CONFIG_DIR)}, `
      + `child ${JSON.stringify(inChild.environment.CLAUDE_CONFIG_DIR)}`
  );
  check(
    "a nested binding wins over the tree it sits in",
    inChild.environment.CLAUDE_CONFIG_DIR === PERSONAL_CONFIG_DIR,
    JSON.stringify(inChild.environment.CLAUDE_CONFIG_DIR)
  );

  const ambientPreserved = await launchAndCaptureEnvironment({
    cwd: unboundWorkspace,
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "an unbound workspace leaves an ambient config directory untouched",
    ambientPreserved.result.status === 0
      && ambientPreserved.environment.CLAUDE_CONFIG_DIR === AMBIENT_CONFIG_DIR,
    JSON.stringify(ambientPreserved.environment.CLAUDE_CONFIG_DIR)
  );

  const ambientUnset = await launchAndCaptureEnvironment({ cwd: unboundWorkspace });
  check(
    "an unbound workspace leaves an unset config directory unset",
    ambientUnset.result.status === 0
      && ambientUnset.environment.CLAUDE_CONFIG_DIR === undefined,
    JSON.stringify(ambientUnset.environment.CLAUDE_CONFIG_DIR)
  );

  // The identity probe must see the bound directory, or it verifies the wrong account.
  const probeLog = path.join(directory, "probe.log");
  await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { FAKE_AUTH_LOG: probeLog, CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  const probed = existsSync(probeLog) ? await readFile(probeLog, "utf8") : "";
  check(
    "the identity probe runs against the bound config directory",
    probed.trim() === WORK_CONFIG_DIR,
    JSON.stringify(probed)
  );

  // A profile with no recorded identity binds without a probe at all.
  const noIdentityLog = path.join(directory, "no-identity.log");
  const noIdentity = await launchAndCaptureEnvironment({
    cwd: childWorkspace,
    env: { FAKE_AUTH_LOG: noIdentityLog }
  });
  check(
    "a profile with no expected identity is bound without verification",
    noIdentity.environment.CLAUDE_CONFIG_DIR === PERSONAL_CONFIG_DIR
      && !existsSync(noIdentityLog),
    existsSync(noIdentityLog) ? "an identity probe ran" : "not bound"
  );

  // Secure storage follows the binding, or credentials would come from the wrong account.
  const secureStorage = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "an ambient secure-storage directory follows the binding",
    secureStorage.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR === WORK_CONFIG_DIR,
    JSON.stringify(secureStorage.environment.CLAUDE_SECURESTORAGE_CONFIG_DIR)
  );

  // ================================================================ lock modes
  await useRegistry(registryDocument({
    workspaceLocks: [lock(parentWorkspace, "work", "off")]
  }));
  const offMode = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "a lock in 'off' mode does not bind",
    offMode.result.status === 0
      && offMode.environment.CLAUDE_CONFIG_DIR === AMBIENT_CONFIG_DIR,
    JSON.stringify(offMode.environment.CLAUDE_CONFIG_DIR)
  );

  await useRegistry(registryDocument({
    workspaceLocks: [lock(parentWorkspace, "work", "warn")]
  }));
  const warned = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { FAKE_ACCOUNT_ID: "acct-somebody-else" }
  });
  const warnedHealth = await readHealth();
  check(
    "a lock in 'warn' mode binds and never blocks on a mismatch",
    warned.result.status === 0
      && warned.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR
      && !warned.result.stderr.includes("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED"),
    `status ${warned.result.status}, stderr ${JSON.stringify(warned.result.stderr)}`
  );
  check(
    "a tolerated mismatch is still recorded",
    warnedHealth?.category === "identity_mismatch",
    JSON.stringify(warnedHealth)
  );

  await useRegistry(registryDocument());
  const enforcedMismatch = launch(scriptPrefix, ["--print"], {
    cwd: parentWorkspace,
    env: { FAKE_ACCOUNT_ID: "acct-somebody-else" }
  });
  check(
    "a lock in 'enforce' mode blocks a genuine identity mismatch",
    enforcedMismatch.status === 78
      && enforcedMismatch.stderr.includes(
        "CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED category=identity_mismatch"
      )
      && !enforcedMismatch.stdout.includes("FAKE_CLAUDE_LAUNCHED"),
    `status ${enforcedMismatch.status}, stderr ${JSON.stringify(enforcedMismatch.stderr)}`
  );
  const blockedHealth = await readHealth();
  check(
    "a blocked launch records its category and exit code",
    blockedHealth?.category === "identity_mismatch"
      && blockedHealth?.exitCode === 78
      && blockedHealth?.schemaVersion === 1
      && typeof blockedHealth?.updatedAt === "string"
      && typeof blockedHealth?.pid === "number",
    JSON.stringify(blockedHealth)
  );
  check(
    "the health record carries an outcome and nothing else",
    Object.keys(blockedHealth ?? {}).sort().join(",")
      === "category,exitCode,pid,schemaVersion,updatedAt",
    Object.keys(blockedHealth ?? {}).join(",")
  );
  check(
    "a matching identity is not blocked",
    launch(scriptPrefix, ["--print"], { cwd: parentWorkspace }).status === 0
  );

  // ================================================================ never block a sign-in
  const signedOut = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { FAKE_SIGNED_OUT: "1" }
  });
  check(
    "a signed-out bound profile still launches, so the user can sign in",
    signedOut.result.status === 0
      && signedOut.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR
      && !signedOut.result.stderr.includes("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED"),
    `status ${signedOut.result.status}, stderr ${JSON.stringify(signedOut.result.stderr)}`
  );
  check(
    "a signed-out bound profile is reported for diagnostics",
    (await readHealth())?.category === "signed_out",
    JSON.stringify(await readHealth())
  );

  const authBroken = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { FAKE_AUTH_EXIT: "9" }
  });
  check(
    "a CLI that cannot report auth status does not stop the launch",
    authBroken.result.status === 0
      && authBroken.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR,
    `status ${authBroken.result.status}, stderr ${JSON.stringify(authBroken.result.stderr)}`
  );

  const authGarbled = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { FAKE_AUTH_GARBAGE: "1" }
  });
  check(
    "an unreadable auth answer does not stop the launch",
    authGarbled.result.status === 0
      && (await readHealth())?.category === "identity_unverifiable",
    `status ${authGarbled.result.status}, health ${JSON.stringify(await readHealth())}`
  );

  // ================================================================ registry faults
  // The binding cache is what keeps a workspace on the right account when the registry
  // cannot be read, instead of silently reverting it to the ambient one.
  await useRegistry("{corrupt");
  const cachedBinding = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "a corrupt registry forwards rather than blocks",
    cachedBinding.result.status === 0
      && !cachedBinding.result.stderr.includes("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED"),
    `status ${cachedBinding.result.status}, stderr ${JSON.stringify(cachedBinding.result.stderr)}`
  );
  check(
    "a corrupt registry keeps the last known binding",
    cachedBinding.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR,
    JSON.stringify(cachedBinding.environment.CLAUDE_CONFIG_DIR)
  );
  check(
    "a corrupt registry is reported for diagnostics",
    ["registry_unavailable", "identity_mismatch", "signed_out", "identity_unverifiable"]
      .includes((await readHealth())?.category),
    JSON.stringify(await readHealth())
  );

  const uncached = await launchAndCaptureEnvironment({
    cwd: unboundWorkspace,
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "a corrupt registry with nothing cached leaves the environment untouched",
    uncached.result.status === 0
      && uncached.environment.CLAUDE_CONFIG_DIR === AMBIENT_CONFIG_DIR
      && (await readHealth())?.category === "registry_unavailable",
    `${JSON.stringify(uncached.environment.CLAUDE_CONFIG_DIR)}, `
      + `health ${JSON.stringify(await readHealth())}`
  );

  await useRegistry(JSON.stringify({ schemaVersion: 2, profiles: [], workspaceLocks: [] }));
  const unsupported = launch(scriptPrefix, ["--print"], { cwd: unboundWorkspace });
  check(
    "an unsupported registry schema forwards rather than blocks",
    unsupported.status === 0 && unsupported.stdout.includes("FAKE_CLAUDE_LAUNCHED"),
    `status ${unsupported.status}, stderr ${JSON.stringify(unsupported.stderr)}`
  );

  await useRegistry(registryDocument({
    workspaceLocks: [lock(parentWorkspace, "work", "sometimes")]
  }));
  const invalidMode = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "an unknown lock mode invalidates the registry without blocking",
    invalidMode.result.status === 0,
    `status ${invalidMode.result.status}, stderr ${JSON.stringify(invalidMode.result.stderr)}`
  );

  await useRegistry(registryDocument({
    workspaceLocks: [lock(unboundWorkspace, "deleted-profile", "enforce")]
  }));
  const ghostProfile = await launchAndCaptureEnvironment({
    cwd: unboundWorkspace,
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "a lock naming a deleted profile forwards with the ambient account",
    ghostProfile.result.status === 0
      && ghostProfile.environment.CLAUDE_CONFIG_DIR === AMBIENT_CONFIG_DIR
      && (await readHealth())?.category === "required_profile_missing",
    `${JSON.stringify(ghostProfile.environment.CLAUDE_CONFIG_DIR)}, `
      + `health ${JSON.stringify(await readHealth())}`
  );

  // The extension can be uninstalled while the launcher survives, because Claude Code's
  // wrapper setting is global. With no guard state there is nothing to bind.
  await rm(registryPath, { force: true });
  const uninstalled = launch(scriptPrefix, ["--echo-stdin"], {
    cwd: parentWorkspace,
    input: "FALLBACK_STDIN_OK\r\n",
    env: { CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR }
  });
  check(
    "a missing registry forwards the launch unchanged",
    uninstalled.status === 0
      && uninstalled.stdout.includes("FAKE_CLAUDE_LAUNCHED")
      && uninstalled.stdout.includes("FALLBACK_STDIN_OK"),
    `status ${uninstalled.status}, stderr ${JSON.stringify(uninstalled.stderr)}`
  );

  // ================================================================ kill switch
  await useRegistry(registryDocument());
  const disabled = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: {
      CLAUDE_CONFIG_DIR: AMBIENT_CONFIG_DIR,
      CLAUDE_WORKSPACE_ACCOUNTS_DISABLE: "1",
      FAKE_ACCOUNT_ID: "acct-somebody-else"
    }
  });
  check(
    "the kill switch bypasses binding and blocking alike",
    disabled.result.status === 0
      && disabled.environment.CLAUDE_CONFIG_DIR === AMBIENT_CONFIG_DIR,
    `status ${disabled.result.status}, `
      + `CLAUDE_CONFIG_DIR ${JSON.stringify(disabled.environment.CLAUDE_CONFIG_DIR)}`
  );

  // ================================================================ pass-through
  const stdinForwarded = launch(scriptPrefix, ["--echo-stdin"], {
    cwd: parentWorkspace,
    input: "WRAPPER_STDIN_OK\r\n"
  });
  check(
    "stdin reaches the CLI",
    stdinForwarded.status === 0
      && stdinForwarded.stdout.includes("FAKE_CLAUDE_LAUNCHED")
      && stdinForwarded.stdout.includes("WRAPPER_STDIN_OK"),
    JSON.stringify(stdinForwarded.stdout)
  );

  // A two-token CLI prefix must be probed and forwarded as one CLI.
  const vectorPath = path.join(directory, "argv.json");
  await rm(vectorPath, { force: true });
  const claudeArguments = ["--print", "--output-format=stream-json", "--verbose", "-p", "a b"];
  const hosted = launch(scriptPrefix, claudeArguments, {
    cwd: parentWorkspace,
    env: { ARGDUMP_OUT: vectorPath }
  });
  const hostedVector = await readJson(vectorPath);
  check(
    "a hosted JavaScript CLI is launched, not its host",
    hosted.status === 0 && hosted.stdout.includes("FAKE_CLAUDE_LAUNCHED"),
    `status ${hosted.status}, stderr ${JSON.stringify(hosted.stderr)}`
  );
  check(
    "a hosted JavaScript CLI receives its arguments byte-exact",
    JSON.stringify(hostedVector) === JSON.stringify(claudeArguments),
    JSON.stringify(hostedVector)
  );

  // A batch-file CLI is a real configuration (an npm-installed claude.cmd).
  const batch = launch([CLI_BATCH], ["--echo-stdin"], {
    cwd: parentWorkspace,
    input: "BATCH_STDIN_OK\r\n"
  });
  check(
    "a batch-file CLI is verified and launched through the command processor",
    batch.status === 0 && batch.stdout.includes("FAKE_CLAUDE_LAUNCHED"),
    `status ${batch.status}, stderr ${JSON.stringify(batch.stderr)}`
  );

  const collision = launch(scriptPrefix, ["--print"], {
    cwd: parentWorkspace,
    env: { FAKE_EXIT_CODE: "78" }
  });
  const collisionHealth = await readHealth();
  check(
    "a CLI exit of 78 is not reported as a guard block",
    collision.status === 78
      && !collision.stderr.includes("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED")
      && collisionHealth?.category === "forwarded",
    `stderr ${JSON.stringify(collision.stderr)}, health ${JSON.stringify(collisionHealth)}`
  );

  // ================================================================ telemetry injection
  const collectorRegistry = (updatedAt) => registryDocument({
    collectors: {
      work: {
        profileId: "work",
        port: 45999,
        token: "collector-token",
        pid: process.pid,
        updatedAt
      }
    }
  });

  await useRegistry(collectorRegistry(new Date().toISOString()));
  const injected = await launchAndCaptureEnvironment({ cwd: parentWorkspace });
  check(
    "a fresh collector registration is injected for the bound profile",
    injected.result.status === 0
      && injected.environment.OTEL_EXPORTER_OTLP_ENDPOINT === "http://127.0.0.1:45999"
      && injected.environment.OTEL_EXPORTER_OTLP_HEADERS
        === "Authorization=Bearer collector-token"
      && injected.environment.CLAUDE_CODE_ENABLE_TELEMETRY === "1"
      && injected.environment.CLAUDE_WORKSPACE_ACCOUNTS_PROFILE_ID === "work",
    `status ${injected.result.status}, environment ${JSON.stringify(injected.environment)}`
  );
  check(
    "the wire format the collector needs is set explicitly",
    injected.environment.OTEL_EXPORTER_OTLP_PROTOCOL === "http/json"
      && injected.environment.OTEL_METRICS_EXPORTER === "otlp"
      && injected.environment.OTEL_LOGS_EXPORTER === "otlp",
    JSON.stringify(injected.environment)
  );
  check(
    "spans are refused rather than beta-enabled",
    // The collector does not accept traces, and enabling them needs a beta flag Workspace Accounts
    // will not set for the user. `none` explicitly, so an inherited `otlp` cannot aim spans at a
    // route that rejects them.
    injected.environment.OTEL_TRACES_EXPORTER === "none"
      && injected.environment.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA === undefined,
    JSON.stringify(injected.environment)
  );
  check(
    "every content-telemetry flag is forced off",
    ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES"]
      .every((name) => injected.environment[name] === "0"),
    JSON.stringify(injected.environment)
  );
  check(
    "the workspace is identified by hash and label, never by path",
    /claude\.account_guard\.workspace_hash=[0-9a-f]{16}/
      .test(injected.environment.OTEL_RESOURCE_ATTRIBUTES ?? "")
      && !(injected.environment.OTEL_RESOURCE_ATTRIBUTES ?? "")
        .includes(normalize(parentWorkspace)),
    JSON.stringify(injected.environment.OTEL_RESOURCE_ATTRIBUTES)
  );

  const preserved = await launchAndCaptureEnvironment({
    cwd: parentWorkspace,
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com" }
  });
  check(
    "an exporter the user configured is never redirected",
    preserved.environment.OTEL_EXPORTER_OTLP_ENDPOINT === "https://collector.example.com",
    JSON.stringify(preserved.environment)
  );

  // The guard used to check four endpoints and three exporter selections, so a user who had set
  // any other part of their own pipeline was injected over and then had every export rejected.
  // Every variable the extension considers foreign must refuse injection outright.
  for (const name of FOREIGN_OTEL_VARIABLES) {
    const foreign = await launchAndCaptureEnvironment({
      cwd: parentWorkspace,
      env: { [name]: name.endsWith("_PROTOCOL") ? "http/protobuf" : "user-value" }
    });
    check(
      `a user's ${name} refuses collector injection outright`,
      foreign.environment.CLAUDE_CODE_ENABLE_TELEMETRY === undefined
        && foreign.environment.OTEL_EXPORTER_OTLP_ENDPOINT
          !== "http://127.0.0.1:45999",
      JSON.stringify(foreign.environment)
    );
  }

  await useRegistry(collectorRegistry(new Date(Date.now() - 600_000).toISOString()));
  const stale = await launchAndCaptureEnvironment({ cwd: parentWorkspace });
  check(
    "a stale collector registration is ignored",
    stale.environment.OTEL_EXPORTER_OTLP_ENDPOINT === undefined,
    JSON.stringify(stale.environment)
  );

  // ================================================================ upstream chaining
  const upstreamPath = path.join(directory, "upstream.cmd");
  const upstreamMarker = path.join(directory, "upstream-argv.txt");
  await writeFile(
    upstreamPath,
    `@echo off\r\n>"${upstreamMarker}" echo %*\r\n%*\r\nexit /b %ERRORLEVEL%\r\n`,
    "utf8"
  );
  await useRegistry(registryDocument({ integration: { upstreamWrapper: upstreamPath } }));
  const chained = await launchAndCaptureEnvironment({ cwd: parentWorkspace });
  check(
    "a chained upstream wrapper receives the whole CLI invocation and launches it",
    chained.result.status === 0
      && chained.result.stdout.includes("FAKE_CLAUDE_LAUNCHED")
      && existsSync(upstreamMarker),
    `status ${chained.result.status}, stderr ${JSON.stringify(chained.result.stderr)}`
  );
  check(
    "a chained launch is still bound",
    chained.environment.CLAUDE_CONFIG_DIR === WORK_CONFIG_DIR,
    JSON.stringify(chained.environment.CLAUDE_CONFIG_DIR)
  );

  await useRegistry(registryDocument({
    integration: { upstreamWrapper: path.join(directory, "does-not-exist.exe") }
  }));
  const missingUpstream = launch(scriptPrefix, ["--print"], { cwd: parentWorkspace });
  check(
    "an upstream wrapper that no longer exists is skipped, not fatal",
    missingUpstream.status === 0 && missingUpstream.stdout.includes("FAKE_CLAUDE_LAUNCHED"),
    `status ${missingUpstream.status}, stderr ${JSON.stringify(missingUpstream.stderr)}`
  );

  // ================================================================ process containment
  await useRegistry(registryDocument());
  const holdPath = path.join(directory, "held.pid");
  await rm(holdPath, { force: true });
  const held = spawn(WRAPPER, [...scriptPrefix, "--print"], {
    cwd: parentWorkspace,
    env: { ...baseEnvironment(), FAKE_HOLD_PID_OUT: holdPath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const started = Date.now() + 30_000;
  while (!existsSync(holdPath) && Date.now() < started) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let containment = "the CLI never started";
  if (existsSync(holdPath)) {
    const childPid = Number(await readFile(holdPath, "utf8"));
    held.kill();
    const deadline = Date.now() + 20_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    containment = alive ? `pid ${childPid} outlived the wrapper` : null;
    if (alive) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  held.kill();
  check("killing the wrapper kills the CLI it started", containment === null, containment ?? "");
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(
    `Windows wrapper guard smoke test: ${failures.length} of ${checks} checks FAILED\n`
  );
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(`Windows wrapper guard smoke test: OK (${checks} checks)`);
