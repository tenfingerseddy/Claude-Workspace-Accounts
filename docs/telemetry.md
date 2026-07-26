# Local telemetry

Local usage collection has two independent sources.

## Status snapshots

The profile-specific Claude `statusLine` command receives documented session JSON. Account Guard installs a bridge only after confirmation. The bridge:

- parses the JSON from standard input;
- writes only model, session, context, cost, lines, rate-limit, workspace label, and workspace hash fields;
- excludes transcript paths and raw workspace paths;
- atomically drops the normalized snapshot into the local inbox;
- forwards the original JSON to the previous status-line command and preserves its output.
- stops writing immediately when either the profile or global telemetry switch is disabled.

If graphical Claude Code does not invoke the status line for a particular version, quota and context remain explicitly unavailable.

## OpenTelemetry

The process wrapper configures Claude Code to send metrics, logs, and traces to an authenticated loopback receiver using OTLP HTTP/JSON. The collector understands documented Claude Code metrics such as:

- `claude_code.session.count`
- `claude_code.lines_of_code.count`
- `claude_code.pull_request.count`
- `claude_code.commit.count`
- `claude_code.cost.usage`
- `claude_code.token.usage`
- `claude_code.active_time.total`

It also normalizes API request/error spans and events, trace-derived request latency and time to first token, tool result/decision, authentication, and MCP connection events when present.

Only these analysis attributes are allowlisted: model, query source, token type, hashed workspace plus short label, safe skill/plugin/agent labels, durations, success, decision source, status/error category, and server/tool name. Attribute strings are bounded before persistence. User email, command lines, request bodies, and other unlisted resource/span attributes are discarded.

Changing `claudeAccountGuard.telemetry.enabled` to false removes the collector registration and updates shared guard state immediately. Extension shutdown also disables collection; the next activation restores it only when the setting remains enabled.

## Provenance

- Quota and context: exact when present in a Claude status snapshot.
- Cost: **Estimated local cost**.
- Token, active-time, request, and tool metrics: locally observed.
- Provider billing and plan enforcement remain authoritative.

Missing data is not converted to zero. Dashboard sections declare collection source, last update, and availability.
