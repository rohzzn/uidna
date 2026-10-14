/**
 * The forms policy's driver. For one `<form>` of a base state it performs a
 * chain: an empty submit (to observe client-side validation), one fill per
 * fillable control with a synthetic value (each a transition when the page
 * changed, else `unchanged`), then a submit of the filled form, whose
 * request the browser blocks and which is therefore a side effect. Every
 * step starts from the state the previous one produced; the chain is
 * reverted once, with a fresh load of the base URL. Values are never read
 * from the page: the policy chose them.
 */
import { join } from 'node:path';
import type { Transition } from '@rohzzn/uidna-schema';
import { redactUrl } from '../browser/redact.js';
import { describeError } from '../domain/errors.js';
import { transitionId as makeTransitionId } from '../domain/ids.js';
import { isSideEffect } from '../domain/safe-policy.js';
import {
  actionOf,
  bodyOf,
  changedNodeIds,
  clip,
  discardProbe,
  ensureBase,
  finishProbed,
  hasSideEffect,
  markSideEffect,
  PROBE_STABILITY,
  quietly,
  recordAttempt,
  reloadRevert,
  report,
  skippedRecord,
  stopReason,
  storeDerived,
  stripHash,
  toUiAction,
  unperformedNavigation,
  type Cursor,
  type FormSequence,
  type Planned,
  type Reference,
  type Run,
  type Stop,
} from './run.js';

/** Reason recorded when a fill or submit step is skipped because its control already caused a side effect or a navigation (in this run or an earlier one). */
export const SUBMIT_SKIPPED_EARLIER = 'side effect observed earlier';

interface StepResult {
  readonly cursor: Cursor;
  readonly transition: Transition | null;
  /** True when the browser acted on the document (typed, checked, selected or submitted), even when nothing observable changed: the chain's revert must load the base URL afresh. */
  readonly touched: boolean;
  /** True when the chain cannot continue (the page left the document, a probe failed, the browser is gone). */
  readonly ended: boolean;
  /** True when the step's only side effect was requests UI DNA blocked: the control is remembered when the chain ends. */
  readonly blockedOnly?: boolean;
}

