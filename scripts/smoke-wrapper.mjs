import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(path.join(os.tmpdir(), "claude-account-guard-wrapper-"));
const registryDirectory = path.join(directory, "ClaudeAccountGuard");
await mkdir(registryDirectory, { recursive: true });

const normalizedWorkspace = path.win32.normalize(process.cwd()).replace(/[\\/]+$/, "").toLowerCase();
const registry = {
  schemaVersion: 1,
  revision: 1,
  profiles: [
    {
      id: "work",
      displayName: "Work",
      configDir: "C:\\profiles\\work",
      configDirNormalized: "c:\\profiles\\work",
      expectedIdentity: {
        email: "work@example.com",
        accountId: "acct-work",
        organizationId: "org-work"
      }
    }
  ],
  workspaceLocks: [
    {
      workspaceUri: "file:///legacy-folder-window",
      workspacePathNormalized: normalizedWorkspace,
      workspaceLabel: "legacy-folder-window",
      profileId: "personal",
      mode: "enforce"
    },
    {
      workspaceUri: "file:///workspace",
      workspaceKey: "0123456789abcdef",
      workspacePathNormalized: normalizedWorkspace,
      workspaceLabel: "workspace",
      profileId: "work",
      mode: "enforce"
    }
  ],
  collectors: {},
  integration: {},
  updatedAt: new Date().toISOString()
};
await writeFile(
  path.join(registryDirectory, "registry.json"),
  JSON.stringify(registry),
  "utf8"
);

const wrapper = path.resolve("bin/native/win-x64/claude-account-guard-wrapper.exe");
const fakeClaude = path.resolve("test/fixtures/fake-claude.cmd");
const run = (configDir, fakeEmail = "work@example.com", fakeAccountId = "acct-work") => spawnSync(wrapper, [
  fakeClaude,
  "--echo-stdin"
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    LOCALAPPDATA: directory,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY: "0123456789abcdef",
    FAKE_EMAIL: fakeEmail,
    FAKE_ACCOUNT_ID: fakeAccountId
  },
  input: "WRAPPER_STDIN_OK\r\n",
  encoding: "utf8",
  windowsHide: true
});

try {
  const allowed = run("C:\\profiles\\work");
  if (allowed.status !== 0
    || !allowed.stdout.includes("FAKE_CLAUDE_LAUNCHED")
    || !allowed.stdout.includes("WRAPPER_STDIN_OK")) {
    throw new Error(`Matching wrapper launch failed: ${allowed.error?.message || allowed.stderr || allowed.stdout || `status ${allowed.status}`}`);
  }
  const blocked = run("C:\\profiles\\personal");
  if (blocked.status !== 78
    || !blocked.stderr.includes("runtime_profile_mismatch")
    || blocked.stdout.includes("FAKE_CLAUDE_LAUNCHED")) {
    throw new Error(`Mismatched wrapper launch was not fail-closed: ${blocked.stderr || blocked.stdout}`);
  }
  const drifted = run("C:\\profiles\\work", "personal@example.com", "acct-personal");
  if (drifted.status !== 78
    || !drifted.stderr.includes("identity_mismatch")
    || drifted.stdout.includes("FAKE_CLAUDE_LAUNCHED")) {
    throw new Error(`Identity drift was not fail-closed: ${drifted.stderr || drifted.stdout}`);
  }

  await writeFile(path.join(registryDirectory, "registry.json"), "{corrupt", "utf8");
  const corruptRegistry = run("C:\\profiles\\work");
  if (corruptRegistry.status !== 78
    || !corruptRegistry.stderr.includes("registry_unavailable")
    || corruptRegistry.stdout.includes("FAKE_CLAUDE_LAUNCHED")) {
    throw new Error(
      `A corrupt registry did not fail closed: ${corruptRegistry.stderr || corruptRegistry.stdout}`
    );
  }
  const wrapperHealth = JSON.parse(
    (await readFile(path.join(registryDirectory, "wrapper-health.json"), "utf8"))
      .replace(/^\uFEFF/, "")
  );
  if (wrapperHealth.category !== "registry_unavailable"
    || wrapperHealth.exitCode !== 78
    || Object.hasOwn(wrapperHealth, "arguments")
    || Object.hasOwn(wrapperHealth, "environment")) {
    throw new Error("The wrapper health record was missing or contained unsafe detail.");
  }
  await writeFile(
    path.join(registryDirectory, "registry.json"),
    JSON.stringify(registry),
    "utf8"
  );

  const fallbackDirectory = path.join(directory, "uninstalled-support");
  await mkdir(fallbackDirectory, { recursive: true });
  const fallbackWrapper = path.join(fallbackDirectory, path.basename(wrapper));
  await copyFile(wrapper, fallbackWrapper);
  const fallback = spawnSync(fallbackWrapper, [
    process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/c",
    fakeClaude,
    "--echo-stdin"
  ], {
    cwd: process.cwd(),
    env: process.env,
    input: "FALLBACK_STDIN_OK\r\n",
    encoding: "utf8",
    windowsHide: true
  });
  if (fallback.status !== 0
    || !fallback.stdout.includes("FAKE_CLAUDE_LAUNCHED")
    || !fallback.stdout.includes("FALLBACK_STDIN_OK")) {
    throw new Error(
      `Wrapper uninstall fallback did not preserve Claude startup: ${
        fallback.error?.message || fallback.stderr || fallback.stdout || `status ${fallback.status}`
      }`
    );
  }
  console.log("Windows wrapper executable smoke test: OK");
} finally {
  await rm(directory, { recursive: true, force: true });
}
