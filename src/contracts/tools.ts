/**
 * The canonical tool contracts. Order matters: it is the order of the
 * generated catalog and of the MCP tool list.
 */
import { z } from 'zod';
import {
  ActionSchema,
  AssetSchema,
  BoxSchema,
  ComponentDefinitionSchema,
  ComponentPropSchema,
  LimitationSchema,
  TOKEN_KINDS,
  TokensSchema,
  UiDnaDocumentStructureSchema,
  UiNodeSchema,
  ViewportSchema,
} from '@rohzzn/uidna-schema';
import { DiffReportSchema, FindingSchema } from './diff-report.js';
import { defineTool } from './types.js';

/* ----------------------------------------------------------- shared inputs */

/** Viewport widths; heights are derived (≥1200 → 800, ≥700 → 1024, else 844). */
export const ViewportWidthsSchema = z
  .array(z.number().int().min(240).max(3840))
  .min(1)
  .max(6)
  .describe('Viewport widths in CSS pixels. Heights are derived: ≥1200 → 800, ≥700 → 1024, otherwise 844.');

/** Default viewports when none are given. */
export const DEFAULT_VIEWPORT_WIDTHS = [1280, 768, 390];

/** Derive a viewport from a width. */
export function viewportFromWidth(width: number): { width: number; height: number } {
  if (width >= 1200) return { width, height: 800 };
  if (width >= 700) return { width, height: 1024 };
  return { width, height: 844 };
}

export const BudgetInputSchema = z
  .object({
    timeMs: z.number().int().positive().nullable().optional().describe('Wall-clock limit in ms; null = unlimited.'),
    pages: z.number().int().positive().nullable().optional().describe('Pages that may be loaded. Default: crawl.maxPages (1 without a crawl).'),
    actions: z.number().int().positive().nullable().optional().describe('Interactions the explorer may perform.'),
    resources: z.number().int().positive().nullable().optional().describe('Resources (assets, requests) that may be recorded.'),
  })
  .describe('Per-scan budget. Exhaustion ends the step with partial artifacts and a diagnostic.');

export const ScanIdSchema = z.string().regex(/^scan_\d{8}_[0-9a-f]{6}$/).describe('Scan id returned by scan_interface, e.g. scan_20261013_3f9a1c.');

const TargetFields = {
  url: z
    .string()
    .url()
    .refine((value) => /^https?:/i.test(value), 'only http(s) URLs can be scanned')
    .optional()
    .describe('Public http(s) page to scan with Playwright-launched Chromium. robots.txt is always honored.'),
  cdpEndpoint: z
    .string()
    .optional()
    .describe('Attach to your own Chrome started with --remote-debugging-port, e.g. http://localhost:9222. Requires your authorization.'),
  targetId: z.string().optional().describe('CDP target (tab) id; defaults to the active page.'),
};

/** Checks that exactly one of `url` and `cdpEndpoint` is set. */
export function validateTarget(input: { url?: string | undefined; cdpEndpoint?: string | undefined }): string | null {
  const has = Number(Boolean(input.url)) + Number(Boolean(input.cdpEndpoint));
  if (has === 0) return 'Provide either url or cdpEndpoint.';
  if (has > 1) return 'Provide only one of url and cdpEndpoint.';
  return null;
}

/* ----------------------------------------------------------- shared outputs */

