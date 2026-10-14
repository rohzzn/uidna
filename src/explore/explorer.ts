/**
 * The explorer behind `explore_interactions`. For every base state of a scan
 * it loads that state's own page, lets the policy pick the interactions,
 * performs them one at a time, probes the page after each one and stores a
 * derived state plus a transition whenever the DOM, the role tree or the
 * screenshot changed. Every action is reverted (Escape, toggle or reload)
 * and the page is checked against the base state before the next one.
 * Links to other crawled pages are followed as navigation transitions to
 * that page's base state (`navigation.ts`); under the forms policy every
 * form is submitted empty, filled with synthetic values and submitted again
 * (`forms.ts`). Nothing is inferred: what could not be observed, restored
 * or stored is reported as a limitation or an unknown, never dropped.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transition, UiNode } from '@rohzzn/uidna-schema';
import type { WorkflowContext } from '../application/context.js';
import type { ExploreRecord, ScanRecord, StateRecord } from '../application/records.js';
import { openSession, pageKey } from '../application/scan.js';
import { redactUrl } from '../browser/redact.js';
import type { CapturedState, UiAction } from '../browser/types.js';
import type { BudgetTracker } from '../domain/budget.js';
import { isoNow } from '../domain/clock.js';
import { describeError, toError, uidnaError } from '../domain/errors.js';
import { transitionId as makeTransitionId } from '../domain/ids.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import {
  classifyForms,
  classifyInteractions,
  DEFAULT_DENY_NAMES,
  isDisclosureTrigger,
  isSideEffect,
  pageLevelActions,
  type FormPlan,
  type InteractionCandidate,
  type PageLevelAction,
  type SkippedInteraction,
} from '../domain/safe-policy.js';
import { runFormSequence } from './forms.js';
import { performNavigation } from './navigation.js';
import {
  actionOf,
  attributeRevert,
  bodyOf,
  changedNodeIds,
  clip,
  compareBySnapshot,
  describeNode,
  discardProbe,
  ensureBase,
  finishProbed,
  freshLoad,
  hasStepSideEffect,
  markSideEffect,
  markStepSideEffect,
  noteCaptureLimitations,
  noteOnce,
  orReload,
  PROBE_STABILITY,
  quietly,
  recordAttempt,
  recordUnperformedSideEffect,
  reloadRevert,
  report,
  resetDocument,
  revertQuietly,
  revertUnchanged,
  settle,
  skippedRecord,
  stopReason,
  storeDerived,
  stripHash,
  targetOf,
  toUiAction,
  unperformedNavigation,
  type ExplorePolicy,
  type FormSequence,
  type PageCoverage,
  type Planned,
  type Reference,
  type RevertOutcome,
  type RoundKind,
  type Run,
  type Stop,
} from './run.js';

export { changedNodeIds, MAX_CHANGED_NODE_IDS } from './run.js';

/** Input of `exploreInteractions`. */
export interface ExploreInput {
  readonly ctx: WorkflowContext;
  /** The scan to explore; it is not mutated, the updated record is returned. */
  readonly scan: ScanRecord;
  /** Captures of the scan's states keyed by state id (at least every base state to explore). */
  readonly captures: ReadonlyMap<string, CapturedState>;
  /** Budget of this run; its limits are reported in the explore record. */
  readonly budget: BudgetTracker;
  /** Evidence id of this run; recorded on derived states and transitions. */
  readonly evidenceId: string;
  /** Deny phrases added to `DEFAULT_DENY_NAMES`. */
  readonly denyNames?: readonly string[];
  /** Explore only the base states at these viewport widths. Default: all base states. */
  readonly viewportWidths?: readonly number[];
  /** Explore only the base states of these pages. Default: every page of the scan. */
  readonly pageIds?: readonly string[];
  /** `safe` (default) never touches forms; `forms` additionally submits and fills every form with synthetic values. */
  readonly policy?: ExplorePolicy;
  /** Synthetic values by control name or id for the forms policy; they win over the built-in ones. Never real credentials. */
  readonly formValues?: Readonly<Record<string, string>>;
  /** Transitions recorded by an earlier run of this scan; ids continue after them and they are returned together with the new ones. */
  readonly previousTransitions?: readonly Transition[];
  /**
   * Nodes whose actions caused a side effect or a navigation in an earlier run; they are never acted on again.
   * Entries are `<pageId>:<nodePath>` keys, or bare node paths, which apply on every page of the scan.
   */
  readonly knownSideEffectPaths?: ReadonlySet<string>;
}

/** What a run produced. The caller re-assembles `dna.json` with `transitions`. */
export interface ExploreOutcome {
  /** The scan record with derived states appended, status, budget and `steps.explore` updated, as saved. */
  readonly scan: ScanRecord;
  readonly record: ExploreRecord;
  readonly transitions: Transition[];
  /** Input captures plus the stored derived captures (paths relative to the scan directory). */
  readonly captures: Map<string, CapturedState>;
  readonly newStateIds: string[];
}

