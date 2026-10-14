/**
 * Navigation steps: a click on a same-origin link that leads to another
 * crawled page, performed with `allowNavigation: 'same-origin'` so the
 * browser follows the one document navigation. The destination is already
 * captured by the scan, so no new state is stored: the transition joins the
 * originating base state to the base state of the destination page at the
 * same viewport width, with the change computed between the two base
 * captures, and the originating page is loaded again. A link whose click
 * lands anywhere else is reported, never recorded as a transition.
 */
import type { Transition } from '@rohzzn/uidna-schema';
import { pageKey } from '../application/scan.js';
import { redactUrl } from '../browser/redact.js';
import { isoNow } from '../domain/clock.js';
import { describeError } from '../domain/errors.js';
import { transitionId as makeTransitionId } from '../domain/ids.js';
import { isSideEffect } from '../domain/safe-policy.js';
import {
  changedNodeIds,
  clip,
  ensureBase,
  finishProbed,
  hasSideEffect,
  markSideEffect,
  PROBE_STABILITY,
  quietly,
  recordAttempt,
  reloadRevert,
  report,
  revertUnchanged,
  sameAsReference,
  skippedRecord,
  targetOf,
  bodyOf,
  unperformedNavigation,
  type Planned,
  type Reference,
  type Run,
} from './run.js';

/** Reason recorded when a navigation step is skipped because the node is remembered as side-effecting or navigating. */
export const NAVIGATION_SKIPPED_EARLIER = 'navigation or side effect observed earlier';

/** The base state of `pageId` at the reference's viewport width, when the scan captured one. */
function destinationBase(run: Run, ref: Reference, pageId: string): { stateId: string } | null {
  const candidates = run.scan.states.filter((state) => state.kind === 'base' && (state.pageId ?? run.scan.pageId) === pageId && state.viewport.width === ref.viewport.width);
  const exact = candidates.find((state) => state.viewport.height === ref.viewport.height) ?? candidates[0];
  return exact === undefined ? null : { stateId: exact.stateId };
}

/**
 * Perform one navigation step and record the transition, then load the
 * originating base state again. Every outcome is recorded: a transition when
 * the click reached a crawled page, an `unchanged` attempt when the link did
 * not navigate, a `navigated` attempt with the destination when it led
 * elsewhere, a `failed` attempt when the browser refused the click.
 */
