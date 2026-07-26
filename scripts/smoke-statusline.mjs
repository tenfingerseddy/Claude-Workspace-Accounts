// Behaviour smoke test for the native status-line bridge.
//
// Claude runs this component on every status-line refresh, with the session JSON on stdin, and
// displays whatever it writes to stdout. Every case below is a failure the PowerShell version it
// replaces actually had: a long payload wrapped by console-width formatting and then silently
// dropped, a chained command whose quoting was stripped, a profile whose configuration directory
// was a drive root and therefore never matched, an unsanitized workspace label, and - worst - a
// blank status line with exit code 0 whenever anything at all went wrong.
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const failures = [];
let checks = 0;

function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) {
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  }
}

// Windows can expose the same temporary directory in 8.3 form to Node and long form to a child
// process, so canonicalize before sharing paths across the process boundary.
const directory = await realpath(
  await mkdtemp(path.join(await realpath(os.tmpdir()), "claude-account-guard-statusline-"))
);
const supportRoot = path.join(directory, "ClaudeAccountGuard");
const inbox = path.join(supportRoot, "snapshots");
const configDir = path.join(directory, ".claude-work");
const profileBackupDirectory = path.join(configDir, ".claude-account-guard");

// The bridge resolves its guard-owned backup mirror beside its own executable, so run it from a
// copy laid out the way installation lays it out.
const bridgeDirectory = path.join(directory, "wrapper");
const bridge = path.join(bridgeDirectory, "statusline-bridge.exe");
const mirrorDirectory = path.join(bridgeDirectory, "statusline-backups");

// A workspace whose directory name is full of characters that must never reach a telemetry
// attribute or a usage dimension unescaped.
const awkwardWorkspace = path.join(directory, "My Project (v2) & more!");

// A chained status-line command living behind a space in its path, with quoted arguments: the
// exact shape PowerShell 5.1 used to break.
const chainDirectory = path.join(directory, "chain dir");
const chainScript = path.join(chainDirectory, "echo-args.js");
const chainArgumentsPath = path.join(directory, "chain-argv.json");

await Promise.all([
  mkdir(inbox, { recursive: true }),
  mkdir(profileBackupDirectory, { recursive: true }),
  mkdir(mirrorDirectory, { recursive: true }),
  mkdir(awkwardWorkspace, { recursive: true }),
  mkdir(chainDirectory, { recursive: true })
]);
await copyFile(path.resolve("bin/native/win-x64/statusline-bridge.exe"), bridge);
await writeFile(
  chainScript,
  "import fs from \"node:fs\";\n"
    + "import process from \"node:process\";\n"
    + "fs.writeFileSync(process.env.CHAIN_ARGV_OUT, JSON.stringify(process.argv.slice(2)), \"utf8\");\n"
    + "let payload = \"\";\n"
    + "process.stdin.on(\"data\", (chunk) => { payload += chunk; });\n"
    + "process.stdin.on(\"end\", () => {\n"
    + "  fs.writeFileSync(process.env.CHAIN_STDIN_OUT, payload, \"utf8\");\n"
    + "  process.stdout.write(\"CHAINED_STATUS\");\n"
    + "});\n",
  "utf8"
);
const chainStdinPath = path.join(directory, "chain-stdin.txt");
const chainCommand = `"${process.execPath}" "${chainScript}" "a b" c`;

const normalize = (value) =>
  path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
const driveRoot = path.parse(directory).root;
/** The bridge's own rule: lower-cased leaf with everything outside `A-Za-z0-9_.-` replaced. */
const expectedLabel = (value) =>
  path.win32.basename(normalize(value)).replace(/[^A-Za-z0-9_.-]/g, "_");

const workProfile = {
  id: "work",
  displayName: "Work",
  configDir,
  configDirNormalized: normalize(configDir),
  telemetryEnabled: true
};

// A profile installed at a bare drive root. The PowerShell bridge trimmed the trailing separator
// without putting it back, so `C:\` normalized to `c:` and this profile could never be found.
const rootProfile = {
  id: "root",
  displayName: "Root",
  configDir: driveRoot,
  configDirNormalized: normalize(driveRoot) + "\\",
  telemetryEnabled: true
};

async function useRegistry(integration = { telemetryEnabled: true }) {
  await writeFile(path.join(supportRoot, "registry.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    profiles: [workProfile, rootProfile],
    workspaceLocks: [],
    collectors: {},
    integration,
    updatedAt: new Date().toISOString()
  }), "utf8");
}

