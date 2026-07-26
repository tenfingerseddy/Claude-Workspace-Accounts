// Argument-fidelity gate for the Claude process wrapper.
//
// The wrapper sits between the official Claude Code extension and the Claude CLI. Any
// argument it drops, merges, re-quotes, or expands is a defect: Claude Code launches with
// flags such as `-p`, `--verbose`, `--mcp-config <json>`, and empty string values, and a
// lossy hand-off produces failures that look like Claude bugs.
//
// Every case below asserts that the vector the CLI receives is byte-identical to the
// vector the extension spawned. Do not relax a case to make an implementation pass.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const WRAPPER = path.resolve("bin/native/win-x64/claude-workspace-accounts-wrapper.exe");
const failures = [];
let checks = 0;

const directory = await mkdtemp(path.join(os.tmpdir(), "claude-workspace-accounts-args-"));
const supportRoot = path.join(directory, "ClaudeWorkspaceAccounts");
await mkdir(supportRoot, { recursive: true });

const compiler = path.join(
  process.env.WINDIR ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe"
);
const argDump = path.join(directory, "argdump.exe");
await run(compiler, [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  `/out:${argDump}`,
  path.resolve("test/fixtures/ArgDump.cs")
], { windowsHide: true });

// A batch-file CLI is a real configuration: an npm-installed `claude.cmd` on PATH.
const argDumpShim = path.join(directory, "argdump-shim.cmd");
await writeFile(
  argDumpShim,
  `@echo off\r\n"${argDump}" %*\r\n`,
  "utf8"
);

const normalizedWorkspace = path.win32
  .normalize(process.cwd())
  .replace(/[\\/]+$/, "")
  .toLowerCase();

const enforcedRegistry = {
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

const registryPath = path.join(supportRoot, "registry.json");

async function useEnforcedRegistry() {
  await writeFile(registryPath, JSON.stringify(enforcedRegistry), "utf8");
}

async function useNoRegistry() {
  await rm(registryPath, { force: true });
}

function invoke(claudeBinary, claudeArguments, options = {}) {
  const dumpPath = path.join(directory, "argv.json");
  return {
    dumpPath,
    result: spawnSync(WRAPPER, [claudeBinary, ...claudeArguments], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCALAPPDATA: directory,
        CLAUDE_CONFIG_DIR: "C:\\profiles\\work",
        CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY: "0123456789abcdef",
        ARGDUMP_OUT: dumpPath,
        FAKE_EMAIL: "work@example.com",
        FAKE_ACCOUNT_ID: "acct-work",
        FAKE_ORG_ID: "org-work"
      },
      windowsHide: true,
      encoding: options.encoding ?? "utf8",
      input: options.input,
      maxBuffer: 32 * 1024 * 1024
    })
  };
}

async function expectFidelity(label, claudeArguments, claudeBinary = argDump) {
  checks += 1;
  const dumpPath = path.join(directory, "argv.json");
  await rm(dumpPath, { force: true });
  const { result } = invoke(claudeBinary, claudeArguments);
  let received;
  try {
    received = JSON.parse(await readFile(dumpPath, "utf8"));
  } catch {
    failures.push(
      `${label}: the CLI was never reached or wrote no argument vector `
        + `(status ${result.status}, stderr ${JSON.stringify((result.stderr ?? "").slice(0, 400))})`
    );
    return;
  }
  const expected = JSON.stringify(claudeArguments);
  const actual = JSON.stringify(received);
  if (expected !== actual) {
    failures.push(`${label}:\n    expected ${expected}\n    received ${actual}`);
  }
}

function check(label, condition, detail = "") {
  checks += 1;
  if (!condition) {
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  }
}