/** Rounds in the order they are explored for every base state: state-changing clicks first, so a tight budget covers them at every viewport. */
export const ROUNDS: readonly RoundKind[] = ['click', 'navigate', 'form', 'key', 'hover', 'focus'];

/* ---------------------------------------------------------------- plans */

/** Everything the policies planned for one base state. */
interface Plans {
  readonly planned: Planned[];
  readonly forms: FormSequence[];
  readonly skipped: SkippedInteraction[];
}

function planCandidate(candidate: InteractionCandidate): Planned {
  if (candidate.kind === 'navigate' && candidate.navigation !== undefined) {
    return { kind: 'navigate', node: candidate.node, navigation: candidate.navigation, describe: `click on ${describeNode(candidate.node)} to ${candidate.navigation.toPageId}` };
  }
  return { kind: candidate.kind, node: candidate.node, describe: `${candidate.kind} on ${describeNode(candidate.node)}` };
}

function planPageLevel(action: PageLevelAction): Planned {
  return { kind: 'key', node: null, key: action.key, describe: `key ${action.key}` };
}

function planForm(plan: FormPlan, capture: CapturedState): FormSequence {
  const via = plan.submitTarget.id === plan.form.id ? `submit ${describeNode(plan.form)}` : `submit ${describeNode(plan.form)} via ${describeNode(plan.submitTarget)}`;
  const fills: Planned[] = plan.fills.map((fill) => ({ kind: 'fill', node: fill.node, value: fill.value, describe: `fill ${describeNode(fill.node)} (${fill.source})` }));
  const emptySubmit: Planned = { kind: 'submit', node: plan.submitTarget, describe: `${via} (empty)` };
  const filledSubmit: Planned = { kind: 'submit', node: plan.submitTarget, describe: `${via} (filled)` };
  return { form: plan.form, steps: fills.length === 0 ? [emptySubmit] : [emptySubmit, ...fills, filledSubmit], capture };
}

/** What the planners need from a run. */
type Planner = Pick<Run, 'policy' | 'denyNames' | 'formValues' | 'pagesByKey' | 'scan'>;

/** Plan every step of a base state from its capture (the stored one when scheduling, the fresh one when exploring). */
function plansFor(run: Planner, capture: CapturedState, base: StateRecord): Plans {
  const pageId = base.pageId ?? run.scan.pageId;
  const classified = classifyInteractions(capture, { denyNames: run.denyNames, navigation: { pageUrl: base.url, pageId, pagesByKey: run.pagesByKey, keyOf: pageKey } });
  const planned = [...classified.candidates.map(planCandidate), ...pageLevelActions().map(planPageLevel)];
  if (run.policy !== 'forms') return { planned, forms: [], skipped: classified.skipped };
  const forms = classifyForms(capture, { denyNames: run.denyNames, formValues: run.formValues });
  return { planned, forms: forms.forms.map((plan) => planForm(plan, capture)), skipped: [...classified.skipped, ...forms.skipped] };
}

/** Steps of one round. */
function stepsOf(plans: Plans, kind: RoundKind): Planned[] {
  if (kind === 'form') return plans.forms.flatMap((sequence) => [...sequence.steps]);
  return plans.planned.filter((step) => step.kind === kind);
}

function countSteps(plans: Plans): number {
  return plans.planned.length + plans.forms.reduce((sum, sequence) => sum + sequence.steps.length, 0);
}

/* --------------------------------------------------------- base states */

/** Load a base state on its own page and build the reference the probes are compared against. */
async function loadBase(run: Run, base: StateRecord, stored: CapturedState): Promise<Result<Reference>> {
  const { session, budget } = run;
  const pageId = base.pageId ?? run.scan.pageId;
  report(run, `page ${pageId}: loading base state ${base.stateId} at ${base.viewport.width}×${base.viewport.height}`);
  const resized = await session.setViewport(base.viewport);
  if (!resized.ok) return resized;
  const navigated = await session.navigate(base.url, { waitUntil: 'load', timeoutMs: Math.min(30_000, Math.max(5_000, budget.remainingMs())) });
  if (!navigated.ok) return navigated;
  if (!run.pagesLoaded.has(pageId)) {
    budget.consumePage();
    run.pagesLoaded.add(pageId);
  }
  const settled = await settle(run, base.stateId);
  if (!settled.ok) return settled;
  // The reference is the first capture of the fresh document, exactly as the scan's base capture was
  // (a later capture of the same document reports retained layout for content Chromium skips).
  const fresh = await session.capture({ screenshotPath: join(run.tmpDir, `base-${base.stateId}.png`), maxHeight: 4000 });
  if (!fresh.ok) return fresh;
  noteCaptureLimitations(run, `base state ${base.stateId} (fresh reference capture)`, fresh.value);
  const domChanged = fresh.value.domDigest !== stored.domDigest;
  if (domChanged) noteOnce(run, `base state ${base.stateId} differs from the scan capture (dom digest changed); exploring the fresh page`);
  const screenshotDigest = fresh.value.screenshot?.digest ?? null;
  if (!domChanged && stored.screenshot !== null && screenshotDigest !== null && stored.screenshot.digest !== screenshotDigest) {
    noteOnce(run, `base state ${base.stateId} renders differently from the scan screenshot (screenshot digest changed); probes are compared against the fresh screenshot`);
  }
  const ref: Reference = {
    stateId: base.stateId,
    pageId,
    url: base.url,
    viewport: { ...base.viewport },
    capture: fresh.value,
    domDigest: fresh.value.domDigest,
    roleTreeDigest: fresh.value.roleTreeDigest,
    screenshotDigest,
  };
  // The reference capture warmed this document: reload so that the first probe is a first capture too.
  await resetDocument(run, ref, { kind: 'key', node: null, describe: `loading base state ${base.stateId}` });
  if (run.aborted !== null) return err(uidnaError('browser', run.aborted));
  return ok(ref);
}