function sessionPayload(overrides = {}) {
  return JSON.stringify({
    session_id: "session-smoke",
    session_name: "Status smoke",
    model: { id: "claude-opus-4-8", display_name: "Opus" },
    workspace: { current_dir: process.cwd() },
    effort: { level: "high" },
    thinking: { enabled: true },
    fast_mode: false,
    cost: {
      total_cost_usd: 0.5,
      total_duration_ms: 1000,
      total_api_duration_ms: 500,
      total_lines_added: 4,
      total_lines_removed: 1
    },
    context_window: {
      used_percentage: 25,
      remaining_percentage: 75,
      context_window_size: 200000,
      total_input_tokens: 900,
      total_output_tokens: 120,
      current_usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 25
      }
    },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 1784786400 },
      seven_day: { used_percentage: 86, resets_at: 1785225600 }
    },
    ...overrides
  });
}

function runBridge(input, options = {}) {
  return spawnSync(bridge, [], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      LOCALAPPDATA: directory,
      CLAUDE_CONFIG_DIR: options.configDir ?? configDir,
      CHAIN_ARGV_OUT: chainArgumentsPath,
      CHAIN_STDIN_OUT: chainStdinPath
    },
    input,
    encoding: options.encoding ?? "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
}

async function clearInbox() {
  for (const file of await readdir(inbox)) {
    await rm(path.join(inbox, file), { force: true });
  }
}

/** The single snapshot the last run produced, or undefined when it produced none. */
async function latestSnapshot() {
  const files = (await readdir(inbox)).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) {
    return undefined;
  }
  return JSON.parse(
    (await readFile(path.join(inbox, files.at(-1)), "utf8")).replace(/^\uFEFF/, "")
  );
}

async function snapshotCount() {
  return (await readdir(inbox)).filter((file) => file.endsWith(".json")).length;
}

const backupDocument = (command) => JSON.stringify({
  schemaVersion: 1,
  nextStatusLine: { type: "command", command, padding: 2 },
  installedAt: new Date().toISOString()
});

const profileBackupPath = path.join(profileBackupDirectory, "statusline-next.json");
const mirrorBackupPath = path.join(mirrorDirectory, "work.json");

