# Changelog

All notable changes to `@rohzzn/uidna-schema` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows semantic versioning. `dnaVersion` inside a document tracks this
package's version.

## [0.1.0] - 2026-10-13

### Added

- First published UI DNA document schema (`dnaVersion` 0.1.0).
- Provenance envelope (`measured | observed | inferred | unknown`) with the
  rule that `inferred` values come only from the `agent` source and `unknown`
  values carry a reason instead of a value.
- Top-level sections: `target`, `app`, `states`, `components`, `visual`,
  `behavior`, `assets`, `limitations`, `evidence`, `annotations` (the log of
  agent patches applied through `annotate_dna`).
- `validateUiDna`, `parseUiDna`, `isUiDna` helpers and a generated JSON Schema
  at `@rohzzn/uidna-schema/ui-dna.schema.json`.
- Complete example document built from Fixture A (`fixtures/a-marketing`).
