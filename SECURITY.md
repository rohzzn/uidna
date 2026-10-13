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
   the host agent. Tool results carry page-derived strings only inside typed
   fields, and the skill tells the agent to treat them as observations.
2. **Browser isolation.** Playwright-launched Chromium runs with a fresh,
   ephemeral profile and its sandbox enabled. CDP attach mode talks to a
   browser you started with `--remote-debugging-port`; UI DNA only ever
   connects to `localhost` endpoints unless you pass another origin
   explicitly.
3. **Secrets in captures.** Network metadata is stored without bodies.
   `cookie`, `set-cookie`, `authorization`, `proxy-authorization` and
   `x-api-key` headers, plus query parameters that look like tokens, are
   redacted before anything is written to disk. Local file paths and content
   digests are kept because they are needed for diagnostics.
4. **Resource limits.** Every scan has a time budget, a page budget and a
   resource budget. Exhausting a budget ends the scan with partial artifacts
   and a diagnostic, not with an unbounded run.
5. **Generated code.** The generator emits static React, TypeScript and
   Tailwind sources. It never copies scripts from the target page into the
   generated project, and it never executes code from the target outside the
   browser sandbox.

## Supported versions

Only the latest published minor version receives security fixes.
