/**
 * Persisted records under `.uidna/<scan-id>/`. Everything written to disk is
 * validated with these schemas on write and on read.
 *
 * Layout:
 *   scan.json                      ScanRecord
 *   dna.json                       UiDnaDocument (see @rohzzn/uidna-schema)
 *   states/<stateId>/capture.json  CapturedState
 *   states/<stateId>/screenshot.png
 *   assets/<digest>.<ext>          stored asset copies
 *   evidence/ledger.jsonl          EvidenceRecord per line
 *   explore.json                   ExploreRecord
 *   generate.json                  GenerateRecord
 *   verify/attempt-<n>/diff-report.json
 *   verify/attempt-<n>/*.png
 *   report.html
 *   export/                        evidence bundle
 */
import { z } from 'zod';
import { ActionSchema, ViewportSchema } from '@rohzzn/uidna-schema';

export const ScanStatusSchema = z.enum(['capturing', 'captured', 'exploring', 'explored', 'partial', 'failed']);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const StateRecordSchema = z.strictObject({
  stateId: z.string(),
  /** Page the state belongs to; absent in scans written before multi-page crawls (then the scan's single page). */
  pageId: z.string().optional(),
  kind: z.enum(['base', 'derived']),
  parentStateId: z.string().nullable(),
  viewport: ViewportSchema,
  url: z.string(),
  title: z.string(),
  capturePath: z.string().describe('Relative to the scan directory.'),
  screenshotPath: z.string().nullable(),
  domDigest: z.string(),
  roleTreeDigest: z.string(),
  nodeCount: z.number().int().min(0),
  capturedAt: z.string(),
  evidenceId: z.string(),
  /** For derived states: the transition that produced them. */
  viaTransitionId: z.string().nullable(),
});
export type StateRecord = z.infer<typeof StateRecordSchema>;

export const BudgetRecordSchema = z.strictObject({
  limits: z.strictObject({
    timeMs: z.number().int().positive().nullable(),
    pages: z.number().int().positive().nullable(),
    actions: z.number().int().positive().nullable(),
    resources: z.number().int().positive().nullable(),
  }),
  used: z.strictObject({
    timeMs: z.number().int().min(0),
    pages: z.number().int().min(0),
    actions: z.number().int().min(0),
    resources: z.number().int().min(0),
  }),
});
export type BudgetRecord = z.infer<typeof BudgetRecordSchema>;

export const ScanRecordSchema = z.strictObject({
  scanId: z.string(),
  toolVersion: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  target: z.strictObject({
    kind: z.enum(['url', 'cdp']),
    url: z.string(),
    cdp: z.strictObject({ endpoint: z.string(), targetId: z.string().optional() }).optional(),
  }),
  browser: z.strictObject({ mode: z.enum(['launch', 'cdp']), name: z.string(), version: z.string().nullable() }),
  viewports: z.array(ViewportSchema).min(1),
  /** The seed page's id. */
  pageId: z.string(),
  /** Every crawled page, seed first. Absent in scans written before multi-page crawls. */
  pages: z
    .array(
      z.strictObject({
        pageId: z.string(),
        url: z.string(),
        depth: z.number().int().min(0),
        /** `<fromPageId>:<nodePath>` of the link that led the crawl to this page, null for the seed; the assembler resolves it to a navigation edge id. */
        discoveredVia: z.string().nullable(),
        title: z.string(),
      }),
    )
    .optional(),
  status: ScanStatusSchema,
  budget: BudgetRecordSchema,
  states: z.array(StateRecordSchema),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  steps: z.strictObject({
    scan: z.strictObject({ at: z.string(), evidenceId: z.string() }).nullable(),
    explore: z.strictObject({ at: z.string(), evidenceId: z.string(), recordPath: z.string() }).nullable(),
    generate: z.strictObject({ at: z.string(), evidenceId: z.string(), outDir: z.string(), recordPath: z.string() }).nullable(),
    verify: z.array(z.strictObject({ attempt: z.number().int().min(1), at: z.string(), evidenceId: z.string(), reportPath: z.string(), label: z.string().nullable() })),
    report: z.strictObject({ at: z.string(), evidenceId: z.string(), path: z.string() }).nullable(),
  }),
});
export type ScanRecord = z.infer<typeof ScanRecordSchema>;

export const SkippedRecordSchema = z.strictObject({
  stateId: z.string(),
  nodeId: z.string(),
  nodePath: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  tag: z.string(),
  reason: z.string(),
});
export type SkippedRecord = z.infer<typeof SkippedRecordSchema>;

export const AttemptedInteractionSchema = z.strictObject({
  stateId: z.string(),
  action: ActionSchema,
  outcome: z.enum(['changed', 'unchanged', 'side-effect', 'navigated', 'failed']),
  transitionId: z.string().nullable(),
  reason: z.string().nullable(),
  durationMs: z.number().int().min(0),
});
export type AttemptedInteraction = z.infer<typeof AttemptedInteractionSchema>;

