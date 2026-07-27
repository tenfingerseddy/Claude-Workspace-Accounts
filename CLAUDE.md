# Claude Workspace Accounts

Windows-only VS Code extension for developers with more than one Claude Code account.

**The core feature, in one sentence:** each VS Code workspace can use a different Claude account, so
signing in somewhere else does not change the account every other workspace uses. Local usage
collection is a secondary feature.

Published to the Marketplace as `ResonanceLattice-Semanticus.claude-workspace-accounts`.

## The rename, and why nothing may un-migrate

Up to and including v0.1.0 this shipped as **Claude Account Guard**
(`ResonanceLattice-Semanticus.claude-account-guard`). The name described a product that blocked
launches; the product now *selects* an account, so 0.2.0 renamed everything: display name, extension
`name`, the `claudeAccountGuard.` command and configuration namespace (now `claudeAccounts.`), the
`CLAUDE_ACCOUNT_GUARD_` environment prefix (now `CLAUDE_WORKSPACE_ACCOUNTS_`),
`%LOCALAPPDATA%\ClaudeAccountGuard` (now `ClaudeWorkspaceAccounts`), the per-profile
`.claude-account-guard` directory, the C# namespace, and `claude-account-guard-wrapper.exe`. The
status-line bridge executable name is deliberately **unchanged**, which is what still lets
`isStatusLineBridgeCommand` recognise a bridge command installed by the old release.

Because the extension `name` changed, this is a new Marketplace listing rather than an upgrade path,
so `src/migration/legacyMigration.ts` exists to stop the rename orphaning an existing installation.
Its rules are load-bearing:

- **It copies; it never moves.** `registry.json` is often the only copy of a user's bindings. The old
  directory is left intact and a marker file is written into it — the single write this codebase ever
  makes to the old support root.
- **It never overwrites the destination**, which is what makes it resumable after a partial failure
  and a no-op on the second activation.
- **It runs before anything reads support state.** `ProfileRegistry.initialize()` creates an empty
  registry when there is none, so migrating after it would present an upgrading user with no accounts.
- **It fails open** and records every step to `migration-report.json`, which the diagnostics report
  reads back. A migration defect must never stop activation or block a Claude launch.
- It rewrites only what it can prove is ours: a `claudeCode.claudeProcessWrapper` naming the *old*
  wrapper executable, and a `statusLine` command matched by the one shared bridge matcher. Anything
  else belongs to somebody else and is left completely alone.
- `SETTING_KEYS` is checked against `package.json` by a test, so a configuration property added later
  cannot be silently stranded in the old namespace.

### Names a rename must not touch

A blanket rename is dangerous in exactly one place: strings that must keep naming the *old* thing.
Four defects of this shape were found in this one rename, so check this list before any future sweep.

- `CLAUDE_ACCOUNT_GUARD_DISABLE` is a **permanent alias** for the kill switch. It was documented and
  shipped in v0.1.0; a `setx` value or a checked-in `terminal.integrated.env.windows` entry survives a
  rename and no migration can reach either, so dropping it would leave someone believing the wrapper
  was bypassed while binding and telemetry were quietly active again.
- `claude-account-guard-wrapper.exe` must stay in `OBSOLETE_SUPPORT_FILES` and must stay recognised by
  `isManagedWrapperPath`, or upgrade cleanup becomes a no-op and Disconnect refuses to detach a wrapper
  it installed itself.
- `.claude-account-guard` remains a read-only fallback location for a profile's `statusline-next.json`,
  consulted after the migrated `.claude-workspace-accounts`. When the migration cannot move that
  directory it holds the only record of the user's previous status line.
- The `claude.account_guard.*` OTLP resource attributes are a wire contract between the wrapper and
  `normalizers.ts`/`usageRepository.ts`. Renaming them would silently split usage history in two.
  During an upgrade the *old* wrapper can still be emitting to the *new* collector, so they are
  deliberately unrenamed.

Conversely, `GuardSupport.Resolve()` deliberately has **no** fallback to the old support root. The
wrapper only ever runs once the new extension has installed and configured it, which is after the
migration copied `registry.json`; a legacy-root fallback would give the wrapper a second source of
truth for bindings, which is worse than not finding one.

Registry schema stays at version 1 with no migration. In particular `workspaceLocks` and its `mode`
field keep their names because both native binaries read them; only what the *user* sees says
"bind" rather than "lock".

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
does not ask — it uses `claudeAccounts.defaultBindMode`.

### Identity verification works — an earlier note here said it did not

