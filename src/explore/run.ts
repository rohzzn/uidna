/**
 * State and helpers shared by the explorer's drivers (`explorer.ts` for the
 * ordinary safe actions, `navigation.ts` for link clicks that lead to a
 * crawled page, `forms.ts` for the forms policy): the run record, the base
 * state reference every probe is compared against, loading and restoring
 * base states, storing derived states and the records that describe what
 * was attempted or skipped. Internal to `src/explore`.
 */
import { detectCollections } from '../domain/collections.js';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, ActionTarget, Transition, UiNode } from '@rohzzn/uidna-schema';
import type { WorkflowContext } from '../application/context.js';
import type { AttemptedInteraction, ScanRecord, SkippedRecord } from '../application/records.js';
import { relativizeCapture } from '../application/scan.js';
import { redactUrl } from '../browser/redact.js';
import type { ActionOutcome, BrowserSession, CapturedState, PageSnapshot, UiAction } from '../browser/types.js';
import type { BudgetTracker } from '../domain/budget.js';
import { stableStringify } from '../domain/digest.js';
import { describeError, toError } from '../domain/errors.js';
import { stateId as makeStateId } from '../domain/ids.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import { isSideEffect } from '../domain/safe-policy.js';

/** Exploration policy of a run. */
export type ExplorePolicy = 'safe' | 'forms';

/** Rounds of a run, in the order they are explored for every base state. */
export type RoundKind = 'click' | 'navigate' | 'form' | 'key' | 'hover' | 'focus';

/** Kinds of single steps the drivers perform. */
export type StepKind = 'click' | 'navigate' | 'key' | 'hover' | 'focus' | 'fill' | 'submit';

/** Maximum changed node ids listed per transition; the remainder is reported as a limitation. */
export const MAX_CHANGED_NODE_IDS = 500;

/** Stability wait after an action, as the policy prescribes. */
export const PROBE_STABILITY = { timeoutMs: 3000 } as const;
/**
 * Stability wait after a fill or submit of a form chain: the page must stay
 * quiet for a second, so that what a debounced handler (an autosave, a
 * validation request) does in reaction to the step happens before the step
 * is observed and is attributed to it rather than to the next step.
 */
export const CHAIN_STABILITY = { timeoutMs: 4000, quietMs: 1000 } as const;
/** Stability wait after a revert step (the DOM must only settle). */
export const REVERT_STABILITY = { timeoutMs: 1500, quietMs: 100 } as const;
/** Longest accessible name quoted in messages. */
const MAX_QUOTED_NAME = 60;

/** One step to perform: an element interaction, a page-level key press, a navigation click, a fill or a submit. */
export interface Planned {
  readonly kind: StepKind;
  readonly node: UiNode | null;
  readonly key?: string;
  /** Synthetic value of a `fill` step. */
  readonly value?: string;
  /** Crawled page a `navigate` step is expected to reach. */
  readonly navigation?: { readonly toPageId: string; readonly url: string };
  /** Plain-words description used in messages, e.g. `click on button "Open menu"`. */
  readonly describe: string;
}

/** The forms-policy steps of one `<form>`: empty submit, one fill per control, filled submit. Performed as a chain, reverted once. */
export interface FormSequence {
  readonly form: UiNode;
  readonly steps: readonly Planned[];
  /** The capture the steps were planned from: their node paths are paths in it. */
  readonly capture: CapturedState;
}

/** The base state the explorer compares every probe against. */
export interface Reference {
  readonly stateId: string;
  readonly pageId: string;
  readonly url: string;
  readonly viewport: { readonly width: number; readonly height: number };
  capture: CapturedState;
  domDigest: string;
  roleTreeDigest: string;
  screenshotDigest: string | null;
}

/** The state a chained step starts from (the base reference, or the derived state the previous step produced). */
export interface Cursor {
  readonly stateId: string;
  readonly capture: CapturedState;
}

/** Coverage counters of one page. */
export interface PageCoverage {
  discovered: number;
  explored: number;
  changed: number;
  skipped: number;
}

