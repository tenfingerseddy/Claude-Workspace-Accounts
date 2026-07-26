# Troubleshooting

## Claude is blocked

Open **Claude Account Guard: Diagnostics**. A structured wrapper category identifies the safe resolution:

- `runtime_profile_mismatch`: reopen the workspace with the required profile.
- `signed_out`: sign in within the required isolated profile.
- `identity_mismatch`: verify identity drift; accept a new identity only after reviewing it.
- `identity_unverifiable`: confirm the bundled CLI supports `auth status`.
- `registry_unavailable`: restore or repair the shared registry before launching Claude.

The wrapper does not log raw authentication output.

### Corrupt shared registry

Account Guard deliberately preserves an invalid `%LOCALAPPDATA%\ClaudeAccountGuard\registry.json`, and guarded Claude launches remain fail-closed. Do not replace it with an empty file: that could discard workspace locks. Close VS Code, make a backup, repair or restore the last known-good registry, then reopen VS Code. The wrapper reports `registry_unavailable` without printing registry contents.

## Usage is unavailable

Quota is present only for supported Claude.ai subscription sessions after Claude emits the first API response, and five-hour and seven-day windows can be independently absent. The dashboard therefore distinguishes unavailable, awaiting data, and stale states.

Confirm:

1. Local usage was enabled for the profile.
2. The profile’s status-line bridge is present in its Claude `settings.json`.
3. `disableAllHooks` is not disabling status-line execution.
4. The dashboard’s collection timestamp advances after a Claude response.

## Another process wrapper was already configured

Account Guard does not silently overwrite it. Accept **Use Account Guard Wrapper** to put the safety preflight first and chain the prior wrapper afterward. Diagnostics shows both redacted paths and any unresolved conflict.

## Disable or uninstall

The launcher copies the wrapper and status-line bridge to `%LOCALAPPDATA%\ClaudeAccountGuard\wrapper`, outside the versioned extension directory. This prevents Claude Code from breaking when an extension version is upgraded, disabled, or removed.

To fully remove integration:

1. Remove profile metadata from Account Guard while it is installed so prior status-line commands can be restored.
2. Clear `claudeCode.claudeProcessWrapper` in VS Code settings, or restore the upstream wrapper shown in diagnostics.
3. After exporting or deleting usage as desired, remove `%LOCALAPPDATA%\ClaudeAccountGuard`.

Never remove Claude profile directories as part of Account Guard cleanup; they belong to Claude Code and may contain credentials.

## SQLite availability

The extension uses the `node:sqlite` API bundled with the VS Code 1.130 extension host. No native database addon is packaged. Older VS Code releases are rejected by the extension manifest rather than failing at activation with a native ABI mismatch.