// The exact vector the installed Claude Code extension uses, plus the flags that a
// PowerShell-hosted wrapper silently consumes as common parameters.
const FIDELITY_CASES = [
  ["claude code stream-json launch", ["--print", "--output-format=stream-json", "--verbose"]],
  ["separated stream-json launch", ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]],
  ["verbose alone", ["--verbose"]],
  ["debug alone", ["--debug"]],
  ["print flag with prompt value", ["-p", "hello world from claude"]],
  ["short flag colliding with a common parameter", ["-p", "summarize"]],
  ["common parameter abbreviations", ["--ea", "--ov", "--pv", "--wa", "--wv", "--iv", "--ob"]],
  ["mcp config json", ["--mcp-config", '{"mcpServers":{"x":{"command":"y","args":["a b"]}}}']],
  ["json with escaped quotes", ["--settings", '{"env":{"A":"b\\"c"}}']],
  ["empty string value", ["--print", "", "--model", "sonnet"]],
  ["embedded double quotes", ["-p", 'say "hi" now']],
  ["shell metacharacters", ["-p", "a;b,c&d|e"]],
  ["value that looks like a flag", ["-p", "--not-a-flag"]],
  ["bare dash", ["--print", "-"]],
  ["powershell expansion characters", ["-p", "cost $5 `x` @y"]],
  ["cmd expansion characters", ["-p", "%USERPROFILE% %%x%% !DELAYED!"]],
  ["caret and parentheses", ["-p", "^caret^ (paren) [bracket] {brace}"]],
  ["single quotes", ["-p", "'single quoted'"]],
  ["trailing backslash", ["--append-system-prompt", "trailing backslash\\"]],
  ["quoted path with trailing separator", ["--add-dir", "C:\\path with space\\"]],
  ["tool permission syntax", ["--allowedTools", "Bash(git status:*)", "--disallowedTools", "Read(./secret/**)"]],
  ["tab character", ["-p", "tab\there"]],
  ["newline in value", ["--append-system-prompt", "line one\nline two"]],
  ["unicode value", ["-p", "unicode: caf\u00e9 \u2192 \u65e5\u672c\u8a9e \ud83c\udf89"]],
  ["repeated flags preserve order", ["--add-dir", "a", "--add-dir", "b", "--add-dir", "a"]],
  ["long value", ["-p", "x".repeat(4000)]],
  ["no arguments", []]
];