try {
  await useRegistry();

  // ---------------------------------------------------------------- chaining
  await writeFile(profileBackupPath, backupDocument(chainCommand), "utf8");
  await clearInbox();
  await rm(chainArgumentsPath, { force: true });
  const chained = runBridge(sessionPayload());
  check(
    "the previous status-line command is chained and its output passed through",
    chained.status === 0 && chained.stdout.includes("CHAINED_STATUS"),
    `status ${chained.status}, stdout ${JSON.stringify(chained.stdout)}, `
      + `stderr ${JSON.stringify(chained.stderr)}`
  );
  let chainedArguments;
  try {
    chainedArguments = JSON.parse(await readFile(chainArgumentsPath, "utf8"));
  } catch {
    chainedArguments = undefined;
  }
  check(
    "a chained command keeps its own quoting, spaces and all",
    JSON.stringify(chainedArguments) === JSON.stringify(["a b", "c"]),
    JSON.stringify(chainedArguments)
  );
  let chainedStdin;
  try {
    chainedStdin = await readFile(chainStdinPath, "utf8");
  } catch {
    chainedStdin = undefined;
  }
  check(
    "the session payload reaches the chained command unchanged",
    chainedStdin === sessionPayload(),
    JSON.stringify((chainedStdin ?? "").slice(0, 120))
  );

  // ---------------------------------------------------------------- snapshot shape
  const snapshot = await latestSnapshot();
  check(
    "a snapshot is recorded for the bound profile",
    snapshot?.profileId === "work"
      && snapshot?.schemaVersion === 1
      && snapshot?.sessionId === "session-smoke"
      && typeof snapshot?.capturedAt === "string",
    JSON.stringify(snapshot)
  );
  check(
    "quota and context values are recorded where the repository expects them",
    snapshot?.rateLimits?.fiveHour?.usedPercentage === 42
      && snapshot?.rateLimits?.sevenDay?.usedPercentage === 86
      && snapshot?.rateLimits?.sevenDay?.resetsAt === 1785225600
      && snapshot?.contextWindow?.usedPercentage === 25
      && snapshot?.contextWindow?.currentUsage?.cacheRead === 100
      && snapshot?.costUsd === 0.5
      && snapshot?.thinkingEnabled === true
      && snapshot?.fastMode === false
      && snapshot?.effort === "high",
    JSON.stringify(snapshot)
  );
  check(
    "a workspace path is not recorded unless the user opted in",
    snapshot?.workspacePath === null
      && snapshot?.workspaceHash?.length === 16
      && /^[0-9a-f]{16}$/.test(snapshot?.workspaceHash ?? ""),
    JSON.stringify(snapshot)
  );
  check(
    "nothing from the raw payload leaks into the snapshot",
    !Object.hasOwn(snapshot ?? {}, "transcript_path")
      && !Object.hasOwn(snapshot ?? {}, "session_id")
      && !JSON.stringify(snapshot ?? {}).includes("transcript"),
    JSON.stringify(snapshot)
  );

  // ---------------------------------------------------------------- payload fidelity
  // A single-line payload longer than a console width. `Out-String` wrapped this, the parse then
  // failed, and the failure was swallowed by a blanket catch.
  await clearInbox();
  const longName = "L".repeat(6000);
  const longPayload = sessionPayload({ session_name: longName });
  const long = runBridge(longPayload);
  const longSnapshot = await latestSnapshot();
  check(
    "a payload far longer than a console width is read intact",
    long.status === 0 && longSnapshot?.sessionName === longName,
    `status ${long.status}, length ${longSnapshot?.sessionName?.length}, `
      + `stderr ${JSON.stringify(long.stderr)}`
  );

  await clearInbox();
  const unicodeName = "café → 日本語 🎉";
  runBridge(sessionPayload({ session_name: unicodeName }));
  check(
    "a payload is decoded as UTF-8 regardless of console encoding",
    (await latestSnapshot())?.sessionName === unicodeName,
    JSON.stringify((await latestSnapshot())?.sessionName)
  );

  // ---------------------------------------------------------------- workspace identity
  await clearInbox();
  runBridge(sessionPayload({ workspace: { current_dir: awkwardWorkspace } }));
  const awkward = await latestSnapshot();
  check(
    "a workspace label is sanitized before it is recorded",
    awkward?.workspaceLabel === expectedLabel(awkwardWorkspace)
      && /^[A-Za-z0-9_.-]*$/.test(awkward?.workspaceLabel ?? "x"),
    `${JSON.stringify(awkward?.workspaceLabel)} expected `
      + `${JSON.stringify(expectedLabel(awkwardWorkspace))}`
  );

  // The same workspace must hash the same way whichever component recorded it, so the label and
  // hash are derived from one normalization. A trailing separator must not change the identity.
  await clearInbox();
  runBridge(sessionPayload({ workspace: { current_dir: `${awkwardWorkspace}\\` } }));
  check(
    "a trailing separator does not change a workspace's identity",
    (await latestSnapshot())?.workspaceHash === awkward?.workspaceHash,
    `${JSON.stringify((await latestSnapshot())?.workspaceHash)} vs `
      + JSON.stringify(awkward?.workspaceHash)
  );

  // ---------------------------------------------------------------- drive-root profile
  await clearInbox();
  await writeFile(mirrorBackupPath, backupDocument(chainCommand), "utf8");
  const atRoot = runBridge(sessionPayload(), { configDir: driveRoot });
  check(
    "a profile whose configuration directory is a bare drive root still matches",
    atRoot.status === 0 && (await latestSnapshot())?.profileId === "root",
    `status ${atRoot.status}, snapshot ${JSON.stringify(await latestSnapshot())}`
  );

  // ---------------------------------------------------------------- backup fallbacks
  await clearInbox();
  await rm(profileBackupPath, { force: true });
  const viaMirror = runBridge(sessionPayload());
  check(
    "a missing profile backup falls back to the guard-owned mirror",
    viaMirror.status === 0 && viaMirror.stdout.includes("CHAINED_STATUS"),
    `status ${viaMirror.status}, stdout ${JSON.stringify(viaMirror.stdout)}`
  );

  await clearInbox();
  await writeFile(profileBackupPath, "{not json", "utf8");
  const viaMirrorAgain = runBridge(sessionPayload());
  check(
    "a malformed profile backup falls back to the guard-owned mirror",
    viaMirrorAgain.status === 0 && viaMirrorAgain.stdout.includes("CHAINED_STATUS"),
    `status ${viaMirrorAgain.status}, stdout ${JSON.stringify(viaMirrorAgain.stdout)}`
  );

  // ---------------------------------------------------------------- never blank
  await rm(profileBackupPath, { force: true });
  await rm(mirrorBackupPath, { force: true });
  await clearInbox();
  const unchained = runBridge(sessionPayload());
  check(
    "with no command to chain the bridge still writes a status line",
    unchained.status === 0 && unchained.stdout.trim().length > 0,
    `status ${unchained.status}, stdout ${JSON.stringify(unchained.stdout)}`
  );
  check(
    "the fallback status line names the account in play",
    unchained.stdout.includes("Work") && unchained.stdout.includes("Opus"),
    JSON.stringify(unchained.stdout)
  );

  const unparseable = runBridge("this is not json");
  check(
    "an unreadable payload produces a visible marker, not a blank line",
    unparseable.status === 0
      && unparseable.stdout.includes("[account-guard: status line unavailable]"),
    `status ${unparseable.status}, stdout ${JSON.stringify(unparseable.stdout)}`
  );

  const empty = runBridge("");
  check(
    "an empty payload produces a visible marker, not a blank line",
    empty.status === 0
      && empty.stdout.includes("[account-guard: status line unavailable]"),
    `status ${empty.status}, stdout ${JSON.stringify(empty.stdout)}`
  );

  // An unregistered configuration directory is an ordinary state, not a fault: it is what a user
  // sees before they add their first profile. It must produce a real status line rather than an
  // error marker, and no snapshot.
  await clearInbox();
  const unknown = runBridge(sessionPayload(), {
    configDir: path.join(directory, ".claude-unregistered")
  });
  check(
    "an unregistered account gets a real status line, not an error marker",
    unknown.status === 0
      && !unknown.stdout.includes("[account-guard: status line unavailable]")
      && unknown.stdout.includes("Opus"),
    `status ${unknown.status}, stdout ${JSON.stringify(unknown.stdout)}`
  );
  check(
    "an unregistered account produces no snapshot",
    (await snapshotCount()) === 0,
    `snapshots ${await snapshotCount()}`
  );

  // A payload the bridge cannot parse must still reach a chained command untouched, because the
  // user's own status line may well understand a newer schema than this bridge does.
  await writeFile(profileBackupPath, backupDocument(chainCommand), "utf8");
  await rm(chainStdinPath, { force: true });
  const chainedGarbage = runBridge("this is not json");
  check(
    "an unreadable payload is still handed to the chained command verbatim",
    chainedGarbage.status === 0
      && chainedGarbage.stdout.includes("CHAINED_STATUS")
      && (await readFile(chainStdinPath, "utf8")) === "this is not json",
    `stdout ${JSON.stringify(chainedGarbage.stdout)}`
  );

  // ---------------------------------------------------------------- collection gates
  await clearInbox();
  await useRegistry({ telemetryEnabled: false });
  const optedOut = runBridge(sessionPayload());
  check(
    "a global telemetry opt-out stops snapshots and keeps the status line",
    optedOut.status === 0
      && optedOut.stdout.includes("CHAINED_STATUS")
      && (await snapshotCount()) === 0,
    `status ${optedOut.status}, snapshots ${await snapshotCount()}`
  );

  await clearInbox();
  await useRegistry({ telemetryEnabled: true, collectWorkspacePath: true });
  runBridge(sessionPayload());
  check(
    "an explicit opt-in records the full workspace path",
    (await latestSnapshot())?.workspacePath === process.cwd(),
    JSON.stringify((await latestSnapshot())?.workspacePath)
  );

  // A profile with collection disabled must not produce snapshots even when the integration allows
  // it: collection is opt-in on both sides.
  await clearInbox();
  await writeFile(path.join(supportRoot, "registry.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    profiles: [{ ...workProfile, telemetryEnabled: false }, rootProfile],
    workspaceLocks: [],
    collectors: {},
    integration: { telemetryEnabled: true },
    updatedAt: new Date().toISOString()
  }), "utf8");
  const profileOptedOut = runBridge(sessionPayload());
  check(
    "a profile that has not enabled collection produces no snapshot",
    profileOptedOut.status === 0
      && profileOptedOut.stdout.includes("CHAINED_STATUS")
      && (await snapshotCount()) === 0,
    `snapshots ${await snapshotCount()}`
  );

  // A registry that cannot be read must not break the status line either.
  await writeFile(path.join(supportRoot, "registry.json"), "{corrupt", "utf8");
  const corrupt = runBridge(sessionPayload());
  check(
    "a corrupt registry keeps the status line working",
    corrupt.status === 0 && corrupt.stdout.trim().length > 0,
    `status ${corrupt.status}, stdout ${JSON.stringify(corrupt.stdout)}`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Status-line bridge smoke test: ${failures.length} of ${checks} checks FAILED\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(`Status-line bridge smoke test: OK (${checks} checks)`);