/** Perform one fill or submit step from `cursor` and record what happened. */
async function performChainStep(run: Run, ref: Reference, cursor: Cursor, planned: Planned): Promise<StepResult> {
  const { session, budget } = run;
  const node = planned.node;
  const keep: StepResult = { cursor, transition: null, touched: false, ended: false };
  if (node === null) return keep;
  run.progress.current += 1;
  report(run, `${planned.describe} (${cursor.stateId}, ${ref.pageId})`);
  const stateId = cursor.stateId;
  const started = run.ctx.clock.now().getTime();

  const marker = session.markNetwork();
  const acted = await session.act(toUiAction(planned));
  budget.consumeAction();
  if (!acted.ok) {
    recordAttempt(run, stateId, planned, 'failed', null, describeError(acted.error), started);
    if (/closed/i.test(acted.error.message)) {
      run.aborted = `browser session unavailable (${describeError(acted.error)})`;
      return { ...keep, ended: true };
    }
    return keep;
  }
  const outcome = acted.value;
  if (outcome.dialogs.length > 0) {
    run.limitations.push(`${planned.describe}: ${outcome.dialogs.length} dialog(s) opened and were dismissed (${outcome.dialogs.map(clip).join('; ')})`);
  }
  const blockedRequests = outcome.blockedRequests ?? [];
  if (!outcome.performed && blockedRequests.length === 0) {
    const navigation = unperformedNavigation(outcome);
    if (navigation !== null) {
      // A GET submission or a script navigation (blocked, or committed and undone): the page is back; recorded once, never repeated.
      markSideEffect(run, ref, node);
      recordAttempt(run, stateId, planned, 'navigated', null, navigation, started);
      run.unknowns.push(`${planned.describe} skipped: ${outcome.reason ?? navigation}`);
      // The submit event ran (or the document was replaced and restored): the chain ends on a document loaded afresh.
      return { ...keep, touched: true };
    }
    recordAttempt(run, stateId, planned, 'failed', null, outcome.reason ?? 'action not performed', started);
    return keep;
  }
  const stable = await session.waitForStability(PROBE_STABILITY);
  if (!stable.ok) run.limitations.push(`${planned.describe}: stability wait failed (${describeError(stable.error)})`);
  // The ledger records the requests the guard blocked too (with their failure), so `network` already counts them.
  const network = isSideEffect(session.networkSince(marker));
  // A blocked submission request is a side effect the page attempted, like a non-GET request that got through.
  const sideEffect = blockedRequests.length > 0 || network.nonGet > 0 || outcome.navigated;
  // A side effect that consisted only of requests UI DNA blocked never reached a server: the control may be
  // submitted again later in this chain (the guard blocks it again), so an empty submit that sent a request does
  // not hide the filled submission. The chain remembers the control when it ends; no other chain repeats it.
  const blockedOnly = blockedRequests.length > 0 && network.nonGet <= blockedRequests.length && !outcome.navigated;
  if (sideEffect && !blockedOnly) markSideEffect(run, ref, node);
  const touched: StepResult = { ...keep, touched: true, blockedOnly };
  if (blockedRequests.length > 0) run.unknowns.push(`${planned.describe}: ${blockedRequests.length} non-GET request(s) blocked (${blockedRequests.join(', ')}); the server's response is not observed`);

  if (outcome.navigated && stripHash(outcome.url) !== stripHash(ref.url)) {
    const destination = redactUrl(outcome.url);
    recordAttempt(run, stateId, planned, 'navigated', null, `navigated to ${destination}`, started);
    run.unknowns.push(`${planned.describe} navigated to ${destination}; the form sequence ended there`);
    return { ...touched, ended: true };
  }

  const probePath = join(run.tmpDir, 'probe.png');
  const probed = await session.capture({ screenshotPath: probePath, assetDir: run.assetDir, maxHeight: 4000 });
  if (!probed.ok) {
    recordAttempt(run, stateId, planned, 'failed', null, `probe capture failed: ${describeError(probed.error)}`, started);
    return { ...touched, ended: true };
  }
  const probe = probed.value;
  const domChanged = probe.domDigest !== cursor.capture.domDigest;
  const roleTreeChanged = probe.roleTreeDigest !== cursor.capture.roleTreeDigest;
  const screenshotChanged = (probe.screenshot?.digest ?? null) !== (cursor.capture.screenshot?.digest ?? null);
  if (!domChanged && !roleTreeChanged && !screenshotChanged && !sideEffect) {
    // Nothing observable changed, but a typed value lives in a control's property, which no digest covers: the chain still ends with a fresh load.
    recordAttempt(run, stateId, planned, 'unchanged', null, null, started);
    await discardProbe(run, probePath);
    return touched;
  }

  const transitionId = makeTransitionId(run.transitions.length + 1);
  const stored = await storeDerived(run, ref, cursor, probe, probePath, transitionId);
  if (!stored.ok) {
    recordAttempt(run, stateId, planned, 'failed', null, `derived state not stored: ${describeError(stored.error)}`, started);
    return { ...touched, ended: true };
  }
  budget.consumeResources(probe.assets.length + network.total);
  const changed = changedNodeIds(cursor.capture, probe);
  if (changed.total > changed.ids.length) run.limitations.push(`transition ${transitionId}: changedNodeIds lists ${changed.ids.length} of ${changed.total} changed nodes`);
  const transition: Transition = {
    id: transitionId,
    from: cursor.stateId,
    to: stored.value.stateId,
    action: actionOf(planned),
    sideEffects: sideEffect,
    network: { requests: network.total, nonGet: network.nonGet },
    revert: { method: 'reload', succeeded: false },
    change: { domChanged, roleTreeChanged, screenshotChanged, changedNodeIds: changed.ids },
    provenance: {
      kind: 'observed',
      source: 'interaction',
      stateId: cursor.stateId,
      viewport: { ...ref.viewport },
      evidenceId: run.evidenceId,
      capturedAt: probe.capturedAt,
      confidence: 1,
    },
  };
  run.transitions.push(transition);
  recordAttempt(run, stateId, planned, sideEffect ? 'side-effect' : 'changed', transitionId, stored.value.reused ? `same as state ${stored.value.stateId}` : null, started);
  return { cursor: { stateId: stored.value.stateId, capture: stored.value.capture }, transition, touched: true, ended: false, blockedOnly };
}