export const PageSummarySchema = z.strictObject({
  pageId: z.string(),
  url: z.string(),
  title: z.string(),
  depth: z.number().int().min(0),
  discoveredVia: z.string().nullable(),
  stateIds: z.array(z.string()),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export const CrawlInputSchema = z
  .object({
    maxPages: z.number().int().min(1).max(50).optional().describe('Pages to visit including the seed. Default 1 (no crawl). Bounded by the pages budget.'),
    include: z.array(z.string()).optional().describe('Only follow same-origin links whose path starts with one of these prefixes.'),
    exclude: z.array(z.string()).optional().describe('Never follow same-origin links whose path starts with one of these prefixes.'),
  })
  .describe('Breadth-first crawl of same-origin links discovered on captured pages. Cross-origin links are recorded, never followed.');

export const ResponsiveInputSchema = z
  .object({
    css: z.boolean().optional().describe('Read @media conditions from the page stylesheets (inline and same-origin; cross-origin sheets are reported as unreadable). Default true.'),
    probe: z.boolean().optional().describe('Resize between the scanned widths to locate where the layout changes. Resize only: no clicks, keys or scrolling; every non-GET request is blocked while probing. Default true.'),
    maxProbes: z.number().int().min(0).max(200).optional().describe('Widths measured per page, scanned widths included. Default 32.'),
    tolerancePx: z.number().int().min(1).max(64).optional().describe('Bisection stops at this precision; leftover budget refines to 1px. Stylesheet thresholds are confirmed to 1px. Default 8.'),
    height: z.number().int().min(200).max(2160).optional().describe('Viewport height held constant while probing. Default 800.'),
    settleMs: z.number().int().min(0).max(5000).optional().describe('DOM quiet time after each resize. Default 300.'),
  })
  .describe('Responsive-rule inference: where between and around the scanned widths the layout changes, and which stylesheet condition explains it.');

/** A located breakpoint as tools report it. */
export const BreakpointSummarySchema = z.strictObject({
  minWidth: z.number().int().positive(),
  source: z.enum(['css', 'probe']),
  bracket: z.strictObject({ lower: z.number().int().positive(), upper: z.number().int().positive() }),
  conditions: z.array(z.string()),
  pageIds: z.array(z.string()),
  rules: z.number().int().min(0),
});

export const StateSummarySchema = z.strictObject({
  stateId: z.string(),
  pageId: z.string(),
  kind: z.enum(['base', 'derived']),
  parentStateId: z.string().nullable(),
  viewport: ViewportSchema,
  url: z.string(),
  title: z.string(),
  screenshot: z.string().nullable().describe('Path relative to the scan directory.'),
  nodeCount: z.number().int().min(0),
  roleTreeDigest: z.string(),
});
export type StateSummary = z.infer<typeof StateSummarySchema>;

export const TransitionSummarySchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  action: ActionSchema,
  sideEffects: z.boolean(),
  revert: z.strictObject({ method: z.enum(['escape', 'toggle', 'reload', 'none']), succeeded: z.boolean() }),
});
export type TransitionSummary = z.infer<typeof TransitionSummarySchema>;

export const SkippedInteractionSchema = z.strictObject({
  stateId: z.string(),
  nodeId: z.string(),
  nodePath: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  tag: z.string(),
  reason: z.string(),
});
export type SkippedInteraction = z.infer<typeof SkippedInteractionSchema>;

export const StepOutcomeSchema = z.strictObject({
  name: z.string(),
  ok: z.boolean(),
  durationMs: z.number().int().min(0),
  evidenceId: z.string().nullable(),
  error: z.string().nullable(),
});
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

/* ------------------------------------------------------------------- tools */

