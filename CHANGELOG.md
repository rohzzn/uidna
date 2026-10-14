# Changelog

All notable changes to `@rohzzn/uidna` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
semantic versioning. The document schema has its own changelog in
[`packages/schema/CHANGELOG.md`](packages/schema/CHANGELOG.md).

## [Unreleased]

Completes Phase 2 with responsive-rule inference and search, filter and sort inference,
each proven end to end on the new Fixture B (an orders dashboard) in real Chromium.

### Added

- Responsive-rule inference: `scan_interface` reads the width conditions of readable
  stylesheets and resizes between the scanned widths (resize only, every non-GET request
  blocked) to locate where the layout changes. Located breakpoints, with their bracket,
  explaining condition and the layout values that change, are in `visual.responsive`
  (schema 0.3.0) and in the scan result. `responsive` input to tune or turn it off.
- The generator declares the located breakpoints and attributes each style change to the
  breakpoint that explains it; the verifier checks the generated layout on both sides of
  every probed breakpoint (`responsive` comparisons in the DiffReport).
- Search, filter and sort inference: tables, lists and card grids become collections
  (schema 0.3.0) with item identity, fields and value kinds; transitions that narrowed or
  reordered them become search, filter, sort and reset rules with the field, match,
  predicate or order that explains them, and the empty-state message of an empty result.
- `explore_interactions` tries the search box of a collection with a query taken from its
  items, then one that matches nothing, then clears it; `collections: false` skips it.
- Generated collections render their items through search, filter and sort state, with
  `aria-pressed` and `aria-sort` following it; the verifier compares the items shown after
  a replay with the original's by identity and order, and generated tests assert them.
- Fixture B and its end-to-end acceptance test, in the CI matrix.

### Changed

- Exploration blocks every non-GET request for the whole run: an action that sends one is
  a side effect that never reaches its server. A control repeated in every item of a
  collection is one action: after a side effect it is skipped in every item.
- Captures keep identity attributes (`data-id` and similar) and table `scope`, `colspan`
  and `rowspan`.
- A click toggle whose changes span several section files (a menu button in the header
  and the drawer it opens in the main section) shares one state through
  `src/lib/shared-state.ts` instead of being left out.
- Absolutely and fixed positioned boxes keep the inset they are anchored by and their
  measured width, and drop the opposite inset, which the browser resolves to the scanned
  width; a box stretched by both insets keeps both.
- A flex or grid container taller than its children keeps its height (margins never
  collapse there), unless its own flex or grid parent stretches it.
- Together with the shared toggle state, these changes took the generated Fixture B
  dashboard from 112 to 116 of 116 matched transitions and from 2 to 3 of 3 breakpoints
  matched on both sides.
- The HTML report shows each page's route from the generated project's manifest, and says
  when a page was not generated.

### Fixed

- `act()` waits for the popup of a click whose request the guard already saw, so a slow
  popup report under load no longer makes the click count as performed.

- `uidna setup` registers `npx -y @rohzzn/uidna@latest serve`. With the bare package name,
  npx run inside a checkout of this repository resolved to the checkout and the server
  failed to start; the tag also keeps agents on the newest release.
- `uidna doctor` reports an unreachable Chrome on the default debugging port as optional
  information. It is a problem only when an endpoint is named with `--cdp` or in config.
- CI uses `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` v7, which
  run on Node 24.

## [0.2.0] - 2026-10-14

Phase 2: sites, forms and data. Every capability is an end-to-end CI gate on its own
fixture in real Chromium.

### Added

- `scan_interface` and `reconstruct_interface` take `crawl: { maxPages, include, exclude }`:
  a breadth-first crawl of same-origin links within the page budget. Cross-origin links
  are recorded and never followed. Results list the pages with their depth and the link
  that discovered them.
- `captureBodies: "json"` stores JSON responses from fetch and XHR as redacted,
  size-capped data assets.
- `explore_interactions` explores every page, records clicks on links to another crawled
  page as navigation transitions, and reports coverage per page. `pages` narrows it.
- The `forms` exploration policy fills forms with synthetic values (`formValues` overrides
  them per control) and submits them empty and filled. Validation states keep
  `aria-invalid`, the error message and native validity. Every submission request is
  blocked, recorded as a side effect and never repeated, in the same run or a later one.
- `generate_project` writes one component per page behind react-router with the shared
  header and footer in a layout (`router`), forms that reproduce the observed validation
  without sending a request, a typed mock per data asset, and Playwright behavior tests in
  `tests/behavior.spec.ts` (`behaviorTests`).
- `verify_reconstruction` renders every page at its route, replays fills, blocked submits
  and same-origin navigations, and runs the generated Playwright suite with
  `runGeneratedTests`. A failing generated test becomes a behavior finding.
- Fixture C (a signup form with validation, a POST endpoint and a JSON list) and Fixture D
  (a three-page site), each with an end-to-end acceptance test.

### Changed

- Transitions that caused a side effect are never replayed, by the verifier or by the
  generated Playwright suite, which skips them with the reason.
- `explore_interactions` remembers side-effect controls per page, so a control on one page
  no longer hides a control at the same position on another.
- Generated-test and build processes are killed with their whole process tree on Windows
  when they time out or are cancelled.
- The forms policy holds its non-GET guard for a whole form chain, from the first step to
  the fresh load that reverts it. Requests a page sends while unloading, such as beacons
  and keepalive fetches, are blocked through the DevTools Protocol because Playwright
  routing cannot see them.
- Form chain steps find their control again after an earlier step changed the form, and
  skip with a reason when it can no longer be matched.
- Side effects caused by revert steps, by actions the browser reported as not performed,
  by navigations to pages without a capture at that width, and by page-level keys are
  attributed to their action and remembered.
- The generator and the verifier share one replay tracer. A state reachable only through a
  side effect is never replayed, and its generated test is skipped with the reason.
- The verifier takes page routes from the generated project's manifest when it was
  generated from the same scan. Pages the generator left out are reported, not compared.

### Fixed

- A page-controlled field name such as `constructor` no longer resolves to a built-in
  object member when the forms policy picks a synthetic value.
- A stale generated-test report from an earlier attempt is never read as the current one.
- Literal routes that contain a colon, such as `/wiki/Help:Contents`, are matched as
  literal paths.
- Requests of a document replaced by a navigation are settled as abandoned. They used to
  stay in flight forever, so every later stability wait ran to its timeout.
- `verify_reconstruction` never runs the behavior tests of a project generated from
  another scan, whose transition ids name other transitions; a limitation says why.

## [0.1.0] - 2026-10-13

### Added

- Phase 1: the single-page loop from URL to verified React project. Capture at several
  viewports, safe exploration with revert, token clustering, component fingerprinting,
  agent annotations with `inferred` provenance, a deterministic React + TypeScript +
  Tailwind + Vite generator, and a verifier with pixel, SSIM, geometry, style and
  behavior comparison across attempts.
- Twelve tools with one evidence envelope over MCP and the CLI, plus `setup` and `doctor`.