/* ------------------------------------------------------------- actions */

/** Record the Escape press that took a derived state back to its base. */
function recordEscapeTransition(run: Run, ref: Reference, node: UiNode, derived: { stateId: string; capture: CapturedState }, network: { nonGet: number; total: number }): void {
  const id = makeTransitionId(run.transitions.length + 1);
  const changed = changedNodeIds(derived.capture, ref.capture);
  if (changed.total > changed.ids.length) run.limitations.push(`transition ${id}: changedNodeIds lists ${changed.ids.length} of ${changed.total} changed nodes`);
  run.transitions.push({
    id,
    from: derived.stateId,
    to: ref.stateId,
    action: { type: 'key', target: targetOf(node), key: 'Escape' },
    sideEffects: network.nonGet > 0,
    network: { requests: network.total, nonGet: network.nonGet },
    revert: { method: 'none', succeeded: true },
    change: {
      domChanged: derived.capture.domDigest !== ref.domDigest,
      roleTreeChanged: derived.capture.roleTreeDigest !== ref.roleTreeDigest,
      screenshotChanged: (derived.capture.screenshot?.digest ?? null) !== ref.screenshotDigest,
      changedNodeIds: changed.ids,
    },
    provenance: {
      kind: 'observed',
      source: 'interaction',
      stateId: derived.stateId,
      viewport: { ...ref.viewport },
      evidenceId: run.evidenceId,
      capturedAt: isoNow(run.ctx.clock),
      confidence: 1,
    },
  });
}

/**
 * Undo an action that changed the page. Hover: pointer reset. Focus: blur.
 * Key: Escape. Click: Escape for disclosure triggers and tabs (recorded as
 * a transition back to the base when `derived` was stored and Escape
 * works), else a second click, else a fresh load. Side effects are always
 * reverted with a fresh load, and so is any action whose cheaper revert did
 * not restore the base, so `method` names what actually restored it and
 * `succeeded` is the digest comparison right after that method. A non-GET
 * request a cheap revert causes (an Escape handler that saves, a blur that
 * autosaves) is attributed to the action: it is never performed again.
 */
async function revertChanged(run: Run, ref: Reference, planned: Planned, derived: { stateId: string; capture: CapturedState } | null, sideEffect: boolean): Promise<RevertOutcome> {
  if (sideEffect) {
    const outcome = await reloadRevert(run, ref);
    await quietly(run, { kind: 'reset-pointer' });
    return outcome;
  }
  const finish = (method: RevertOutcome['method']): Promise<RevertOutcome> => compareBySnapshot(run, ref, method);
  /** Perform the cheap revert, let the page settle, and attribute what it sent to the action. */
  const cheap = async (actions: readonly UiAction[], revert: string, method: RevertOutcome['method']): Promise<{ after: RevertOutcome; network: { nonGet: number; total: number } }> => {
    const marker = run.session.markNetwork();
    for (const action of actions) await quietly(run, action);
    const after = await finish(method);
    return { after, network: attributeRevert(run, ref, planned, marker, revert) };
  };
  switch (planned.kind) {
    case 'hover':
      return orReload(run, ref, (await cheap([{ kind: 'reset-pointer' }], 'a pointer reset', 'none')).after);
    case 'focus':
      return orReload(run, ref, (await cheap([{ kind: 'blur' }], 'a blur', 'none')).after);
    case 'key':
      return orReload(run, ref, (await cheap([{ kind: 'key', key: 'Escape' }, { kind: 'reset-pointer' }, { kind: 'blur' }], 'Escape', 'escape')).after);
    case 'click': {
      const node = planned.node;
      if (node === null) return orReload(run, ref, await finish('none'));
      if (isDisclosureTrigger(node) || node.role === 'tab') {
        const escaped = await cheap([{ kind: 'key', key: 'Escape' }], 'Escape', 'escape');
        if (escaped.after.succeeded) {
          if (derived !== null) recordEscapeTransition(run, ref, node, derived, escaped.network);
          await revertQuietly(run, ref, planned, [{ kind: 'reset-pointer' }, { kind: 'blur' }], 'a pointer reset and a blur');
          return escaped.after;
        }
      }
      const toggleMarker = run.session.markNetwork();
      const toggled = await run.session.act({ kind: 'click', target: { nodeId: node.id, nodePath: node.path } });
      const toggleNetwork = isSideEffect(run.session.networkSince(toggleMarker));
      const toggleLeft = toggled.ok && (toggled.value.navigated || toggled.value.blockedNavigation !== undefined);
      if (toggleNetwork.nonGet > 0 || toggleLeft) {
        // The second click did what the first did not: it is a side effect, so this element is never acted on again.
        markSideEffect(run, ref, node);
        const what = toggleNetwork.nonGet > 0 ? `caused ${toggleNetwork.nonGet} non-GET request(s)` : 'requested a document navigation';
        run.limitations.push(`reverting ${planned.describe} with a second click ${what}; the element will not be acted on again`);
      }
      if (toggled.ok && toggled.value.performed && !toggled.value.navigated && toggleNetwork.nonGet === 0) {
        const after = await finish('toggle');
        if (after.succeeded) {
          await revertQuietly(run, ref, planned, [{ kind: 'reset-pointer' }, { kind: 'blur' }], 'a pointer reset and a blur');
          return after;
        }
      }
      const reloaded = await reloadRevert(run, ref);
      await quietly(run, { kind: 'reset-pointer' });
      return reloaded;
    }
    default:
      return orReload(run, ref, await finish('none'));
  }
}

