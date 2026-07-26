# Claude Account Guard

Claude Account Guard is a Windows-first VS Code extension for developers who use more than one Claude Code account. It makes the account in play visible, opens workspaces under isolated `CLAUDE_CONFIG_DIR` profiles, and can stop Claude before launch when a workspace is bound to a different verified identity.

The extension never opens, copies, modifies, displays, exports, or centrally stores Claude credential files. Identity checks use only the supported `claude auth status` command.

## What is implemented

- Always-visible account, authentication, lock, and fresh quota state in the VS Code status bar.
- Named profiles backed by distinct Claude configuration and VS Code user-data directories.
- Safe switching by opening a new window; the original window remains open.
- Workspace locks stored outside repositories.
- A stable Windows process wrapper using the official `claudeCode.claudeProcessWrapper` contract.
- Fail-closed identity preflight for enforced locks, including drift detection.
- Five-hour, seven-day, context, cost, and session snapshots without fabricating absent values.
- Loopback-only, ephemeral-token OpenTelemetry ingestion with content-bearing fields discarded.
- Shared SQLite/WAL usage history and configurable retention.
- A responsive, theme-aware dashboard with custom dates, main/auxiliary scope, model/workspace filters, reliability views, and keyboard-accessible tables.
- Local model, workspace, skill, plugin, agent/subagent, and MCP attribution when safe labels are exposed.
- Separate profile-metadata, usage-export, and usage-deletion actions.
- Redacted diagnostics.

## Requirements

- Windows 10 or 11.
- VS Code 1.130 or newer (the extension uses the extension host's built-in SQLite API).
- The official `anthropic.claude-code` VS Code extension with a bundled Windows CLI.
- PowerShell 5.1 or newer for the stable process and status-line bridges.
- The in-box .NET Framework 4.x runtime for the 6 KiB executable launcher.

## Build

```powershell
npm install
npm run check
npm run package
```

The packaged extension is written to `artifacts/claude-account-guard.vsix`.

## First run

1. Open a folder or workspace.
2. Choose **Register current account as a profile** or **Create another account profile**.
3. Confirm only the identity returned by `claude auth status`.
4. Optionally enable local usage collection. An existing status-line command is chained and can be restored.
5. Lock the workspace to the intended verified profile.

Switching profiles always launches another VS Code window with a profile-specific `CLAUDE_CONFIG_DIR` and `--user-data-dir`. Dirty editors are saved only after confirmation, and the original window is never force-closed.

## Safety model

For an enforced workspace lock, the stable wrapper:

1. resolves the longest matching workspace root;
2. confirms the runtime configuration directory maps to the required profile;
3. runs the bundled Claude executable with `auth status`;
4. compares stable account and organization IDs when available, otherwise normalized email;
5. forwards the original executable and arguments only on a match.

The wrapper returns exit code `78` and a structured, non-secret error on a mismatch or unverifiable identity. Unlocked and warning-only workspaces continue normally.

The packaged documentation includes `docs/privacy.md`, `docs/telemetry.md`,
`docs/troubleshooting.md`, `docs/feasibility.md`, and
`docs/release-readiness.md`.

## Current verification boundary

The defined automated gate covers lint, strict type-checking, unit/integration tests, the production bundle, SQLite reconciliation and migration, authenticated collector ingestion, status-line chaining and opt-out, plus executable wrapper allow/block, corrupt-registry, argument/stdin, and uninstall-fallback behavior. The release-readiness record states which gates have actually run.

Two-account graphical end-to-end acceptance still requires two real Claude identities and an interactive VS Code session. The extension reports unsupported or unobserved quota/telemetry paths as unavailable rather than inferring success.