/** Mutable state of one run. */
export interface Run {
  readonly ctx: WorkflowContext;
  readonly session: BrowserSession;
  readonly scan: ScanRecord;
  readonly budget: BudgetTracker;
  readonly evidenceId: string;
  readonly policy: ExplorePolicy;
  readonly denyNames: readonly string[];
  readonly formValues: Readonly<Record<string, string>>;
  /** Whether search controls of detected collections are typed into. */
  readonly collections: boolean;
  /** Page id by page key of every crawled page. */
  readonly pagesByKey: ReadonlyMap<string, string>;
  readonly tmpDir: string;
  readonly assetDir: string;
  readonly captures: Map<string, CapturedState>;
  readonly transitions: Transition[];
  readonly attempted: AttemptedInteraction[];
  readonly skipped: SkippedRecord[];
  readonly limitations: string[];
  readonly unknowns: string[];
  readonly newStateIds: string[];
  /** Keys (`<pageId>:<nodePath>`, `<pageId>:key:<key>` for page-level key presses) of actions that caused a side effect or a navigation in this run; never performed again. */
  readonly sideEffectKeys: Set<string>;
  /** Keys or bare node paths from earlier runs (bare paths apply on every page). */
  readonly knownSideEffectKeys: ReadonlySet<string>;
  /** Derived state id by `<parent>|<dom>|<roleTree>|<screenshot>` digests, for deduplication. */
  readonly derivedByDigests: Map<string, string>;
  readonly progress: { current: number; total: number };
  /** Pages whose first base state was loaded (one page of budget each). */
  readonly pagesLoaded: Set<string>;
  readonly discoveredByPage: Map<string, number>;
  discovered: number;
  partial: boolean;
  /** Set when the browser can no longer be driven; ends the run. */
  aborted: string | null;
}

/** Why a run must stop before the remaining steps. */
export interface Stop {
  readonly reason: 'budget exhausted' | 'cancelled' | 'browser failure';
  readonly detail: string;
}

/* -------------------------------------------------------------- helpers */

/** The URL without its fragment. */
export function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/** Clip page text quoted in messages; the ellipsis marks the cut. */
export function clip(text: string): string {
  return text.length > MAX_QUOTED_NAME ? `${text.slice(0, MAX_QUOTED_NAME)}…` : text;
}

function quote(name: string | null): string {
  if (name === null) return '(unnamed)';
  return `"${clip(name)}"`;
}

/** Record a limitation once: a base state is loaded once per round, and what its page could not do does not change between rounds. */
export function noteOnce(run: Run, message: string): void {
  if (!run.limitations.includes(message)) run.limitations.push(message);
}

/** Record what a temporary capture (never stored) could not do, so the information is not lost with the file. */
export function noteCaptureLimitations(run: Run, label: string, capture: CapturedState): void {
  for (const limitation of capture.limitations) noteOnce(run, `${label}: ${limitation}`);
}

/**
 * How an action the browser reports as not performed nevertheless left, or
 * tried to leave, the document: a document navigation the session blocked,
 * or one that committed and was undone (the session's cross-origin defence
 * navigates back). Null when it did neither. Either is a navigation in the
 * sense of the schema: recorded once as `navigated` and never repeated.
 */
export function unperformedNavigation(outcome: ActionOutcome): string | null {
  if (outcome.blockedNavigation !== undefined) return `navigation to ${outcome.blockedNavigation} was blocked`;
  if (outcome.navigated) return outcome.reason ?? `navigated to ${redactUrl(outcome.url)}`;
  return null;
}

/** `role "name"` or `<tag> "name"` for messages. */
export function describeNode(node: UiNode): string {
  return `${node.role ?? `<${node.tag}>`} ${quote(node.name)}`;
}

/** The schema's action target for a node. */
export function targetOf(node: UiNode): ActionTarget {
  return { nodeId: node.id, nodePath: node.path, role: node.role, name: node.name, tag: node.tag, nth: node.a11y.nth ?? 0 };
}

/** The schema action a planned step is recorded as (a navigation is a click). */
export function actionOf(planned: Planned): Action {
  const type: Action['type'] = planned.kind === 'navigate' ? 'click' : planned.kind;
  return {
    type,
    target: planned.node === null ? null : targetOf(planned.node),
    ...(planned.key === undefined ? {} : { key: planned.key }),
    ...(planned.value === undefined ? {} : { value: planned.value }),
  };
}

