# Changelog

## 0.2.0

### Renamed from Claude Account Guard, and migrated

The product no longer guards anything — it selects which Claude account a workspace uses — so the
name has changed. Because the extension `name` changed with it, this is a **new Marketplace listing**
(`ResonanceLattice-Semanticus.claude-workspace-account-manager`) rather than an update to
`ResonanceLattice-Semanticus.claude-account-guard`.

The listing slug is `claude-workspace-account-manager` rather than `claude-workspace-accounts`
because the latter was already reserved on the Marketplace. That affects the listing ID and the VSIX
filename only: the display name is still *Claude Workspace Accounts*, and the settings namespace,
environment prefix, support directory, per-profile directory and wrapper executable are unchanged.

- Display name `Claude Account Guard` → `Claude Workspace Accounts`; output channel and command
  category likewise.
- Command and configuration namespace `claudeAccountGuard.` → `claudeAccounts.`. Two IDs also changed
  leaf name because they described the wrong model: `lockWorkspace` → `bindWorkspace`,
  `unlockWorkspace` → `unbindWorkspace`, and the setting `defaultLockMode` → `defaultBindMode`.
  **Keybindings on the old IDs need updating by hand; VS Code does not migrate them.**
- Environment prefix `CLAUDE_ACCOUNT_GUARD_` → `CLAUDE_WORKSPACE_ACCOUNTS_`, including the kill
  switch `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1` and the blocked-launch stderr marker
  `CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED`.
- Support directory `%LOCALAPPDATA%\ClaudeAccountGuard` → `%LOCALAPPDATA%\ClaudeWorkspaceAccounts`;
  per-profile subdirectory `.claude-account-guard` → `.claude-workspace-accounts`; wrapper
  `claude-account-guard-wrapper.exe` → `claude-workspace-accounts-wrapper.exe`; VSIX
  `claude-workspace-accounts.vsix`; C# namespace `ClaudeWorkspaceAccounts`. The status-line bridge
  executable name is deliberately unchanged, which is how a bridge command installed by the previous
  release is still recognised.
- The registry schema is untouched: still version 1, no migration, and `workspaceLocks` and its
  `mode` field keep their names because both native binaries read them. Only what the user sees now
  says "bind" rather than "lock".
- **New: an automatic migration on first activation**, before anything reads support state. It copies
  `registry.json`, `usage.sqlite3` and its `-wal`/`-shm` siblings, `snapshots/`, `binding-cache.json`
  and the status-line backup mirror into the new support directory; repoints the recorded wrapper
  path; repoints `claudeCode.claudeProcessWrapper` **only** when it names the old wrapper executable;
  moves each `claudeAccountGuard.*` value the user actually set to `claudeAccounts.*` at the same
  scope; renames each account's per-profile subdirectory; and repoints each account's `statusLine`
  when — and only when — it is a bridge command of ours. It copies rather than moves, so a failure
  part way through cannot destroy the only copy of a user's bindings, and the old directory is left
  in place with a marker file rather than deleted. It is idempotent, fails open, and writes
  `migration-report.json`, which the diagnostics report reads back.
- Activation warns when the previous extension is still installed: both write the same global
  `claudeCode.claudeProcessWrapper`, so they overwrite each other and one silently stops applying
  per-workspace accounts.
- `bin/native/` is now emptied before each build. It is packaged verbatim, so an executable left
  behind under its previous name would otherwise ship inside the VSIX.

### Per-workspace Claude accounts are now the product

- A workspace is given a Claude account by name, and the wrapper applies it by setting `CLAUDE_CONFIG_DIR` for each Claude Code launch in that workspace. Two ordinary VS Code windows, your own extensions and settings in both, a different Claude account in each.
- Adding an account asks for a display name and nothing else. It no longer asks for a Claude configuration directory or a VS Code user-data directory; the directory is derived, shown, and created.
- Signing in to an account happens in an integrated terminal with `CLAUDE_CONFIG_DIR` set for that account, instead of launching a second, blank VS Code window with its own `--user-data-dir`.
- Binding no longer requires a verified identity first, and no longer asks for enforce / warn / off. Both were dead ends: adding an account produced one that could not be bound, and the mode question came before anything worked. The mode now comes from `claudeAccounts.defaultBindMode`.
- Optional, explicit opt-in to also set `CLAUDE_CONFIG_DIR` in the workspace's integrated terminals, so a `claude` you run yourself matches. Workspace Accounts reports it plainly when that setting cannot be written at workspace scope instead of pretending it worked.
- The status bar, menu, dashboard, and diagnostics all report the account the wrapper will actually use, not the one this VS Code window happened to inherit.
- `bindWorkspace`, `unbindWorkspace`, and `switchProfile` now mean choose, clear, and change this workspace's account. Retitled in the palette accordingly. The first two were `lockWorkspace` and `unlockWorkspace` in 0.1.0 and were renamed with the rest of the namespace, below.
- The isolated-window launcher and its readiness handshake are no longer used.

