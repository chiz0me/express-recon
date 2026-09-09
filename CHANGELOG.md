# Changelog

## 0.17.3

- Validate retained OpenAPI/Swagger references during repository scans. Invalid
  source specifications are retained byte-for-byte with structured diagnostics,
  excluded from API viewers, and shown as warnings without blocking offline
  organization validation or rendering. They still mark coverage incomplete.
- Keep integrity manifest coverage for invalid raw artifacts and strict validation
  for generated OpenAPI and accepted enrichment. Reference errors identify the
  repository, application when known, original source, saved artifact, and reference.
- Checkpoint successfully processed repositories with incomplete coverage. Resume
  preserves their status, verifies artifact hashes and the current source commit,
  and retries operational failures, interrupted work, or incompatible evidence.
  Changed configuration or scan scope invalidates reuse. Legacy retained-spec
  checkpoints are rescanned to establish reference-validation metadata.
- Report up to 20 oversized file paths per repository, their byte sizes, the
  configured `scan.maxFileBytes`, and the count of additional omitted entries.
- Show artifact warnings and acquisition diagnostics in offline HTML reports.

Earlier release notes are available in the
[GitHub releases](https://github.com/chiz0me/express-recon/releases).