/** The browser action of a planned step. */
export function toUiAction(planned: Planned): UiAction {
  if (planned.kind === 'key') return { kind: 'key', key: planned.key ?? '' };
  const node = planned.node;
  const target = node === null ? {} : { nodeId: node.id, nodePath: node.path };
  switch (planned.kind) {
    case 'navigate':
      return { kind: 'click', target, allowNavigation: 'same-origin' };
    case 'fill':
      return { kind: 'fill', target, value: planned.value ?? '' };
    case 'submit':
      return { kind: 'submit', target };
    default:
      return { kind: planned.kind, target };
  }
}

/** The body node of a capture (fallback for skipped records of page-level steps). */
export function bodyOf(capture: CapturedState | undefined): Pick<UiNode, 'id' | 'path' | 'role' | 'name' | 'tag'> {
  const body = capture?.nodes.find((node) => node.path === '') ?? capture?.nodes[0];
  return body ?? { id: 'body', path: '', role: null, name: null, tag: 'body' };
}

/** Label of a step kind in skipped reasons: `click` for navigations, `key <key>` for key presses. */
export function stepLabel(planned: Planned): string {
  if (planned.kind === 'key') return `key ${planned.key ?? ''}`;
  if (planned.kind === 'navigate') return 'click';
  return planned.kind;
}

/** A skipped record for a planned step. */
export function skippedRecord(stateId: string, planned: Planned, fallbackBody: Pick<UiNode, 'id' | 'path' | 'role' | 'name' | 'tag'>, reason: string): SkippedRecord {
  const node = planned.node ?? fallbackBody;
  return { stateId, nodeId: node.id, nodePath: node.path, role: node.role, name: node.name, tag: node.tag, reason: `${stepLabel(planned)}: ${reason}` };
}

function boxesEqual(a: UiNode['box'], b: UiNode['box']): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function nodeDiffers(before: UiNode, after: UiNode): boolean {
  return (
    before.tag !== after.tag ||
    before.text !== after.text ||
    before.visible !== after.visible ||
    before.styleId !== after.styleId ||
    !boxesEqual(before.box, after.box) ||
    stableStringify(before.attrs) !== stableStringify(after.attrs)
  );
}

/** Ids of nodes in `to` that differ from the node at the same path in `from` (or have no counterpart), capped. */
export function changedNodeIds(from: CapturedState, to: CapturedState): { ids: string[]; total: number } {
  const byPath = new Map(from.nodes.map((node) => [node.path, node]));
  const ids: string[] = [];
  let total = 0;
  for (const node of to.nodes) {
    const before = byPath.get(node.path);
    if (before !== undefined && !nodeDiffers(before, node)) continue;
    total += 1;
    if (ids.length < MAX_CHANGED_NODE_IDS) ids.push(node.id);
  }
  return { ids, total };
}

/** True when the snapshot's digests equal the reference's. */
export function sameAsReference(snapshot: PageSnapshot, ref: Reference): boolean {
  return snapshot.domDigest === ref.domDigest && snapshot.roleTreeDigest === ref.roleTreeDigest;
}

/** The reason the run must stop now (cancellation, budget), or null. */
export function stopReason(run: Run): Stop | null {
  if (run.ctx.signal?.aborted === true) return { reason: 'cancelled', detail: 'operation cancelled by caller' };
  const hit = run.budget.check();
  if (hit !== null) return hit._tag === 'cancelled' ? { reason: 'cancelled', detail: hit.message } : { reason: 'budget exhausted', detail: hit.message };
  if (run.budget.wouldExceed('actions')) {
    return { reason: 'budget exhausted', detail: `actions used ${run.budget.usage().actions} of ${run.budget.limits.actions ?? 0}` };
  }
  return null;
}

/** Send a progress event with the run's counters. */
export function report(run: Run, message: string): void {
  run.ctx.progress.report({ message, current: run.progress.current, total: run.progress.total });
}

/** Key under which a node's side effect is remembered: page-scoped, since node paths repeat across pages. */
export function effectKey(pageId: string, nodePath: string): string {
  return `${pageId}:${nodePath}`;
}

