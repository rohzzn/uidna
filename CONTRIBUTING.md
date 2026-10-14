# Contributing

Thanks for your interest in UI DNA. This page covers how the repository is organized, how
to run it, and what a change needs before it can land.

## Setup

```bash
git clone https://github.com/rohzzn/uidna.git
cd uidna
npm ci
npx playwright install chromium
npm run build
npm run test:unit
```

Node 20.19 or newer. The unit suite drives a real Chromium against Fixture A and synthetic
pages and takes about 90 seconds; the end-to-end suite (`npm run test:e2e`) runs the whole
Phase 1 loop and the MCP server over stdio and takes about 10 minutes.

## Principles

- **The agent is the brain; UI DNA is the instrument.** No model calls, no API keys, no
  token budgets inside this repository. Anything that needs judgment belongs to the host
  agent through the MCP tools and the skill.
- **Evidence over guesswork.** Every value in the document carries provenance. The
  instrument writes `measured`, `observed` or `unknown` with a reason; only `annotate_dna`
  writes `inferred`. Never fabricate a count, a percentage or a score.
- **Schema first.** Document changes start in `packages/schema` with a changelog entry and
  a version bump; the JSON Schema and the reference example follow.
- **One application layer.** The CLI and the MCP server dispatch through the same handler
  registry (`src/application/handlers.ts`); a tool that behaves differently in one of them
  is a bug.
- **Honest output.** Limitations and unknowns are part of the result, not a log line.
  Truncation says why and how to get the rest.

## Layout

```text
packages/schema/   the UI DNA document schema (published separately)
src/domain/        pure logic: fingerprints, clustering, colors, safe policy, Result, budgets
src/contracts/     tool contracts; docs/tools.md is generated from them
src/browser/       Playwright launch and CDP attach, capture, robots, redaction
src/analysis/      tokens, components, layout, behavior, document assembly
src/explore/       safe interaction exploration
src/generate/      document → React project
src/verify/        visual and behavioral comparison, DiffReport, HTML report
src/application/  workflows, scan store, ledger, setup and doctor
src/server/        MCP adapter       src/cli.ts, src/cli/  the CLI
fixtures/          fixture sites     tests/                end-to-end tests
```

## Rules enforced by CI

- ESM TypeScript in strict mode; `npm run typecheck` and `npm run lint` must pass.
- Zod parsing at every boundary (MCP input, CLI input, config, environment, files on disk).
- Fallible functions return `Result` with a tagged error; no throws across module
  boundaries, no broad catches that swallow errors.
- No `any`, no non-null assertions, no floating promises; JSDoc on every export.
- Tests run on production seams: real Chromium, real fixtures, the real workflows. Module
  mocks are not used.
- `docs/tools.md` is generated: run `npm run docs:catalog` after changing a contract, and
  `npm run docs:check` passes in CI.
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Making a change

1. Open an issue or a draft pull request describing the behavior you want to change and
   the evidence that motivates it (a DiffReport, a scan, a failing test).
2. Add or extend a test on the real seam first, then change the code until it passes.
3. If the document shape changes, update `packages/schema` (schema, changelog, version),
   `docs/ui-dna.md`, and regenerate `docs/examples/fixture-a.dna.json` with
   `scripts/refresh-example.ts` from a real scan.
4. If a tool's input or output changes, update `src/contracts/tools.ts`, regenerate the
   catalog, and keep the CLI mirror in sync (it is derived from the contract).
5. Keep README claims measured: the "A measured run" table is written by
   `scripts/readme-numbers.ts` from a scan; do not edit the numbers by hand.

## Fixtures

Fixture A (`fixtures/a-marketing`) is served by `fixtures/serve.mjs` and is the subject of
every CI run. A new capability needs a fixture that exercises it and an end-to-end test that
would fail without it; see `tests/loop.e2e.test.ts` for the shape.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Never add code
that bypasses authentication, CAPTCHAs, anti-bot measures or access controls, and never
store credentials or response bodies by default.
