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

/** How many skipped interactions are spelled out in the prose `unknowns` list (the structured list is always complete). */
const MAX_SKIPPED_DETAILS = 40;

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
  // An earlier run of this scan is evidence too: its transitions are kept and the actions that
  // caused side effects or navigations are never repeated.
  const previousRecord = await ctx.store.loadExplore(input.scanId);
  if (!previousRecord.ok) return previousRecord;
  const previousDna = (await ctx.store.hasDna(input.scanId)) ? await ctx.store.loadDna(input.scanId) : null;
  if (previousDna !== null && !previousDna.ok) return previousDna;
  const previousTransitions = previousDna ? previousDna.value.states.transitions : [];
  const knownSideEffectPaths = new Set<string>();
  for (const attempt of previousRecord.value?.attempted ?? []) {
    if ((attempt.outcome === 'side-effect' || attempt.outcome === 'navigated') && attempt.action.target) knownSideEffectPaths.add(attempt.action.target.nodePath);
  }
  for (const transition of previousTransitions) {
    if (transition.sideEffects && transition.action.target) knownSideEffectPaths.add(transition.action.target.nodePath);
  }

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
    previousTransitions,
    knownSideEffectPaths,
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
  // The structured `skipped` list in the result is complete; the prose list is summarized by
  // reason so a page with hundreds of controls stays readable, and says where the rest is.
  const byReason = new Map<string, number>();
  for (const skipped of outcome.record.skipped) byReason.set(skipped.reason, (byReason.get(skipped.reason) ?? 0) + 1);
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) unknowns.push(`${count} interaction${count === 1 ? '' : 's'} skipped: ${reason}`);
  const detailed = outcome.record.skipped.slice(0, MAX_SKIPPED_DETAILS);
  for (const skipped of detailed) {
    unknowns.push(`${skipped.stateId} ${skipped.tag}${skipped.role ? ` [${skipped.role}]` : ''}${skipped.name ? ` "${skipped.name}"` : ''}: ${skipped.reason}`);
  }
  if (outcome.record.skipped.length > detailed.length) {
    unknowns.push(`${outcome.record.skipped.length - detailed.length} more skipped interactions are listed in result.skipped and explore.json`);
  }
  if (outcome.record.partial) limitations.push('exploration ended early (budget, cancellation or browser failure); coverage counts tell how far it got');

  const result: ToolOutput<typeof exploreContract> = {
    scanId: input.scanId,
    policy: 'safe',
    coverage: outcome.record.coverage,
    coverageByPage: outcome.record.coverageByPage ?? {},
    newStates: stateSummaries(dna.value).filter((s) => newStates.has(s.stateId)),
    transitions,
    skipped: outcome.record.skipped,
    dnaPath: dnaPath.value,
  };
  return ok(envelope(finalEvidence, result, { limitations, unknowns }));
}