/** True when the node caused a side effect or a navigation in this run or an earlier one. */
export function hasSideEffect(run: Run, ref: Reference, node: UiNode): boolean {
  const key = effectKey(ref.pageId, node.path);
  if (run.sideEffectKeys.has(key) || run.knownSideEffectKeys.has(key) || run.knownSideEffectKeys.has(node.path)) return true;
  // The same control in another repeated item (the "Archive" button of the next row) is the same action.
  const item = itemControlKey(ref.capture, node.path);
  if (item === null) return false;
  const itemKey = effectKey(ref.pageId, item);
  return run.sideEffectKeys.has(itemKey) || run.knownSideEffectKeys.has(itemKey);
}

/** Remember that the node's action caused a side effect or a navigation (for its repeated-item equivalents too). */
export function markSideEffect(run: Run, ref: Reference, node: UiNode): void {
  run.sideEffectKeys.add(effectKey(ref.pageId, node.path));
  const item = itemControlKey(ref.capture, node.path);
  if (item !== null) run.sideEffectKeys.add(effectKey(ref.pageId, item));
}

const ITEM_KEYS = new WeakMap<CapturedState, ReadonlyMap<string, string>>();

/**
 * Equivalence key of a node inside a repeated item of a detected collection:
 * `item:<container path>:<path relative to the item>`, shared by the same
 * control in every item; null outside collections.
 */
export function itemControlKey(capture: CapturedState, path: string): string | null {
  let keys = ITEM_KEYS.get(capture);
  if (keys === undefined) {
    const map = new Map<string, string>();
    for (const collection of detectCollections(capture.nodes)) {
      for (const item of collection.items) {
        const prefix = `${item.path}/`;
        for (const node of capture.nodes) {
          if (node.path !== item.path && !node.path.startsWith(prefix)) continue;
          const rel = node.path === item.path ? '' : node.path.slice(prefix.length);
          map.set(node.path, `item:${collection.container.path}:${rel}`);
        }
      }
    }
    keys = map;
    ITEM_KEYS.set(capture, keys);
  }
  return keys.get(path) ?? null;
}

/** Key under which a page-level key press (no target node) is remembered: page-scoped like a node's, never a node path. */
export function keyPressEffectKey(pageId: string, key: string): string {
  return effectKey(pageId, `key:${key}`);
}

/** True when the step's node, or for a page-level key press its key, caused a side effect or a navigation in this run or an earlier one. */
export function hasStepSideEffect(run: Run, ref: Reference, planned: Planned): boolean {
  if (planned.node !== null) return hasSideEffect(run, ref, planned.node);
  if (planned.kind !== 'key' || planned.key === undefined) return false;
  const key = keyPressEffectKey(ref.pageId, planned.key);
  return run.sideEffectKeys.has(key) || run.knownSideEffectKeys.has(key);
}

/** Remember that the step (its node, or for a page-level key press its key) caused a side effect or a navigation. */
export function markStepSideEffect(run: Run, ref: Reference, planned: Planned): void {
  if (planned.node !== null) markSideEffect(run, ref, planned.node);
  else if (planned.kind === 'key' && planned.key !== undefined) run.sideEffectKeys.add(keyPressEffectKey(ref.pageId, planned.key));
}

/** Record one attempted step; returns the record, which a later observation may still update. */
export function recordAttempt(
  run: Run,
  stateId: string,
  planned: Planned,
  outcome: AttemptedInteraction['outcome'],
  transitionId: string | null,
  reason: string | null,
  startedAt: number,
): AttemptedInteraction {
  const now = run.ctx.clock.now().getTime();
  const attempt: AttemptedInteraction = { stateId, action: actionOf(planned), outcome, transitionId, reason, durationMs: Math.max(0, Math.round(now - startedAt)) };
  run.attempted.push(attempt);
  return attempt;
}

/**
 * Record an action the browser reports as not performed that still sent
 * non-GET requests (a click that POSTs, then opens a popup UI DNA closes):
 * a side effect, so the step's control or key is remembered and never acted
 * on again. Returns false, recording nothing, when it sent none.
 */