/** List the steps of a sequence from `index` on as skipped for `reason`. */
function skipRemaining(run: Run, ref: Reference, steps: readonly Planned[], index: number, reason: string): void {
  for (const step of steps.slice(index)) run.skipped.push(skippedRecord(ref.stateId, step, bodyOf(ref.capture), reason));
}

/**
 * Run the chain of one form and bring the page back to the base state. The
 * transitions of the chain share the revert that ends it (a fresh load).
 * Returns the stop that interrupted the chain, whose remaining steps are
 * then listed as skipped, or null when it ran to the end.
 */
export async function runFormSequence(run: Run, ref: Reference, sequence: FormSequence): Promise<Stop | null> {
  let cursor: Cursor = { stateId: ref.stateId, capture: ref.capture };
  const chain: Transition[] = [];
  let touched = false;
  let last: Planned | null = null;
  // Controls whose submission was blocked in this chain: remembered as side effects once the chain ends.
  const blockedInChain: Planned[] = [];
  const remember = (): void => {
    for (const planned of blockedInChain) if (planned.node !== null) markSideEffect(run, ref, planned.node);
  };
  const steps = sequence.steps;
  for (const [index, step] of steps.entries()) {
    const stop = stopReason(run);
    if (stop !== null) {
      skipRemaining(run, ref, steps, index, `${stop.reason} (${stop.detail})`);
      remember();
      await revertSequence(run, ref, chain, touched, last ?? step);
      return stop;
    }
    // A control whose fill or submit caused a side effect or a navigation, in this run or an earlier one, is never acted on again.
    if (step.node !== null && hasSideEffect(run, ref, step.node)) {
      run.skipped.push(skippedRecord(ref.stateId, step, bodyOf(ref.capture), SUBMIT_SKIPPED_EARLIER));
      continue;
    }
    last = step;
    const result = await performChainStep(run, ref, cursor, step);
    cursor = result.cursor;
    touched = touched || result.touched;
    if (result.transition !== null) chain.push(result.transition);
    if (result.blockedOnly === true) blockedInChain.push(step);
    if (run.aborted !== null) {
      skipRemaining(run, ref, steps, index + 1, `browser failure (${run.aborted})`);
      remember();
      return null;
    }
    if (result.ended) {
      skipRemaining(run, ref, steps, index + 1, 'the form sequence ended early (see the attempt that preceded it)');
      break;
    }
  }
  remember();
  await revertSequence(run, ref, chain, touched, last ?? steps[0] ?? { kind: 'submit', node: sequence.form, describe: 'form sequence' });
  return null;
}

/**
 * Bring the page back after a chain and record the revert on every
 * transition of the chain. A chain that reached the document is always
 * reverted with a fresh load of the base URL, even when every step was
 * `unchanged`: the values a fill typed live in control properties that no
 * digest covers, so a snapshot cannot tell them apart from the base.
 */
async function revertSequence(run: Run, ref: Reference, chain: Transition[], touched: boolean, planned: Planned): Promise<void> {
  if (run.aborted !== null) return;
  if (chain.length === 0 && !touched) {
    // No step reached the page: verify, and reload only when needed.
    await quietly(run, { kind: 'blur' });
    await ensureBase(run, ref, planned, null);
    return;
  }
  const reverted = await reloadRevert(run, ref);
  await quietly(run, { kind: 'reset-pointer' });
  for (const transition of chain) transition.revert = { method: 'reload', succeeded: reverted.succeeded };
  await finishProbed(run, ref, planned, reverted.snapshot, 'reload');
}
