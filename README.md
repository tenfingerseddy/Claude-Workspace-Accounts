# Claude Account Guard

**What it is.** A Windows VS Code extension that gives each workspace its own Claude Code account. Open your work project and Claude Code uses your work account; open a side project in another window and it uses that account. Switching accounts in one project changes nothing anywhere else. It also shows which account a workspace is using, and collects your usage locally.

**Do you need it?** Only if you use more than one Claude Code account on one machine. With a single account, it adds nothing.

**How to start.** Open a folder, click the Claude item in the status bar, and choose the account for this workspace. If you have no accounts yet it walks you through adding one: a name, then a sign-in in a terminal. Two clicks from a clean install to a bound workspace.

**How to get out.** Run **Claude Account Guard: Disconnect From Claude Code**, then **Reload Window**. That clears the one global setting this extension writes (`claudeCode.claudeProcessWrapper`) and Claude Code goes back to your default account everywhere. Uninstalling the extension alone does *not* do this — see [Disable or uninstall](#disable-or-uninstall). `CLAUDE_ACCOUNT_GUARD_DISABLE=1` in the environment bypasses it without changing any setting.

The extension never opens, copies, modifies, displays, exports, or centrally stores Claude credential files. Identity checks use only the supported `claude auth status` command.

## How it works, and what it does not guarantee

An account is a Claude configuration directory. Claude Code reads `CLAUDE_CONFIG_DIR`, and credentials live inside that directory, so setting it selects the account for one process. Account Guard installs a small process wrapper and points the official Claude Code extension's `claudeCode.claudeProcessWrapper` setting at it. On each launch the wrapper looks up the workspace, sets `CLAUDE_CONFIG_DIR` to that workspace's account, adds local telemetry variables, and then launches Claude Code unchanged.

Be clear about the guarantee:

- This is a **convenience and safety mechanism, not a security boundary.** It stops you from using the wrong account by accident. It cannot stop someone who wants to use a different account.
- It applies to **Claude Code launched by the official VS Code extension**. A `claude` you run yourself in a terminal uses your default account unless you opt in to the terminal setting (offered when you bind a workspace) or set `CLAUDE_CONFIG_DIR` yourself.
- It **fails open**. If the wrapper, its data, or the account registry is unusable, Claude Code launches normally rather than being blocked. A tool that blocks your work when its own bookkeeping breaks is worse than one that stops selecting accounts for you.
- **Account Guard cannot tell which account a per-workspace directory is signed into.** Claude Code reports `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is set — even when it is set to the directory that was already the default — while still reporting that it is signed in. So for any account used per workspace, Account Guard knows the account is signed in and nothing more. It cannot warn you that a directory was re-authenticated as a different Claude account, and on this CLI version `enforce` therefore behaves like `warn`. Verified against Claude Code 2.1.220; if a future version restores those fields, the checks below start working with no change on our side.
- The one exception is your **default** account: when a registered account is the directory the CLI would use anyway, Account Guard probes it without setting the variable and does get the real email and organization.
- With `claudeAccountGuard.defaultLockMode` set to `enforce`, a launch *is* stopped in one specific case: the workspace's account is applied, but the Claude identity that answers inside it is not the one you confirmed earlier (that directory was signed into a different account). That is drift detection, not access control, and it is recoverable in two clicks from the status bar. `warn` reports it instead. Every other problem — unreadable registry, missing account, unverifiable identity, missing executable — launches Claude Code anyway and is reported, never blocked.
- A workspace can switch the guard off for its own integrated terminals, because `terminal.integrated.env.windows` is workspace-scoped: a checked-in `.vscode/settings.json` can set `CLAUDE_ACCOUNT_GUARD_DISABLE` to `1`. Worth knowing before cloning somebody else's repository.
- If you let Account Guard chain a third-party wrapper, that wrapper runs with the environment Account Guard prepared, including the bound `CLAUDE_CONFIG_DIR` and the local collector's bearer token when usage collection is on.

## Command surface

One status bar item and one menu are the entry point. The menu says what each action will do and reflects the current account, workspace binding, integration state, and collection state.

In the Command Palette (all prefixed `Claude Account Guard:`):

| Command | Shown when |
| --- | --- |
| Account Menu | always |
| Add a Claude Account | always |
| Use a Claude Account in This Workspace | a folder is open and it has no account yet |
| Change This Workspace's Claude Account | a folder is open and it has one |
| Use the Default Claude Account in This Workspace | a folder is open and it has one |
| Sign In to This Workspace's Claude Account | an account exists |
| Update This Workspace's Expected Claude Identity | an account exists |
| Check This Workspace's Claude Identity | an account exists |
| Usage Dashboard | always |
| Connect to Claude Code | the integration is off |
| Disconnect From Claude Code | always |
| Remove All Account Guard Data | always |
| Show Diagnostics | always |

Reached through the menu, still registered as commands so keybindings and older docs keep working: `registerCurrentProfile`, `manageProfiles`, `enableUsageCollection`, `bindTerminal`, `exportUsage`, `deleteUsageData`.

## What is implemented

- Per-workspace Claude accounts, applied by injecting `CLAUDE_CONFIG_DIR` at launch. No second VS Code window, no separate `--user-data-dir`, none of your extensions or settings left behind.
- Adding an account asks for a name only, then signs in through an integrated terminal scoped to that account.
- An optional, explicit opt-in that also sets `CLAUDE_CONFIG_DIR` for the workspace's integrated terminals.
- One status bar item and one self-describing quick-pick menu as the entry point.
- Explicit, one-time consent before the global `claudeCode.claudeProcessWrapper` setting is written, requested at the point where it is actually needed.
- First-class **Disconnect From Claude Code** and **Remove All Account Guard Data** commands, plus an activation-time repair for a wrapper setting pointing at a missing file.
- Identity drift detection wherever the CLI reports an identity (in practice: the default account), with `enforce` and `warn` behaviour, a two-click recovery from the status bar, and an explicit “bound but no longer verifiable” state so a check that stops working cannot go unnoticed.
- Five-hour, seven-day, context, cost, and session snapshots without fabricating absent values.
- Loopback-only, ephemeral-token OpenTelemetry ingestion with content-bearing fields discarded.
- Shared SQLite/WAL usage history and configurable retention.
- A responsive, theme-aware dashboard with custom dates, main/auxiliary scope, model/workspace filters, reliability views, and keyboard-accessible tables — and, when it is empty, the specific reason plus the button that fixes it.
- Redacted diagnostics that name which account each part of the chain believes is active.

## Requirements

- Windows 10 or 11.
- VS Code 1.130 or newer (the extension uses the extension host's built-in SQLite API).
- The official `anthropic.claude-code` VS Code extension with a bundled Windows CLI.
- PowerShell 5.1 or newer for the status-line bridge.
- The in-box .NET Framework 4.x runtime for the small executable launcher.

## Build

```powershell
npm install
npm run check
npm run package
```

The packaged extension is written to `artifacts/claude-account-guard.vsix`.

## First run

1. Open a folder or workspace. Account Guard introduces itself once and offers one next step.
2. **Choose this workspace's Claude account.** If you have none yet, you are asked for a name — say `Work` — and Account Guard creates `%USERPROFILE%\.claude-work` for it. Nothing is copied and your default account is untouched.
3. **Sign in.** A terminal opens with `CLAUDE_CONFIG_DIR` set to that account, running the Claude sign-in. The session lands in that directory only.
4. Account Guard asks **once** for permission to set `claudeCode.claudeProcessWrapper`, and names the setting and how to undo it. This is what applies per-workspace accounts, so declining leaves the choice recorded but not applied.
5. Optionally check the account's sign-in. For a per-workspace account, Claude Code reports only that it is signed in, so that is all Account Guard records and all it claims. For your default account it also records the email and organization, which is what lets it notice later that the directory has been signed into a different Claude account.
6. Optionally turn on usage collection for the account. A status-line command is added to *that account's* `settings.json`, and any status line you already had runs after it.
7. Optionally opt in to the same account for this workspace's integrated terminals.

Repeat step 2 in another workspace with a different account. Both windows are ordinary VS Code windows with all your usual extensions.

If a workspace has no account of its own it uses your default Claude account, which is normal — the status bar says so and names the directory. If that default account is not one Account Guard knows about, its usage is not collected; the status bar and dashboard say exactly that and offer to track it.

## Disable or uninstall

Account Guard writes exactly one setting outside its own namespace: the **global** `claudeCode.claudeProcessWrapper`, pointing at `%LOCALAPPDATA%\ClaudeAccountGuard\wrapper\claude-account-guard-wrapper.exe`. The wrapper lives outside the extension directory on purpose, so upgrading the extension cannot break a Claude Code launch. The consequence is that **uninstalling the extension does not undo it** — the setting stays, and Claude Code keeps launching through a wrapper that may no longer exist.

Choose the path that matches what you want:

| Goal | Do this | What changes |
| --- | --- | --- |
| Temporarily bypass it | Set `CLAUDE_ACCOUNT_GUARD_DISABLE=1` in the environment | Nothing persistent; the wrapper forwards straight to Claude Code with your default account |
| Stop per-workspace accounts | **Claude Account Guard: Disconnect From Claude Code**, then **Reload Window** | Clears `claudeCode.claudeProcessWrapper`, or restores the third-party wrapper Account Guard chained. Every workspace goes back to your default account and token telemetry stops. Accounts, bindings, and collected usage are kept, so reconnecting restores them |
| Remove everything Account Guard stored | **Claude Account Guard: Remove All Account Guard Data**, then **Reload Window** | The above, plus restores any status line it chained, removes the terminal `CLAUDE_CONFIG_DIR` it set, deletes its wrapper files and its `binding-cache.json`, and deletes all accounts, bindings, and local usage in `%LOCALAPPDATA%\ClaudeAccountGuard` |
| Uninstall | Run **Remove All Account Guard Data** *first*, then uninstall the extension | Leaves no global setting behind |

Nothing above signs any account out or deletes a Claude configuration directory. The accounts you added under `%USERPROFILE%\.claude-<name>` remain usable with `CLAUDE_CONFIG_DIR` by hand; delete them yourself if you want them gone.

If the extension is already gone and Claude Code is broken, open `settings.json` (Command Palette → *Preferences: Open User Settings (JSON)*), delete the `"claudeCode.claudeProcessWrapper"` entry, reload the window, and delete `%LOCALAPPDATA%\ClaudeAccountGuard`. Reinstalling Account Guard also repairs this automatically: on activation it clears or reinstalls a wrapper setting that points at a missing file and tells you what it did.

## What the wrapper does at launch

1. Reads the account registry. If it is missing or unusable, Claude Code is launched unchanged.
2. Finds the binding for the current workspace, longest matching root first.
3. Sets `CLAUDE_CONFIG_DIR` to that account for this process only.
4. Adds loopback OpenTelemetry variables when local usage collection is on for that account, and never overrides an `OTEL_EXPORTER_OTLP_*` configuration of your own.
5. For an `enforce` binding with a confirmed identity, runs `auth status` in that account and stops the launch with exit code `78` and a non-secret message if a different identity answers. That is the only case in which it stops a launch; every other failure is recorded and forwarded.
6. Launches the original executable with the original arguments.

The packaged documentation includes `docs/privacy.md`, `docs/telemetry.md`, `docs/troubleshooting.md`, `docs/feasibility.md`, and `docs/release-readiness.md`.

## Current verification boundary

The defined automated gate covers lint, strict type-checking, unit/integration tests, the production bundle, SQLite reconciliation and migration, authenticated collector ingestion, status-line chaining and opt-out, plus executable wrapper allow/block, corrupt-registry, argument/stdin, and uninstall-fallback behaviour. The release-readiness record states which gates have actually run.

Two-account graphical end-to-end acceptance still requires two real Claude identities and an interactive VS Code session. The extension reports unsupported or unobserved quota and telemetry paths as unavailable rather than inferring success.