export function recordUnperformedSideEffect(run: Run, ref: Reference, planned: Planned, outcome: ActionOutcome, network: { nonGet: number; total: number }, startedAt: number): boolean {
  if (network.nonGet === 0) return false;
  markStepSideEffect(run, ref, planned);
  const why = (outcome.reason ?? unperformedNavigation(outcome) ?? 'the action was not performed').replace(/\.$/, '');
  recordAttempt(run, ref.stateId, planned, 'side-effect', null, `${why}; it caused ${network.nonGet} non-GET request(s)`, startedAt);
  run.unknowns.push(`${planned.describe} was not performed (${why}) but caused ${network.nonGet} non-GET request(s); it will not be performed again`);
  return true;
}

/* --------------------------------------------------------- base states */

/** Freeze animations and wait for the page to be quiet after a load. */
export async function settle(run: Run, stateId: string): Promise<Result<void>> {
  const stabilized = await run.session.stabilize();
  if (!stabilized.ok) run.limitations.push(`base state ${stateId}: could not freeze animations (${describeError(stabilized.error)})`);
  const stable = await run.session.waitForStability({ timeoutMs: Math.min(8_000, Math.max(1_000, run.budget.remainingMs())) });
  if (!stable.ok) return stable;
  if (!stable.value.stable) run.limitations.push(`base state ${stateId}: page kept changing for ${stable.value.waitedMs}ms after loading`);
  return ok(undefined);
}

/**
 * Navigate to the base URL again and refresh the stabilization; returns the
 * snapshot afterwards. A failed stability wait is recorded, not fatal: the
 * snapshot still tells whether the page is back at the reference.
 */
export async function freshLoad(run: Run, ref: Reference): Promise<Result<PageSnapshot>> {
  const navigated = await run.session.navigate(ref.url, { waitUntil: 'load', timeoutMs: Math.min(30_000, Math.max(5_000, run.budget.remainingMs())) });
  if (!navigated.ok) return navigated;
  const settled = await settle(run, ref.stateId);
  if (!settled.ok) run.limitations.push(`base state ${ref.stateId}: stability wait failed after a fresh load (${describeError(settled.error)})`);
  return run.session.snapshot();
}

/** Replace the reference with a first capture of the current (freshly loaded) document. */
export async function recaptureReference(run: Run, ref: Reference, planned: Planned, fallback: PageSnapshot): Promise<void> {
  const fresh = await run.session.capture({ screenshotPath: join(run.tmpDir, `base-${ref.stateId}.png`), maxHeight: 4000 });
  if (!fresh.ok) {
    run.limitations.push(`could not capture the fresh page after ${planned.describe} (${describeError(fresh.error)})`);
    ref.domDigest = fallback.domDigest;
    ref.roleTreeDigest = fallback.roleTreeDigest;
    return;
  }
  noteCaptureLimitations(run, `base state ${ref.stateId} (reference re-captured after ${planned.describe})`, fresh.value);
  ref.capture = fresh.value;
  ref.domDigest = fresh.value.domDigest;
  ref.roleTreeDigest = fresh.value.roleTreeDigest;
  ref.screenshotDigest = fresh.value.screenshot?.digest ?? null;
}

/**
 * Make sure the page is back at the reference. A snapshot taken by the
 * caller is reused; otherwise one is taken. A page that cannot be restored
 * is reloaded, and when even the fresh load differs the fresh page becomes
 * the reference for the rest of the base state. Returns true when the
 * document was reloaded here.
 */
export async function ensureBase(run: Run, ref: Reference, planned: Planned, snapshot: PageSnapshot | null): Promise<boolean> {
  let current: PageSnapshot | null = snapshot;
  if (current === null) {
    const taken = await run.session.snapshot();
    if (!taken.ok) {
      run.limitations.push(`could not verify the base state after ${planned.describe} (${describeError(taken.error)})`);
      return false;
    }
    current = taken.value;
  }
  if (sameAsReference(current, ref)) return false;
  const reloaded = await freshLoad(run, ref);
  if (!reloaded.ok) {
    run.limitations.push(`could not restore base state after ${planned.describe}: reload failed (${describeError(reloaded.error)})`);
    run.aborted = `reload failed after ${planned.describe}`;
    return true;
  }
  if (sameAsReference(reloaded.value, ref)) return true;
  run.limitations.push(`could not restore base state after ${planned.describe}; continuing from a fresh load`);
  await recaptureReference(run, ref, planned, reloaded.value);
  return true;
}

