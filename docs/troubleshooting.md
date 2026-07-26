# Troubleshooting

## I want Workspace Accounts out of the way, now

Workspace Accounts changes exactly one setting outside its own namespace, and it is **global**:

```jsonc
// %APPDATA%\Code\User\settings.json
"claudeCode.claudeProcessWrapper": "%LOCALAPPDATA%\\ClaudeWorkspaceAccounts\\wrapper\\claude-workspace-accounts-wrapper.exe"
```

Three escape hatches, in increasing order of finality:

1. **Bypass without changing anything.** Set the environment variable `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1` (for one shell: `$env:CLAUDE_WORKSPACE_ACCOUNTS_DISABLE = "1"`; permanently: `setx CLAUDE_WORKSPACE_ACCOUNTS_DISABLE 1`, then restart VS Code). The wrapper forwards straight to Claude Code with your default account. No per-workspace account is applied while this is set.
2. **Disconnect from the UI.** Run **Claude Workspace Accounts: Disconnect From Claude Code**, then choose **Reload Window**. It clears `claudeCode.claudeProcessWrapper`, or restores a third-party wrapper Workspace Accounts chained, and says which of the two it did. Every workspace goes back to your default Claude account. Accounts, bindings, and collected usage are kept, so reconnecting later restores the previous behaviour. Workspace Accounts will not silently reconfigure the setting afterwards — disconnecting is remembered.
3. **Remove everything.** Run **Claude Workspace Accounts: Remove All Workspace Accounts Data**. It disconnects as above, restores any status-line command it chained into an account's Claude `settings.json`, removes the terminal `CLAUDE_CONFIG_DIR` it set for this workspace, deletes its wrapper files and its `binding-cache.json`, and deletes all accounts, bindings, and local usage under `%LOCALAPPDATA%\ClaudeWorkspaceAccounts`. Reload the window afterwards, then uninstall the extension if you are done.

A workspace can also switch per-workspace accounts off for its own terminals: `terminal.integrated.env.windows` is workspace-scoped, so a checked-in `.vscode/settings.json` setting `CLAUDE_WORKSPACE_ACCOUNTS_DISABLE` to `1` bypasses the wrapper for terminals opened in that repository. That is the same mechanism the Workspace Accounts opt-in terminal binding uses, and it is worth knowing before cloning somebody else's repository.

None of these signs an account out or deletes a Claude configuration directory. Accounts you added live in `%USERPROFILE%\.claude-<name>` and stay usable by setting `CLAUDE_CONFIG_DIR` yourself; delete those directories by hand if you want them gone.

### Close other windows before removing data

Workspace Accounts cannot coordinate teardown across VS Code windows. Another window's collector can still be running, and can write to the usage database after removal has emptied it. The confirmation prompt warns when it detects other live collectors; close those windows first if you want removal to be final. Everything else in the removal report is verified per artifact, but that one cannot be.

### Uninstalling the extension is not enough

The wrapper is installed to `%LOCALAPPDATA%\ClaudeWorkspaceAccounts\wrapper` rather than inside the versioned extension directory, so an extension upgrade cannot break a Claude Code launch. The trade-off is that removing the extension leaves the global setting in place, still pointing at the wrapper. Run **Remove All Workspace Accounts Data** *before* uninstalling.

If the extension is already gone:

1. Command Palette → **Preferences: Open User Settings (JSON)**.
2. Delete the `"claudeCode.claudeProcessWrapper"` entry, or set it back to your own wrapper.
3. Reload the window — Claude Code reads the setting at launch.
4. Delete `%LOCALAPPDATA%\ClaudeWorkspaceAccounts`.

Reinstalling Workspace Accounts also repairs this: at activation it checks whether the configured wrapper still exists on disk, reinstalls it or clears the setting, and tells you which. It never leaves Claude Code pointed at a missing wrapper.

## Nothing global is written until it is needed

Workspace Accounts does not touch `claudeCode.claudeProcessWrapper` until you give a workspace its own Claude account, or turn on local usage collection — and then it asks once, naming the setting and how to undo it. Declining is remembered across windows, and the binding is saved but reported as not applied. To connect later, run **Claude Workspace Accounts: Connect to Claude Code**. If `claudeAccounts.wrapper.autoConfigure` is `false`, Workspace Accounts stays read-only and will not ask at all; per-workspace accounts then do nothing.

