# Privacy

Claude Workspace Accounts is local-first. It does not provide a network service beyond a loopback-only OpenTelemetry receiver for Claude Code processes on the same machine.

## Data the extension stores

- Profile display name and non-secret configuration paths.
- Expected email, account ID, and organization ID confirmed by the user.
- Workspace-lock URI and a normalized path used by the local preflight wrapper.
- Sanitized authentication-check outcome; raw command output is never persisted.
- Normalized usage totals, status snapshots, request timing, tool names, permission decisions, and collector health.
- Locally estimated cost, explicitly distinguished from provider billing.

Email and organization identifiers are personal data. Profile metadata has an explicit JSON export and deletion path.

### The one file it reads inside a Claude account directory

Plan quota is read from `cachedUsageUtilization` in `<configDir>\.claude.json`, which Claude Code writes there itself when it refreshes usage. The extension only ever reads that file, only that one member of it, and stores only quota fields from it: the percentage, reset time, model name and reported severity of each window, the extra-usage pool's utilization and limit, and Claude's own timestamp for the reading.

`.claude.json` also holds unrelated things, including the account block Claude keeps there. None of it is read, stored, displayed, or exported. `.credentials.json` sits beside it and is still never opened — see below.

This is how quota reaches the status bar and dashboard for an account. It needs no session, no status line, no local collection, and no write of any kind into your account directory.

## Data the extension never reads or stores

- `.credentials.json`.
- Any part of `<configDir>\.claude.json` other than `cachedUsageUtilization`.
- OAuth tokens, API keys, browser cookies, passwords, or raw authorization headers.
- Prompt or response text.
- Tool input or output content.
- Raw API request or response bodies.
- Raw `claude auth status` output.

OpenTelemetry ingestion uses a strict attribute allowlist. Unknown and content-bearing fields are dropped before SQLite writes.

### The five content-logging flags

On every Claude launch it wraps, and before it does anything else with the environment, the wrapper sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and `OTEL_LOG_RAW_API_BODIES` to `0`. This does not depend on whether local collection is running: it applies with no account registry, with no collector registered, with a stale registration, and with collection turned off for the account or turned off globally. Those paths used to leave the flags exactly as inherited, which mattered beyond the wording — with `CLAUDE_CODE_ENABLE_TELEMETRY=1` inherited and no endpoint configured, OTLP falls back to its default localhost endpoint, so an inherited `OTEL_LOG_USER_PROMPTS=1` could export prompt and response content to whatever was listening there.

Two cases are exempt, both deliberately:

- **You have configured your own OpenTelemetry pipeline.** If any exporter, endpoint, protocol, compression, header, or client-certificate variable is set, the wrapper injects nothing at all — no endpoint, no headers, no exporter selection — and it also leaves your content flags exactly as you set them. Nothing reaches a Workspace Accounts collector on that path, and the destination is a collector you chose; a pipeline that logs prompts on purpose is a legitimate configuration, and silently disabling it would be this extension overriding your explicit choice rather than protecting anything of its own.
- **`CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1`** (or `CLAUDE_ACCOUNT_GUARD_DISABLE=1`, the name the previous release documented). The kill switch makes the wrapper a pure pass-through and changes no environment variable whatsoever, including these five. An escape hatch that still edited the environment could not be used to escape a defect in how the wrapper edits the environment.

Neither exemption lets Workspace Accounts itself collect content: nothing is injected in either case, its collector's attribute allowlist has no content field, and it never writes prompt, response, or tool content to disk.

## Local endpoints

Each active profile window binds an HTTP receiver to `127.0.0.1` on an ephemeral port. A 256-bit random bearer token is generated for that process, placed in the local registry, refreshed while the collector is alive, and rejected after it becomes stale.

## Workspace paths

Account bindings require a local canonical path because the wrapper runs outside the extension host, so `registry.json` holds the path of each workspace you have bound an account to. Everything else records a workspace as a sanitized label plus a one-way truncated SHA-256 hash: usage snapshots, usage rows, the OpenTelemetry resource attributes the wrapper sets, and `binding-cache.json` — the wrapper's own record of the last account each workspace resolved to, which it falls back on when the registry cannot be read. Full workspace-path collection remains disabled unless the user changes `claudeAccounts.privacy.collectWorkspacePath`.

`binding-cache.json` previously recorded the literal directory of every workspace that had ever been bound, regardless of that setting, and it is one of the files that survives uninstalling the extension. It is now keyed on the hash, and a cache written by an earlier release is rewritten into that form — or deleted if it cannot be read — on the first launch after upgrading, without losing the bindings it recorded.

## Retention and deletion

- Normalized events: 30 days by default, configurable from 1 to 365 days.
- Daily aggregates: 365 days.
- Status snapshots: older snapshots are downsampled after 24 hours.
- **Delete Local Usage Data** removes usage, snapshots, events, and collector diagnostics.
- **Delete Profile Metadata** removes the profile and its workspace locks, and attempts to restore its previous status-line command.

Neither action deletes Claude settings or credentials.