/**
 * Load the base URL afresh after a probed action so that the next probe is
 * again the first capture of a fresh document, like the scan's base
 * captures: a second capture of the same document reports retained layout
 * for content Chromium skips (closed `<details>` panels), which would show
 * up as phantom changes. The revert itself has already been verified.
 *
 * This is a navigation to the base URL, never `reload()`: a reload of a
 * document that an action produced with a POST would resubmit it, and a
 * navigation also honours the session's rate limit.
 */
export async function resetDocument(run: Run, ref: Reference, planned: Planned): Promise<void> {
  const reloaded = await freshLoad(run, ref);
  if (!reloaded.ok) {
    run.limitations.push(`could not load the base URL again after ${planned.describe} (${describeError(reloaded.error)})`);
    run.aborted = `fresh load failed after ${planned.describe}`;
    return;
  }
  if (sameAsReference(reloaded.value, ref)) return;
  run.limitations.push(`page differs from base state ${ref.stateId} after the fresh load that followed ${planned.describe}; re-capturing the reference`);
  await recaptureReference(run, ref, planned, reloaded.value);
}

/* ------------------------------------------------------------- reverts */

/** Perform a cheap action and ignore its outcome (pointer reset, blur): nothing to observe. */
export async function quietly(run: Run, action: UiAction): Promise<void> {
  const result = await run.session.act(action);
  if (!result.ok) run.limitations.push(`${action.kind} failed during revert (${describeError(result.error)})`);
}

/** What a revert did and whether the page is back at the reference afterwards. */
export interface RevertOutcome {
  readonly method: Transition['revert']['method'];
  readonly succeeded: boolean;
  readonly snapshot: PageSnapshot | null;
}

/** Compare the page with the reference by its digests once the DOM has settled. */
export async function compareBySnapshot(run: Run, ref: Reference, method: RevertOutcome['method']): Promise<RevertOutcome> {
  await run.session.waitForStability(REVERT_STABILITY);
  const snapshot = await run.session.snapshot();
  if (!snapshot.ok) return { method, succeeded: false, snapshot: null };
  return { method, succeeded: sameAsReference(snapshot.value, ref), snapshot: snapshot.value };
}

/**
 * Load the base URL afresh as a revert; used after side effects, navigations
 * and when nothing else restores the base. A navigation, never `reload()`:
 * reloading a document that a POST produced would repeat the side effect.
 */
export async function reloadRevert(run: Run, ref: Reference): Promise<RevertOutcome> {
  const reloaded = await freshLoad(run, ref);
  if (!reloaded.ok) {
    run.limitations.push(`fresh load failed during revert (${describeError(reloaded.error)})`);
    return { method: 'reload', succeeded: false, snapshot: null };
  }
  return { method: 'reload', succeeded: sameAsReference(reloaded.value, ref), snapshot: reloaded.value };
}

/** Fall back to a fresh load when the cheap revert did not restore the base, so the recorded method is the one that worked. */
export async function orReload(run: Run, ref: Reference, after: RevertOutcome): Promise<RevertOutcome> {
  if (after.succeeded) return after;
  const reloaded = await reloadRevert(run, ref);
  await quietly(run, { kind: 'reset-pointer' });
  return reloaded;
}

/** After a probe: verify the base state, then reload unless the page was just reloaded anyway. */
export async function finishProbed(run: Run, ref: Reference, planned: Planned, snapshot: PageSnapshot | null, revertMethod: RevertOutcome['method'] | null): Promise<void> {
  const reloaded = await ensureBase(run, ref, planned, snapshot);
  if (reloaded || revertMethod === 'reload' || run.aborted !== null) return;
  await resetDocument(run, ref, planned);
}

/**
 * Attribute to the planned step the non-GET requests seen since `marker`,
 * which a revert of it (Escape, blur, pointer reset) caused: the step's
 * control, or page-level key, is remembered as side-effecting and a
 * limitation names the revert. Returns the requests seen.
 */