export const ExploreRecordSchema = z.strictObject({
  scanId: z.string(),
  policy: z.enum(['safe', 'forms']),
  startedAt: z.string(),
  finishedAt: z.string(),
  evidenceId: z.string(),
  budget: BudgetRecordSchema,
  coverage: z.strictObject({
    discovered: z.number().int().min(0),
    explored: z.number().int().min(0),
    changed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
  /** Coverage per page id; absent for records written before multi-page crawls. */
  coverageByPage: z
    .record(
      z.string(),
      z.strictObject({
        discovered: z.number().int().min(0),
        explored: z.number().int().min(0),
        changed: z.number().int().min(0),
        skipped: z.number().int().min(0),
      }),
    )
    .optional(),
  attempted: z.array(AttemptedInteractionSchema),
  skipped: z.array(SkippedRecordSchema),
  /** Transition ids live in dna.json; this lists them for quick lookup. */
  transitionIds: z.array(z.string()),
  newStateIds: z.array(z.string()),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  /** True when the run ended early (budget, cancellation, browser failure). */
  partial: z.boolean(),
  /**
   * `<pageId>:<nodePath>` of every control whose action caused a side effect or left the crawl, and
   * `<pageId>:key:<key>` of every page-level key press that caused one, in this run or an earlier one; a later
   * run never performs them again. Absent for records written before multi-page crawls.
   */
  sideEffectKeys: z.array(z.string()).optional(),
});
export type ExploreRecord = z.infer<typeof ExploreRecordSchema>;

/** A stylesheet width condition as read on one page, with what the parser made of it. */
export const ResponsiveConditionRecordSchema = z.strictObject({
  text: z.string(),
  kind: z.enum(['media', 'import', 'link-media']),
  sheet: z.strictObject({ url: z.string().nullable(), origin: z.enum(['same-origin', 'cross-origin', 'inline']) }),
  ruleCount: z.number().int().min(0),
  /** Nodes (by path) the condition's rules match, with the properties they declare. */
  targets: z.array(z.strictObject({ path: z.string(), properties: z.array(z.string()) })),
  thresholds: z.array(z.number().int().positive()),
  never: z.boolean(),
  unsupported: z.array(z.string()),
});
export type ResponsiveConditionRecord = z.infer<typeof ResponsiveConditionRecordSchema>;

const SignatureChangeRecordSchema = z.strictObject({ path: z.string(), property: z.string(), below: z.string().nullable(), above: z.string().nullable() });

/** What responsive measurement did on one page. */
export const PageResponsiveRecordSchema = z.strictObject({
  pageId: z.string(),
  conditions: z.array(ResponsiveConditionRecordSchema),
  /** Stylesheets that could not be read (cross-origin). */
  unreadable: z.array(z.string()),
  containerRules: z.number().int().min(0),
  emPx: z.number().positive(),
  /** Null when probing was off or fewer than two widths were scanned. */
  probe: z
    .strictObject({
      height: z.number().int().positive(),
      maxProbes: z.number().int().min(0),
      widths: z.array(z.number().int().positive()),
      exhausted: z.boolean(),
      blockedRequests: z.number().int().min(0),
      failures: z.array(z.string()),
      changePoints: z.array(z.strictObject({ lower: z.number().int().positive(), upper: z.number().int().positive(), changes: z.array(SignatureChangeRecordSchema) })),
      /** Full signatures at both sides of every change point, for the verifier: width → key → value. */
      signatures: z.record(z.string(), z.record(z.string(), z.string())),
    })
    .nullable(),
  limitations: z.array(z.string()),
});
export type PageResponsiveRecord = z.infer<typeof PageResponsiveRecordSchema>;

/** `responsive.json`: stylesheet conditions and probe results per page. */
export const ResponsiveRecordSchema = z.strictObject({
  scanId: z.string(),
  evidenceId: z.string(),
  options: z.strictObject({
    css: z.boolean(),
    probe: z.boolean(),
    maxProbes: z.number().int().min(0),
    tolerancePx: z.number().int().positive(),
    height: z.number().int().positive(),
    settleMs: z.number().int().min(0),
  }),
  pages: z.record(z.string(), PageResponsiveRecordSchema),
});
export type ResponsiveRecord = z.infer<typeof ResponsiveRecordSchema>;

export const GenerateRecordSchema = z.strictObject({
  scanId: z.string(),
  outDir: z.string(),
  generatedAt: z.string(),
  evidenceId: z.string(),
  files: z.array(z.string()),
  components: z.array(z.strictObject({ name: z.string(), file: z.string(), definitionId: z.string().nullable(), instances: z.number().int().min(0) })),
  placeholders: z.array(z.strictObject({ kind: z.string(), assetId: z.string(), url: z.string(), reason: z.string(), file: z.string() })),
  mocks: z.array(z.strictObject({ name: z.string(), file: z.string(), reason: z.string() })),
  install: z.strictObject({ attempted: z.boolean(), ok: z.boolean().nullable(), logPath: z.string().nullable(), durationMs: z.number().int().min(0) }),
  build: z.strictObject({ attempted: z.boolean(), ok: z.boolean().nullable(), logPath: z.string().nullable(), durationMs: z.number().int().min(0), distDir: z.string().nullable() }),
});
export type GenerateRecord = z.infer<typeof GenerateRecordSchema>;

export const EvidenceRecordSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  artifacts: z.array(z.string()),
  capturedAt: z.string(),
  scanId: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