/** Perform one ordinary step (click, hover, focus, key), record what happened and bring the page back to the reference. */
async function performAction(run: Run, ref: Reference, planned: Planned): Promise<void> {
  const { session, budget } = run;
  run.progress.current += 1;
  report(run, `${planned.describe} (${ref.stateId}, ${ref.pageId})`);
  const stateId = ref.stateId;
  const started = run.ctx.clock.now().getTime();

  if (hasStepSideEffect(run, ref, planned)) {
    run.skipped.push(skippedRecord(stateId, planned, bodyOf(ref.capture), 'side effect observed earlier'));
    return;
  }

  const marker = session.markNetwork();
  const acted = await session.act(toUiAction(planned));
  budget.consumeAction();
  if (!acted.ok) {
    recordAttempt(run, stateId, planned, 'failed', null, describeError(acted.error), started);
    if (/closed/i.test(acted.error.message)) {
      run.aborted = `browser session unavailable (${describeError(acted.error)})`;
      return;
    }
    await ensureBase(run, ref, planned, null);
    return;
  }
  const outcome = acted.value;
  if (outcome.dialogs.length > 0) {
    // A dialog the browser dismissed for us is evidence the page asked something; it is not inferred, so it is recorded as seen.
    run.limitations.push(`${planned.describe}: ${outcome.dialogs.length} dialog(s) opened and were dismissed (${outcome.dialogs.map(clip).join('; ')})`);
  }
  if (!outcome.performed) {
    // An action that sent non-GET requests is a side effect, whatever else it did.
    if (!recordUnperformedSideEffect(run, ref, planned, outcome, isSideEffect(session.networkSince(marker)), started)) {
      const navigation = unperformedNavigation(outcome);
      if (navigation !== null) {
        // The action left or tried to leave the document: a side effect that is recorded once and never repeated.
        markStepSideEffect(run, ref, planned);
        recordAttempt(run, stateId, planned, 'navigated', null, navigation, started);
        run.unknowns.push(
          outcome.blockedNavigation !== undefined
            ? `${planned.describe} skipped: it navigates to ${outcome.blockedNavigation} (blocked; only links to crawled pages of the same origin are followed)`
            : `${planned.describe} skipped: ${navigation}`,
        );
      } else {
        recordAttempt(run, stateId, planned, 'failed', null, outcome.reason ?? 'action not performed', started);
      }
    }
    await revertUnchanged(run, ref, planned);
    await ensureBase(run, ref, planned, null);
    return;
  }
  const stable = await session.waitForStability(PROBE_STABILITY);
  if (!stable.ok) run.limitations.push(`${planned.describe}: stability wait failed (${describeError(stable.error)})`);
  const network = isSideEffect(session.networkSince(marker));
  // A navigation counts as a side effect like a non-GET request (schema: `sideEffects`); neither is ever repeated.
  const sideEffect = network.nonGet > 0 || outcome.navigated;
  if (sideEffect) markStepSideEffect(run, ref, planned);

  if (outcome.navigated && stripHash(outcome.url) !== stripHash(ref.url)) {
    const destination = redactUrl(outcome.url);
    recordAttempt(run, stateId, planned, 'navigated', null, `navigated to ${destination}`, started);
    run.unknowns.push(`${planned.describe} skipped: navigated to ${destination}`);
    const reloaded = await freshLoad(run, ref);
    await ensureBase(run, ref, planned, reloaded.ok ? reloaded.value : null);
    return;
  }

  // A click leaves the pointer over the element; move it away so the probe shows the click, not the hover.
  if (planned.kind === 'click') await quietly(run, { kind: 'reset-pointer' });

  const probePath = join(run.tmpDir, 'probe.png');
  const probed = await session.capture({ screenshotPath: probePath, assetDir: run.assetDir, maxHeight: 4000 });
  if (!probed.ok) {
    recordAttempt(run, stateId, planned, 'failed', null, `probe capture failed: ${describeError(probed.error)}`, started);
    await revertUnchanged(run, ref, planned);
    await finishProbed(run, ref, planned, null, null);
    return;
  }
  const probe = probed.value;
  const domChanged = probe.domDigest !== ref.domDigest;
  const roleTreeChanged = probe.roleTreeDigest !== ref.roleTreeDigest;
  const screenshotChanged = (probe.screenshot?.digest ?? null) !== ref.screenshotDigest;

  if (!domChanged && !roleTreeChanged && !screenshotChanged && !sideEffect) {
    recordAttempt(run, stateId, planned, 'unchanged', null, null, started);
    await discardProbe(run, probePath);
    await revertUnchanged(run, ref, planned);
    await finishProbed(run, ref, planned, null, null);
    return;
  }

  const transitionId = makeTransitionId(run.transitions.length + 1);
  const stored = await storeDerived(run, ref, { stateId: ref.stateId, capture: ref.capture }, probe, probePath, transitionId);
  if (!stored.ok) {
    recordAttempt(run, stateId, planned, 'failed', null, `derived state not stored: ${describeError(stored.error)}`, started);
    // Nothing was stored, so no transition (not even the Escape back to the base) may refer to this probe.
    const reverted = await revertChanged(run, ref, planned, null, sideEffect);
    await finishProbed(run, ref, planned, reverted.snapshot, reverted.method);
    return;
  }
  budget.consumeResources(probe.assets.length + network.total);
  const changed = changedNodeIds(ref.capture, probe);
  if (changed.total > changed.ids.length) run.limitations.push(`transition ${transitionId}: changedNodeIds lists ${changed.ids.length} of ${changed.total} changed nodes`);
  const transition: Transition = {
    id: transitionId,
    from: ref.stateId,
    to: stored.value.stateId,
    action: actionOf(planned),
    sideEffects: sideEffect,
    network: { requests: network.total, nonGet: network.nonGet },
    revert: { method: 'none', succeeded: false },
    change: { domChanged, roleTreeChanged, screenshotChanged, changedNodeIds: changed.ids },
    provenance: {
      kind: 'observed',
      source: 'interaction',
      stateId: ref.stateId,
      viewport: { ...ref.viewport },
      evidenceId: run.evidenceId,
      capturedAt: probe.capturedAt,
      confidence: 1,
    },
  };
  run.transitions.push(transition);
  recordAttempt(run, stateId, planned, sideEffect ? 'side-effect' : 'changed', transitionId, stored.value.reused ? `same as state ${stored.value.stateId}` : null, started);

  const reverted = await revertChanged(run, ref, planned, { stateId: stored.value.stateId, capture: stored.value.capture }, sideEffect);
  transition.revert = { method: reverted.method, succeeded: reverted.succeeded };
  await finishProbed(run, ref, planned, reverted.snapshot, reverted.method);
}

