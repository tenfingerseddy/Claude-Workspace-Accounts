# Claude Workspace Accounts

**What it is.** A Windows VS Code extension that gives each workspace its own Claude Code account. Open your work project and Claude Code uses your work account; open a side project in another window and it uses that account. Switching accounts in one project changes nothing anywhere else. It also shows which account a workspace is using, and collects your usage locally.

**Do you need it?** Only if you use more than one Claude Code account on one machine. With a single account, it adds nothing.

**How to start.** Open a folder, click the Claude item in the status bar, and choose the account for this workspace. If you have no accounts yet it walks you through adding one: a name, then a sign-in in a terminal. Two clicks from a clean install to a bound workspace.

**How to get out.** Run **Claude Workspace Accounts: Disconnect From Claude Code**, then **Reload Window**. That clears the one global setting this extension writes (`claudeCode.claudeProcessWrapper`) and Claude Code goes back to your default account everywhere. Uninstalling the extension alone does *not* do this — see [Disable or uninstall](#disable-or-uninstall). `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1` in the environment bypasses it without changing any setting.

The extension never opens, copies, modifies, displays, exports, or centrally stores Claude credential files. Identity checks use only the supported `claude auth status` command.

## How it works, and what it does not guarantee

An account is a Claude configuration directory. Claude Code reads `CLAUDE_CONFIG_DIR`, and credentials live inside that directory, so setting it selects the account for one process. Workspace Accounts installs a small process wrapper and points the official Claude Code extension's `claudeCode.claudeProcessWrapper` setting at it. On each launch the wrapper looks up the workspace, sets `CLAUDE_CONFIG_DIR` to that workspace's account, adds local telemetry variables, and then launches Claude Code unchanged.

Be clear about the guarantee:

- This is a **convenience and safety mechanism, not a security boundary.** It stops you from using the wrong account by accident. It cannot stop someone who wants to use a different account.
- It applies to **Claude Code launched by the official VS Code extension**. A `claude` you run yourself in a terminal uses your default account unless you opt in to the terminal setting (offered when you bind a workspace) or set `CLAUDE_CONFIG_DIR` yourself.
- It **fails open**. If the wrapper, its data, or the account registry is unusable, Claude Code launches normally rather than being blocked. A tool that blocks your work when its own bookkeeping breaks is worse than one that stops selecting accounts for you.
- **Workspace Accounts cannot tell which account a per-workspace directory is signed into.** Claude Code reports `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is set — even when it is set to the directory that was already the default — while still reporting that it is signed in. So for any account used per workspace, Workspace Accounts knows the account is signed in and nothing more. It cannot warn you that a directory was re-authenticated as a different Claude account, and on this CLI version `enforce` therefore behaves like `warn`. Verified against Claude Code 2.1.220; if a future version restores those fields, the checks below start working with no change on our side.
- The one exception is your **default** account: when a registered account is the directory the CLI would use anyway, Workspace Accounts probes it without setting the variable and does get the real email and organization.
- With `claudeAccounts.defaultBindMode` set to `enforce`, a launch *is* stopped in one specific case: the workspace's account is applied, but the Claude identity that answers inside it is not the one you confirmed earlier (that directory was signed into a different account). That is drift detection, not access control, and it is recoverable in two clicks from the status bar. `warn` reports it instead. Every other problem — unreadable registry, missing account, unverifiable identity, missing executable — launches Claude Code anyway and is reported, never blocked.
- A workspace can switch this off for its own integrated terminals, because `terminal.integrated.env.windows` is workspace-scoped: a checked-in `.vscode/settings.json` can set `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE` to `1`. Worth knowing before cloning somebody else's repository.
- If you let Workspace Accounts chain a third-party wrapper, that wrapper runs with the environment Workspace Accounts prepared, including the bound `CLAUDE_CONFIG_DIR` and the local collector's bearer token when usage collection is on.

## Command surface

One status bar item and one menu are the entry point. The menu says what each action will do and reflects the current account, workspace binding, integration state, and collection state.

In the Command Palette (all prefixed `Claude Workspace Accounts:`):

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
| Remove All Workspace Accounts Data | always |
| Show Diagnostics | always |

Reached through the menu, and also registered as commands so they can be bound to keys: `claudeAccounts.registerCurrentProfile`, `manageProfiles`, `enableUsageCollection`, `bindTerminal`, `exportUsage`, `deleteUsageData`.

Every command ID lives under `claudeAccounts.` as of 0.2.0. If you had keybindings on the old `claudeAccountGuard.` IDs they need updating by hand — VS Code keybindings are not migrated. Two IDs also changed name because they described the wrong model: `lockWorkspace` is now `bindWorkspace`, and `unlockWorkspace` is now `unbindWorkspace`.

## What is implemented

- Per-workspace Claude accounts, applied by injecting `CLAUDE_CONFIG_DIR` at launch. No second VS Code window, no separate `--user-data-dir`, none of your extensions or settings left behind.
- Adding an account asks for a name only, then signs in through an integrated terminal scoped to that account.
- An optional, explicit opt-in that also sets `CLAUDE_CONFIG_DIR` for the workspace's integrated terminals.
- One status bar item and one self-describing quick-pick menu as the entry point.
- Explicit, one-time consent before the global `claudeCode.claudeProcessWrapper` setting is written, requested at the point where it is actually needed.
- First-class **Disconnect From Claude Code** and **Remove All Workspace Accounts Data** commands, plus an activation-time repair for a wrapper setting pointing at a missing file.
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
- The in-box .NET Framework 4.x runtime, which both native executables need: the process wrapper and the status-line bridge. Nothing else has to be installed — they are a few kilobytes each and compile against the runtime that ships with Windows. No PowerShell is used anywhere in the product.

## Upgrading from Claude Account Guard

This extension was published as **Claude Account Guard** (`ResonanceLattice-Semanticus.claude-account-guard`) up to version 0.1.0. It selects which Claude account a workspace uses; it does not guard anything, so it has been renamed. Because the extension `name` changed, this is a **new Marketplace listing** rather than an update, and there are two consequences:

- **Uninstall Claude Account Guard.** Two installations both write the same global `claudeCode.claudeProcessWrapper` setting, so they overwrite each other and one of them silently stops applying per-workspace accounts. Workspace Accounts detects the old extension on activation and says so.
- **Your data moves itself.** On first activation your accounts, workspace bindings, local usage, and status-line settings are migrated from `%LOCALAPPDATA%\ClaudeAccountGuard` to `%LOCALAPPDATA%\ClaudeWorkspaceAccounts`; `claudeAccountGuard.*` settings are moved to `claudeAccounts.*`; and a `claudeCode.claudeProcessWrapper` pointing at the old wrapper is repointed at the new one. Reload the window afterwards so Claude Code picks it up. A wrapper setting that points at anything else is left alone.

The old support directory is **copied, not moved** — a half-finished move could destroy the only copy of your workspace bindings — so `%LOCALAPPDATA%\ClaudeAccountGuard` stays where it is with a small marker file added. Delete it by hand once you are satisfied nothing is missing. If any part of the migration fails, activation continues, Claude Code keeps working, and the reason is in the migration report and in **Show Diagnostics**.

## Build

```powershell
npm install
npm run check
npm run package
```

The packaged extension is written to `artifacts/claude-workspace-accounts.vsix`.

## First run

1. Open a folder or workspace. Workspace Accounts introduces itself once and offers one next step.
2. **Choose this workspace's Claude account.** If you have none yet, you are asked for a name — say `Work` — and Workspace Accounts creates `%USERPROFILE%\.claude-work` for it. Nothing is copied and your default account is untouched.
3. **Sign in.** A terminal opens with `CLAUDE_CONFIG_DIR` set to that account, running the Claude sign-in. The session lands in that directory only.
4. Workspace Accounts asks **once** for permission to set `claudeCode.claudeProcessWrapper`, and names the setting and how to undo it. This is what applies per-workspace accounts, so declining leaves the choice recorded but not applied.
5. Optionally check the account's sign-in. For a per-workspace account, Claude Code reports only that it is signed in, so that is all Workspace Accounts records and all it claims. For your default account it also records the email and organization, which is what lets it notice later that the directory has been signed into a different Claude account.
6. Optionally turn on usage collection for the account. A status-line command is added to *that account's* `settings.json`, and any status line you already had runs after it.
7. Optionally opt in to the same account for this workspace's integrated terminals.

Repeat step 2 in another workspace with a different account. Both windows are ordinary VS Code windows with all your usual extensions.

If a workspace has no account of its own it uses your default Claude account, which is normal — the status bar says so and names the directory. If that default account is not one Workspace Accounts knows about, its usage is not collected; the status bar and dashboard say exactly that and offer to track it.

## Disable or uninstall

Workspace Accounts writes exactly one setting outside its own namespace: the **global** `claudeCode.claudeProcessWrapper`, pointing at `%LOCALAPPDATA%\ClaudeWorkspaceAccounts\wrapper\claude-workspace-accounts-wrapper.exe`. The wrapper lives outside the extension directory on purpose, so upgrading the extension cannot break a Claude Code launch. The consequence is that **uninstalling the extension does not undo it** — the setting stays, and Claude Code keeps launching through a wrapper that may no longer exist.

Choose the path that matches what you want:

| Goal | Do this | What changes |
| --- | --- | --- |
| Temporarily bypass it | Set `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1` in the environment | Nothing persistent; the wrapper forwards straight to Claude Code with your default account |
| Stop per-workspace accounts | **Claude Workspace Accounts: Disconnect From Claude Code**, then **Reload Window** | Clears `claudeCode.claudeProcessWrapper`, or restores the third-party wrapper Workspace Accounts chained. Every workspace goes back to your default account and token telemetry stops. Accounts, bindings, and collected usage are kept, so reconnecting restores them |
| Remove everything Workspace Accounts stored | **Claude Workspace Accounts: Remove All Workspace Accounts Data**, then **Reload Window** | The above, plus restores any status line it chained, removes the terminal `CLAUDE_CONFIG_DIR` it set, deletes its wrapper files and its `binding-cache.json`, and deletes all accounts, bindings, and local usage in `%LOCALAPPDATA%\ClaudeWorkspaceAccounts` |
| Uninstall | Run **Remove All Workspace Accounts Data** *first*, then uninstall the extension | Leaves no global setting behind |

Nothing above signs any account out or deletes a Claude configuration directory. The accounts you added under `%USERPROFILE%\.claude-<name>` remain usable with `CLAUDE_CONFIG_DIR` by hand; delete them yourself if you want them gone.

If the extension is already gone and Claude Code is broken, open `settings.json` (Command Palette → *Preferences: Open User Settings (JSON)*), delete the `"claudeCode.claudeProcessWrapper"` entry, and reload the window. Then delete the support directory: `%LOCALAPPDATA%\ClaudeWorkspaceAccounts`, and also `%LOCALAPPDATA%\ClaudeAccountGuard` if you ever had the old **Claude Account Guard** release — the rename copies rather than moves, so an upgraded machine has both. Reinstalling Workspace Accounts also repairs the setting automatically: on activation it clears or reinstalls a wrapper setting that points at a missing file and tells you what it did.

## What the wrapper does at launch

1. Reads the account registry. If it is missing or unusable, Claude Code is launched unchanged.
2. Finds the binding for the current workspace, longest matching root first.
3. Sets `CLAUDE_CONFIG_DIR` to that account for this process only.
4. Adds loopback OpenTelemetry variables when local usage collection is on for that account, and never overrides an `OTEL_EXPORTER_OTLP_*` configuration of your own.
5. For an `enforce` binding with a confirmed identity, runs `auth status` in that account and stops the launch with exit code `78` and a non-secret message if a different identity answers. That is the only case in which it stops a launch; every other failure is recorded and forwarded.
6. Launches the original executable with the original arguments.

The packaged documentation includes `docs/privacy.md`, `docs/telemetry.md`, `docs/troubleshooting.md`, `docs/feasibility.md`, and `docs/release-readiness.md`.

## Current verification boundary

`npm run check` is the gate. Run against this release, it is:

- **219 tests across 18 files** (`vitest`): registry concurrency, SQLite storage and retention, collector ingestion, status-line chaining and restoration, the OTEL environment contract in both languages, the pure UX and teardown decisions, and the rename migration.
- **The argument-fidelity gate, 69 checks** (`scripts/smoke-wrapper-args.mjs`). It asserts that the argument vector reaching the Claude CLI is byte-identical to the vector VS Code spawned, for each flag Claude Code actually uses, plus exit-code, stdout-byte, channel-separation and stdin fidelity. This is the gate that would have caught the defect that made v0.1.0 unusable: the wrapper forwarded through PowerShell, which ate `--verbose`, `--debug` and the value after `-p`. Treat it as a specification — if a case fails, the wrapper is wrong.
- **The wrapper guard smoke test, 70 checks** (`scripts/smoke-wrapper.mjs`), including that two different bound workspaces resolve to two different `CLAUDE_CONFIG_DIR` values regardless of the ambient environment. That is the core product promise, and it was previously untested.
- **The status-line bridge smoke test, 25 checks** (`scripts/smoke-statusline.mjs`).
- **Lint, strict type-checking, the production esbuild bundle, and the VSIX package step.**

Two-account graphical end-to-end acceptance still requires two real Claude identities and an interactive VS Code session, and has not been performed here. The same applies to the rename migration against a real installation. The extension reports unsupported or unobserved quota and telemetry paths as unavailable rather than inferring success. `docs/release-readiness.md` records which gates have actually run, and when.
