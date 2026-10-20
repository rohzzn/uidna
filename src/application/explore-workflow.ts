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
import type { Transition } from 'uidna-schema';
import { effectKey, exploreInteractions as runExplorer, keyPressEffectKey } from '../explore/index.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import type { ExploreRecord, ScanRecord } from './records.js';
import { stateSummaries } from './inspect.js';
import { reassembleDna, resolveLimits } from './scan.js';

/** How many skipped interactions are spelled out in the prose `unknowns` list (the structured list is always complete). */
const MAX_SKIPPED_DETAILS = 40;

/**
 * The keys of the actions an earlier run must not perform again: `<pageId>:<nodePath>` for a control,
 * `<pageId>:key:<key>` for a page-level key press (no target). They are the keys the run persisted,
 * or, for records written before it did, those of the attempts that caused a side effect or left the
 * crawl (a navigation without a transition), plus the actions of side-effect transitions. A navigation
 * that produced a transition between two crawled pages is not a side effect: it is explored again.
 * Keys are scoped to the page of the state the action started from.
 */
export function knownSideEffects(
  scan: Pick<ScanRecord, 'pageId'> & { readonly states: readonly Pick<ScanRecord['states'][number], 'stateId' | 'pageId'>[] },
  previous: Pick<ExploreRecord, 'attempted' | 'sideEffectKeys'> | null,
  previousTransitions: readonly Pick<Transition, 'from' | 'sideEffects' | 'action'>[],
): Set<string> {
  const keys = new Set<string>(previous?.sideEffectKeys ?? []);
  const pageOf = new Map(scan.states.map((state) => [state.stateId, state.pageId ?? scan.pageId] as const));
  const add = (stateId: string, action: Pick<Transition['action'], 'target' | 'key'>): void => {
    const pageId = pageOf.get(stateId) ?? scan.pageId;
    if (action.target !== null && action.target !== undefined) keys.add(effectKey(pageId, action.target.nodePath));
    else if (action.key !== undefined) keys.add(keyPressEffectKey(pageId, action.key));
  };
  if (previous !== null && previous.sideEffectKeys === undefined) {
    for (const attempt of previous.attempted) {
      const leftCrawl = attempt.outcome === 'navigated' && attempt.transitionId === null;
      if (attempt.outcome === 'side-effect' || leftCrawl) add(attempt.stateId, attempt.action);
    }
  }
  for (const transition of previousTransitions) {
    if (transition.sideEffects) add(transition.from, transition.action);
  }
  return keys;
}

/** `explore_interactions`. */
export async function exploreInteractions(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof exploreContract>,
): Promise<Result<Envelope<ToolOutput<typeof exploreContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
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
  const knownSideEffectPaths = knownSideEffects(scan, previousRecord.value, previousTransitions);

  const limits = resolveLimits(ctx, { ...scan.budget.limits, ...(input.budget ?? {}) });
  const budget = new BudgetTracker(limits, ctx.clock, ctx.signal);
  const evidence = await ctx.ledger.record({
    kind: 'explore',
    inputs: { scanId: input.scanId, policy: input.policy ?? 'safe', budget: limits, viewports: input.viewports, pages: input.pages, denyNames: input.denyNames, formValues: input.formValues === undefined ? undefined : Object.keys(input.formValues) },
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
    ...(input.pages === undefined ? {} : { pageIds: input.pages }),
    ...(input.formValues === undefined ? {} : { formValues: input.formValues }),
    ...(input.collections === undefined ? {} : { collections: input.collections }),
    policy: input.policy ?? 'safe',
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
    policy: outcome.record.policy,
    coverage: outcome.record.coverage,
    coverageByPage: outcome.record.coverageByPage ?? {},
    newStates: stateSummaries(dna.value).filter((s) => newStates.has(s.stateId)),
    transitions,
    skipped: outcome.record.skipped,
    dnaPath: dnaPath.value,
  };
  return ok(envelope(finalEvidence, result, { limitations, unknowns }));
}