/* ---------------------------------------------------------------- main */

function sumUsage(a: ScanRecord['budget']['used'], b: ScanRecord['budget']['used']): ScanRecord['budget']['used'] {
  return { timeMs: a.timeMs + b.timeMs, pages: a.pages + b.pages, actions: a.actions + b.actions, resources: a.resources + b.resources };
}

/** Coverage per page from the run's lists, keyed in the order the explored pages appear in the scan. */
function coverageByPage(run: Run, bases: readonly StateRecord[]): Record<string, PageCoverage> {
  const { scan } = run;
  const pageOf = new Map(scan.states.map((state) => [state.stateId, state.pageId ?? scan.pageId] as const));
  const coverage = new Map<string, PageCoverage>();
  for (const base of bases) {
    const pageId = base.pageId ?? scan.pageId;
    if (!coverage.has(pageId)) coverage.set(pageId, { discovered: 0, explored: 0, changed: 0, skipped: 0 });
  }
  const bump = (stateId: string, field: 'explored' | 'changed' | 'skipped'): void => {
    const pageId = pageOf.get(stateId);
    const entry = pageId === undefined ? undefined : coverage.get(pageId);
    if (entry !== undefined) entry[field] += 1;
  };
  for (const [pageId, discovered] of run.discoveredByPage) {
    const entry = coverage.get(pageId);
    if (entry !== undefined) entry.discovered = discovered;
  }
  for (const attempt of run.attempted) bump(attempt.stateId, 'explored');
  for (const stateId of run.newStateIds) bump(stateId, 'changed');
  for (const skipped of run.skipped) bump(skipped.stateId, 'skipped');
  return Object.fromEntries(coverage);
}

