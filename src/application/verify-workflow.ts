/**
 * `verify_reconstruction` and `report_reconstruction`: compare a generated
 * project with its scan, keep every attempt, and render the static report.
 */
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_THRESHOLDS, type DiffReport } from '../contracts/diff-report.js';
import type { reportReconstruction as reportContract, verifyReconstruction as verifyContract } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { isoNow } from '../domain/clock.js';
import { uidnaError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import { renderReport, verifyReconstruction as runVerifier } from '../verify/index.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { resolveOutDir } from './generate-workflow.js';
import { loadScanAndDna } from './inspect.js';

/** Load every stored attempt of a scan, ascending. */
export async function loadAttempts(ctx: WorkflowContext, scanId: string): Promise<Result<DiffReport[]>> {
  const numbers = await ctx.store.listAttempts(scanId);
  const reports: DiffReport[] = [];
  for (const attempt of numbers) {
    const loaded = await ctx.store.loadDiffReport(scanId, attempt);
    if (!loaded.ok) return loaded;
    reports.push(loaded.value);
  }
  return ok(reports);
}

/** `verify_reconstruction`. */
export async function verifyReconstruction(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof verifyContract>,
): Promise<Result<Envelope<DiffReport>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { scan, dna } = loaded.value;
  const outDir = resolveOutDir(ctx, input.outDir);
  const attempts = await loadAttempts(ctx, input.scanId);
  if (!attempts.ok) return attempts;
  const previous = attempts.value.length > 0 ? (attempts.value[attempts.value.length - 1] ?? null) : null;
  const attempt = (previous?.attempt ?? 0) + 1;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const evidence = await ctx.ledger.record({
    kind: 'verify',
    inputs: { scanId: input.scanId, outDir, attempt, label: input.label ?? null, thresholds, build: input.build ?? true, viewports: input.viewports, runGeneratedTests: input.runGeneratedTests ?? false },
    scanId: input.scanId,
  });
  const report = await runVerifier({
    ctx,
    scan,
    dna,
    outDir,
    attempt,
    previous,
    thresholds,
    build: input.build ?? true,
    label: input.label ?? null,
    evidenceId: evidence.id,
    runGeneratedTests: input.runGeneratedTests ?? false,
    ...(input.viewports === undefined ? {} : { viewportWidths: input.viewports }),
  });
  if (!report.ok) return report;
  const value = report.value;
  const finalEvidence = ctx.ledger.withArtifacts(evidence, [`verify/attempt-${attempt}/diff-report.json`, ...value.artifacts]);
  const limitations = [...value.limitations];
  if (previous === null) limitations.push('first attempt: regressions and resolved findings are empty by definition');
  return ok(envelope(finalEvidence, value, { limitations, unknowns: value.unknowns }));
}

/** `report_reconstruction`. */
export async function reportReconstruction(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof reportContract>,
): Promise<Result<Envelope<ToolOutput<typeof reportContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { scan, dna } = loaded.value;
  const attempts = await loadAttempts(ctx, input.scanId);
  if (!attempts.ok) return attempts;
  const outPath = input.outPath ? (isAbsolute(input.outPath) ? input.outPath : resolve(ctx.cwd, input.outPath)) : ctx.store.resolvePath(input.scanId, 'report.html');
  const evidence = await ctx.ledger.record({ kind: 'report', inputs: { scanId: input.scanId, outPath, attempts: attempts.value.length }, scanId: input.scanId });
  const rendered = await renderReport({ ctx, scan, dna, attempts: attempts.value, outPath });
  if (!rendered.ok) return rendered;
  scan.steps.report = { at: isoNow(ctx.clock), evidenceId: evidence.id, path: outPath };
  const saved = await ctx.store.saveScan(scan);
  if (!saved.ok) return saved;
  const finalEvidence = ctx.ledger.withArtifacts(evidence, [outPath]);
  const limitations: string[] = [];
  if (attempts.value.length === 0) limitations.push('no verification attempt yet; the report shows the captured states and the document only');
  if (scan.steps.explore === null) limitations.push('exploration was not run; no transitions or behavior replay to report');
  const result: ToolOutput<typeof reportContract> = {
    scanId: input.scanId,
    reportPath: rendered.value.path,
    attempts: rendered.value.attempts,
    findings: rendered.value.findings,
    states: rendered.value.states,
  };
  if (result.attempts !== attempts.value.length) return err(uidnaError('internal', 'report attempt count does not match stored attempts'));
  return ok(envelope(finalEvidence, result, { limitations }));
}
