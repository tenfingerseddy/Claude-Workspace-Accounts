# Release readiness

This file separates evidence produced by the repository from acceptance work that
requires real Claude accounts. A green automated gate is not a substitute for the
full Version 1 acceptance criteria.

## Verified locally

Verified on Windows with VS Code 1.130.0 and Node.js 24 on 2026-07-24:

- `npm.cmd install` completed with zero reported vulnerabilities;
- ESLint and strict TypeScript checks pass;
- all 34 Vitest tests across 11 files pass;
- the production esbuild bundle succeeds;
- every TypeScript, JavaScript, and PowerShell source file parses;
- the core policy smoke test passes;
- registry corruption is preserved and rejected fail-closed;
- duplicate or nested isolation directories are rejected atomically;
- SQLite storage, retention, attribution, deletion, and path hashing pass;
- the loopback OTLP metrics, logs, and traces collector passes;
- status-line chaining, global opt-out, and workspace-path opt-in pass;
- the native wrapper passes matching-account, wrong-account, identity-drift,
  corrupt-registry, workspace-key, stdin, fallback, and health-record tests;
- the required Node.js SQLite runtime is available;
- the complete `npm.cmd run check` gate passes;
- the Windows x64 VSIX contains only the expected 18 archive entries;
- the VSIX installs, force-reinstalls, and uninstalls successfully in an isolated
  extension directory. Its Marketplace identity is
  `ResonanceLattice-Semanticus.claude-account-guard`.

Reproduce the complete automated evidence with:

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run package
```

The generated `package-lock.json` is retained. The packaged VSIX has been inspected
and exercised through the VS Code CLI in an isolated temporary profile.

## Required before a release

The following acceptance criteria require that installed VSIX and real accounts:

- two concurrent VS Code windows remain bound to two independently verified Claude
  identities;
- both windows continuously show the correct profile;
- a real locked workspace cannot start Claude under the wrong identity;
- switching never discards dirty editors and never logs the other profile out;
- live five-hour and weekly quota values render accurately when Claude supplies
  them;
- install, upgrade, disable, and uninstall leave Claude Code functional.

Repeat the interactive scenarios in `docs/feasibility.md`. Do not mark Version 1
complete until those live scenarios pass.