/** Explore the interactions of every base state of a scan, page by page. See the module comment. */
export async function exploreInteractions(input: ExploreInput): Promise<Result<ExploreOutcome>> {
  const { ctx, budget, evidenceId } = input;
  if (evidenceId.length === 0) return err(uidnaError('validation', 'evidenceId must not be empty'));
  const policy: ExplorePolicy = input.policy ?? 'safe';
  const widths = input.viewportWidths;
  const pageIds = input.pageIds;
  const knownPages = new Set((input.scan.pages ?? [{ pageId: input.scan.pageId }]).map((page) => page.pageId));
  const unknownPages = (pageIds ?? []).filter((pageId) => !knownPages.has(pageId));
  if (unknownPages.length > 0) return err(uidnaError('validation', `scan ${input.scan.scanId} has no page(s) ${unknownPages.join(', ')}`));
  const bases = input.scan.states.filter(
    (state) =>
      state.kind === 'base' && (widths === undefined || widths.includes(state.viewport.width)) && (pageIds === undefined || pageIds.includes(state.pageId ?? input.scan.pageId)),
  );
  const first = bases[0];
  if (first === undefined) {
    const where = [widths === undefined ? null : `viewport width(s) ${widths.join(', ')}`, pageIds === undefined ? null : `page(s) ${pageIds.join(', ')}`].filter((part) => part !== null);
    return err(uidnaError('validation', where.length === 0 ? `scan ${input.scan.scanId} has no base state to explore` : `scan ${input.scan.scanId} has no base state at ${where.join(' on ')}`));
  }
  for (const base of bases) {
    if (!input.captures.has(base.stateId)) return err(uidnaError('not-found', `capture of base state ${base.stateId} is missing`));
  }
  const scan: ScanRecord = {
    ...input.scan,
    states: [...input.scan.states],
    limitations: [...input.scan.limitations],
    unknowns: [...input.scan.unknowns],
    steps: { ...input.scan.steps, verify: [...input.scan.steps.verify] },
  };
  const paths = tryCatch(
    () => ({ scanDir: ctx.store.scanDir(scan.scanId), tmpDir: join(ctx.store.scanDir(scan.scanId), 'tmp'), assetDir: join(ctx.store.scanDir(scan.scanId), 'assets') }),
    (cause) => toError(cause, 'validation', 'scan directory'),
  );
  if (!paths.ok) return paths;
  const startedAt = isoNow(ctx.clock);
  const denyNames = [...DEFAULT_DENY_NAMES, ...(input.denyNames ?? [])];
  const pagesByKey = new Map<string, string>();
  for (const page of scan.pages ?? [{ pageId: scan.pageId, url: scan.target.url }]) pagesByKey.set(pageKey(page.url), page.pageId);
  const planner: Planner = { policy, denyNames, formValues: input.formValues ?? {}, pagesByKey, scan };

  // Progress total from the stored captures; adjusted when a fresh capture yields other steps.
  let total = 0;
  for (const base of bases) {
    const stored = input.captures.get(base.stateId);
    if (stored) total += countSteps(plansFor(planner, stored, base));
  }

  ctx.progress.report({ message: `opening ${scan.target.kind === 'cdp' ? 'CDP session' : 'Chromium'}`, current: 0, total });
  const target = scan.target.kind === 'cdp' && scan.target.cdp ? { cdpEndpoint: scan.target.cdp.endpoint, targetId: scan.target.cdp.targetId } : { url: scan.target.url };
  const opened = await openSession(ctx, target, first.viewport);
  if (!opened.ok) return opened;
  const session = opened.value;

  const run: Run = {
    ctx,
    session,
    scan,
    budget,
    evidenceId,
    policy,
    denyNames,
    formValues: planner.formValues,
    pagesByKey,
    tmpDir: paths.value.tmpDir,
    assetDir: paths.value.assetDir,
    captures: new Map(input.captures),
    transitions: [...(input.previousTransitions ?? [])],
    attempted: [],
    skipped: [],
    limitations: [],
    unknowns: [],
    newStateIds: [],
    sideEffectKeys: new Set(),
    knownSideEffectKeys: input.knownSideEffectPaths ?? new Set(),
    derivedByDigests: new Map(),
    progress: { current: 0, total },
    pagesLoaded: new Set(),
    discoveredByPage: new Map(),
    discovered: 0,
    partial: false,
    aborted: null,
  };

  try {
    try {
      await mkdir(run.tmpDir, { recursive: true });
    } catch (cause) {
      return err(toError(cause, 'io', `create ${run.tmpDir}`));
    }
    await exploreBases(run, bases, input.captures);
  } finally {
    await session.close();
    const removed = await ctx.store.remove(scan.scanId, 'tmp');
    if (!removed.ok) run.limitations.push(`cleanup_incomplete: ${run.tmpDir} could not be removed (${describeError(removed.error)})`);
  }

  const finishedAt = isoNow(ctx.clock);
  const used = budget.usage();
  scan.budget = { limits: { ...budget.limits }, used: sumUsage(input.scan.budget.used, used) };
  scan.status = run.partial ? 'partial' : 'explored';
  scan.steps.explore = { at: finishedAt, evidenceId, recordPath: 'explore.json' };

  const record: ExploreRecord = {
    scanId: scan.scanId,
    policy,
    startedAt,
    finishedAt,
    evidenceId,
    budget: { limits: { ...budget.limits }, used },
    coverage: { discovered: run.discovered, explored: run.attempted.length, changed: run.newStateIds.length, skipped: run.skipped.length },
    coverageByPage: coverageByPage(run, bases),
    attempted: run.attempted,
    skipped: run.skipped,
    transitionIds: run.transitions.map((t) => t.id),
    newStateIds: [...run.newStateIds],
    limitations: run.limitations,
    unknowns: run.unknowns,
    partial: run.partial,
    sideEffectKeys: [...new Set([...run.knownSideEffectKeys, ...run.sideEffectKeys])].sort(),
  };
  // The explore record goes first: its side-effect keys are what keeps a later run from repeating an action
  // that caused a side effect, so they are persisted even when the scan record cannot be. Both are attempted.
  const savedExplore = await ctx.store.saveExplore(scan.scanId, record);
  const savedScan = await ctx.store.saveScan(scan);
  if (!savedExplore.ok) return savedExplore;
  if (!savedScan.ok) return savedScan;
  return ok({ scan, record, transitions: run.transitions, captures: run.captures, newStateIds: [...run.newStateIds] });
}