## The workspace is using the wrong account

Check the status bar tooltip and the diagnostics report, which name the account each part of the chain believes is active.

- **"Set to use X, but not applied yet".** Claude Code is not launching through Workspace Accounts. Run **Connect to Claude Code**.
- **A Claude Code session started before you bound the workspace.** The account is chosen at launch. Restart the Claude Code session (or reload the window) after changing it.
- **`CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1` is set** in your environment, which bypasses everything by design.
- **`claudeAccounts.defaultBindMode` is `off`.** The choice is recorded and deliberately not applied.
- **The old *Claude Account Guard* extension is still installed.** It writes the same global `claudeCode.claudeProcessWrapper` setting, so the two overwrite each other on activation and whichever loses stops applying accounts. Uninstall it and reload the window; the diagnostics report names this under *Upgrade from Claude Account Guard*.
- **A `claude` you started in a terminal.** The wrapper only covers launches made by the Claude Code extension. When binding a workspace, accept **Also use this account for `claude` in this workspace's terminals** to have Workspace Accounts write `CLAUDE_CONFIG_DIR` into this workspace's `terminal.integrated.env.windows`. If that setting cannot be written at workspace scope in your setup, Workspace Accounts says so and leaves it to you; set `CLAUDE_CONFIG_DIR` in the terminal yourself. Terminals already open keep their old environment.

## Claude was stopped before launching

Exactly one condition stops a launch: the workspace's account is applied in `enforce` mode, an expected identity was recorded for it, and a **different** Claude identity now answers inside that account directory — usually because the directory was signed into another account. The wrapper exits with code `78` and a non-secret `identity_mismatch` message.

Two ways out, both two clicks:

- **Update the expected identity.** Click the Claude status bar item, or run **Claude Workspace Accounts: Update This Workspace's Expected Claude Identity** (it is also offered from the diagnostics report). It shows the identity that was recorded and the one that answers now, and records the new one if that is what you intended.
- **Only warn here.** The same prompt offers switching this workspace to `warn`, which reports a mismatch in the status bar and never stops a launch. `claudeAccounts.defaultBindMode` sets the default for new bindings.

If the account was signed into the wrong Claude account by mistake, sign it back in instead: **Sign In to This Workspace's Claude Account**.

Everything else fails open. These appear in `wrapper-health.json` and in diagnostics as categories, but Claude Code is launched anyway:

- `signed_out`: that account has no Claude session. Sign in to it.
- `registry_unavailable`: the account registry could not be read. The wrapper falls back to `binding-cache.json` so the workspace keeps its account; repair the registry.
- `required_profile_missing`: the workspace refers to an account that no longer exists. Choose an account again.
- `identity_unverifiable`: `auth status` returned nothing comparable with the recorded identity. On current CLI versions this is the normal outcome for a per-workspace account, not a fault.
- `binary_missing`: the Claude Code extension's bundled executable was not found.

### Identity reporting is unavailable for per-workspace accounts

Claude Code reports `email`, `orgId` and `orgName` as null whenever `CLAUDE_CONFIG_DIR` is set, even when it is set to the directory that was already the default, while still reporting `loggedIn: true` and exiting 0:

```
$ claude.exe auth status
{"loggedIn":true,"email":"you@example.com","orgId":"...","orgName":"...","subscriptionType":"team"}

$ CLAUDE_CONFIG_DIR="%USERPROFILE%\.claude" claude.exe auth status
{"loggedIn":true,"email":null,"orgId":null,"orgName":null,"subscriptionType":"team"}
```

Consequences, stated plainly:

- An account used by a workspace shows as **signed in, account details not reported**. That is not an error and nothing is wrong with the account.
- Workspace Accounts cannot detect that such a directory has been signed into a different Claude account, so `enforce` behaves like `warn` for it.
- Your **default** account is exempt: Workspace Accounts probes it without setting the variable, so the real email and organization are recorded and drift detection works for it.
- Nothing is gated on identity. Adding, signing in to, binding, and collecting usage for an account all work without it. (An earlier release refused to register an account whose identity it could not read, which is why registration appeared to do nothing.)

Verified against Claude Code 2.1.220 with its bundled native binary. Whether this is intended is unknown; `subscriptionType` survives while the identity fields do not. If a future version restores them, drift detection resumes with no change here.