export async function performNavigation(run: Run, ref: Reference, planned: Planned): Promise<void> {
  const { session, budget } = run;
  const node = planned.node;
  const expected = planned.navigation;
  if (node === null || expected === undefined) return;
  run.progress.current += 1;
  report(run, `${planned.describe} (${ref.stateId}, ${ref.pageId})`);
  const stateId = ref.stateId;
  const now = (): number => run.ctx.clock.now().getTime();

  if (hasSideEffect(run, ref, node)) {
    run.skipped.push(skippedRecord(stateId, planned, bodyOf(ref.capture), NAVIGATION_SKIPPED_EARLIER));
    return;
  }

  const marker = session.markNetwork();
  const started = now();
  const acted = await session.act({ kind: 'click', target: { nodeId: node.id, nodePath: node.path }, allowNavigation: 'same-origin' });
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
    run.limitations.push(`${planned.describe}: ${outcome.dialogs.length} dialog(s) opened and were dismissed (${outcome.dialogs.map(clip).join('; ')})`);
  }
  if (!outcome.performed) {
    const navigation = unperformedNavigation(outcome);
    if (navigation !== null) {
      // The browser refused the navigation (robots.txt, cross-origin redirect, a popup) or undid one that committed: recorded once, never repeated.
      markSideEffect(run, ref, node);
      recordAttempt(run, stateId, planned, 'navigated', null, navigation, started);
      run.unknowns.push(`${planned.describe} skipped: ${outcome.reason ?? navigation}`);
    } else {
      recordAttempt(run, stateId, planned, 'failed', null, outcome.reason ?? 'action not performed', started);
    }
    await revertUnchanged(run, planned);
    await ensureBase(run, ref, planned, null);
    return;
  }
  const stable = await session.waitForStability(PROBE_STABILITY);
  if (!stable.ok) run.limitations.push(`${planned.describe}: stability wait failed (${describeError(stable.error)})`);
  const network = isSideEffect(session.networkSince(marker));

  if (!outcome.navigated) {
    const snapshot = await session.snapshot();
    if (snapshot.ok && sameAsReference(snapshot.value, ref) && network.nonGet === 0) {
      recordAttempt(run, stateId, planned, 'unchanged', null, 'the link did not navigate', started);
      await revertUnchanged(run, planned);
      await finishProbed(run, ref, planned, snapshot.value, null);
      return;
    }
    if (network.nonGet > 0) markSideEffect(run, ref, node);
    recordAttempt(
      run,
      stateId,
      planned,
      network.nonGet > 0 ? 'side-effect' : 'changed',
      null,
      network.nonGet > 0
        ? `the link did not navigate but caused ${network.nonGet} non-GET request(s); link clicks are explored as navigations only, so no state was stored`
        : 'the link changed the page without navigating; link clicks are explored as navigations only, so no state was stored',
      started,
    );
    await revertUnchanged(run, planned);
    await ensureBase(run, ref, planned, snapshot.ok ? snapshot.value : null);
    return;
  }

  const destination = redactUrl(outcome.url);
  const toPageId = run.pagesByKey.get(pageKey(outcome.url));
  if (toPageId === undefined || toPageId === ref.pageId) {
    // Landed off the crawl, or back on the current page (a hash or history change, a redirect home): a navigation
    // transition joins two pages, so none is recorded; the click is remembered and never repeated.
    markSideEffect(run, ref, node);
    const where = toPageId === undefined ? 'which is not a crawled page' : `which is the current page (${ref.pageId})`;
    recordAttempt(run, stateId, planned, 'navigated', null, `navigated to ${destination}, ${where}`, started);
    run.unknowns.push(`${planned.describe} navigated to ${destination}, ${where}; no transition recorded`);
    const reverted = await reloadRevert(run, ref);
    await quietly(run, { kind: 'reset-pointer' });
    await finishProbed(run, ref, planned, reverted.snapshot, 'reload');
    return;
  }
  const toBase = destinationBase(run, ref, toPageId);
  const toCapture = toBase === null ? undefined : run.captures.get(toBase.stateId);
  if (toBase === null || toCapture === undefined) {
    recordAttempt(run, stateId, planned, 'navigated', null, `navigated to ${toPageId} (${destination}), which has no base state capture at ${ref.viewport.width}px`, started);
    run.unknowns.push(`${planned.describe} navigated to ${toPageId} (${destination}), but that page has no base state capture at ${ref.viewport.width}px; no transition recorded`);
    const reverted = await reloadRevert(run, ref);
    await quietly(run, { kind: 'reset-pointer' });
    await finishProbed(run, ref, planned, reverted.snapshot, 'reload');
    return;
  }
  if (toPageId !== expected.toPageId) run.limitations.push(`${planned.describe} led to ${toPageId} (${destination}) instead of ${expected.toPageId}; the transition records where it went`);

  const sideEffects = network.nonGet > 0;
  if (sideEffects) markSideEffect(run, ref, node);
  const transitionId = makeTransitionId(run.transitions.length + 1);
  const changed = changedNodeIds(ref.capture, toCapture);
  if (changed.total > changed.ids.length) run.limitations.push(`transition ${transitionId}: changedNodeIds lists ${changed.ids.length} of ${changed.total} changed nodes`);
  const transition: Transition = {
    id: transitionId,
    from: ref.stateId,
    to: toBase.stateId,
    action: { type: 'click', target: targetOf(node) },
    sideEffects,
    network: { requests: network.total, nonGet: network.nonGet },
    revert: { method: 'reload', succeeded: false },
    change: {
      domChanged: toCapture.domDigest !== ref.domDigest,
      roleTreeChanged: toCapture.roleTreeDigest !== ref.roleTreeDigest,
      screenshotChanged: (toCapture.screenshot?.digest ?? null) !== ref.screenshotDigest,
      changedNodeIds: changed.ids,
    },
    navigation: { toPageId, url: destination },
    provenance: {
      kind: 'observed',
      source: 'interaction',
      stateId: ref.stateId,
      viewport: { ...ref.viewport },
      evidenceId: run.evidenceId,
      capturedAt: isoNow(run.ctx.clock),
      confidence: 1,
    },
  };
  run.transitions.push(transition);
  budget.consumeResources(network.total);
  recordAttempt(run, stateId, planned, 'navigated', transitionId, `navigated to ${toPageId}`, started);

  const reverted = await reloadRevert(run, ref);
  await quietly(run, { kind: 'reset-pointer' });
  transition.revert = { method: 'reload', succeeded: reverted.succeeded };
  await finishProbed(run, ref, planned, reverted.snapshot, 'reload');
}
