/**
 * The forms policy's driver. For one `<form>` of a base state it performs a
 * chain: an empty submit (to observe client-side validation), one fill per
 * fillable control with a synthetic value (each a transition when the page
 * changed, else `unchanged`), then a submit of the filled form, whose
 * request the browser blocks and which is therefore a side effect. Every
 * step starts from the state the previous one produced and acts on its
 * control as found again in that state (an earlier step may have moved it);
 * the chain is reverted once, with a fresh load of the base URL. The
 * session's non-GET guard is held from the first step to the end of that
 * fresh load, so no request a step, a timer it started or the unloading
 * document sends reaches a server. A step is observed once the page has been
 * quiet for a second (`CHAIN_STABILITY`), so a debounced handler's request
 * counts for the step that started it; one that appears later still, before
 * the next step, belongs to that step too. A step that reached the browser
 * but failed or was not performed is treated the same way (its handlers may
 * have run), and makes the chain end with that fresh load. Values are never
 * read from the page: the policy chose them.
 */
import { join } from 'node:path';
import type { Transition, UiNode } from '@rohzzn/uidna-schema';
import type { AttemptedInteraction } from '../application/records.js';
import { redactUrl } from '../browser/redact.js';
import { blockedByUiDna } from '../browser/session.js';
import type { CapturedState, NetworkEntry } from '../browser/types.js';
import { describeError } from '../domain/errors.js';
import { transitionId as makeTransitionId } from '../domain/ids.js';
import { isNonGetRequest, isSideEffect, submitDenial } from '../domain/safe-policy.js';
import {
  actionOf,
  bodyOf,
  CHAIN_STABILITY,
  changedNodeIds,
  clip,
  describeNode,
  discardProbe,
  ensureBase,
  finishProbed,
  hasSideEffect,
  markSideEffect,
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

/** Reason recorded when a step's control cannot be found unambiguously in the state the earlier steps of its chain produced; the step is not performed. */
export const TARGET_MOVED = 'target moved after an earlier step';

/** What a step that reached the browser leaves for the requests that appear after it was observed. */
interface StepTail {
  /** The step as performed, on its control as found in the state it started from. */
  readonly planned: Planned;
  /** Remembered when a late request makes the step a side effect: the control acted on, and the planned one. */
  readonly nodes: readonly UiNode[];
  /** Ledger marker from which requests have not been attributed to the step yet. */
  observedUntil: string;
  readonly attempt: AttemptedInteraction | null;
  readonly transition: Transition | null;
}

interface StepResult {
  readonly cursor: Cursor;
  readonly transition: Transition | null;
  /**
   * True when the step reached the browser (typed, checked, selected or submitted, or reached `act()` and failed
   * there, or was not performed after its handlers may have run), even when nothing observable changed: the chain's
   * revert must load the base URL afresh while the guard is held.
   */
  readonly touched: boolean;
  /** True when the chain cannot continue (the page left the document, a probe failed, the browser is gone). */
  readonly ended: boolean;
  /** True when the step's only side effect was requests UI DNA blocked: the control is remembered when the chain ends. */
  readonly blockedOnly?: boolean;
  /** What later requests are attributed to; null when the step never reached the browser. */
  readonly tail: StepTail | null;
}

/** Identity of a control across the states of a chain: tag, type, `name` and `id` attributes, accessible name. */
function identityOf(node: UiNode): string {
  return JSON.stringify([node.tag.toLowerCase(), (node.attrs.type ?? '').trim().toLowerCase(), node.attrs.name ?? '', node.attrs.id ?? '', node.name ?? '']);
}

/**
 * `node`, a node of `planned` (the capture a step was planned from), as found
 * in `current`: the node with the same identity (tag, type, `name` and `id`
 * attributes, accessible name) at the same position among the nodes that
 * share it. Null when there is no such node, or when the number of nodes
 * sharing it changed: an earlier step added or removed one, so the position
 * no longer tells which one it is.
 */
export function resolveMoved(planned: CapturedState, current: CapturedState, node: UiNode): UiNode | null {
  if (planned === current) return node;
  const identity = identityOf(node);
  const before = planned.nodes.filter((candidate) => identityOf(candidate) === identity);
  const nth = before.findIndex((candidate) => candidate.path === node.path);
  const after = current.nodes.filter((candidate) => identityOf(candidate) === identity);
  if (nth < 0 || after.length !== before.length) return null;
  return after[nth] ?? null;
}

/**
 * The step as it is performed from `cursor`, on its control found again in
 * the state the earlier steps produced; or the reason it is skipped: the
 * control cannot be found unambiguously, or (for a submit) the control found
 * now carries a denied name.
 */
function resolveStep(run: Run, sequence: FormSequence, cursor: Cursor, step: Planned): Planned | string {
  const node = step.node;
  if (node === null) return step;
  const found = resolveMoved(sequence.capture, cursor.capture, node);
  if (found === null) return TARGET_MOVED;
  if (step.kind === 'submit') {
    const denied = submitDenial(found, cursor.capture, run.denyNames);
    if (denied !== null) return `denied name: ${denied}`;
  }
  return found === node ? step : { ...step, node: found };
}

/** The planned control and the one acted on, once each. */
function stepNodes(planned: Planned, performed: Planned): UiNode[] {
  const nodes = [planned.node, performed.node].filter((node): node is UiNode => node !== null);
  return nodes.filter((node, index) => nodes.findIndex((other) => other.path === node.path) === index);
}

/**
 * Attribute to a step the requests that appeared after it was observed
 * (`entries`). A non-GET one makes the step a side effect after all, on its
 * attempt and its transition. When the guard blocked every such request the
 * step's controls are remembered with the chain (`blockedNodes`), like a
 * blocked submission; otherwise they are remembered now.
 */
function attributeLate(run: Run, ref: Reference, tail: StepTail, entries: readonly NetworkEntry[], blockedNodes: UiNode[], when: string): void {
  const nonGet = entries.filter(isNonGetRequest);
  if (nonGet.length === 0) return;
  const blocked = nonGet.filter(blockedByUiDna);
  if (blocked.length === nonGet.length) blockedNodes.push(...tail.nodes);
  else for (const node of tail.nodes) markSideEffect(run, ref, node);
  const transition = tail.transition;
  if (transition !== null) {
    transition.sideEffects = true;
    transition.network = { requests: transition.network.requests + entries.length, nonGet: transition.network.nonGet + nonGet.length };
  }
  const note = `${nonGet.length} non-GET request(s) ${when}`;
  const attempt = tail.attempt;
  if (attempt !== null && (attempt.outcome === 'changed' || attempt.outcome === 'unchanged' || attempt.outcome === 'failed')) {
    attempt.outcome = 'side-effect';
    attempt.reason = attempt.reason === null ? note : `${attempt.reason}; ${note}`;
  }
  const fate = blocked.length === nonGet.length ? "blocked; the server's response is not observed" : `${blocked.length} of them blocked`;
  run.unknowns.push(`${tail.planned.describe}: ${note} (${nonGet.map((entry) => entry.url).join(', ')}), ${fate}; attributed to this step`);
}

/** Perform one fill or submit step from `cursor` and record what happened. `nodes` are remembered when it causes a side effect; `marker` was taken just before. */
async function performChainStep(run: Run, ref: Reference, cursor: Cursor, planned: Planned, nodes: readonly UiNode[], marker: string): Promise<StepResult> {
  const { session, budget } = run;
  const keep: StepResult = { cursor, transition: null, touched: false, ended: false, tail: null };
  run.progress.current += 1;
  report(run, `${planned.describe} (${cursor.stateId}, ${ref.pageId})`);
  const stateId = cursor.stateId;
  const started = run.ctx.clock.now().getTime();
  const remember = (): void => {
    for (const node of nodes) markSideEffect(run, ref, node);
  };
  const tailOf = (observedUntil: string, attempt: AttemptedInteraction | null, transition: Transition | null): StepTail => ({ planned, nodes, observedUntil, attempt, transition });
  // A step that reached `act()` and failed, or was not performed, may still have reached the page: setChecked clicks
  // the box before it finds the state unchanged, a fill whose input handler opened a popup is reported as not
  // performed. Its handlers ran and may have started timers, and no snapshot covers control values or timers: the
  // chain ends with a fresh load under the guard (`touched`), whose unload ends those timers. The page first gets the
  // quiet second every step gets, so that a request a debounced handler sends counts for this step, not the next one.
  const failed = async (attempt: AttemptedInteraction): Promise<StepResult> => {
    const stable = await session.waitForStability(CHAIN_STABILITY);
    if (!stable.ok) run.limitations.push(`${planned.describe}: stability wait failed (${describeError(stable.error)})`);
    const tail = tailOf(marker, attempt, null);
    const blocked: UiNode[] = [];
    // Nothing is awaited between the two reads: what appears from here on is attributed to the step by the chain.
    attributeLate(run, ref, tail, session.networkSince(marker), blocked, 'followed the action');
    tail.observedUntil = session.markNetwork();
    return { ...keep, touched: true, blockedOnly: blocked.length > 0, tail };
  };

  const acted = await session.act(toUiAction(planned));
  budget.consumeAction();
  if (!acted.ok) {
    const attempt = recordAttempt(run, stateId, planned, 'failed', null, describeError(acted.error), started);
    if (/closed/i.test(acted.error.message)) {
      run.aborted = `browser session unavailable (${describeError(acted.error)})`;
      return { ...keep, ended: true };
    }
    return failed(attempt);
  }
  const outcome = acted.value;
  if (outcome.dialogs.length > 0) {
    run.limitations.push(`${planned.describe}: ${outcome.dialogs.length} dialog(s) opened and were dismissed (${outcome.dialogs.map(clip).join('; ')})`);
  }
  const blockedRequests = outcome.blockedRequests ?? [];
  const sentEarly = isSideEffect(session.networkSince(marker)).nonGet > 0;
  if (!outcome.performed && blockedRequests.length === 0 && !sentEarly) {
    const navigation = unperformedNavigation(outcome);
    if (navigation !== null) {
      const observedUntil = session.markNetwork();
      // A GET submission or a script navigation (blocked, or committed and undone): the page is back; recorded once, never repeated.
      remember();
      const attempt = recordAttempt(run, stateId, planned, 'navigated', null, navigation, started);
      run.unknowns.push(`${planned.describe} skipped: ${outcome.reason ?? navigation}`);
      // The submit event ran (or the document was replaced and restored): the chain ends on a document loaded afresh.
      return { ...keep, touched: true, tail: tailOf(observedUntil, attempt, null) };
    }
    return failed(recordAttempt(run, stateId, planned, 'failed', null, outcome.reason ?? 'action not performed', started));
  }
  const stable = await session.waitForStability(CHAIN_STABILITY);
  if (!stable.ok) run.limitations.push(`${planned.describe}: stability wait failed (${describeError(stable.error)})`);
  // The ledger records the requests the guards blocked too (with their failure), so `network` counts them. Taken
  // together with the marker, so that what appears from here on is attributed to this step later (`attributeLate`).
  const entries = session.networkSince(marker);
  const observedUntil = session.markNetwork();
  const network = isSideEffect(entries);
  const nonGet = entries.filter(isNonGetRequest);
  const blocked = nonGet.filter(blockedByUiDna);
  // A blocked submission request is a side effect the page attempted, like a non-GET request that got through.
  const sideEffect = blockedRequests.length > 0 || network.nonGet > 0 || outcome.navigated;
  // A side effect that consisted only of requests UI DNA blocked never reached a server: the control may be
  // submitted again later in this chain (the guard blocks it again), so an empty submit that sent a request does
  // not hide the filled submission. The chain remembers the control when it ends; no other chain repeats it.
  const blockedOnly = blocked.length > 0 && blocked.length === nonGet.length && !outcome.navigated;
  if (sideEffect && !blockedOnly) remember();
  const touched: StepResult = { ...keep, touched: true, blockedOnly };
  if (blocked.length > 0) {
    run.unknowns.push(`${planned.describe}: ${blocked.length} non-GET request(s) blocked (${blocked.map((entry) => entry.url).join(', ')}); the server's response is not observed`);
  }

  if (outcome.navigated && stripHash(outcome.url) !== stripHash(ref.url)) {
    const destination = redactUrl(outcome.url);
    const attempt = recordAttempt(run, stateId, planned, 'navigated', null, `navigated to ${destination}`, started);
    run.unknowns.push(`${planned.describe} navigated to ${destination}; the form sequence ended there`);
    return { ...touched, ended: true, tail: tailOf(observedUntil, attempt, null) };
  }

  const probePath = join(run.tmpDir, 'probe.png');
  const probed = await session.capture({ screenshotPath: probePath, assetDir: run.assetDir, maxHeight: 4000 });
  if (!probed.ok) {
    const attempt = recordAttempt(run, stateId, planned, 'failed', null, `probe capture failed: ${describeError(probed.error)}`, started);
    return { ...touched, ended: true, tail: tailOf(observedUntil, attempt, null) };
  }
  const probe = probed.value;
  const domChanged = probe.domDigest !== cursor.capture.domDigest;
  const roleTreeChanged = probe.roleTreeDigest !== cursor.capture.roleTreeDigest;
  const screenshotChanged = (probe.screenshot?.digest ?? null) !== (cursor.capture.screenshot?.digest ?? null);
  if (!domChanged && !roleTreeChanged && !screenshotChanged && !sideEffect) {
    // Nothing observable changed, but a typed value lives in a control's property, which no digest covers: the chain still ends with a fresh load.
    const attempt = recordAttempt(run, stateId, planned, 'unchanged', null, null, started);
    await discardProbe(run, probePath);
    return { ...touched, tail: tailOf(observedUntil, attempt, null) };
  }

  const transitionId = makeTransitionId(run.transitions.length + 1);
  const stored = await storeDerived(run, ref, cursor, probe, probePath, transitionId);
  if (!stored.ok) {
    const attempt = recordAttempt(run, stateId, planned, 'failed', null, `derived state not stored: ${describeError(stored.error)}`, started);
    return { ...touched, ended: true, tail: tailOf(observedUntil, attempt, null) };
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
  const attempt = recordAttempt(run, stateId, planned, sideEffect ? 'side-effect' : 'changed', transitionId, stored.value.reused ? `same as state ${stored.value.stateId}` : null, started);
  return { cursor: { stateId: stored.value.stateId, capture: stored.value.capture }, transition, touched: true, ended: false, blockedOnly, tail: tailOf(observedUntil, attempt, transition) };
}

/** List the steps of a sequence from `index` on as skipped for `reason`. */
function skipRemaining(run: Run, ref: Reference, steps: readonly Planned[], index: number, reason: string): void {
  for (const step of steps.slice(index)) run.skipped.push(skippedRecord(ref.stateId, step, bodyOf(ref.capture), reason));
}

/**
 * Run the chain of one form and bring the page back to the base state. The
 * transitions of the chain share the revert that ends it (a fresh load).
 * The session's non-GET guard is held for the whole chain, revert included.
 * Returns the stop that interrupted the chain, whose remaining steps are
 * then listed as skipped, or null when it ran to the end.
 */
export async function runFormSequence(run: Run, ref: Reference, sequence: FormSequence): Promise<Stop | null> {
  const held = await run.session.holdNonGetGuard();
  if (!held.ok) {
    // Without the guard a submission (or a debounced autosave) could reach a server: the chain is not run.
    const reason = `the non-GET guard could not be installed (${describeError(held.error)})`;
    run.limitations.push(`form ${describeNode(sequence.form)} was not explored: ${reason}`);
    skipRemaining(run, ref, sequence.steps, 0, reason);
    if (/closed/i.test(held.error.message)) run.aborted = `browser session unavailable (${describeError(held.error)})`;
    return null;
  }
  try {
    return await runGuardedSequence(run, ref, sequence);
  } finally {
    await held.value.release();
  }
}

/** `runFormSequence` once the guard is held. */
async function runGuardedSequence(run: Run, ref: Reference, sequence: FormSequence): Promise<Stop | null> {
  const { session } = run;
  let cursor: Cursor = { stateId: ref.stateId, capture: ref.capture };
  const chain: Transition[] = [];
  let touched = false;
  let last: Planned | null = null;
  let tail: StepTail | null = null;
  // Controls whose only side effect so far was requests UI DNA blocked: remembered once the chain ends.
  const blockedNodes: UiNode[] = [];
  const remember = (): void => {
    for (const node of blockedNodes) markSideEffect(run, ref, node);
  };
  // Attribute what appeared since the last step was observed to that step, and split the ledger here: the marker
  // returned is where the next step (or the revert) starts. Nothing is awaited between the two reads.
  const settleTail = (): string => {
    if (tail !== null) attributeLate(run, ref, tail, session.networkSince(tail.observedUntil), blockedNodes, 'appeared after the step was observed');
    const marker = session.markNetwork();
    if (tail !== null) tail.observedUntil = marker;
    return marker;
  };
  const end = async (fallback: Planned): Promise<void> => {
    const revertStart = settleTail();
    await revertSequence(run, ref, chain, touched, last ?? fallback);
    if (run.aborted === null) {
      // The revert's requests (a beacon of the unloading document, a blur's autosave) were blocked too; the chain
      // caused them, so they belong to its last step.
      const during = session.networkSince(revertStart);
      if (tail !== null) attributeLate(run, ref, tail, during, blockedNodes, 'were sent while the form sequence was reverted');
      else noteRevertRequests(run, sequence, during);
    }
    remember();
  };
  const steps = sequence.steps;
  for (const [index, step] of steps.entries()) {
    const stop = stopReason(run);
    if (stop !== null) {
      skipRemaining(run, ref, steps, index, `${stop.reason} (${stop.detail})`);
      await end(step);
      return stop;
    }
    const marker = settleTail();
    // An earlier step may have moved the control (an error summary inserted before it): act on it where it is now.
    const performed = resolveStep(run, sequence, cursor, step);
    if (typeof performed === 'string') {
      run.skipped.push(skippedRecord(ref.stateId, step, bodyOf(ref.capture), performed));
      continue;
    }
    const nodes = stepNodes(step, performed);
    // A control whose fill or submit caused a side effect or a navigation, in this run or an earlier one, is never acted on again.
    if (nodes.some((node) => hasSideEffect(run, ref, node))) {
      run.skipped.push(skippedRecord(ref.stateId, step, bodyOf(ref.capture), SUBMIT_SKIPPED_EARLIER));
      continue;
    }
    last = performed;
    const result = await performChainStep(run, ref, cursor, performed, nodes, marker);
    cursor = result.cursor;
    touched = touched || result.touched;
    if (result.transition !== null) chain.push(result.transition);
    if (result.tail !== null) tail = result.tail;
    if (result.blockedOnly === true) blockedNodes.push(...nodes);
    if (run.aborted !== null) {
      skipRemaining(run, ref, steps, index + 1, `browser failure (${run.aborted})`);
      settleTail();
      remember();
      return null;
    }
    if (result.ended) {
      skipRemaining(run, ref, steps, index + 1, 'the form sequence ended early (see the attempt that preceded it)');
      break;
    }
  }
  await end(steps[0] ?? { kind: 'submit', node: sequence.form, describe: 'form sequence' });
  return null;
}

/** Report the non-GET requests a revert sent when no step of the chain was performed (nothing to attribute them to). */
function noteRevertRequests(run: Run, sequence: FormSequence, entries: readonly NetworkEntry[]): void {
  const nonGet = entries.filter(isNonGetRequest);
  if (nonGet.length === 0) return;
  const blocked = nonGet.filter(blockedByUiDna).length;
  run.limitations.push(`reverting the form sequence of ${describeNode(sequence.form)} sent ${nonGet.length} non-GET request(s) (${nonGet.map((entry) => entry.url).join(', ')}); ${blocked} of them blocked`);
}

/**
 * Bring the page back after a chain and record the revert on every
 * transition of the chain. A chain any step of which reached the browser is
 * always reverted with a fresh load of the base URL, even when every step
 * was `unchanged` or failed: the values a fill typed live in control
 * properties, and the timers its handlers started in the page, which no
 * digest covers, so a snapshot cannot tell them apart from the base. The
 * fresh load unloads that document while the guard is still held.
 */
async function revertSequence(run: Run, ref: Reference, chain: Transition[], touched: boolean, planned: Planned): Promise<void> {
  if (run.aborted !== null) return;
  if (chain.length === 0 && !touched) {
    // Every step was skipped, none reached the browser: verify, and reload only when needed.
    await quietly(run, { kind: 'blur' });
    await ensureBase(run, ref, planned, null);
    return;
  }
  const reverted = await reloadRevert(run, ref);
  await quietly(run, { kind: 'reset-pointer' });
  for (const transition of chain) transition.revert = { method: 'reload', succeeded: reverted.succeeded };
  await finishProbed(run, ref, planned, reverted.snapshot, 'reload');
}
