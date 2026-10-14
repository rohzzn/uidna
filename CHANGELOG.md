# Changelog

All notable changes to `@rohzzn/uidna` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows
semantic versioning. The document schema has its own changelog in
[`packages/schema/CHANGELOG.md`](packages/schema/CHANGELOG.md).

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
