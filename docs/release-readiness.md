# Release readiness

This file records what has actually been verified, what has not, and what a previously green gate
failed to catch. A passing automated gate is not evidence that the product works; v0.1.0 proved that.

## What v0.1.0 shipped, and why the gate missed it

v0.1.0 passed lint, strict type-checking, 34 tests, the production bundle, and a wrapper smoke test
covering matching-account, wrong-account, identity-drift, corrupt-registry, workspace-key, stdin,
uninstall-fallback, and health-record behaviour. It was published to the Marketplace. It did not work.

Three independent failures were present.

**1. The process wrapper corrupted Claude's argument vector.** It forwarded launches through
`powershell.exe`, whose parameter binding consumed `--verbose` and `--debug` as PowerShell's own common
parameters, bound `-p` to `-PipelineVariable` and swallowed the following value, stripped the quoting
out of `--mcp-config` JSON, dropped empty-string arguments, and turned a trailing backslash into a
quote. The user-visible symptom was Claude Code failing with *"When using --print,
--output-format=stream-json requires --verbose"* — about a flag the extension had passed and the
wrapper had eaten.

The gate missed it because the wrapper smoke test only ever passed `--echo-stdin`. It asserted that *a*
launch happened, never that the arguments survived. Every argument it did not test was broken.

**2. The core feature was unreachable.** Adding an account opened a blank VS Code window with a
separate `--user-data-dir` and never set `expectedIdentity`; the lock command then filtered to profiles
that had one and refused with *"Verify at least one account profile before locking a workspace."* There
was no path from a clean install to a workspace bound to an account.

The gate missed it because no test exercised the command surface as a sequence. Each unit passed in
isolation; the workflow they compose contained a dead end.

**3. Local usage collection had never produced a single row.** In a real installation every usage table
was empty. Contributing causes: a stale closure meant registering a profile never started the collector;
storage failures were reported as non-retryable HTTP 400, so Claude's exporter discarded batches
permanently; snapshots were deleted in a `finally` regardless of whether they were stored; there was no
gzip or `Content-Type` handling; and boolean-like values arriving as the strings `"true"`/`"false"` were
compared as strict booleans, inverting tool success.

The gate missed it because the committed OTLP fixtures encoded an idealised shape rather than the real
wire format, so the normalizer tests validated the fixtures rather than Anthropic's output.

The lesson, recorded in `CLAUDE.md`: this product's characteristic failure mode is silence. A test that
asserts "something happened" is worth very little here — assert the payload.

## Gates added in response

- `scripts/smoke-wrapper-args.mjs` asserts the argument vector reaching the CLI is byte-identical to the
  vector spawned, across the flags Claude Code actually uses, plus exit-code passthrough, stdout
  byte-fidelity, stdout/stderr channel separation, and stdin delivery. It is a specification, not a test
  to be adjusted: if a case fails, the wrapper is wrong. Against the v0.1.0 wrapper, 50 of 68 checks
  failed.
- Binding coverage in `scripts/smoke-wrapper.mjs` asserts that two different bound workspaces resolve to
  two different `CLAUDE_CONFIG_DIR` values regardless of the ambient environment — the core product
  promise, previously untested.

## Verification status

Populate from the actual run at reconciliation. Do not carry claims forward from a previous release;
re-run and record what happened, including failures.

| Gate | Status |
| --- | --- |
| `npm run lint` | not yet run for this release |
| `npm run typecheck` | not yet run for this release |
| `npm test` | not yet run for this release |
| `npm run test:e2e` (includes both wrapper gates) | not yet run for this release |
| `npm run package` | not yet run for this release |

## Required before release, and not yet done

These need two real Claude accounts and an interactive VS Code session. They cannot be automated here,
and v0.1.0 was published without them.

- A clean install reaches a workspace bound to an account without the user reading documentation.
- Two ordinary VS Code windows, opened normally, use two different Claude accounts simultaneously, and
  signing in within one does not change the other.
- Signing in to a second account works through the flow the extension actually offers.
- A bound workspace whose profile directory has been re-authenticated as a different account is detected
  rather than silently serving the wrong account.
- Local usage appears for a bound account; and when it does not, the extension states which stage failed
  instead of rendering an empty dashboard.
- Install, upgrade, disable, and uninstall each leave Claude Code functional. Specifically, uninstalling
  must not leave `claudeCode.claudeProcessWrapper` pointing at a wrapper that no longer exists — that is
  the defect which made v0.1.0 unrecoverable without hand-editing `settings.json`.

Repeat the interactive scenarios in `docs/feasibility.md`. Do not describe a release as ready until the
above have been performed and recorded here with dates.
