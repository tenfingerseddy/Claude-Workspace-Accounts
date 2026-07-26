# Claude Account Guard

Windows-only VS Code extension for developers with more than one Claude Code account.

**The core feature, in one sentence:** each VS Code workspace can use a different Claude account, so
signing in somewhere else does not change the account every other workspace uses. Local usage
collection is a secondary feature.

Published to the Marketplace as `ResonanceLattice-Semanticus.claude-account-guard`.

## Bind, don't block

The mechanism is `CLAUDE_CONFIG_DIR`. It is a complete per-process account switch — credentials live
at `<configDir>\.credentials.json`, and the official extension derives secure storage from
`CLAUDE_SECURESTORAGE_CONFIG_DIR ?? CLAUDE_CONFIG_DIR`. Verified against the real CLI:

```
$ CLAUDE_CONFIG_DIR=~/.claude-work claude.exe auth status
{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}
```

The process wrapper is the only component that runs on every launch and knows which workspace it is
in, so **the wrapper resolves the workspace's binding and sets `CLAUDE_CONFIG_DIR` on the Claude
process.** That is the whole feature. The binding *is* the enforcement — a workspace cannot be on the
wrong account, because the account is chosen per launch rather than inherited.

An earlier design instead required the user to launch a separate VS Code window per account with its
own `--user-data-dir`, and blocked the launch when the window's ambient `CLAUDE_CONFIG_DIR` did not
match the workspace's lock. That made the product unusable: adding an account opened a blank VS Code
with none of the user's extensions, the new profile had no `expectedIdentity`, and the lock command
filtered to profiles that had one — so it refused with "Verify at least one account profile before
locking a workspace" and there was no path forward. **Do not reintroduce ambient-environment checks or
isolated-window launching.** If a change starts requiring the user to be in a special window, it is
wrong.

Blocking now survives in exactly one case: the bound profile's directory has been re-authenticated as
a different account than the `expectedIdentity` recorded for it, so binding would silently hand over
the wrong account. Not being signed in is **not** a block — Claude prompting for sign-in in the bound
directory is correct behaviour, and blocking there would prevent the user from ever signing in.

`mode` on a binding stays `"enforce" | "warn" | "off"` (schema v1, no migration): `enforce` binds and
blocks on genuine identity mismatch, `warn` binds and never blocks, `off` disables the binding. The UI
does not ask — it uses `claudeAccountGuard.defaultLockMode`.

### What this is not

With fail-open behaviour this is a convenience and safety mechanism, **not a security boundary**. It
does not cover Claude launched outside the official extension, and a determined user can bypass it
with one environment variable. Documentation must state the guarantee at that strength and no higher.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | Extension host code (TypeScript, ESM, bundled to `dist/extension.cjs` by esbuild) |
| `native/Shared/` | Path normalization, JSON reading, registry loading shared by both native binaries |
| `native/WrapperLauncher/` | The process wrapper: C# compiled by in-box `csc.exe` to a small .NET Framework exe |
| `native/StatusLineBridge/` | The status-line bridge, same toolchain — a second binary, not an argv mode of the first |
| `bin/` | `bin/native/win-x64/` build output only, and gitignored. No PowerShell ships any more |
| `scripts/` | Build, package, and smoke-test entry points (`.mjs`, plus `.ts` run through a loader) |
| `test/` | `vitest` unit + integration tests; `test/fixtures/` holds stand-in executables |
| `docs/` | Privacy, telemetry, troubleshooting, feasibility, release-readiness records |

## Commands

```powershell
npm run check      # lint + typecheck + vitest + full e2e chain. The gate.
npm run build      # esbuild bundle + csc compile of the wrapper into bin/native/
npm test           # vitest only
npm run package    # -> artifacts/claude-account-guard.vsix
```

`npm run check` is the contract; run it before declaring anything done. `bin/native/` is gitignored, so
a clean checkout must `npm run build` before the wrapper smoke tests can run.

## The process wrapper is the dangerous part

The official Claude Code extension supports a `claudeCode.claudeProcessWrapper` setting. When set,
Claude Code launches:

```
<wrapper.exe> <claude-cli-path> <claude args...>
```

The wrapper is therefore **on the critical path of every Claude launch in the editor**. Three rules
follow, and all three were learned by breaking them:

**1. Argument fidelity is absolute.** The argument vector handed to the CLI must be byte-identical to
the vector Claude Code spawned. `scripts/smoke-wrapper-args.mjs` asserts this across the flags Claude
Code actually uses. Treat it as a specification, not a test to be adjusted — if a case fails, the
wrapper is wrong.