interface ScheduleEntry {
  readonly base: StateRecord;
  readonly kind: RoundKind;
}

/** A step that will not run, with the state it belonged to. */
interface Pending {
  readonly stateId: string;
  readonly planned: Planned;
  readonly body: Pick<UiNode, 'id' | 'path' | 'role' | 'name' | 'tag'>;
}

function pendingOf(ref: Reference, steps: readonly Planned[]): Pending[] {
  return steps.map((planned) => ({ stateId: ref.stateId, planned, body: bodyOf(ref.capture) }));
}

/** The plans of a base state and the capture they were made from. */
interface KnownPlans {
  readonly plans: Plans;
  readonly capture: CapturedState;
}

/**
 * The plans of a base state as the run knows them: from the fresh capture of
 * its first load once it was loaded (the page the explorer acts on, which may
 * differ from the scan's), else from the stored capture. Null without a
 * stored capture.
 */
type PlansLookup = (base: StateRecord) => KnownPlans | null;

/**
 * Explore the base states in rounds (every base state's clicks, then navigations, forms,
 * page keys, hovers and focus), stopping and listing the rest as skipped when the budget
 * ends or the browser fails. A base state is loaded only for rounds that have steps.
 */
async function exploreBases(run: Run, bases: readonly StateRecord[], stored: ReadonlyMap<string, CapturedState>): Promise<void> {
  const schedule: ScheduleEntry[] = ROUNDS.flatMap((kind) => bases.map((base) => ({ base, kind })));
  const fresh = new Map<string, KnownPlans>();
  const plansOf: PlansLookup = (base) => {
    const known = fresh.get(base.stateId);
    if (known !== undefined) return known;
    const capture = stored.get(base.stateId);
    return capture === undefined ? null : { plans: plansFor(run, capture, base), capture };
  };
  const failed = new Set<string>();
  for (const [position, entry] of schedule.entries()) {
    const storedCapture = stored.get(entry.base.stateId);
    if (storedCapture === undefined || failed.has(entry.base.stateId)) continue;
    const stop = stopReason(run);
    if (stop !== null) {
      markRemaining(run, schedule.slice(position), plansOf, [], stop, failed);
      return;
    }
    // Whether a later round has steps is decided from the page the explorer saw, not from the scan's capture.
    const known = fresh.get(entry.base.stateId);
    if (known !== undefined && stepsOf(known.plans, entry.kind).length === 0) continue;
    const pageId = entry.base.pageId ?? run.scan.pageId;
    if (!run.pagesLoaded.has(pageId) && run.budget.wouldExceed('pages')) {
      // A page that does not fit the page budget is never loaded; every step of its base state is listed, once.
      run.partial = true;
      const reason = `budget exhausted (pages used ${run.budget.usage().pages} of ${run.budget.limits.pages ?? 0})`;
      run.limitations.push(`base state ${entry.base.stateId} on ${pageId} not explored: ${reason}`);
      failed.add(entry.base.stateId);
      const plans = plansFor(run, storedCapture, entry.base);
      for (const kind of ROUNDS) {
        for (const planned of stepsOf(plans, kind)) run.skipped.push(skippedRecord(entry.base.stateId, planned, bodyOf(storedCapture), reason));
      }
      continue;
    }
    const loaded = await loadBase(run, entry.base, storedCapture);
    if (!loaded.ok) {
      run.partial = true;
      run.limitations.push(`base state ${entry.base.stateId} not explored: ${describeError(loaded.error)}`);
      failed.add(entry.base.stateId);
      const laterKinds = new Set(ROUNDS.slice(ROUNDS.indexOf(entry.kind)));
      const { plans, capture } = known ?? { plans: plansFor(run, storedCapture, entry.base), capture: storedCapture };
      for (const kind of laterKinds) {
        for (const planned of stepsOf(plans, kind)) run.skipped.push(skippedRecord(entry.base.stateId, planned, bodyOf(capture), 'base state could not be loaded'));
      }
      if (run.aborted !== null) {
        // The browser can no longer be driven: later entries would fail for the same reason, misattributed to themselves.
        run.limitations.push(`run ended early: ${run.aborted}`);
        markRemaining(run, schedule.slice(position + 1), plansOf, [], { reason: 'browser failure', detail: run.aborted }, failed);
        return;
      }
      continue;
    }
    const ref = loaded.value;
    const all = plansFor(run, ref.capture, entry.base);
    if (known === undefined) {
      fresh.set(entry.base.stateId, { plans: all, capture: ref.capture });
      run.progress.total += countSteps(all) - countSteps(plansFor(run, storedCapture, entry.base));
      const discovered = ref.capture.nodes.filter((node) => node.interactive && node.visible).length;
      run.discovered += discovered;
      run.discoveredByPage.set(ref.pageId, (run.discoveredByPage.get(ref.pageId) ?? 0) + discovered);
      for (const skipped of all.skipped) {
        run.skipped.push({ stateId: ref.stateId, nodeId: skipped.node.id, nodePath: skipped.node.path, role: skipped.node.role, name: skipped.node.name, tag: skipped.node.tag, reason: skipped.reason });
      }
    }
    const ended = entry.kind === 'form' ? await runForms(run, ref, all.forms) : await runSteps(run, ref, stepsOf(all, entry.kind));
    if (ended === null) continue;
    markRemaining(run, schedule.slice(position + 1), plansOf, ended.pending, ended.stop, failed);
    return;
  }
}

