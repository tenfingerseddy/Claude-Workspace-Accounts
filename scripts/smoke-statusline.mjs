import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Windows can expose the same temporary directory in 8.3 form to Node and long
// form to Windows PowerShell. Canonicalize it before sharing paths across the
// process boundary so registry/profile comparisons stay deterministic.
const tempRoot = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(tempRoot, "claude-account-guard-statusline-"));
const configDir = path.join(directory, ".claude-work");
const registryDirectory = path.join(directory, "ClaudeAccountGuard");
const bridgeDirectory = path.join(configDir, ".claude-account-guard");
await Promise.all([
  mkdir(registryDirectory, { recursive: true }),
  mkdir(bridgeDirectory, { recursive: true })
]);

const normalizedConfig = path.win32.normalize(configDir).replace(/[\\/]+$/, "").toLowerCase();
await writeFile(path.join(registryDirectory, "registry.json"), JSON.stringify({
  schemaVersion: 1,
  revision: 1,
  profiles: [
    {
      id: "work",
      displayName: "Work",
      configDir,
      configDirNormalized: normalizedConfig,
      telemetryEnabled: true
    }
  ],
  workspaceLocks: [],
  collectors: {},
  integration: { telemetryEnabled: true },
  updatedAt: new Date().toISOString()
}), "utf8");
await writeFile(path.join(bridgeDirectory, "statusline-next.json"), JSON.stringify({
  schemaVersion: 1,
  nextStatusLine: {
    type: "command",
    command: "echo CHAINED_STATUS",
    padding: 2
  }
}), "utf8");

const input = JSON.stringify({
  session_id: "session-smoke",
  session_name: "Status smoke",
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  workspace: { current_dir: process.cwd() },
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
  }
});

const runBridge = () => spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.resolve("bin/statusline-bridge.ps1")
  ], {
    env: {
      ...process.env,
      LOCALAPPDATA: directory,
      CLAUDE_CONFIG_DIR: configDir
    },
    input,
    encoding: "utf8",
    windowsHide: true
  });

try {
  const result = runBridge();
  if (result.status !== 0 || !result.stdout.includes("CHAINED_STATUS")) {
    throw new Error(`Existing status line was not chained: ${result.stderr || result.stdout}`);
  }
  const inbox = path.join(registryDirectory, "snapshots");
  const files = (await readdir(inbox).catch((error) => {
    throw new Error(
      `The status-line bridge did not create its snapshot inbox: ${
        error instanceof Error ? error.message : String(error)
      }. Bridge stderr: ${result.stderr || "(empty)"}`
    );
  })).filter((file) => file.endsWith(".json"));
  if (files.length !== 1) {
    throw new Error("The status snapshot was not written atomically.");
  }
  const snapshot = JSON.parse(
    (await readFile(path.join(inbox, files[0]), "utf8")).replace(/^\uFEFF/, "")
  );
  if (snapshot.profileId !== "work"
    || snapshot.rateLimits.fiveHour.usedPercentage !== 42
    || snapshot.contextWindow.usedPercentage !== 25
    || snapshot.workspacePath != null
    || Object.hasOwn(snapshot, "transcript_path")) {
    throw new Error("The status snapshot was not normalized safely.");
  }
  await writeFile(path.join(registryDirectory, "registry.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    profiles: [{
      id: "work",
      displayName: "Work",
      configDir,
      configDirNormalized: normalizedConfig,
      telemetryEnabled: true
    }],
    workspaceLocks: [],
    collectors: {},
    integration: { telemetryEnabled: false },
    updatedAt: new Date().toISOString()
  }), "utf8");
  const disabled = runBridge();
  const afterDisabled = (await readdir(inbox)).filter((file) => file.endsWith(".json"));
  if (disabled.status !== 0
    || !disabled.stdout.includes("CHAINED_STATUS")
    || afterDisabled.length !== 1) {
    throw new Error("Global telemetry opt-out did not stop snapshots while preserving the user status line.");
  }
  await writeFile(path.join(registryDirectory, "registry.json"), JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    profiles: [{
      id: "work",
      displayName: "Work",
      configDir,
      configDirNormalized: normalizedConfig,
      telemetryEnabled: true
    }],
    workspaceLocks: [],
    collectors: {},
    integration: {
      telemetryEnabled: true,
      collectWorkspacePath: true
    },
    updatedAt: new Date().toISOString()
  }), "utf8");
  const optedIn = runBridge();
  const afterOptIn = (await readdir(inbox)).filter((file) => file.endsWith(".json"));
  const optedInSnapshot = JSON.parse(
    (await readFile(path.join(inbox, afterOptIn.sort().at(-1)), "utf8")).replace(/^\uFEFF/, "")
  );
  if (optedIn.status !== 0
    || afterOptIn.length !== 2
    || optedInSnapshot.workspacePath !== process.cwd()) {
    throw new Error("Explicit full workspace-path collection did not follow the privacy setting.");
  }
  console.log("Status-line bridge executable smoke test: OK");
} finally {
  await rm(directory, { recursive: true, force: true });
}
