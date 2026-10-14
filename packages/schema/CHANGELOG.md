# Changelog

All notable changes to `@rohzzn/uidna-schema` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows semantic versioning. `dnaVersion` inside a document tracks this
package's version.

## [0.3.0] - 2026-10-14

### Added (all optional; 0.2.0 documents stay valid)

- `visual.responsive`: breakpoints located by reading the page's stylesheets and by
  resizing between the scanned widths (`minWidth`, `source` css or probe, the `bracket`
  that locates it, `observed`), the width conditions read from stylesheets with their
  thresholds, the layout properties that change at each breakpoint (`rules`), and what
  probing did per page (`probes`).
- `collections`: repeated items measured in a base state (container, item identity,
  fields, items in base order) and `rules` that classify observed transitions as
  `search`, `filter`, `sort` or `reset`, with the control, the views before and after,
  and the predicate, match or order that explains the change.
- Provenance source `stylesheet`: a value read from the page's CSS rules.

## [0.2.0] - 2026-10-14

### Added (all optional; 0.1.0 documents stay valid)

- `app.pages[]`: `depth`, `discoveredVia` and `coverage` for multi-page crawls and
  explored-versus-discovered counts per page.
- `states.transitions[].navigation`: set when a same-origin link led to another page.
- `Action.type` gains `fill` and `submit`; `Action.value` carries the synthetic value a
  `fill` action typed.
- `UiNode.form`: native validity, validation message, required flag, control type and
  whether a value was present, for form controls. `A11yProps.invalid` and
  `A11yProps.errorMessage`.
- `Asset.kind` gains `data` for opt-in captured JSON responses, with `Asset.request`.
- `ComponentDefinition.pageIds` for candidates that span pages.

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