try {
  // Fidelity must hold on the unguarded path (no registry present)...
  await useNoRegistry();
  for (const [label, argumentVector] of FIDELITY_CASES) {
    await expectFidelity(`passthrough / ${label}`, argumentVector);
  }
  await expectFidelity(
    "passthrough / batch-file CLI",
    ["--print", "-p", "hello world", "--mcp-config", '{"a":"b c"}'],
    argDumpShim
  );

  // ...and on the guarded path, where an enforced lock verifies identity first.
  await useEnforcedRegistry();
  for (const [label, argumentVector] of FIDELITY_CASES) {
    await expectFidelity(`enforced / ${label}`, argumentVector);
  }
  await expectFidelity(
    "enforced / batch-file CLI",
    ["--print", "-p", "hello world", "--mcp-config", '{"a":"b c"}'],
    argDumpShim
  );

  // Exit codes must survive unchanged, including one that collides with the guard's
  // own blocked code, so callers can distinguish a Claude failure from a guard block.
  for (const code of [0, 1, 2, 42, 78, 130]) {
    const { result } = invoke(argDump, ["--exit-code", String(code)]);
    check(
      `exit code ${code} is forwarded`,
      result.status === code,
      `received ${result.status}`
    );
    if (code === 78) {
      check(
        "a forwarded exit 78 is not recorded as a guard block",
        !(result.stderr ?? "").includes("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED"),
        JSON.stringify((result.stderr ?? "").slice(0, 200))
      );
    }
  }

  // stdout must be byte-exact: no BOM, no injected newline, no CRLF rewriting.
  const exact = invoke(argDump, ["--exact-stdout"], { encoding: "buffer" });
  check(
    "stdout is byte-exact",
    Buffer.compare(exact.result.stdout, Buffer.from('{"type":"exact"}', "utf8")) === 0,
    JSON.stringify(exact.result.stdout.toString("utf8"))
  );

  // stdout and stderr must stay on their own channels; stream-json parsing breaks otherwise.
  const channels = invoke(argDump, ["--write-stderr"]);
  check(
    "stdout carries only stdout",
    channels.result.stdout === "ARGDUMP_STDOUT",
    JSON.stringify(channels.result.stdout)
  );
  check(
    "stderr carries only stderr",
    channels.result.stderr === "ARGDUMP_STDERR",
    JSON.stringify(channels.result.stderr)
  );

  // stdin must reach the CLI unmodified.
  const stdin = invoke(argDump, ["--echo-stdin"], { input: '{"type":"user"}\n' });
  check(
    "stdin is forwarded",
    stdin.result.stdout === '{"type":"user"}\n',
    JSON.stringify(stdin.result.stdout)
  );

  // An explicit kill switch must bypass the guard entirely, so a broken guard can never
  // leave a user unable to run Claude.
  await useEnforcedRegistry();
  const disabledDump = path.join(directory, "argv.json");
  await rm(disabledDump, { force: true });
  const disabled = spawnSync(WRAPPER, [argDump, "--print", "-p", "hello world", "--verbose"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCALAPPDATA: directory,
      CLAUDE_CONFIG_DIR: "C:\\profiles\\mismatched",
      CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY: "0123456789abcdef",
      CLAUDE_WORKSPACE_ACCOUNTS_DISABLE: "1",
      ARGDUMP_OUT: disabledDump
    },
    windowsHide: true,
    encoding: "utf8"
  });
  check(
    "CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1 bypasses the guard",
    disabled.status === 0,
    `status ${disabled.status}, stderr ${JSON.stringify((disabled.stderr ?? "").slice(0, 300))}`
  );
  try {
    check(
      "CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1 still forwards arguments intact",
      JSON.stringify(JSON.parse(await readFile(disabledDump, "utf8")))
        === JSON.stringify(["--print", "-p", "hello world", "--verbose"])
    );
  } catch {
    failures.push("CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1 still forwards arguments intact: no vector written");
  }

  // The same escape hatch under the name v0.1.0 documented and shipped. A persistent `setx`
  // value or a checked-in workspace `terminal.integrated.env.windows` entry survives an
  // extension rename, so both names bypass the guard permanently.
  await rm(disabledDump, { force: true });
  const legacyDisabled = spawnSync(WRAPPER, [argDump, "--print", "-p", "hello world", "--verbose"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCALAPPDATA: directory,
      CLAUDE_CONFIG_DIR: "C:\\profiles\\mismatched",
      CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY: "0123456789abcdef",
      CLAUDE_WORKSPACE_ACCOUNTS_DISABLE: undefined,
      CLAUDE_ACCOUNT_GUARD_DISABLE: "1",
      ARGDUMP_OUT: disabledDump
    },
    windowsHide: true,
    encoding: "utf8"
  });
  check(
    "CLAUDE_ACCOUNT_GUARD_DISABLE=1 bypasses the guard",
    legacyDisabled.status === 0,
    `status ${legacyDisabled.status}, `
      + `stderr ${JSON.stringify((legacyDisabled.stderr ?? "").slice(0, 300))}`
  );
  try {
    check(
      "CLAUDE_ACCOUNT_GUARD_DISABLE=1 still forwards arguments intact",
      JSON.stringify(JSON.parse(await readFile(disabledDump, "utf8")))
        === JSON.stringify(["--print", "-p", "hello world", "--verbose"])
    );
  } catch {
    failures.push("CLAUDE_ACCOUNT_GUARD_DISABLE=1 still forwards arguments intact: no vector written");
  }

  // A malformed invocation is a launch failure with its own exit code, not the guard's refusal.
  const emptyInvocation = spawnSync(WRAPPER, [], {
    cwd: process.cwd(),
    env: { ...process.env, LOCALAPPDATA: directory },
    windowsHide: true,
    encoding: "utf8"
  });
  check(
    "an empty invocation does not exit with the guard's blocked code",
    emptyInvocation.status === 64
      && !(emptyInvocation.stderr ?? "").includes("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED"),
    `status ${emptyInvocation.status}, `
      + `stderr ${JSON.stringify((emptyInvocation.stderr ?? "").slice(0, 300))}`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Wrapper argument-fidelity gate: ${failures.length} of ${checks} checks FAILED\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log(`Wrapper argument-fidelity gate: OK (${checks} checks)`);
