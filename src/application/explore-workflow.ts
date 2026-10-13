/**
 * `explore_interactions`: run the safe interaction policy on a scan's base
 * states, record new states and transitions, and re-assemble the document.
 */
import type { exploreInteractions as exploreContract } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { BudgetTracker } from '../domain/budget.js';
import { isoNow } from '../domain/clock.js';
import { describeError, uidnaError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import { exploreInteractions as runExplorer } from '../explore/index.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { stateSummaries } from './inspect.js';
import { reassembleDna, resolveLimits } from './scan.js';

/** `explore_interactions`. */
export async function exploreInteractions(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof exploreContract>,
): Promise<Result<Envelope<ToolOutput<typeof exploreContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  if (input.policy !== undefined && input.policy !== 'safe') return err(uidnaError('validation', 'only the "safe" policy exists in Phase 1'));
  const loadedScan = await ctx.store.loadScan(input.scanId);
  if (!loadedScan.ok) return loadedScan;
  const scan = loadedScan.value;
  if (scan.states.length === 0) return err(uidnaError('validation', `scan ${input.scanId} has no captured states to explore`));
  const captures = await ctx.store.loadAllCaptures(input.scanId, scan);
  if (!captures.ok) return captures;

  const limits = resolveLimits(ctx, { ...scan.budget.limits, ...(input.budget ?? {}) });
  const budget = new BudgetTracker(limits, ctx.clock, ctx.signal);
  const evidence = await ctx.ledger.record({
    kind: 'explore',
    inputs: { scanId: input.scanId, policy: 'safe', budget: limits, viewports: input.viewports, denyNames: input.denyNames },
    scanId: input.scanId,
  });
  const denyNames = [...(ctx.config.denyNames ?? []), ...(input.denyNames ?? [])];

  const explored = await runExplorer({
    ctx,
    scan,
    captures: captures.value,
    budget,
    evidenceId: evidence.id,
    ...(denyNames.length > 0 ? { denyNames } : {}),
    ...(input.viewports === undefined ? {} : { viewportWidths: input.viewports }),
  });
  if (!explored.ok) return explored;
  const outcome = explored.value;

  const limitations = [...outcome.record.limitations];
  const unknowns = [...outcome.record.unknowns];
  ctx.progress.report({ message: 'assembling UI DNA document with transitions' });
  const dnaPath = await reassembleDna(ctx, outcome.scan, outcome.transitions);
  if (!dnaPath.ok) {
    limitations.push(`UI DNA document not updated: ${describeError(dnaPath.error)}`);
    return err(uidnaError(dnaPath.error._tag, `explore ${input.scanId}: ${dnaPath.error.message}`, { details: { scanId: input.scanId }, cause: dnaPath.error }));
  }
  outcome.scan.steps.explore = { at: isoNow(ctx.clock), evidenceId: evidence.id, recordPath: 'explore.json' };
  const savedScan = await ctx.store.saveScan(outcome.scan);
  if (!savedScan.ok) return savedScan;

  const dna = await ctx.store.loadDna(input.scanId);
  if (!dna.ok) return dna;
  const newStates = new Set(outcome.newStateIds);
  const transitions = outcome.transitions.map((t) => ({ id: t.id, from: t.from, to: t.to, action: t.action, sideEffects: t.sideEffects, revert: t.revert }));
  const artifacts = ['explore.json', 'dna.json', ...outcome.newStateIds.flatMap((id) => [`states/${id}/capture.json`, `states/${id}/screenshot.png`])];
  const finalEvidence = ctx.ledger.withArtifacts(evidence, artifacts);
  for (const skipped of outcome.record.skipped) {
    unknowns.push(`${skipped.stateId} ${skipped.tag}${skipped.role ? ` [${skipped.role}]` : ''}${skipped.name ? ` "${skipped.name}"` : ''}: ${skipped.reason}`);
  }
  if (outcome.record.partial) limitations.push('exploration ended early (budget, cancellation or browser failure); coverage counts tell how far it got');

  const result: ToolOutput<typeof exploreContract> = {
    scanId: input.scanId,
    policy: 'safe',
    coverage: outcome.record.coverage,
    newStates: stateSummaries(dna.value).filter((s) => newStates.has(s.stateId)),
    transitions,
    skipped: outcome.record.skipped,
    dnaPath: dnaPath.value,
  };
  return ok(envelope(finalEvidence, result, { limitations, unknowns }));
}
