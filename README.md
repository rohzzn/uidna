<h1 align="center">UI DNA</h1>

<p align="center">
  <strong>Reverse-engineer any user interface. Rebuild it as code you own. Prove it.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rohzzn/uidna"><img alt="npm version" src="https://img.shields.io/npm/v/%40rohzzn%2Fuidna?label=%40rohzzn%2Fuidna&color=2f5bea"></a>
  <a href="https://www.npmjs.com/package/@rohzzn/uidna-schema"><img alt="schema version" src="https://img.shields.io/npm/v/%40rohzzn%2Fuidna-schema?label=%40rohzzn%2Fuidna-schema&color=2f5bea"></a>
  <a href="https://github.com/rohzzn/uidna/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/rohzzn/uidna/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1f9d6a"></a>
  <img alt="Node 20.19+" src="https://img.shields.io/badge/node-%E2%89%A520.19-d98a1f">
</p>

<p align="center">
  An MCP server and CLI for coding agents. The agent is the brain; UI DNA is the instrument.<br>
  No model calls, no API keys, nothing leaves your machine.
</p>

---

UI DNA is [REA](https://github.com/morluto/rea) for user interfaces. REA's promise is
"see a feature you like, understand how it works, down to the binary, show the evidence,
build it." UI DNA's promise: see an interface you like, understand how it is structured,
how it behaves and how to reproduce it, down to the token, the component and the state
transition, then rebuild it as code you own, with proof.

```text
agent asks about a target  →  UI DNA captures, crawls, measures, explores
                           →  returns a UI DNA document + evidence + unknowns
agent reconstructs, verifies, repairs, reports
```

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [What ships today](#what-ships-today)
- [Tools and commands](#tools-and-commands)
- [The UI DNA document](#the-ui-dna-document)
- [A measured run](#a-measured-run)
- [Authorized use](#authorized-use)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Quick start

```bash
npm install -g @rohzzn/uidna
npx playwright install chromium
uidna setup      # registers the MCP server in Claude Code, Codex and Cursor; asks first, backs up
uidna doctor     # browser availability, CDP reachability, registration state
```

`uidna setup` prints the planned changes to `~/.claude.json`, `~/.codex/config.toml` and
`~/.cursor/mcp.json`, asks for confirmation and backs up every file it touches. Use
`--scope project` to write `.mcp.json` and `.cursor/mcp.json` in the current directory
instead, and `--yes` to skip the prompt. The registered command is
`npx -y @rohzzn/uidna serve` (wrapped in `cmd /c` on Windows).

Manual MCP configuration, if you prefer:

```json
{
  "mcpServers": {
    "uidna": { "type": "stdio", "command": "npx", "args": ["-y", "@rohzzn/uidna", "serve"] }
  }
}
```

The shipped skill, [`skills/uidna/SKILL.md`](skills/uidna/SKILL.md), teaches the agent the
loop. Copy it into your agent's skills directory (for Claude Code, `~/.claude/skills/uidna/`).

To run the whole loop without an agent, on one page:

```bash
uidna reconstruct https://example.com ./example-clone --viewports 1280,768,390
```

On a small site you own, following up to five same-origin pages, capturing JSON responses
as data and exercising its forms with synthetic values:

```bash
uidna reconstruct http://localhost:3000 ./my-site --crawl '{"maxPages":5}' --capture-bodies json --policy forms
```

## How it works

| Step | What happens | Who decides |
| --- | --- | --- |
| **Capture** | Chromium loads each page at each viewport. UI DNA records the DOM, computed styles filtered to rendering properties, bounding boxes, the accessibility tree, form facts, fonts, assets, network metadata and one screenshot per state. With a crawl, same-origin links are followed breadth-first within a page budget; with body capture, JSON responses are stored as redacted data assets. | UI DNA |
| **Explore** | Hover, focus, Escape, Tab, and clicks on non-submitting buttons, summaries, tabs and disclosure or menu triggers, on every page. Links to another crawled page are followed once and recorded as navigation transitions. The `forms` policy also fills each form with synthetic values and submits it empty and filled, with every submission request blocked. Every action is snapshotted, performed, diffed and reverted; every skip has a reason. | UI DNA |
| **Measure** | Tokens come from clustering measured values, with sample counts. Component candidates come from structural fingerprints across pages, with instances, varying props, variants and a confidence derived from agreement. Header and footer shared by every page become a layout. | UI DNA |
| **Understand and annotate** | The agent reads the document, names components and tokens, records what it infers and why, and authorizes assets the user owns. Agent readings are stored as `inferred` next to the measured values, never over them. | the agent |
| **Generate** | A deterministic React + TypeScript + Tailwind + Vite project: one component per page behind react-router, semantic HTML, extracted components, tokens as CSS variables and a Tailwind theme, observed transitions as React state with the original ARIA attributes, forms with the observed validation messages, typed mocks from captured data, and a Playwright suite that replays the recorded transitions. | UI DNA |
| **Verify** | Pixel diff, SSIM, geometry, computed styles and element presence per page, state and viewport. Recorded transitions are replayed, including fills, blocked submits and navigations, and the generated Playwright suite can run too. One finding per concrete difference, with the original and generated values. | UI DNA |
| **Repair and report** | The agent edits the project against the DiffReport and re-verifies; regressions and resolved findings are tracked per attempt. A static HTML report shows the evidence. | the agent |

Every value in the document carries provenance: `measured`, `observed`, `inferred` (agent
only) or `unknown` with a reason. Nothing is rounded into a guess, and no result is a
single blended score.

## What ships today

**Phase 1, the single-page loop.** From URL to verified React project, proven in CI with a
real Chromium against [Fixture A](fixtures/a-marketing), a marketing page with a
responsive navbar and hamburger menu, a hero, two call-to-action buttons, a three-card
grid, an image, an FAQ accordion and a footer, at 1280, 768 and 390 pixels wide.

- Two browser modes: Playwright-launched Chromium for public pages, and attach to your own
  Chrome over the DevTools Protocol for sessions you are authorized to analyze.
- `robots.txt` honored, per-origin rate limits, Chromium sandbox requested (with an honest
  limitation when the host cannot provide one), secrets redacted before anything is stored.
- Twelve tools with one evidence envelope, identical over MCP and the CLI; `setup` and
  `doctor` on the CLI; `--json`, a config file and debug logging.
- A versioned, framework-neutral schema published separately as
  [`@rohzzn/uidna-schema`](packages/schema).
- The generated project builds; its build, the recorded transitions, and an injected CSS
  and behavior regression are each a CI test.

**Phase 2, sites, forms and data.** Each capability below is a CI gate on its own fixture.

- **Multi-page crawl.** `crawl: { maxPages, include, exclude }` follows same-origin links
  breadth-first; cross-origin links are recorded and never followed. Pages carry their
  depth and the link that discovered them. Components are matched across pages, and the
  header and footer every page shares become one layout.
- **Navigation transitions.** A click on a link to another crawled page is recorded as a
  transition between the two pages. The generator wires it as a router link and the
  verifier replays it through the original link.
- **Forms.** The `forms` policy fills controls with synthetic values (never real
  credentials; hidden and file inputs are never filled), submits the empty form to observe
  client-side validation and the filled form to observe the result. Validation states keep
  `aria-invalid`, the error message and the browser's validity. Every submission request
  is blocked, recorded as a side effect and never repeated.
- **Data.** `captureBodies: "json"` stores JSON responses from fetch and XHR as redacted,
  size-capped data assets. The generator turns each one into a typed mock.
- **Behavior tests.** The generated project includes `tests/behavior.spec.ts`: one
  Playwright test per implemented transition, asserting the observed delta. Transitions
  the generator did not reproduce, or that caused a side effect when observed, are
  skipped with the reason. `verify_reconstruction` runs the suite when asked.

[Fixture C](fixtures/c-form) is a signup form with client-side validation, a POST
endpoint and a JSON list. [Fixture D](fixtures/d-multipage) is a three-page site with a
shared header and footer, tabs, a pricing toggle and a cross-origin footer link.

## Tools and commands

| Command | Tool | Answers |
| --- | --- | --- |
| `uidna scan <url>` | `scan_interface` | What is on each page at each viewport? `--crawl` for a site, `--capture-bodies json` for data. Creates `./.uidna/<scan-id>/`. |
| `uidna explore <scan>` | `explore_interactions` | What changes when I interact? `--policy safe` (default) or `forms`; `--pages` and `--viewports` narrow it. |
| `uidna inspect <scan>` | `inspect_dna` | Summary, one facet, one path, or the whole document. |
| `uidna element <scan> <state>` | `inspect_element` | One node: box, style, tokens, a11y, form facts, ancestors, evidence. |
| `uidna components <scan>` | `search_components` | Fingerprinted component candidates in stable order, matched across pages. |
| `uidna tokens <scan>` | `extract_tokens` | Token clusters with member values and sample counts. |
| `uidna annotate <scan> <patches>` | `annotate_dna` | Apply the agent's readings with `inferred` / `agent` provenance. |
| `uidna generate <scan> <outDir>` | `generate_project` | The React project, installed and built. `--router`, `--no-behavior-tests`. |
| `uidna verify <scan> <outDir>` | `verify_reconstruction` | The DiffReport for this attempt, with regressions and resolved findings. `--run-generated-tests`. |
| `uidna report <scan>` | `report_reconstruction` | The static HTML report. |
| `uidna export <scan>` | `export_evidence` | A portable evidence bundle with a manifest of digests. |
| `uidna reconstruct <url> <outDir>` | `reconstruct_interface` | The whole loop. |

Every tool returns the same envelope; add `--json` on the CLI to see it:

```json
{
  "result": {},
  "evidence_id": "ev_3f9a1c7b2d4e",
  "evidence": { "kind": "scan", "inputs": {}, "artifacts": [], "capturedAt": "2026-10-13T17:29:00.000Z" },
  "limitations": [],
  "unknowns": []
}
```

The full catalog, generated from the contracts, is in [`docs/tools.md`](docs/tools.md).

## The UI DNA document

A UI DNA document describes an interface the way an engineer needs it described to rebuild
it: pages and navigation, observed states and the transitions between them, component
candidates with their instances, visual tokens with the measurements behind them, layout
constraints per node, form facts and validation states, observed behavior, assets and data
with origin and authorization, and what could not be observed.

```json
{
  "value": "248px",
  "provenance": {
    "kind": "measured",
    "source": "computed-style",
    "stateId": "st_01",
    "viewport": { "width": 1280, "height": 800 },
    "evidenceId": "ev_3f9a1c7b2d4e",
    "capturedAt": "2026-10-13T17:29:00.000Z",
    "confidence": 0.98
  }
}
```

Schema 0.2.0 adds pages with depth and discovery, form facts on nodes, `fill` and `submit`
actions, navigation transitions and data assets; every 0.1.0 document is still valid. The
reference is [`docs/ui-dna.md`](docs/ui-dna.md); a complete validated example from
Fixture A is in [`docs/examples/fixture-a.dna.json`](docs/examples/fixture-a.dna.json).

## A measured run

<!-- numbers:begin -->
Measured on Fixture A (`http://127.0.0.1:65125/`) by scan `scan_20261013_176e54` with tool version 0.1.0:

| Step | Result |
| --- | --- |
| scan | 3 base states at 1280, 768, 390 px; 71 / 71 / 71 nodes; 1 asset; 113.1 s of browser time for scan and explore together |
| explore (safe) | 36 interactive elements discovered, 88 interactions performed, 69 produced a new state, 44 skipped with a reason; 73 transitions, 69 derived states |
| tokens | 10 colors, 17 typography styles, 11 font sizes, 12 spacing values, 4 radii, 1 shadow, 2 breakpoints |
| components | 7 candidates, 65 instances (largest: Component01 with 17) |
| behavior | 73 observed rules; 0 limitations recorded |
| verify attempt 1 | 21 findings (layout 9, typography 3, color 6, asset 3); pixel diff 1280px 0.66%, 768px 0.53%, 390px 0.80%; 73/73 replayed transitions matched; 0 regressions, 0 resolved |
| verify attempt 2 | 35 findings (layout 9, typography 3, color 20, asset 3); pixel diff 1280px 1.29%, 768px 1.61%, 390px 1.84%; 73/73 replayed transitions matched; 14 regressions, 0 resolved |
| verify attempt 3 | 21 findings (layout 9, typography 3, color 6, asset 3); pixel diff 1280px 0.66%, 768px 0.53%, 390px 0.80%; 73/73 replayed transitions matched; 0 regressions, 14 resolved |
| verify attempt 4 | 45 findings (layout 9, typography 3, color 6, asset 3, behavior 24); pixel diff 1280px 0.66%, 768px 0.53%, 390px 0.80%; 62/73 replayed transitions matched; 24 regressions, 0 resolved |
| verify attempt 5 | 21 findings (layout 9, typography 3, color 6, asset 3); pixel diff 1280px 0.66%, 768px 0.53%, 390px 0.80%; 73/73 replayed transitions matched; 0 regressions, 24 resolved |

Pixel ratios depend on the fonts of the machine that rendered them; the counts do not.
<!-- numbers:end -->

Attempts 2 and 4 are the CI loop's injected regressions (a changed primary color, then a
script that swallows clicks); attempts 3 and 5 are the reverts. The 21 baseline findings
are all the unauthorized illustration rendered as a labeled placeholder, by design. The
table is written by `scripts/readme-numbers.ts` from the scan that produced it.

## Authorized use

Scan interfaces you own or are allowed to analyze. UI DNA never bypasses authentication,
CAPTCHAs, anti-bot measures or access controls, never stores credentials, and never
redistributes third-party assets: unauthorized assets become labeled placeholders until
you mark them authorized with `annotate_dna`. See [DISCLAIMER.md](DISCLAIMER.md) and
[SECURITY.md](SECURITY.md).

The `forms` policy types synthetic values into the page and runs its submit handlers.
Every non-GET request is blocked from the first step of a form's chain to the fresh load
that ends it, including beacons sent while the page unloads, but use the policy only on
interfaces you may test that way. A crawl stays on the seed's origin, honors `robots.txt`
and stops at its page budget.

To analyze an authenticated app, start your own Chrome with `--remote-debugging-port=9222`,
open the page, then `uidna scan --cdp-endpoint http://localhost:9222`. The session stays
yours; UI DNA reads the page and performs the same safe interactions.

## Limitations

- A crawl follows same-origin `<a href>` links only, up to 50 pages. Navigations made by
  scripts are blocked and reported, not followed.
- Server responses to form submissions are never observed, because the requests are
  blocked. Success states that depend on the server are reproduced only as far as the
  page showed them without one, and the generated README says so.
- `<iframe>` content and shadow DOM are not entered; they are reported as limitations.
- Inline `<svg>` markup is not captured; such nodes become placeholders.
- Breakpoints are observed at the scanned widths: a breakpoint token says the layout at
  that width differs from the next wider scanned width, not where the media query lies.
- Spacing tokens are used values: a `margin: auto` shows up as the pixel margin it produced.
- Hover and focus transitions are reproduced as CSS variants at every viewport; click
  transitions are reproduced when the changed nodes live in the same section or component
  as the trigger. Every behavior the generator could not implement is listed in the
  generated README and skipped in its Playwright suite.
- The generator is a baseline, not a finished product: names are placeholders and the agent
  is expected to repair against the DiffReport.
- Verification compares at the scanned viewports with system fonts; cross-machine pixel
  diffs reflect font rendering differences, which is why findings carry the measured values
  rather than a single score.

## Development

```text
packages/schema/   @rohzzn/uidna-schema: Zod schema, JSON Schema, types, changelog
src/domain/        fingerprints, clustering, colors, safe-action and forms policy, Result, budgets
src/contracts/     tool contracts and the canonical catalog (docs/tools.md is generated)
src/browser/       Playwright launch + CDP attach adapters, capture, robots, redaction, JSON bodies
src/analysis/      normalization, token clustering, components, layout, multi-page assembly
src/explore/       interaction rounds, navigation, form chains, state graph, revert
src/generate/      UI DNA document → React project, router, forms, mocks, Playwright tests
src/verify/        render, visual + behavioral compare, generated-test runs, DiffReport, HTML report
src/application/   workflows shared by the CLI and the MCP server, crawl, scan store
src/server/        MCP adapter
skills/uidna/      SKILL.md
fixtures/          A (marketing page), C (signup form and data), D (three-page site)
tests/             end-to-end loops on Fixtures A, C and D, and the MCP server over stdio
```

```bash
npm ci
npm run build
npm run test:unit    # real Chromium against the fixtures and synthetic pages, no module mocks
npm run test:e2e     # the Phase 1 and Phase 2 loops and the MCP server (about 25 minutes)
npm run docs:catalog
```

Conventional Commits, ESM TypeScript in strict mode, Zod at every boundary, tagged errors
with `Result`, no `any`, no non-null assertions, no floating promises. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