The original implementation forwarded through `powershell.exe`, which silently corrupted arguments:
`[CmdletBinding()]` bound `--verbose` and `--debug` to PowerShell's own common parameters and dropped
them; `-p` bound to `-PipelineVariable` and swallowed the following value, so `-p "some prompt"`
reached the CLI as nothing at all; PowerShell 5.1's native-argument handling stripped quotes out of
`--mcp-config '{"json":"..."}'`; empty-string arguments vanished; trailing backslashes became quotes.
The user-visible symptom was Claude Code failing with *"When using --print,
--output-format=stream-json requires --verbose"* — a message about a flag the extension had passed and
the wrapper had eaten. **Never reintroduce a shell into the launch path.**

**2. Fail open.** Any unexpected error — I/O, JSON parse, P/Invoke, missing support state, an
unreadable registry — must forward the launch unchanged and record why. A block exits `78` with
`CLAUDE_ACCOUNT_GUARD_BLOCKED category=<category>` on stderr, and identity mismatch is the only
category that still blocks. A bug in the guard must never be able to stop someone from running Claude;
that is the failure the owner actually experienced, and it is why the guarantee is deliberately stated
as convenience rather than security. `CLAUDE_ACCOUNT_GUARD_DISABLE=1` bypasses everything, including
binding, and must stay that way.

Note that exit code `78` is also a legal exit code for the CLI itself; a forwarded `78` must be
recorded as `forwarded`, not as a block.

**3. The integration outlives the extension.** The wrapper is installed to
`%LOCALAPPDATA%\ClaudeAccountGuard\wrapper\` — outside the versioned extension directory — so Claude
Code keeps working across extension upgrades. The cost is that uninstalling the extension leaves a
global setting pointing at a wrapper the user can no longer manage from the UI. Detaching must stay a
first-class, discoverable command, and activation must repair or clear a setting that points at a
missing wrapper. `WrapperIntegrationService` owns this: `configure`, `disable`, `repairIfStale`,
`removeSupportFiles`.

Note the wrapper is now load-bearing rather than optional — per-workspace accounts do not work without
it. So configuring it needs explicit consent that names the setting and says how to undo it, and the
disable command must warn that per-workspace accounts stop working. Both directions have to be obvious;
the owner lost time to a wrapper setting that survived uninstalling the extension.

## Toolchain constraints

- **Windows only, local only.** `activate` bails out on non-`win32` and on any `vscode.env.remoteName`.
- **The wrapper compiles with in-box `csc.exe`** (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319`), not
  the `dotnet` SDK. No NuGet, no external DLLs — the .NET Framework 4.x runtime is present on every
  Windows 10/11 machine, which is why the launcher can be a few kilobytes and start instantly. If you
  need JSON in the wrapper, hand-write the reader.
- **VS Code 1.130+** is required because usage storage uses the extension host's built-in `node:sqlite`.
  No native database addon is packaged; do not add one.

## Privacy invariants

These are load-bearing claims made in `docs/privacy.md` and the Marketplace listing. Do not weaken them
without changing the documentation in the same commit.

- Claude credential files are never opened, copied, read, displayed, or stored. Identity comes only from
  `claude auth status`.
- Telemetry is loopback-only with an ephemeral token, and the wrapper forces `OTEL_LOG_USER_PROMPTS`,
  `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and
  `OTEL_LOG_RAW_API_BODIES` to `"0"`. It refuses to inject any OTEL configuration if the user already
  has their own exporter or endpoint set.
- `wrapper-health.json` carries only `{schemaVersion, updatedAt, category, exitCode, pid}`. Never add
  arguments, environment, paths, or auth output to it.
- Workspace paths are stored as a label plus a SHA-256 prefix unless the user opts in via
  `claudeAccountGuard.privacy.collectWorkspacePath`.

## Conventions

- TypeScript is strict ESM with `.js` import specifiers; the bundle output is CJS.
- Registry writes go through `ProfileRegistry` and are atomic (temp file + rename) because the wrapper
  reads the same file from another process. A malformed registry is preserved, never overwritten —
  it may be the only copy of a user's workspace locks.
- Absent data is reported as absent. The dashboard distinguishes unavailable, awaiting-data, and stale
  rather than showing a zero or a guess; quota windows are frequently legitimately missing.
- Comments explain why, not what, and are reserved for the non-obvious — the wrapper is full of
  constraints that look arbitrary until you know the failure they prevent.
