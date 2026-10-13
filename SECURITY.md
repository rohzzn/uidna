# Security

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainers
listed in `package.json`. Please include steps to reproduce and the version
you tested. We aim to acknowledge reports within seven days.

## Threat model

UI DNA runs on your machine and loads pages you choose. The main risks are:

1. **Untrusted page content.** Everything captured from a page (DOM, text,
   attribute values, network metadata) is data. It is validated with Zod at
   every boundary, never evaluated, and never turned into an instruction for
   the host agent. Page-derived strings appear in tool results as values of
   typed fields and as observations in `limitations` and `unknowns` (for
   example the accessible name of a skipped control); the skill tells the
   agent to treat them as observations, never as instructions. Generated code,
   the HTML report and generated READMEs escape them.
2. **Browser isolation.** Playwright-launched Chromium runs with a fresh,
   ephemeral profile. UI DNA asks for Chromium's sandbox (Playwright disables
   it by default); when the host cannot start a sandboxed Chromium it falls
   back to an unsandboxed launch and records "Chromium ran without its
   sandbox" in the scan's limitations. Every document navigation an explored
   action requests is blocked, same-origin or not. CDP attach mode talks to a
   browser you started with `--remote-debugging-port`; the endpoint is stored
   as an origin only, never with its debugging token.
3. **Secrets in captures.** Network metadata is stored without headers or
   bodies. Query parameters that look like credentials (`token`, `key`,
   `auth`, `session`, `password`, `signature`, `code`, `jwt`, `otp`, `csrf`,
   ...) are redacted in every stored URL: the page URL, request URLs, `href`,
   `src`, `srcset` and `action` attributes, asset URLs and tool inputs in the
   evidence ledger. Values of password, hidden and sensitive form fields
   (card, cvv, ssn, phone, email, one-time codes, ...) are never stored. Local
   file paths and content digests are kept because they are needed for
   diagnostics.
4. **Resource limits.** Every scan has a time budget, a page budget and a
   resource budget. Exhausting a budget ends the scan with partial artifacts
   and a diagnostic, not with an unbounded run.
5. **Generated code.** The generator emits static React, TypeScript and
   Tailwind sources. It never copies scripts from the target page into the
   generated project, and it never executes code from the target outside the
   browser sandbox.

## Supported versions

Only the latest published minor version receives security fixes.