/** What ended a round early: the stop and the steps of the round that did not run. */
interface Ended {
  readonly stop: Stop;
  readonly pending: readonly Pending[];
}

/** Run the ordinary and navigation steps of one round; null when every step ran. */
async function runSteps(run: Run, ref: Reference, steps: readonly Planned[]): Promise<Ended | null> {
  for (const [index, planned] of steps.entries()) {
    const stop = stopReason(run);
    if (stop !== null) return { stop, pending: pendingOf(ref, steps.slice(index)) };
    if (planned.kind === 'navigate') await performNavigation(run, ref, planned);
    else await performAction(run, ref, planned);
    if (run.aborted !== null) {
      run.partial = true;
      run.limitations.push(`run ended early: ${run.aborted}`);
      return { stop: { reason: 'browser failure', detail: run.aborted }, pending: pendingOf(ref, steps.slice(index + 1)) };
    }
  }
  return null;
}

/** Run the form sequences of one base state; null when every sequence ran. */
async function runForms(run: Run, ref: Reference, sequences: readonly FormSequence[]): Promise<Ended | null> {
  for (const [index, sequence] of sequences.entries()) {
    const stop = stopReason(run);
    if (stop !== null) return { stop, pending: pendingOf(ref, sequences.slice(index).flatMap((s) => [...s.steps])) };
    const interrupted = await runFormSequence(run, ref, sequence);
    if (run.aborted !== null) {
      run.partial = true;
      run.limitations.push(`run ended early: ${run.aborted}`);
      return { stop: { reason: 'browser failure', detail: run.aborted }, pending: pendingOf(ref, sequences.slice(index + 1).flatMap((s) => [...s.steps])) };
    }
    if (interrupted !== null) return { stop: interrupted, pending: pendingOf(ref, sequences.slice(index + 1).flatMap((s) => [...s.steps])) };
  }
  return null;
}

/** List every step that will not run as skipped with the stop reason, and mark the run partial. */
function markRemaining(run: Run, entries: readonly ScheduleEntry[], plansOf: PlansLookup, current: readonly Pending[], stop: Stop, failed: ReadonlySet<string>): void {
  run.partial = true;
  const reason = `${stop.reason} (${stop.detail})`;
  noteOnce(run, `exploration stopped: ${reason}`);
  for (const entry of current) run.skipped.push(skippedRecord(entry.stateId, entry.planned, entry.body, reason));
  for (const entry of entries) {
    if (failed.has(entry.base.stateId)) continue;
    const known = plansOf(entry.base);
    if (known === null) continue;
    for (const planned of stepsOf(known.plans, entry.kind)) {
      run.skipped.push(skippedRecord(entry.base.stateId, planned, bodyOf(known.capture), reason));
    }
  }
}
