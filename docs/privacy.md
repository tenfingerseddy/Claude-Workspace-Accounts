# Privacy

Claude Account Guard is local-first. It does not provide a network service beyond a loopback-only OpenTelemetry receiver for Claude Code processes on the same machine.

## Data the extension stores

- Profile display name and non-secret configuration paths.
- Expected email, account ID, and organization ID confirmed by the user.
- Workspace-lock URI and a normalized path used by the local preflight wrapper.
- Sanitized authentication-check outcome; raw command output is never persisted.
- Normalized usage totals, status snapshots, request timing, tool names, permission decisions, and collector health.
- Locally estimated cost, explicitly distinguished from provider billing.

Email and organization identifiers are personal data. Profile metadata has an explicit JSON export and deletion path.

## Data the extension never reads or stores

- `.credentials.json`.
- OAuth tokens, API keys, browser cookies, passwords, or raw authorization headers.
- Prompt or response text.
- Tool input or output content.
- Raw API request or response bodies.
- Raw `claude auth status` output.

OpenTelemetry ingestion uses a strict attribute allowlist. Unknown and content-bearing fields are dropped before SQLite writes. The wrapper explicitly sets `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and `OTEL_LOG_RAW_API_BODIES` to `0`.

## Local endpoints

Each active profile window binds an HTTP receiver to `127.0.0.1` on an ephemeral port. A 256-bit random bearer token is generated for that process, placed in the local registry, refreshed while the collector is alive, and rejected after it becomes stale.

## Workspace paths

Account locks require a local canonical path because the wrapper runs outside the extension host. Usage snapshots store a workspace label and a one-way truncated SHA-256 hash by default. Full workspace-path collection remains disabled unless the user changes the privacy setting.

## Retention and deletion

- Normalized events: 30 days by default, configurable from 1 to 365 days.
- Daily aggregates: 365 days.
- Status snapshots: older snapshots are downsampled after 24 hours.
- **Delete Local Usage Data** removes usage, snapshots, events, and collector diagnostics.
- **Delete Profile Metadata** removes the profile and its workspace locks, and attempts to restore its previous status-line command.

Neither action deletes Claude settings or credentials.
