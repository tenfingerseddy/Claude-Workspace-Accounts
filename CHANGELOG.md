# Changelog

## 0.1.0

- Initial Windows implementation of isolated Claude account profiles.
- Fail-closed workspace locks through the official Claude process-wrapper contract.
- Auth verification through `claude auth status`; credential files are never inspected.
- Local status snapshots, privacy-minimized OTLP collection, SQLite storage, diagnostics, export, and an accessible usage dashboard.