An earlier revision of this file recorded that `claude auth status` returns `email`, `orgId` and
`orgName` as `null` whenever `CLAUDE_CONFIG_DIR` is set, and built three layers of the product around
that. **Re-verified against 2.1.220's bundled binary, it reports full identity, per directory:**

```
$ CLAUDE_CONFIG_DIR=~/.claude-work     claude auth status  -> kane…@nexwave.com.au, orgName "nexwave", team
$ CLAUDE_CONFIG_DIR=~/.claude-personal claude auth status  -> kanesnyder1@gmail.com, max
$ claude auth status                                       -> the ambient directory's account
```

So `compareIdentity` can genuinely detect a bound directory re-authenticated as somebody else, and
`enforce` is a real mode rather than a synonym for `warn`. There is still no `accountId` field; email
and organization are the identity.

#### Why `CLAUDE_SECURESTORAGE_CONFIG_DIR` cannot replace `CLAUDE_CONFIG_DIR`

Switching `CLAUDE_CONFIG_DIR` relocates chat transcripts along with the account, because the CLI keeps
them under `<configDir>\projects\`. The official extension resolves that path from the *extension
host's* environment, which the wrapper never touches, so the history picker reads the default root
while the CLI writes to the bound one — an empty picker, and a blank window on reload when the
extension asks to resume a session id the CLI cannot see. There is no setting that fixes this;
`claudeCode.environmentVariables` configures the launched process, not the host.

The obvious escape is to inject only `CLAUDE_SECURESTORAGE_CONFIG_DIR`, since the CLI resolves
`.credentials.json` from it (`bk()` → `_k()` → `CLAUDE_SECURESTORAGE_CONFIG_DIR ?? CLAUDE_CONFIG_DIR`),
leaving history shared. **Do not.** Tested against 2.1.220, the two variables split what should be one
answer — `auth status` takes `email`/`orgId`/`orgName` from the *config* directory and the credential
from the *secure-storage* directory:

```
CONFIG=.claude-personal SECURESTORAGE=.claude-work -> kanesnyder1@gmail.com, subscriptionType "team"
CONFIG=.claude-work SECURESTORAGE=.claude-personal -> kane…@nexwave.com.au,  subscriptionType "max"
```

`subscriptionType` is the tell: it follows the credential while the identity fields follow the config
directory. So a secure-storage-only design would run as one account while `auth status` — the single
source `compareIdentity`, `expectedIdentity` and `enforce` all depend on — confidently named the other.
That converts identity verification from a real check into a wrong answer, which is worse than the
history split it was meant to solve. Pointing secure storage at a directory with no `.credentials.json`
returns `loggedIn: false`, which is how the split was isolated.

The rules that came out of the wrong finding are mostly still right, for better reasons:

- **Still never gate registration or binding on identity being available.** It is available now, but
  an account can be signed out, and a probe can fail; neither is a reason to refuse to register.
- Verify without setting `CLAUDE_CONFIG_DIR` when the profile is the ambient default. Harmless, and
  it keeps one less variable in play.
- What must change: UI and docs may no longer claim a wrong-account change cannot be detected, and
  `defaultBindMode` no longer has a reason to be `warn` — it was set that way solely because
  `enforce` named a behaviour believed impossible.

The lesson worth keeping is the one about method. That claim was recorded as verified, cited a version
number, and shaped `defaultBindMode`, the registration flow and the UI copy — and it was wrong. Re-test
a load-bearing claim about the CLI before building a third layer on it.

### Quota comes from the account's own directory, not the status line

`cachedUsageUtilization` in `<configDir>\.claude.json` is the quota source, read by
`src/usage/quotaCache.ts`. Claude Code writes it there itself. It is per configuration directory,
which is per account, which is this product's unit — so quota needs no session, no status line, no
collection, and no write into the account.

This replaced the status line, which was the original design and could never have worked here. The
official extension launches the CLI with `--output-format stream-json`, which renders no status line,
so `statusLine` is never invoked on the launch path this product exists to manage. Verified by
launching the bundled binary that way and watching the snapshot inbox stay empty. The bridge still
runs for `claude` in a terminal and its snapshot is still read when there is no cache, but it is a
fallback, not the source.

Two claims that were in this file and printed in the UI were also false, and both are in that file:
per-model weekly windows arrive as `limits[]` entries with `kind: "weekly_scoped"` and a
`scope.model.display_name`, and the extra-usage credit pool as `extra_usage`. Neither is private to
the official extension. Do not reintroduce a disclaimer that this product cannot know them.

Three things about reading it:

- **`fetchedAtMs` is Claude's timestamp for the reading, not ours.** It is a cache; it can be
  arbitrarily stale, and an undated reading is reported as ancient rather than assumed fresh.
- **`limits[]` names the two headline windows again**, as `session` and `weekly_all`. Take
  `five_hour`/`seven_day` from the dedicated `utilization` members and read `limits[]` only for
  per-model windows, or the status bar's severity ranking counts each window twice.
- **`extra_usage.monthly_limit` and `used_credits` are minor units, not dollars.** A A$50.00 cap
  with A$58.13 spent arrives as `5000` and `5813`, with the scale in `decimal_places` and again in
  the parallel `spend` block as `{amount_minor, exponent}`. Rendered as major units they became
  "A$5,813 of A$5,000" — the only figure on the dashboard denominated in the user's own money, wrong
  by a factor of a hundred, and obvious to the owner at a glance. The model type names them
  `usedMinorUnits`/`limitMinorUnits` so the next reader cannot repeat it, and when neither source
  states the exponent no amount is shown at all: a plausible wrong number is worse than none.

Quota is also unrelated to `telemetryEnabled`. That flag gates local collection — the OTLP telemetry
and the bridge's snapshots — and a profile missing it silently disabled both, which is worth knowing
because the flag being absent on one account produced a completely empty dashboard with no
explanation.

### What this is not

With fail-open behaviour this is a convenience and safety mechanism, **not a security boundary**. It
does not cover Claude launched outside the official extension, and a determined user can bypass it
with one environment variable. Documentation must state the guarantee at that strength and no higher.

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | Extension host code (TypeScript, ESM, bundled to `dist/extension.cjs` by esbuild) |
| `src/migration/` | The 0.1.0 → 0.2.0 rename migration. Imports no `vscode`; the host is injected |
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
npm run package    # -> artifacts/claude-workspace-accounts.vsix
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
`CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED category=<category>` on stderr, and identity mismatch is the only
category that still blocks. A bug in the guard must never be able to stop someone from running Claude;
that is the failure the owner actually experienced, and it is why the guarantee is deliberately stated
as convenience rather than security. `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1` bypasses everything, including
binding, and must stay that way.

Note that exit code `78` is also a legal exit code for the CLI itself; a forwarded `78` must be
recorded as `forwarded`, not as a block.

**3. The integration outlives the extension.** The wrapper is installed to
`%LOCALAPPDATA%\ClaudeWorkspaceAccounts\wrapper\` — outside the versioned extension directory — so Claude
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
  `OTEL_LOG_RAW_API_BODIES` to `"0"` **before anything else touches the environment, on every wrapped
  launch**, regardless of whether collection is running. They were previously set only inside the
  successful-injection branch, so every early return left them as inherited — and with
  `CLAUDE_CODE_ENABLE_TELEMETRY=1` and no endpoint configured, OTLP falls back to localhost, so an
  inherited `OTEL_LOG_USER_PROMPTS=1` could export prompt content to whatever was listening.
  Two exemptions are deliberate and are spelled out in `docs/privacy.md`: a user who has configured
  their own OTEL pipeline (we inject nothing and override nothing — silently disabling their content
  logging would veto an explicit choice while protecting nothing of ours), and the kill switch (an
  escape hatch that still edited the environment could not be used to escape a defect in how the
  wrapper edits the environment). Neither lets this extension collect content.
- It refuses to inject any OTEL configuration if the user already has their own exporter, endpoint,
  protocol, compression, header, or client-certificate variable set. The authoritative list lives in
  `src/telemetry/otelEnvironment.ts` and is mirrored in C#; a test fails if the two drift.
- `wrapper-health.json` carries only `{schemaVersion, updatedAt, category, exitCode, pid}`. Never add
  arguments, environment, paths, or auth output to it.
- Workspace paths are stored as a label plus a SHA-256 prefix unless the user opts in via
  `claudeAccounts.privacy.collectWorkspacePath`.

## Conventions

- TypeScript is strict ESM with `.js` import specifiers; the bundle output is CJS.
- Registry writes go through `ProfileRegistry` and are atomic (temp file + rename) because the wrapper
  reads the same file from another process. A malformed registry is preserved, never overwritten —
  it may be the only copy of a user's workspace locks.
- Absent data is reported as absent. The dashboard distinguishes unavailable, awaiting-data, and stale
  rather than showing a zero or a guess; quota windows are frequently legitimately missing.
- Comments explain why, not what, and are reserved for the non-obvious — the wrapper is full of
  constraints that look arbitrary until you know the failure they prevent.