### Quota comes from the account itself

- **Plan quota is read from `cachedUsageUtilization` in the bound account's own `<configDir>\.claude.json`**, which Claude Code maintains there. That file is per configuration directory, which is per account, so quota needs no session, no status line, no local collection, and no write of any kind into your account directory.
- This replaces the status line, which could never have worked on the path this product manages: the official extension launches the CLI with `--output-format stream-json`, which renders no status line, so `statusLine` was never invoked and quota never arrived. The bridge still runs for a `claude` you start in a terminal, and its snapshot is still used when no cache has been written — as a fallback, not the source.
- **Per-model weekly windows and the extra-usage credit pool are now shown.** Both are in that file — `limits[]` entries with `kind: "weekly_scoped"` and a model display name, and `extra_usage` — so the previous claim that a third-party extension could not know them was wrong and has been removed from the README and the UI.
- **Credit amounts are minor units, not dollars.** A A$50.00 cap with A$58.13 spent arrives as `5000` and `5813`. Rendered as major units they read "A$5,813 of A$5,000" — the only figure on the dashboard denominated in the user's own money, wrong by a factor of a hundred. The scale now comes from `decimal_places` or the parallel `spend` money object, and when neither states it **no amount is shown at all**.
- The reading's age is Claude's own timestamp for it, not ours. It is a cache and can be arbitrarily stale, so it is held to ninety minutes rather than the status line's fifteen, and an undated reading is reported as ancient rather than assumed fresh.
- `five_hour` and `seven_day` are taken from their dedicated members, and `limits[]` is read only for per-model windows. Both name the two headline windows, and counting each twice skewed the status bar's severity ranking.
- Quota is unrelated to `telemetryEnabled`. That flag gates local collection only; a profile missing it produced a completely empty dashboard with no explanation.

### The usage chart shows the data instead of one flat block

- **"Usage over time" is now small multiples — one row per series, each scaled to its own peak, with that peak stated beside it.** The four series were stacked on one linear axis, but cache reads run three to four orders of magnitude above input (measured at 97% of all tokens and 4,002x input), so every column rendered as a solid block of the cache-read colour with the other three pinned to the minimum-height floor. The chart looked identical whatever had happened. Independent scales cost comparability between rows, so each row states its own peak and the chart says outright that heights compare within a row and never between rows.
- A single day no longer stretches across the whole card. The columns were `1fr` with no cap, so one day expanded to the full panel width and read as a wall rather than as one day's bar.
- Within a series, a day with nothing draws nothing while a day with very little keeps a visible floor, so "none" and "a little" stop looking the same. A series with no activity anywhere in the range says so rather than drawing an empty row.

### Identity reporting, and not depending on it