export const scanInterface = defineTool({
  name: 'scan_interface',
  title: 'Scan interface',
  description:
    'Capture a page at each viewport: DOM, computed styles filtered to rendering properties, bounding boxes, accessibility tree, fonts, assets, network metadata and one screenshot per viewport. Creates a scan under ./.uidna/<scan-id>/ and returns the base state per viewport. Honors robots.txt and never bypasses access controls.',
  shape: 'capture',
  input: z.object({
    ...TargetFields,
    viewports: ViewportWidthsSchema.optional(),
    budget: BudgetInputSchema.optional(),
    headless: z.boolean().optional().describe('Launch mode only. Default true.'),
    crawl: CrawlInputSchema.optional(),
    captureBodies: z.enum(['none', 'json']).optional().describe('Store JSON response bodies of XHR/fetch requests as data assets (redacted, size-capped). Default none.'),
    responsive: ResponsiveInputSchema.optional(),
    outRoot: z.string().optional().describe('Directory that holds scans. Default ./.uidna'),
  }),
  output: z.strictObject({
    scanId: z.string(),
    scanDir: z.string(),
    target: z.strictObject({ kind: z.enum(['url', 'cdp']), url: z.string() }),
    pages: z.array(PageSummarySchema),
    states: z.array(StateSummarySchema),
    /** Breakpoints located by stylesheet and probing, ascending. */
    breakpoints: z.array(BreakpointSummarySchema),
    assets: z.strictObject({
      count: z.number().int().min(0),
      byKind: z.record(z.string(), z.number().int().min(0)),
      byOrigin: z.record(z.string(), z.number().int().min(0)),
    }),
    budget: z.strictObject({ used: z.record(z.string(), z.number()), limits: z.record(z.string(), z.number().nullable()) }),
    dnaPath: z.string().describe('Validated UI DNA document for the captured base states.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cli: { command: 'scan', summary: 'Capture a URL or CDP target into a new scan', positionals: ['url'] },
  longRunning: true,
});

export const exploreInteractions = defineTool({
  name: 'explore_interactions',
  title: 'Explore interactions',
  description:
    'Try safe interactions on the captured base states of every crawled page (hover, focus, Escape, Tab, clicks on non-submitting buttons, summaries, tabs, disclosure and menu triggers). Records a new state and a transition for every action that changed the page, reverts after each one, and lists every skipped interaction with its reason. Same-origin links to another crawled page are clicked once and recorded as navigation transitions between pages; every other document navigation an action requests is blocked. The safe policy never touches forms; the forms policy also fills each form with synthetic values (never real credentials) and submits it empty and filled to observe validation, with every non-GET request blocked. An action that caused a side effect (a non-GET request, or a navigation off the crawl) is never repeated, in this run or a later run of the same scan. Coverage counts, in total and per page: discovered = visible interactive elements, explored = interactions attempted (including ones the browser refused, listed in explore.json), changed = new states.',
  shape: 'capture',
  input: z.object({
    scanId: ScanIdSchema,
    policy: z
      .enum(['safe', 'forms'])
      .optional()
      .describe('"safe" (default) never touches forms. "forms" additionally fills same-origin form controls with synthetic values and submits to observe client-side validation; the submission request itself is blocked and recorded as a side effect.'),
    budget: BudgetInputSchema.optional(),
    viewports: ViewportWidthsSchema.optional().describe('Subset of the scanned viewports to explore. Default all.'),
    pages: z.array(z.string()).optional().describe('Subset of page ids to explore. Default all.'),
    denyNames: z.array(z.string()).optional().describe('Additional accessible-name words that must never be clicked.'),
    formValues: z.record(z.string(), z.string()).optional().describe('Synthetic values per control name or id for the forms policy. Never real credentials.'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    policy: z.enum(['safe', 'forms']),
    coverage: z.strictObject({
      discovered: z.number().int().min(0).describe('Interactive elements found in the base states.'),
      explored: z.number().int().min(0).describe('Interactions attempted (including ones the browser refused; see explore.json).'),
      changed: z.number().int().min(0).describe('Interactions that produced a new state.'),
      skipped: z.number().int().min(0),
    }),
    coverageByPage: z.record(z.string(), z.strictObject({ discovered: z.number().int().min(0), explored: z.number().int().min(0), changed: z.number().int().min(0), skipped: z.number().int().min(0) })),
    newStates: z.array(StateSummarySchema),
    transitions: z.array(TransitionSummarySchema),
    skipped: z.array(SkippedInteractionSchema),
    dnaPath: z.string(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cli: { command: 'explore', summary: 'Explore safe interactions on a scan', positionals: ['scanId'] },
  longRunning: true,
});

export const DNA_FACETS = ['app', 'states', 'transitions', 'components', 'tokens', 'layout', 'behavior', 'assets', 'limitations', 'annotations'] as const;

export const inspectDna = defineTool({
  name: 'inspect_dna',
  title: 'Inspect DNA',
  description:
    'Summarize the UI DNA document of a scan: counts per facet and which facets have data. Pass a path (dot or JSON-pointer) to read one value, or full=true for the whole validated document. Large sections are summarized by default; nothing is truncated silently.',
  shape: 'inspect',
  input: z.object({
    scanId: ScanIdSchema,
    path: z.string().optional().describe('Dot path or JSON pointer into the document, e.g. visual.tokens.colors or /states/items/0.'),
    full: z.boolean().optional().describe('Return the entire document.'),
    facet: z.enum(DNA_FACETS).optional().describe('Return one facet in full.'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    dnaVersion: z.string(),
    dnaPath: z.string(),
    target: z.strictObject({ kind: z.enum(['url', 'cdp']), url: z.string(), scannedAt: z.string() }),
    summary: z.strictObject({
      pages: z.number().int().min(0),
      states: z.number().int().min(0),
      baseStates: z.number().int().min(0),
      transitions: z.number().int().min(0),
      components: z.number().int().min(0),
      componentInstances: z.number().int().min(0),
      tokens: z.record(z.string(), z.number().int().min(0)),
      layoutConstraints: z.number().int().min(0),
      behaviorRules: z.number().int().min(0),
      assets: z.number().int().min(0),
      limitations: z.number().int().min(0),
      annotations: z.number().int().min(0),
      unknownValues: z.number().int().min(0).describe('Attributed values whose provenance is unknown.'),
    }),
    facets: z.record(z.string(), z.strictObject({ available: z.boolean(), count: z.number().int().min(0) })),
    states: z.array(StateSummarySchema),
    value: z.unknown().optional().describe('The value at `path` or the facet, when requested.'),
    document: UiDnaDocumentStructureSchema.optional(),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: 'inspect', summary: 'Summarize or read a scan\'s UI DNA document', positionals: ['scanId'] },
  longRunning: false,
});

export const inspectElement = defineTool({
  name: 'inspect_element',
  title: 'Inspect element',
  description:
    'Return one node of a captured state with its box, filtered computed style, the tokens its values belong to, accessibility properties, ancestors, children and evidence references. Locate it by node id, by role and accessible name, or by a simple selector (#id, .class, tag).',
  shape: 'inspect',
  input: z.object({
    scanId: ScanIdSchema,
    stateId: z.string().describe('State id such as st_01.'),
    nodeId: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional().describe('Accessible name (exact, case-insensitive) when locating by role.'),
    selector: z.string().optional().describe('Simple selector: #id, .class, tag, or tag.class.'),
    nth: z.number().int().min(0).optional().describe('Which match to return when several match. Default 0.'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    stateId: z.string(),
    matches: z.number().int().min(0),
    node: UiNodeSchema,
    style: z.record(z.string(), z.string()),
    tokens: z.array(z.strictObject({ property: z.string(), value: z.string(), tokenId: z.string(), kind: z.string(), generatedName: z.string() })),
    ancestors: z.array(z.strictObject({ id: z.string(), tag: z.string(), role: z.string().nullable(), name: z.string().nullable(), path: z.string() })),
    children: z.array(z.strictObject({ id: z.string(), tag: z.string(), role: z.string().nullable(), name: z.string().nullable(), text: z.string().nullable(), box: BoxSchema.nullable() })),
    componentInstance: z.strictObject({ instanceId: z.string(), definitionId: z.string(), generatedName: z.string() }).nullable(),
    evidence: z.array(z.string()),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: 'element', summary: 'Inspect one node of a captured state', positionals: ['scanId', 'stateId'] },
  longRunning: false,
});

export const searchComponents = defineTool({
  name: 'search_components',
  title: 'Search components',
  description:
    'List component candidates found by fingerprinting (normalized structure + style + role) across the base states, in stable order: match count descending, then fingerprint. Each candidate carries instances, varying props, variants and a confidence derived from structural and style agreement. Naming is left to you.',
  shape: 'search',
  input: z.object({
    scanId: ScanIdSchema,
    minInstances: z.number().int().min(1).optional().describe('Default 2.'),
    stateId: z.string().optional().describe('Restrict instances to one state.'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    candidates: z.array(
      z.strictObject({
        id: z.string(),
        generatedName: z.string(),
        name: z.string().nullable().describe('Agent-given name when annotated.'),
        fingerprint: z.string(),
        signature: z.string(),
        tag: z.string(),
        role: z.string().nullable(),
        instanceCount: z.number().int().min(0),
        matchesByState: z.record(z.string(), z.number().int().min(0)),
        confidence: z.number().min(0).max(1),
        props: z.array(ComponentPropSchema),
        variants: z.number().int().min(0),
        instances: z.array(
          z.strictObject({ id: z.string(), stateId: z.string(), nodeId: z.string(), nodePath: z.string(), box: BoxSchema.nullable(), variantId: z.string().nullable() }),
        ),
      }),
    ),
    total: z.number().int().min(0),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: 'components', summary: 'List fingerprinted component candidates', positionals: ['scanId'] },
  longRunning: false,
});

export const extractTokens = defineTool({
  name: 'extract_tokens',
  title: 'Extract tokens',
  description:
    'Return the token clusters of a scan: colors, typography, font families, font sizes, spacing, radii, shadows and breakpoints. Every token lists its member values with sample counts; values are only merged when the cluster evidence supports it.',
  shape: 'workflow',
  input: z.object({
    scanId: ScanIdSchema,
    kinds: z.array(z.enum(TOKEN_KINDS)).optional().describe('Restrict to some token kinds.'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    tokens: TokensSchema,
    counts: z.record(z.string(), z.number().int().min(0)),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: 'tokens', summary: 'Show token clusters of a scan', positionals: ['scanId'] },
  longRunning: false,
});

const PatchBase = {
  rationale: z.string().optional().describe('Why you believe this.'),
  confidence: z.number().min(0).max(1).describe('Your confidence in this reading; it is stored as given, never defaulted.'),
  basedOn: z.array(z.string()).optional().describe('Evidence ids the patch rests on.'),
};

export const AnnotationPatchSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('name'),
    target: z.enum(['component', 'token', 'typography']),
    id: z.string().describe('Component definition id, token id or typography style id.'),
    value: z.string().min(1).describe('The name you give it.'),
    ...PatchBase,
  }),
  z.object({
    op: z.literal('annotate'),
    path: z.string().describe('Dot path or JSON pointer to an attributed value, e.g. visual.tokens.colors.0.value'),
    value: z.unknown().describe('Your reading of the value. The measured value is kept alongside.'),
    ...PatchBase,
  }),
  z.object({
    op: z.literal('authorize'),
    assetId: z.string(),
    authorization: z.enum(['authorized', 'unauthorized']),
    ...PatchBase,
  }),
  z.object({
    op: z.literal('limitation'),
    limitation: LimitationSchema,
    ...PatchBase,
  }),
  z.object({
    op: z.literal('behavior'),
    event: z.object({
      type: z.enum(['click', 'hover', 'focus', 'key']),
      nodeId: z.string(),
      stateId: z.string(),
      key: z.string().optional(),
    }),
    effects: z.array(
      z.object({
        kind: z.enum(['toggle-attribute', 'set-attribute', 'show', 'hide', 'toggle-class', 'style-change', 'navigate', 'unknown']),
        attribute: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        targetNodeId: z.string().optional(),
        details: z.string().optional(),
      }),
    ),
    transitionId: z.string().optional(),
    ...PatchBase,
  }),
]);
export type AnnotationPatch = z.infer<typeof AnnotationPatchSchema>;

export const annotateDna = defineTool({
  name: 'annotate_dna',
  title: 'Annotate DNA',
  description:
    'Apply your readings to the UI DNA document: name components and tokens, annotate attributed values, authorize assets, add limitations or inferred behavior rules. Every patch is stored with provenance kind "inferred" and source "agent"; measured values are never overwritten. The document is re-validated before it is written.',
  shape: 'mutate',
  input: z.object({
    scanId: ScanIdSchema,
    patches: z.array(AnnotationPatchSchema).min(1),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    dnaPath: z.string(),
    applied: z.array(z.strictObject({ index: z.number().int().min(0), op: z.string(), path: z.string(), annotationId: z.string() })),
    rejected: z.array(z.strictObject({ index: z.number().int().min(0), op: z.string(), reason: z.string() })),
    annotations: z.number().int().min(0).describe('Total annotations on the document after this call.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  cli: { command: 'annotate', summary: 'Apply agent annotations from a JSON file', positionals: ['scanId', 'patchesFile'] },
  longRunning: false,
});

export const generateProject = defineTool({
  name: 'generate_project',
  title: 'Generate project',
  description:
    'Generate a deterministic React + TypeScript + Tailwind + Vite project from the UI DNA document: semantic HTML, components extracted from fingerprint matches (with generated names for you to rename), tokens as CSS variables and a Tailwind theme, observed transitions as React state with the same ARIA attributes. Assets that are not authorized become labeled placeholders. Installs (from the npm registry) and builds the project unless told otherwise and returns the paths of the install and build logs. Generated files in outDir are overwritten; other files are kept.',
  shape: 'workflow',
  input: z.object({
    scanId: ScanIdSchema,
    outDir: z.string().describe('Directory for the generated project. Created if missing; existing generated files are overwritten, other files are kept.'),
    router: z.enum(['none', 'react-router']).optional().describe('How pages are wired: "react-router" (default when the document has more than one page) or "none".'),
    behaviorTests: z.boolean().optional().describe('Also write Playwright tests that replay every recorded transition against the generated app. Default true.'),
    install: z.boolean().optional().describe('Run npm install. Default true.'),
    build: z.boolean().optional().describe('Run the production build after install. Default true.'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    projectPath: z.string(),
    files: z.array(z.string()),
    components: z.array(z.strictObject({ name: z.string(), file: z.string(), definitionId: z.string().nullable(), instances: z.number().int().min(0) })),
    placeholders: z.array(z.strictObject({ kind: z.string(), assetId: z.string(), url: z.string(), reason: z.string(), file: z.string() })),
    mocks: z.array(z.strictObject({ name: z.string(), file: z.string(), reason: z.string() })),
    install: z.strictObject({ attempted: z.boolean(), ok: z.boolean().nullable(), logPath: z.string().nullable(), durationMs: z.number().int().min(0) }),
    build: z.strictObject({ attempted: z.boolean(), ok: z.boolean().nullable(), logPath: z.string().nullable(), durationMs: z.number().int().min(0), distDir: z.string().nullable() }),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  cli: { command: 'generate', summary: 'Generate a React project from a scan', positionals: ['scanId', 'outDir'] },
  longRunning: true,
});

export const verifyReconstruction = defineTool({
  name: 'verify_reconstruction',
  title: 'Verify reconstruction',
  description:
    'Build and serve the generated project, render every base state of every crawled page the project contains at its viewport (each page at the route the project manifest uidna.generated.json records when it was generated from this scan, else at the route the document records; pages the generator left out are reported, not compared), and compare it with the original: pixel diff, SSIM, bounding-box geometry, computed styles, missing or extra elements. Then replay every recorded transition whose source state is reachable from a base state by a chain of at most 8 recorded transitions without side effects (locating each target by role and accessible name, then by the normalized name, then by its data-uidna-path attribute, then by tag and text): clicks, hovers, focus, keys, form fills with the recorded synthetic values, form submits (the request is blocked, as during the scan) and same-origin navigations through the original link, comparing the resulting role-tree change, URL and screenshot. Transitions that caused a side effect are never replayed, except a same-origin navigation that sent no non-GET request. With runGeneratedTests, also runs the generated Playwright behavior tests (npm run test:behavior) and reports each result. Returns a DiffReport with one finding per concrete difference, plus regressions and resolved findings relative to the previous attempt.',
  shape: 'compare',
  input: z.object({
    scanId: ScanIdSchema,
    outDir: z.string().describe('The generated project directory.'),
    viewports: ViewportWidthsSchema.optional(),
    thresholds: z
      .object({
        pixelRatioHigh: z.number().min(0).max(1).optional(),
        pixelRatioMedium: z.number().min(0).max(1).optional(),
        boxDriftPx: z.number().min(0).optional(),
        colorDistance: z.number().min(0).optional(),
      })
      .optional(),
    label: z.string().optional().describe('Free-text label for this attempt, e.g. "after fixing hero spacing".'),
    build: z.boolean().optional().describe('Rebuild the project before verifying. Default true.'),
    runGeneratedTests: z.boolean().optional().describe('Also run the generated Playwright behavior tests and report their outcome. Default false.'),
    outRoot: z.string().optional(),
  }),
  output: DiffReportSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  cli: { command: 'verify', summary: 'Compare a generated project with its scan', positionals: ['scanId', 'outDir'] },
  longRunning: true,
});

export const reportReconstruction = defineTool({
  name: 'report_reconstruction',
  title: 'Report reconstruction',
  description:
    'Render a static HTML report for a scan: side-by-side screenshots with overlays per state and viewport, token tables, component candidates, behavior replay results, the history of every verification attempt (counts, regressions, resolved) with the findings of the latest attempt, and the limitations. No server needed.',
  shape: 'workflow',
  input: z.object({
    scanId: ScanIdSchema,
    outPath: z.string().optional().describe('Where to write the HTML. Default <scan dir>/report.html'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    reportPath: z.string(),
    attempts: z.number().int().min(0),
    findings: z.number().int().min(0),
    states: z.number().int().min(0),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: 'report', summary: 'Write the static HTML report for a scan', positionals: ['scanId'] },
  longRunning: false,
});

export const exportEvidence = defineTool({
  name: 'export_evidence',
  title: 'Export evidence',
  description:
    'Write a portable evidence bundle for a scan: the UI DNA document, every capture, screenshot, diff report and the evidence ledger, with a manifest of file digests. Secrets are redacted at capture time, so the bundle contains what the scan directory contains.',
  shape: 'workflow',
  input: z.object({
    scanId: ScanIdSchema,
    outPath: z.string().optional().describe('Bundle directory. Default <scan dir>/export'),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    bundlePath: z.string(),
    manifestPath: z.string(),
    files: z.number().int().min(0),
    bytes: z.number().int().min(0),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  cli: { command: 'export', summary: 'Write a portable evidence bundle', positionals: ['scanId'] },
  longRunning: false,
});

export const reconstructInterface = defineTool({
  name: 'reconstruct_interface',
  title: 'Reconstruct interface',
  description:
    'Run the whole Phase 1 loop without an agent: scan → explore (safe) → tokens → generate → verify → report. Returns the DiffReport and the unknowns so you can start repairing. Each step that fails leaves its partial artifacts and is reported; later steps that depend on it are skipped, not faked.',
  shape: 'workflow',
  input: z.object({
    ...TargetFields,
    outDir: z.string().describe('Directory for the generated project.'),
    viewports: ViewportWidthsSchema.optional(),
    budget: BudgetInputSchema.optional(),
    crawl: CrawlInputSchema.optional(),
    captureBodies: z.enum(['none', 'json']).optional().describe('Store JSON response bodies of XHR/fetch requests as data assets (redacted, size-capped); the generator turns them into typed mocks. Default none.'),
    responsive: ResponsiveInputSchema.optional(),
    policy: z.enum(['safe', 'forms']).optional().describe('Exploration policy: "safe" never touches forms, "forms" fills and submits them with synthetic values, every submission request blocked. Default safe.'),
    explore: z.boolean().optional().describe('Run exploration. Default true.'),
    install: z.boolean().optional().describe('Run npm install in the generated project. Default true.'),
    headless: z.boolean().optional(),
    outRoot: z.string().optional(),
  }),
  output: z.strictObject({
    scanId: z.string(),
    scanDir: z.string(),
    projectPath: z.string().nullable(),
    dnaPath: z.string().nullable(),
    reportPath: z.string().nullable(),
    diffReport: DiffReportSchema.nullable(),
    steps: z.array(StepOutcomeSchema),
    findings: z.array(FindingSchema).describe('All findings of the verification, most severe first.'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cli: { command: 'reconstruct', summary: 'Run scan → explore → generate → verify → report', positionals: ['url', 'outDir'] },
  longRunning: true,
});

/** Re-exported schema pieces used by adapters. */
export { AssetSchema, ComponentDefinitionSchema };