### Mismatch detection can go quiet

`identity_unverifiable` does not block, which means a check that stops working stops protecting you without stopping your work. Workspace Accounts therefore says so: the status bar reads `Claude · <account> · unverified`, and diagnostics reports `Identity check state: Inactive`. This happens when `auth status` output changes shape, or when the recorded identity holds only an account ID while the CLI reports only an email. Run **Update This Workspace's Expected Claude Identity** to record a comparable identity again.

A workspace bound to an account with **no** recorded identity is different and entirely legitimate: nothing is probed, nothing is blocked, and the status bar reads "bound, identity not confirmed". Confirm it if you want change detection.

### Corrupt account registry

`%LOCALAPPDATA%\ClaudeWorkspaceAccounts\registry.json` is preserved rather than rewritten when it fails validation, and Claude Code keeps launching. The wrapper falls back to `binding-cache.json` in the same folder so each workspace keeps the account it was given rather than silently reverting to your default one. Do not replace the registry with an empty file: that discards your bindings. Close VS Code, make a backup, repair or restore the last known-good file, then reopen VS Code.

## The dashboard is empty

The dashboard, the status bar tooltip, and the diagnostics report all name the specific reason, and the dashboard offers the matching fix as a button. The reasons, in the order they are checked:

1. **`claudeAccounts.telemetry.enabled` is off.** Nothing is collected.
2. **The account in play here is not one Workspace Accounts knows about.** Usually this is your default account in a workspace with no account of its own. Nothing can be attributed to it. Fix: **Track the Default Claude Account**, or give the workspace one of your accounts.
3. **The dashboard is showing an account that is not the one in play here.** Only the account a window actually launches collects.
4. **Usage collection was never turned on for that account.** Quota numbers come from a status-line bridge in that account's `settings.json`. Fix: **Collect Usage for This Workspace's Account**, which chains any status line you already have rather than replacing it.
5. **Claude Code does not launch through Workspace Accounts.** Quota snapshots still arrive, but token, cost, and tool detail arrive over OpenTelemetry that Workspace Accounts injects at launch.
6. **You already configure your own OTLP exporter.** `OTEL_EXPORTER_OTLP_*` is set, and Workspace Accounts deliberately does not redirect Claude's telemetry away from it.
7. **The collector is not listening**, or is rejecting requests, or is accepting batches that normalise to nothing. The diagnostics report names the counted cause.
8. **Nothing has happened yet.** Collection is configured and waiting for the first Claude response. Quota exists only for supported Claude.ai subscription sessions, and the five-hour and seven-day windows can be independently absent.

Also confirm `disableAllHooks` is not disabling status-line execution, and that the dashboard's collection timestamp advances after a Claude response.

Choosing an account for a workspace, or adding one, now starts collection immediately; earlier releases required a window reload before anything was collected.

## Another process wrapper was already configured

Workspace Accounts never silently overwrites it. When a binding or local usage needs the integration, it shows the other wrapper's path and offers **Chain And Connect**, which selects the workspace's account first and then runs your wrapper. A chained wrapper inherits the environment Workspace Accounts prepared — including the bound `CLAUDE_CONFIG_DIR` and, when usage collection is on, the local collector's bearer token — so only chain a wrapper you trust with those. Declining leaves your wrapper untouched. **Disconnect From Claude Code** restores it. Diagnostics shows both redacted paths and any unresolved conflict.

## Status lines

The status-line bridge is per account: it is written only to `<that account's CLAUDE_CONFIG_DIR>\settings.json`. Turning on usage collection for one account never modifies another's, and never modifies the default `%USERPROFILE%\.claude` unless that directory is itself the account being tracked. An existing `statusLine` command is recorded in `<config dir>\.claude-workspace-accounts\statusline-next.json`, run after the bridge on every status-line refresh, and restored when the account is removed from Workspace Accounts or Workspace Accounts data is removed.

Never delete Claude configuration directories as part of Workspace Accounts cleanup; they belong to Claude Code and contain credentials.

## SQLite availability

The extension uses the `node:sqlite` API bundled with the VS Code 1.130 extension host. No native database addon is packaged. Older VS Code releases are rejected by the extension manifest rather than failing at activation with a native ABI mismatch.