- Nothing is gated on Claude reporting an account identity any more. The previous release treated an unreadable identity as a verification failure and **abandoned the registration**, which was one of three independent reasons an account could not be added. A signed-in account with no reportable identity is now a first-class outcome: stored, usable, and bindable.
- **Correcting a claim made during this release's development.** Interim builds, and the docs shipped with them, said `claude auth status` returns `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is set. That is wrong. Re-verified against 2.1.220's bundled binary, identity is reported **per configuration directory**, so a bound account directory that was re-authenticated as somebody else is genuinely detectable. `enforce` is a real mode, not a synonym for `warn`, and the README, settings text, troubleshooting guide and in-product messages no longer claim otherwise. There is still no `accountId` field — the email and organization are the identity.
- Identity is read without setting `CLAUDE_CONFIG_DIR` when the account is the directory the CLI would use anyway. Harmless, and it keeps one less variable in play.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` was evaluated as a way to switch accounts while leaving chat history shared, and **rejected**. Tested against 2.1.220, setting the two variables apart splits one answer in two: `auth status` takes `email`/`orgId`/`orgName` from the config directory while the credential — the account actually used — follows the secure-storage directory. That would run as one account while confidently naming the other, turning identity verification into a wrong answer.
- One status model, in `bindingIdentityState`: only a real mismatch blocks. Signed-out, "the probe did not complete", "never confirmed", and "the CLI reports nothing" are distinct non-blocking states, and the status bar, dashboard and diagnostics all use it. Previously the dashboard rendered two of those as a wrong account, and the status bar could report health from a 30-second cache after the wrapper had already started stopping launches — it now forces a fresh probe when the wrapper's health record shows a mismatch.

### Recovery and consent

- Added **Claude Workspace Accounts: Disconnect From Claude Code**, which clears the global `claudeCode.claudeProcessWrapper` setting or restores a chained third-party wrapper, says which of the two it did, states how many workspaces revert to the default account, and offers **Reload Window**. Disconnecting is remembered, so no later window silently reconfigures the setting.
- Added **Claude Workspace Accounts: Remove All Workspace Accounts Data**, which disconnects Claude Code, restores any chained status line, removes the terminal `CLAUDE_CONFIG_DIR` it set, removes the installed wrapper files, and deletes all accounts, bindings, and local usage.
- Added an activation-time repair: when the wrapper setting points at a wrapper of its own that no longer exists on disk, it is reinstalled or the setting is cleared, and the user is told which. Claude Code is never left pointing at a missing wrapper.
- **A locked wrapper executable can no longer kill activation.** Refreshing the support files runs on the activation path and threw on failure, so reinstalling the extension and reloading the window while a wrapped Claude was still running produced `EBUSY: resource busy or locked, copyfile` — Windows locks a running `.exe` — and the throw escaped `activate()`. The result was no commands, no status bar and no dashboard, which is precisely the fail-open rule the wrapper itself follows being broken one layer up. Three changes: the copy is **skipped when the destination is already byte-identical**, which is the common case and never touches the lock at all; every copy and every obsolete-file deletion is caught individually and returned as a `failures` list that is logged as a warning; and because installing is now best-effort, **Connect verifies the executable actually exists** before writing the global setting, since pointing Claude Code at a missing wrapper would break every launch.
- The global wrapper setting is no longer written silently at activation. It is requested once, at the point where a workspace account or usage collection needs it, through a prompt that names the setting, its new value, and how to undo it. The answer is persisted, `claudeAccounts.wrapper.autoConfigure` is respected, and a pre-existing third-party wrapper is only chained after an explicit confirmation.
- A workspace account created while the integration is off now says plainly that it is recorded but not applied, and offers to connect.
- Added **Claude Workspace Accounts: Update This Workspace's Expected Claude Identity**, the escape from an enforced identity mismatch. It is what the status bar item runs in that state and is offered from the diagnostics report; it shows the identity that was recorded alongside the one that answers now, records the new one, or switches this workspace to warn-only. Previously a re-authenticated account directory stopped every launch in that workspace with no button anywhere.
- A binding whose sign-in check did not complete is visible rather than silently unverified: diagnostics reports the identity state explicitly, and the menu offers to re-check. A binding whose identity the CLI cannot report reads as "signed in, account details not reported by this Claude version", and one that was never confirmed reads as exactly that — both legitimate states, neither an error.
- The chaining prompt now states that a third-party wrapper inherits the environment Workspace Accounts prepared, including the bound `CLAUDE_CONFIG_DIR` and the local collector's bearer token.
- The integrated-terminal opt-in writes only `CLAUDE_CONFIG_DIR` into the workspace's `terminal.integrated.env.windows`, and removing it deletes only that key, leaving any other terminal environment the user has configured intact.

### Cleanup that cannot leave you broken

- **Removing Workspace Accounts data no longer risks breaking every Claude Code launch.** The wrapper executable is deleted only after the global setting has been re-read and confirmed not to reference it; if detaching failed or the setting still points at the extension, the files stay and the exact manual step is shown. Deleting the wrapper out from under a live setting is precisely the failure this release exists to fix.
- Status-line cleanup now inspects the result instead of treating "did not throw" as success. The bridge deliberately reports `unchanged` and leaves its own command in place when the record of the previous status line is missing or corrupt; the account's metadata and the extension's files are now retained in that case, with the manual recovery named, rather than leaving Claude Code running a status line whose script has been deleted.
- Removal now builds a per-artifact manifest with a verified result for each: status lines, terminal variables, the wrapper setting, wrapper files, the binding cache, accounts, collected usage, the registry, the usage database and remembered answers. Anything kept or failed is listed with what to do by hand, and completeness is never claimed on top of a failure. The registry and SQLite files are actually deleted now, and consent is cleared rather than left as "declined".
- Every workspace whose terminal setting the extension wrote is remembered, so removal can name the ones VS Code cannot reach from the current window.
- Before removing anything, the extension checks for other windows still collecting usage and warns that teardown cannot be coordinated across them.
- The wrapper's `binding-cache.json` is invalidated on every change of which account a workspace uses — bind, rebind, unbind, mode change, account deletion, data removal — and a failure to delete it is now surfaced. A stale entry could make the wrapper fall back to the account the user had just stopped using.

### Command surface

- One entry point: the status bar item and a single self-describing account menu, organised as this workspace / accounts / usage / integration. Every row states what it will change and reflects current state.
- Palette entries use a `Claude Workspace Accounts` category with short titles and `when` clauses, so the palette shows the handful of commands that apply to the current state instead of thirteen long flat titles.
- `registerCurrentProfile`, `manageProfiles`, `enableUsageCollection`, `bindTerminal`, `exportUsage`, and `deleteUsageData` are menu-only. Every command ID stays registered, so existing keybindings and documented IDs keep working.
- New commands: `claudeAccounts.configureWrapper`, `claudeAccounts.disableWrapper`, `claudeAccounts.removeAllData`, `claudeAccounts.enableUsageCollection`, `claudeAccounts.bindTerminal`.
- First run is a single prompt that explains what the extension does and names one next step: choose this workspace's Claude account.
- Removed the redundant `onCommand:claudeAccountGuard.openMenu` activation event.

### Empty and error states

- Using the default Claude account in a workspace with no account of its own is now presented as normal rather than as a warning, while still naming the directory — and saying that its usage is not collected when the extension does not know it.
- The dashboard, status bar, and diagnostics distinguish telemetry disabled, an untracked account in play, a non-active account being viewed, an account that never enabled collection, the integration being off, a user-owned OTLP exporter that the extension deliberately will not override, a collector that is not listening, one that is rejecting requests, batches that normalise to nothing, and simply awaiting the first response — each with the single action that fixes it. Collector-side phases are taken from the telemetry layer's collection-health record rather than inferred separately.
- Choosing, adding, or removing an account now reconciles local collection immediately. Previously the collector was bound to the account detected at activation, so a newly added account collected nothing until the window was reloaded.
- A dashboard build or render failure renders an explicit diagnostic with a retry instead of leaving the panel on "Loading local account usage…".
- Empty states for no accounts, no binding, nothing to export, and a collector that failed to start say what is wrong and which action fixes it.

### Correctness under concurrency

- `ProfileRegistry` gained field-level `createProfile`, `patchProfile` and `patchIntegration` operations that apply inside its mutation lock. Confirming an identity and enabling usage collection both read a profile, then prompt, then wrote the whole object back — so two windows erased each other's fields. Account creation and the "is this configuration directory already registered?" check now happen inside the lock too, instead of before a modal and a CLI probe.
- Partial operations are no longer reported as their opposite: a created account whose directory cannot be made is rolled back; an installed status-line bridge that cannot be recorded says so instead of claiming `settings.json` was untouched; a successful import followed by a failed refresh reports the import.
- Suppressed failures now go to the extension's output channel through one reporter, and the ones a user can act on show a message: terminal-setting write failures, binding-cache deletion failures, collector reconciliation failures, status-bar refresh failures, and configuration reconciliation.
- The local collector now follows the *bound* account rather than the ambient one. The wrapper looks up the collector registration for the account it applies, so a bound workspace previously requested a registration that never existed — with no way for the user to fix it, reload included.
- Sign-in opens an explicitly PowerShell terminal: the command it sends is PowerShell syntax and would fail under `cmd.exe` or Git Bash.
- Diagnostics reads collector health and snapshots for the account in play, not the ambient one, which had been masking exactly the collector problem above.

### Documentation

- `README.md` opens with what the extension is, whether you need it, how to start, and how to get out, and states the actual guarantee: a fail-open convenience and safety mechanism covering Claude Code launched by the official extension, not a security boundary.
- `docs/troubleshooting.md` documents the exact setting name, all three escape hatches including `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1`, why uninstalling alone is not enough, the manual `settings.json` fix, why a workspace might still use the wrong account, the per-account status-line chaining, and every reason the dashboard can be empty.

## 0.1.0

- Initial Windows implementation of isolated Claude account profiles.
- Fail-closed workspace locks through the official Claude process-wrapper contract.
- Auth verification through `claude auth status`; credential files are never inspected.
- Local status snapshots, privacy-minimized OTLP collection, SQLite storage, diagnostics, export, and an accessible usage dashboard.
