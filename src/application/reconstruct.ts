/**
 * `reconstruct_interface`: the whole Phase 1 loop without an agent:
 * scan → explore (safe) → tokens (part of assembly) → generate → verify →
 * report. Each step that fails leaves its partial artifacts and is reported;
 * later steps that depend on it are skipped, never faked.
 */
import type { DiffReport, Finding } from '../contracts/diff-report.js';
import type { reconstructInterface as reconstructContract, StepOutcome } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { describeError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { ok, type Result } from '../domain/result.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { exploreInteractions } from './explore-workflow.js';
import { generateProject } from './generate-workflow.js';
import { scanInterface } from './scan.js';
import { reportReconstruction, verifyReconstruction } from './verify-workflow.js';

const SEVERITY_ORDER: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2 };

/** All findings of a report, most severe first, then by category and state. */
export function sortedFindings(report: DiffReport): Finding[] {
  const all = [...report.visual.flatMap((v) => v.findings), ...report.behavioral.flatMap((b) => b.findings)];
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return all.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || compare(a.category, b.category) || compare(a.stateId, b.stateId) || compare(a.key, b.key),
  );
}

/** `reconstruct_interface`. */
export async function reconstructInterface(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof reconstructContract>,
): Promise<Result<Envelope<ToolOutput<typeof reconstructContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const steps: StepOutcome[] = [];
  const limitations: string[] = [];
  const unknowns: string[] = [];
  const started = (): number => ctx.clock.now().getTime();

  const record = (name: string, since: number, outcome: Result<Envelope<unknown>>): boolean => {
    const durationMs = Math.max(0, ctx.clock.now().getTime() - since);
    if (outcome.ok) {
      steps.push({ name, ok: true, durationMs, evidenceId: outcome.value.evidence_id, error: null });
      limitations.push(...outcome.value.limitations.map((l) => `${name}: ${l}`));
      unknowns.push(...outcome.value.unknowns.map((u) => `${name}: ${u}`));
      return true;
    }
    steps.push({ name, ok: false, durationMs, evidenceId: null, error: describeError(outcome.error) });
    return false;
  };

  // 1. scan
  let since = started();
  ctx.progress.report({ message: 'reconstruct: scan', current: 1, total: 6 });
  const scanned = await scanInterface(ctx, {
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.cdpEndpoint === undefined ? {} : { cdpEndpoint: input.cdpEndpoint }),
    ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    ...(input.viewports === undefined ? {} : { viewports: input.viewports }),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    ...(input.headless === undefined ? {} : { headless: input.headless }),
    ...(input.crawl === undefined ? {} : { crawl: input.crawl }),
    ...(input.captureBodies === undefined ? {} : { captureBodies: input.captureBodies }),
  });
  const scanOk = record('scan', since, scanned);
  if (!scanned.ok) {
    const details = scanned.error.details;
    const scanId = typeof details?.scanId === 'string' ? details.scanId : null;
    if (scanId === null) return scanned;
    const scanDir = typeof details?.scanDir === 'string' ? details.scanDir : ctx.store.scanDir(scanId);
    const evidence = await ctx.ledger.record({ kind: 'reconstruct', inputs: { url: input.url, cdpEndpoint: input.cdpEndpoint, outDir: input.outDir }, scanId });
    return ok(
      envelope(evidence, { scanId, scanDir, projectPath: null, dnaPath: null, reportPath: null, diffReport: null, steps, findings: [] }, { limitations: [...limitations, `scan failed: ${scanned.error.message}`], unknowns }),
    );
  }
  const scanId = scanned.value.result.scanId;
  const scanDir = scanned.value.result.scanDir;
  let dnaPath: string | null = scanned.value.result.dnaPath;
  const evidence = await ctx.ledger.record({ kind: 'reconstruct', inputs: { url: input.url, cdpEndpoint: input.cdpEndpoint, outDir: input.outDir, viewports: input.viewports }, scanId });

  // 2. explore
  if (scanOk && (input.explore ?? true)) {
    since = started();
    ctx.progress.report({ message: `reconstruct: explore (${input.policy ?? 'safe'})`, current: 2, total: 6 });
    const explored = await exploreInteractions(ctx, { scanId, policy: input.policy ?? 'safe', ...(input.budget === undefined ? {} : { budget: input.budget }) });
    if (record('explore', since, explored) && explored.ok) dnaPath = explored.value.result.dnaPath;
  } else if (scanOk) {
    steps.push({ name: 'explore', ok: true, durationMs: 0, evidenceId: null, error: null });
    limitations.push('explore: skipped by request (explore=false); no transitions recorded');
  }

  // 3. generate
  let projectPath: string | null = null;
  since = started();
  ctx.progress.report({ message: 'reconstruct: generate', current: 3, total: 6 });
  const generated = await generateProject(ctx, { scanId, outDir: input.outDir, install: input.install ?? true, build: true });
  const generateOk = record('generate', since, generated);
  if (generated.ok) projectPath = generated.value.result.projectPath;
  const buildOk = generated.ok && generated.value.result.build.ok === true;
  if (generated.ok && !buildOk) limitations.push('generate: the project did not build; verification skipped');

  // 4. verify
  let diffReport: DiffReport | null = null;
  if (generateOk && buildOk) {
    since = started();
    ctx.progress.report({ message: 'reconstruct: verify', current: 4, total: 6 });
    const verified = await verifyReconstruction(ctx, { scanId, outDir: input.outDir, build: false, label: 'reconstruct' });
    if (record('verify', since, verified) && verified.ok) diffReport = verified.value.result;
  } else {
    steps.push({ name: 'verify', ok: false, durationMs: 0, evidenceId: null, error: 'skipped: no built project to verify' });
  }

  // 5. report
  let reportPath: string | null = null;
  since = started();
  ctx.progress.report({ message: 'reconstruct: report', current: 5, total: 6 });
  const reported = await reportReconstruction(ctx, { scanId });
  if (record('report', since, reported) && reported.ok) reportPath = reported.value.result.reportPath;

  ctx.progress.report({ message: 'reconstruct: done', current: 6, total: 6 });
  const findings = diffReport ? sortedFindings(diffReport) : [];
  const artifacts = [scanDir, ...(dnaPath ? [dnaPath] : []), ...(projectPath ? [projectPath] : []), ...(reportPath ? [reportPath] : [])];
  const finalEvidence = ctx.ledger.withArtifacts(evidence, artifacts);
  const result: ToolOutput<typeof reconstructContract> = { scanId, scanDir, projectPath, dnaPath, reportPath, diffReport, steps, findings };
  if (steps.some((s) => !s.ok)) limitations.push(`steps failed: ${steps.filter((s) => !s.ok).map((s) => s.name).join(', ')}; their artifacts are partial`);
  return ok(envelope(finalEvidence, result, { limitations, unknowns }));
}