export function attributeRevert(run: Run, ref: Reference, planned: Planned, marker: string, revert: string): { nonGet: number; total: number } {
  const network = isSideEffect(run.session.networkSince(marker));
  if (network.nonGet > 0) {
    markStepSideEffect(run, ref, planned);
    const what = planned.node === null ? 'key' : 'element';
    run.limitations.push(`reverting ${planned.describe} with ${revert} caused ${network.nonGet} non-GET request(s); the ${what} will not be acted on again`);
  }
  return network;
}

/** Perform revert actions whose outcome is not observed (`quietly`) and attribute the non-GET requests they caused to the planned step (`attributeRevert`). */
export async function revertQuietly(run: Run, ref: Reference, planned: Planned, actions: readonly UiAction[], revert: string): Promise<void> {
  if (actions.length === 0) return;
  const marker = run.session.markNetwork();
  for (const action of actions) await quietly(run, action);
  attributeRevert(run, ref, planned, marker, revert);
}

/** Undo the incidental effects of an action that changed nothing (pointer position, focus); what the revert sends is attributed to the action. */
export async function revertUnchanged(run: Run, ref: Reference, planned: Planned): Promise<void> {
  const actions: UiAction[] = [];
  const labels: string[] = [];
  if (planned.kind === 'hover' || planned.kind === 'click' || planned.kind === 'navigate') {
    actions.push({ kind: 'reset-pointer' });
    labels.push('a pointer reset');
  }
  if (planned.kind !== 'hover') {
    actions.push({ kind: 'blur' });
    labels.push('a blur');
  }
  await revertQuietly(run, ref, planned, actions, labels.join(' and '));
}

/* ------------------------------------------------------- derived states */

/** Remove a probe screenshot that will not be stored. */
export async function discardProbe(run: Run, probePath: string): Promise<void> {
  await rm(probePath, { force: true }).catch((cause: unknown) => run.limitations.push(`probe screenshot not removed (${describeError(cause)})`));
}

/** Store the probe as a derived state of `parent` on the reference's page, or reuse an identical one of the same parent. */
export async function storeDerived(
  run: Run,
  ref: Reference,
  parent: Cursor,
  probe: CapturedState,
  probePath: string,
  viaTransitionId: string,
): Promise<Result<{ stateId: string; capture: CapturedState; reused: boolean }>> {
  const { ctx, scan } = run;
  const key = [parent.stateId, probe.domDigest, probe.roleTreeDigest, probe.screenshot?.digest ?? ''].join('|');
  const existing = run.derivedByDigests.get(key);
  if (existing !== undefined) {
    const capture = run.captures.get(existing);
    if (capture !== undefined) {
      await discardProbe(run, probePath);
      return ok({ stateId: existing, capture, reused: true });
    }
  }
  const stateId = makeStateId(scan.states.length + 1);
  const stateDir = tryCatch(() => ctx.store.stateDir(scan.scanId, stateId), (cause) => toError(cause, 'io', 'state directory'));
  if (!stateDir.ok) return stateDir;
  const screenshotPath = join(stateDir.value, 'screenshot.png');
  try {
    await mkdir(stateDir.value, { recursive: true });
    if (probe.screenshot !== null) await rename(probePath, screenshotPath);
  } catch (cause) {
    return err(toError(cause, 'io', `store screenshot of ${stateId}`));
  }
  const moved: CapturedState = { ...probe, screenshot: probe.screenshot === null ? null : { ...probe.screenshot, path: screenshotPath } };
  const capture = relativizeCapture(ctx, scan.scanId, moved);
  const saved = await ctx.store.saveCapture(scan.scanId, stateId, capture);
  if (!saved.ok) return saved;
  scan.states.push({
    stateId,
    pageId: ref.pageId,
    kind: 'derived',
    parentStateId: parent.stateId,
    viewport: capture.viewport,
    url: capture.url,
    title: capture.title,
    capturePath: saved.value,
    screenshotPath: capture.screenshot?.path ?? null,
    domDigest: capture.domDigest,
    roleTreeDigest: capture.roleTreeDigest,
    nodeCount: capture.nodes.length,
    capturedAt: capture.capturedAt,
    evidenceId: run.evidenceId,
    viaTransitionId,
  });
  run.captures.set(stateId, capture);
  run.newStateIds.push(stateId);
  run.derivedByDigests.set(key, stateId);
  return ok({ stateId, capture, reused: false });
}
