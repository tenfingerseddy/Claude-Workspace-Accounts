# Feasibility record

Date: 2026-07-23  
Observed platform: Windows x64  
Observed installed Claude Code extension: `anthropic.claude-code` 2.1.218
Observed VS Code: 1.130.0 / Electron 42.6.0

## Confirmed contracts

1. The installed extension contributes machine-scoped `claudeCode.claudeProcessWrapper`.
2. Inspection of the installed 2.1.218 launcher shows that a configured wrapper becomes the executable and the bundled native Claude path is prepended to its arguments.
3. The installed extension includes `resources/native-binary/claude.exe`.
4. Official documentation describes `CLAUDE_CONFIG_DIR` as the supported Windows isolation mechanism for settings, history, plugins, and credentials.
5. Official CLI documentation defines `claude auth status` as JSON output with exit code 0 when logged in and 1 otherwise.
6. Official status-line documentation defines current-context fields and independently optional five-hour/seven-day `rate_limits`. Context input totals are current state rather than cumulative as of Claude Code 2.1.132.
7. Official monitoring documentation defines OTLP metrics/events and keeps prompt, tool-detail, tool-content, assistant-response, and raw-body fields behind explicit privacy gates.

Primary references:

- [Claude Code in VS Code](https://code.claude.com/docs/en/ide-integrations)
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Status line](https://code.claude.com/docs/en/statusline)
- [Monitoring](https://code.claude.com/docs/en/monitoring-usage)

## Safe implementation decisions

- The process wrapper receives and validates an existing file path as its first argument.
- Child processes use argument arrays; account verification never uses a constructed shell string.
- The registry is outside workspaces and contains metadata only.
- Enforced locks fail closed when the registry exists but cannot be validated, the runtime profile differs, authentication is absent, or identity is unverifiable.
- The stable wrapper lives outside the installed extension version directory so upgrades and disable/uninstall do not leave Claude pointing at a deleted file.
- Existing wrappers are chained only after Account Guard preflight.
- Existing status-line commands are recorded and forwarded rather than overwritten.
- SQLite uses the extension host's built-in `node:sqlite` API, avoiding native-addon ABI drift.

## Interactive acceptance still required

The following cannot be truthfully certified by fixtures alone:

- concurrent graphical windows authenticated as two different real Claude accounts;
- live graphical status-line callbacks and rate-limit fields for the installed account/plan;
- live OTLP delivery from a graphical session;
- end-to-end wrapper invocation by the Claude panel after installing this development VSIX;
- disable/uninstall recovery in a clean VS Code profile.

Until those checks run, unavailable data stays unavailable and the release should be treated as a development build, not a fully accepted v1.
