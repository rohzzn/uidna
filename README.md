# UI DNA

Reverse-engineer any user interface into a **UI DNA document**, rebuild it as code you
own, and prove the result with a DiffReport. UI DNA is an MCP server and CLI for coding
agents: the agent is the brain, UI DNA is the instrument. It makes no model calls, needs
no API keys, and runs entirely on your machine.

It is [REA](https://github.com/morluto/rea) for user interfaces. REA's promise is "see a
feature you like, understand how it works, down to the binary, show the evidence, build
it." UI DNA's promise: see an interface you like, understand how it is structured, how it
behaves and how to reproduce it, down to the token, the component and the state
transition, then rebuild it as code you own, with proof.

```text
agent asks about a target → UI DNA captures, measures, explores
                          → returns a UI DNA document + evidence + unknowns
agent reconstructs, verifies, repairs, reports
```

## What it does today (Phase 1)

Everything below is exercised in CI with a real Chromium against
[Fixture A](fixtures/a-marketing), a marketing page with a responsive navbar and
hamburger menu, a hero, two call-to-action buttons, a three-card grid, an image, an FAQ
accordion and a footer, at 1280, 768 and 390 pixels wide.

- **Capture.** Playwright-launched Chromium for public URLs, or attach to your own Chrome
  over the DevTools Protocol for sessions you are authorized to analyze. Collects the DOM,
  computed styles filtered to rendering properties, bounding boxes, the accessibility tree,
  fonts, assets, network metadata (no bodies, secrets redacted) and one screenshot per
  viewport per state. Honors `robots.txt` and rate limits. Never bypasses access controls.
- **Safe exploration.** Hovers, focuses, presses Escape and Tab, and clicks only
  non-submitting buttons, summaries, tabs and disclosure or menu triggers. Nothing inside
  a form, no navigating links, no deny-listed names (delete, pay, send, sign out, ...).
  Every action is snapshotted, performed, diffed and reverted; a non-GET request marks the
  transition as a side effect and it is never repeated. Everything skipped is reported
  with its reason.
- **Measurement.** Tokens from clustering measured values with sample counts per cluster;
  component candidates from structural fingerprints with match counts, instances, varying
  props, variants and a confidence derived from agreement, never from a guess.
- **UI DNA document.** A validated, framework-neutral document
  ([`@uidna/schema`](packages/schema), [reference](docs/ui-dna.md)) where every value
  carries provenance: `measured`, `observed`, `inferred` (agent only) or `unknown` with a
  reason.
- **Generation.** A deterministic React + TypeScript + Tailwind + Vite baseline: semantic
  HTML, components extracted from fingerprint matches with generated names for the agent
  to rename, tokens as CSS variables and a Tailwind theme, observed transitions as React
  state with the original ARIA attributes, labeled placeholders for unauthorized assets.
  The project builds; its build is a CI test.
- **Verification.** Pixel diff, SSIM, bounding-box geometry, computed-style and
  missing-or-extra element checks per state and viewport; every recorded transition
  replayed against the generated app with role and name locators. The output is a
  structured DiffReport: one finding per concrete difference, with the measured original
  and generated values, the attributed component or token and evidence references. No
  single opaque score. Each attempt is kept; regressions and resolved findings are
  reported against the previous attempt.
- **Report.** A static HTML report with side-by-side screenshots, overlays, token tables,
  component candidates, behavior replay results and limitations.

## Install

```bash
npm install -g uidna
npx playwright install chromium
uidna setup      # registers the MCP server in Claude Code, Codex and Cursor (asks first, backs up)
uidna doctor     # browser availability, CDP reachability, registration state
```

`uidna setup` prints the planned changes to `~/.claude.json`, `~/.codex/config.toml` and
`~/.cursor/mcp.json`, asks for confirmation and backs up every file it touches
(`--scope project` writes `.mcp.json` and `.cursor/mcp.json` in the current directory
instead; `--yes` skips the prompt). The registered command is `npx -y uidna serve`
(wrapped in `cmd /c` on Windows).

Manual MCP configuration, if you prefer:

```json
{
  "mcpServers": {
    "uidna": { "type": "stdio", "command": "npx", "args": ["-y", "uidna", "serve"] }
  }
}
```

The shipped skill ([`skills/uidna/SKILL.md`](skills/uidna/SKILL.md)) teaches the agent
the loop. Copy it into your agent's skills directory, or point the agent at it.

## The loop, from a shell

```bash
uidna reconstruct https://example.com ./example-clone --viewports 1280,768,390
```

runs scan → explore (safe) → generate → verify → report and prints the DiffReport. Each
step is also a command and an MCP tool with the same inputs and the same evidence
envelope:

| Command                              | Tool                     | What it answers                                                      |
| ------------------------------------ | ------------------------ | -------------------------------------------------------------------- |
| `uidna scan <url>`                   | `scan_interface`         | What is on the page at each viewport? Creates `./.uidna/<scan-id>/`. |
| `uidna explore <scan>`               | `explore_interactions`   | What changes when I interact safely? Records states and transitions. |
| `uidna inspect <scan>`               | `inspect_dna`            | Summary, one facet, one path, or the whole document.                 |
| `uidna element <scan> <state>`       | `inspect_element`        | One node: box, style, tokens, a11y, ancestors, evidence.             |
| `uidna components <scan>`            | `search_components`      | Fingerprinted component candidates in stable order.                  |
| `uidna tokens <scan>`                | `extract_tokens`         | Token clusters with member values and sample counts.                 |
| `uidna annotate <scan> <patches>`    | `annotate_dna`           | Apply the agent's readings with `inferred` / `agent` provenance.     |
| `uidna generate <scan> <outDir>`     | `generate_project`       | The React baseline, installed and built.                             |
| `uidna verify <scan> <outDir>`       | `verify_reconstruction`  | The DiffReport for this attempt, with regressions and resolved.      |
| `uidna report <scan>`                | `report_reconstruction`  | The static HTML report.                                              |
| `uidna export <scan>`                | `export_evidence`        | A portable evidence bundle with a manifest of digests.               |
| `uidna reconstruct <url> <outDir>`   | `reconstruct_interface`  | The whole loop.                                                      |

Add `--json` to get the evidence envelope that MCP clients receive:

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

## A sample investigation

<!-- numbers:begin -->
Numbers below come from the CI loop on Fixture A and are regenerated with it.
<!-- numbers:end -->

## Authorized use

Scan interfaces you own or are allowed to analyze. UI DNA never bypasses authentication,
CAPTCHAs, anti-bot measures or access controls, never stores credentials, and never
redistributes third-party assets: unauthorized assets become labeled placeholders until
you mark them authorized with `annotate_dna`. See [DISCLAIMER.md](DISCLAIMER.md) and
[SECURITY.md](SECURITY.md).

Attaching to your own Chrome: start it with `--remote-debugging-port=9222`, open the page,
then `uidna scan --cdp-endpoint http://localhost:9222`. The session stays yours; UI DNA
only reads the page and performs the same safe interactions.

## Limitations

- One page per scan. Same-origin navigation and multi-page crawls are not in Phase 1.
- `<iframe>` content and shadow DOM are not entered; they are reported as limitations.
- Inline `<svg>` markup is not captured; such nodes become placeholders.
- Breakpoints are observed at the scanned widths: a breakpoint token says the layout at
  that width differs from the next wider scanned width, not where the media query lies.
- Spacing tokens are used values: a `margin: auto` shows up as the pixel margin it produced.
- Hover and focus transitions are reproduced as CSS variants at every viewport; click
  transitions are reproduced when the changed nodes live in the same section or component
  as the trigger. Every behavior the generator could not implement is listed in the
  generated README.
- The generator is a baseline, not a finished product: generated names are placeholders,
  text and element interleaving is simplified, and the agent is expected to repair against
  the DiffReport.
- Verification compares at the scanned viewports with system fonts; cross-machine pixel
  diffs reflect font rendering differences, which is why findings carry the measured values
  rather than a single score.

## Repository

```text
packages/schema/   @uidna/schema: Zod schema, JSON Schema, types, changelog
src/domain/        fingerprints, clustering, colors, safe-action policy, Result, budgets
src/contracts/     tool contracts and the canonical catalog (docs/tools.md is generated)
src/browser/       Playwright launch + CDP attach adapters, capture, robots, redaction
src/analysis/      normalization, token clustering, components, layout, assembly
src/explore/       safe interaction exploration, state graph, revert
src/generate/      UI DNA document → React project
src/verify/        render, visual + behavioral compare, DiffReport, HTML report
src/application/  workflows shared by the CLI and the MCP server
src/server/        MCP adapter
skills/uidna/      SKILL.md
fixtures/          Fixture A
tests/             end-to-end loop on Fixture A
```

```bash
npm ci
npm run build
npm test            # unit (real Chromium on Fixture A) + e2e loop
npm run docs:catalog
```

## License

MIT. See [LICENSE](LICENSE).
