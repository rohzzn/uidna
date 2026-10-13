/**
 * Persisted records under `.uidna/<scan-id>/`. Everything written to disk is
 * validated with these schemas on write and on read.
 *
 * Layout:
 *   scan.json                      ScanRecord
 *   dna.json                       UiDnaDocument (see @uidna/schema)
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
import { ActionSchema, ViewportSchema } from '@uidna/schema';

export const ScanStatusSchema = z.enum(['capturing', 'captured', 'exploring', 'explored', 'partial', 'failed']);
export type ScanStatus = z.infer<typeof ScanStatusSchema>;

export const StateRecordSchema = z.strictObject({
  stateId: z.string(),
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
  pageId: z.string(),
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
  policy: z.literal('safe'),
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
  attempted: z.array(AttemptedInteractionSchema),
  skipped: z.array(SkippedRecordSchema),
  /** Transition ids live in dna.json; this lists them for quick lookup. */
  transitionIds: z.array(z.string()),
  newStateIds: z.array(z.string()),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  /** True when the run ended early (budget, cancellation, browser failure). */
  partial: z.boolean(),
});
export type ExploreRecord = z.infer<typeof ExploreRecordSchema>;

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
