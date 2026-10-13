/**
 * The explorer behind `explore_interactions`. For every base state of a scan
 * it reloads the page, lets the safe policy pick the interactions, performs
 * them one at a time, probes the page after each one and stores a derived
 * state plus a transition whenever the DOM, the role tree or the screenshot
 * changed. Every action is reverted (Escape, toggle or reload) and the page
 * is checked against the base state before the next one. Nothing is inferred:
 * what could not be observed, restored or stored is reported as a limitation
 * or an unknown, never dropped.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Action, ActionTarget, Transition, UiNode } from '@uidna/schema';
import type { WorkflowContext } from '../application/context.js';
import type { AttemptedInteraction, ExploreRecord, ScanRecord, SkippedRecord, StateRecord } from '../application/records.js';
import { openSession, relativizeCapture } from '../application/scan.js';
import { redactUrl } from '../browser/redact.js';
import type { BrowserSession, CapturedState, PageSnapshot, UiAction } from '../browser/types.js';
import type { BudgetTracker } from '../domain/budget.js';
import { isoNow } from '../domain/clock.js';
import { stableStringify } from '../domain/digest.js';
import { describeError, toError, uidnaError } from '../domain/errors.js';
import { stateId as makeStateId, transitionId as makeTransitionId } from '../domain/ids.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import {
  classifyInteractions,
  DEFAULT_DENY_NAMES,
  isDisclosureTrigger,
  isSideEffect,
  pageLevelActions,
  type InteractionCandidate,
  type PageLevelAction,
} from '../domain/safe-policy.js';

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

/** Maximum changed node ids listed per transition; the remainder is reported as a limitation. */
export const MAX_CHANGED_NODE_IDS = 500;

/** Stability wait after an action, as the policy prescribes. */
const PROBE_STABILITY = { timeoutMs: 3000 } as const;
/** Stability wait after a revert step (the DOM must only settle). */
const REVERT_STABILITY = { timeoutMs: 1500, quietMs: 100 } as const;
/** Longest accessible name quoted in messages. */
const MAX_QUOTED_NAME = 60;

type Kind = 'click' | 'hover' | 'focus' | 'key';

/** One interaction to perform: an element candidate or a page-level key press. */
interface Planned {
  readonly kind: Kind;
  readonly node: UiNode | null;
  readonly key?: string;
  /** Plain-words description used in messages, e.g. `click on button "Open menu"`. */
  readonly describe: string;
}

/** The base state the explorer compares every probe against. */
interface Reference {
  readonly stateId: string;
  readonly url: string;
  readonly viewport: { readonly width: number; readonly height: number };
  capture: CapturedState;
  domDigest: string;
  roleTreeDigest: string;
  screenshotDigest: string | null;
}

/** Mutable state of one run. */
interface Run {
  readonly ctx: WorkflowContext;
  readonly session: BrowserSession;
  readonly scan: ScanRecord;
  readonly budget: BudgetTracker;
  readonly evidenceId: string;
  readonly denyNames: readonly string[];
  readonly tmpDir: string;
  readonly assetDir: string;
  readonly captures: Map<string, CapturedState>;
  readonly transitions: Transition[];
  readonly attempted: AttemptedInteraction[];
  readonly skipped: SkippedRecord[];
  readonly limitations: string[];
  readonly unknowns: string[];
  readonly newStateIds: string[];
  /** Node paths whose action caused a non-GET request; never acted on again. */
  readonly sideEffectPaths: Set<string>;
  /** Derived state id by `<base>|<dom>|<roleTree>|<screenshot>` digests, for deduplication. */
  readonly derivedByDigests: Map<string, string>;
  readonly progress: { current: number; total: number };
  discovered: number;
  partial: boolean;
  pageConsumed: boolean;
  /** Set when the browser can no longer be driven; ends the run. */
  aborted: string | null;
}

interface Stop {
  readonly reason: 'budget exhausted' | 'cancelled' | 'browser failure';
  readonly detail: string;
}

/* -------------------------------------------------------------- helpers */

function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/** Clip page text quoted in messages; the ellipsis marks the cut. */
function clip(text: string): string {
  return text.length > MAX_QUOTED_NAME ? `${text.slice(0, MAX_QUOTED_NAME)}…` : text;
}

function quote(name: string | null): string {
  if (name === null) return '(unnamed)';
  return `"${clip(name)}"`;
}

/** Record what a temporary capture (never stored) could not do, so the information is not lost with the file. */
function noteCaptureLimitations(run: Run, label: string, capture: CapturedState): void {
  for (const limitation of capture.limitations) run.limitations.push(`${label}: ${limitation}`);
}

function describeNode(node: UiNode): string {
  return `${node.role ?? `<${node.tag}>`} ${quote(node.name)}`;
}

function targetOf(node: UiNode): ActionTarget {
  return { nodeId: node.id, nodePath: node.path, role: node.role, name: node.name, tag: node.tag, nth: node.a11y.nth ?? 0 };
}

function actionOf(planned: Planned): Action {
  return {
    type: planned.kind,
    target: planned.node === null ? null : targetOf(planned.node),
    ...(planned.key === undefined ? {} : { key: planned.key }),
  };
}

function toUiAction(planned: Planned): UiAction {
  if (planned.kind === 'key') return { kind: 'key', key: planned.key ?? '' };
  const node = planned.node;
  const target = node === null ? {} : { nodeId: node.id, nodePath: node.path };
  return { kind: planned.kind, target };
}

function planCandidate(candidate: InteractionCandidate): Planned {
  return { kind: candidate.kind, node: candidate.node, describe: `${candidate.kind} on ${describeNode(candidate.node)}` };
}

function planPageLevel(action: PageLevelAction): Planned {
  return { kind: 'key', node: null, key: action.key, describe: `key ${action.key}` };
}

function bodyOf(capture: CapturedState | undefined): Pick<UiNode, 'id' | 'path' | 'role' | 'name' | 'tag'> {
  const body = capture?.nodes.find((node) => node.path === '') ?? capture?.nodes[0];
  return body ?? { id: 'body', path: '', role: null, name: null, tag: 'body' };
}

function skippedRecord(stateId: string, planned: Planned, fallbackBody: Pick<UiNode, 'id' | 'path' | 'role' | 'name' | 'tag'>, reason: string): SkippedRecord {
  const node = planned.node ?? fallbackBody;
  const label = planned.kind === 'key' ? `key ${planned.key ?? ''}` : planned.kind;
  return { stateId, nodeId: node.id, nodePath: node.path, role: node.role, name: node.name, tag: node.tag, reason: `${label}: ${reason}` };
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

function sameAsReference(snapshot: PageSnapshot, ref: Reference): boolean {
  return snapshot.domDigest === ref.domDigest && snapshot.roleTreeDigest === ref.roleTreeDigest;
}

function stopReason(run: Run): Stop | null {
  if (run.ctx.signal?.aborted === true) return { reason: 'cancelled', detail: 'operation cancelled by caller' };
  const hit = run.budget.check();
  if (hit !== null) return hit._tag === 'cancelled' ? { reason: 'cancelled', detail: hit.message } : { reason: 'budget exhausted', detail: hit.message };
  if (run.budget.wouldExceed('actions')) {
    return { reason: 'budget exhausted', detail: `actions used ${run.budget.usage().actions} of ${run.budget.limits.actions ?? 0}` };
  }
  return null;
}

function plansFor(capture: CapturedState, denyNames: readonly string[]): { planned: Planned[]; skipped: ReturnType<typeof classifyInteractions>['skipped'] } {
  const classified = classifyInteractions(capture, { denyNames });
  return { planned: [...classified.candidates.map(planCandidate), ...pageLevelActions().map(planPageLevel)], skipped: classified.skipped };
}

function report(run: Run, message: string): void {
  run.ctx.progress.report({ message, current: run.progress.current, total: run.progress.total });
}

/* --------------------------------------------------------- base states */

/** Load a base state in the session and build the reference the probes are compared against. */
async function loadBase(run: Run, base: StateRecord, stored: CapturedState): Promise<Result<Reference>> {
  const { session, budget, scan } = run;
  report(run, `loading base state ${base.stateId} at ${base.viewport.width}×${base.viewport.height}`);
  const resized = await session.setViewport(base.viewport);
  if (!resized.ok) return resized;
  const navigated = await session.navigate(scan.target.url, { waitUntil: 'load', timeoutMs: Math.min(30_000, Math.max(5_000, budget.remainingMs())) });
  if (!navigated.ok) return navigated;
  if (!run.pageConsumed) {
    budget.consumePage();
    run.pageConsumed = true;
  }
  const settled = await settle(run, base.stateId);
  if (!settled.ok) return settled;
  // The reference is the first capture of the fresh document, exactly as the scan's base capture was
  // (a later capture of the same document reports retained layout for content Chromium skips).
  const fresh = await session.capture({ screenshotPath: join(run.tmpDir, `base-${base.stateId}.png`), maxHeight: 4000 });
  if (!fresh.ok) return fresh;
  noteCaptureLimitations(run, `base state ${base.stateId} (fresh reference capture)`, fresh.value);
  const domChanged = fresh.value.domDigest !== stored.domDigest;
  if (domChanged) run.limitations.push(`base state ${base.stateId} differs from the scan capture (dom digest changed); exploring the fresh page`);
  const screenshotDigest = fresh.value.screenshot?.digest ?? null;
  if (!domChanged && stored.screenshot !== null && screenshotDigest !== null && stored.screenshot.digest !== screenshotDigest) {
    run.limitations.push(`base state ${base.stateId} renders differently from the scan screenshot (screenshot digest changed); probes are compared against the fresh screenshot`);
  }
  const ref: Reference = {
    stateId: base.stateId,
    url: scan.target.url,
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

/** Freeze animations and wait for the page to be quiet after a load. */
async function settle(run: Run, stateId: string): Promise<Result<void>> {
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
async function freshLoad(run: Run, ref: Reference): Promise<Result<PageSnapshot>> {
  const navigated = await run.session.navigate(ref.url, { waitUntil: 'load', timeoutMs: Math.min(30_000, Math.max(5_000, run.budget.remainingMs())) });
  if (!navigated.ok) return navigated;
  const settled = await settle(run, ref.stateId);
  if (!settled.ok) run.limitations.push(`base state ${ref.stateId}: stability wait failed after a fresh load (${describeError(settled.error)})`);
  return run.session.snapshot();
}

/** Replace the reference with a first capture of the current (freshly loaded) document. */
async function recaptureReference(run: Run, ref: Reference, planned: Planned, fallback: PageSnapshot): Promise<void> {
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
async function ensureBase(run: Run, ref: Reference, planned: Planned, snapshot: PageSnapshot | null): Promise<boolean> {
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
async function resetDocument(run: Run, ref: Reference, planned: Planned): Promise<void> {
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

/* ------------------------------------------------------------- actions */

/** Perform a cheap action and ignore its outcome (pointer reset, blur): nothing to observe. */
async function quietly(run: Run, action: UiAction): Promise<void> {
  const result = await run.session.act(action);
  if (!result.ok) run.limitations.push(`${action.kind} failed during revert (${describeError(result.error)})`);
}

interface RevertOutcome {
  readonly method: Transition['revert']['method'];
  readonly succeeded: boolean;
  readonly snapshot: PageSnapshot | null;
}

/** Compare the page with the reference by its digests once the DOM has settled. */
async function compareBySnapshot(run: Run, ref: Reference, method: RevertOutcome['method']): Promise<RevertOutcome> {
  await run.session.waitForStability(REVERT_STABILITY);
  const snapshot = await run.session.snapshot();
  if (!snapshot.ok) return { method, succeeded: false, snapshot: null };
  return { method, succeeded: sameAsReference(snapshot.value, ref), snapshot: snapshot.value };
}

/**
 * Load the base URL afresh as a revert; used after side effects and when
 * nothing else restores the base. A navigation, never `reload()`: reloading
 * a document that a POST produced would repeat the side effect.
 */
async function reloadRevert(run: Run, ref: Reference): Promise<RevertOutcome> {
  const reloaded = await freshLoad(run, ref);
  if (!reloaded.ok) {
    run.limitations.push(`fresh load failed during revert (${describeError(reloaded.error)})`);
    return { method: 'reload', succeeded: false, snapshot: null };
  }
  return { method: 'reload', succeeded: sameAsReference(reloaded.value, ref), snapshot: reloaded.value };
}

/** Fall back to a fresh load when the cheap revert did not restore the base, so the recorded method is the one that worked. */
async function orReload(run: Run, ref: Reference, after: RevertOutcome): Promise<RevertOutcome> {
  if (after.succeeded) return after;
  const reloaded = await reloadRevert(run, ref);
  await quietly(run, { kind: 'reset-pointer' });
  return reloaded;
}

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
 * `succeeded` is the digest comparison right after that method.
 */
async function revertChanged(run: Run, ref: Reference, planned: Planned, derived: { stateId: string; capture: CapturedState } | null, sideEffect: boolean): Promise<RevertOutcome> {
  if (sideEffect) {
    const outcome = await reloadRevert(run, ref);
    await quietly(run, { kind: 'reset-pointer' });
    return outcome;
  }
  const finish = (method: RevertOutcome['method']): Promise<RevertOutcome> => compareBySnapshot(run, ref, method);
  switch (planned.kind) {
    case 'hover':
      await quietly(run, { kind: 'reset-pointer' });
      return orReload(run, ref, await finish('none'));
    case 'focus':
      await quietly(run, { kind: 'blur' });
      return orReload(run, ref, await finish('none'));
    case 'key':
      await quietly(run, { kind: 'key', key: 'Escape' });
      await quietly(run, { kind: 'reset-pointer' });
      await quietly(run, { kind: 'blur' });
      return orReload(run, ref, await finish('escape'));
    case 'click': {
      const node = planned.node;
      if (node === null) return orReload(run, ref, await finish('none'));
      if (isDisclosureTrigger(node) || node.role === 'tab') {
        const marker = run.session.markNetwork();
        await quietly(run, { kind: 'key', key: 'Escape' });
        const after = await finish('escape');
        if (after.succeeded) {
          if (derived !== null) recordEscapeTransition(run, ref, node, derived, isSideEffect(run.session.networkSince(marker)));
          await quietly(run, { kind: 'reset-pointer' });
          await quietly(run, { kind: 'blur' });
          return after;
        }
      }
      const toggleMarker = run.session.markNetwork();
      const toggled = await run.session.act({ kind: 'click', target: { nodeId: node.id, nodePath: node.path } });
      const toggleNetwork = isSideEffect(run.session.networkSince(toggleMarker));
      if (toggleNetwork.nonGet > 0) {
        // The second click did what the first did not: it is a side effect, so this element is never acted on again.
        run.sideEffectPaths.add(node.path);
        run.limitations.push(`reverting ${planned.describe} with a second click caused ${toggleNetwork.nonGet} non-GET request(s); the element will not be acted on again`);
      }
      if (toggled.ok && toggled.value.performed && !toggled.value.navigated && toggleNetwork.nonGet === 0) {
        const after = await finish('toggle');
        if (after.succeeded) {
          await quietly(run, { kind: 'reset-pointer' });
          await quietly(run, { kind: 'blur' });
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

/** After a probe: verify the base state, then reload unless the page was just reloaded anyway. */
async function finishProbed(run: Run, ref: Reference, planned: Planned, snapshot: PageSnapshot | null, revertMethod: RevertOutcome['method'] | null): Promise<void> {
  const reloaded = await ensureBase(run, ref, planned, snapshot);
  if (reloaded || revertMethod === 'reload' || run.aborted !== null) return;
  await resetDocument(run, ref, planned);
}

/** Undo the incidental effects of an action that changed nothing (pointer position, focus). */
async function revertUnchanged(run: Run, planned: Planned): Promise<void> {
  if (planned.kind === 'hover' || planned.kind === 'click') await quietly(run, { kind: 'reset-pointer' });
  if (planned.kind !== 'hover') await quietly(run, { kind: 'blur' });
}

/** Store the probe as a derived state, or reuse an identical one of the same base. */
async function storeDerived(run: Run, ref: Reference, probe: CapturedState, probePath: string, viaTransitionId: string): Promise<Result<{ stateId: string; capture: CapturedState; reused: boolean }>> {
  const { ctx, scan } = run;
  const key = [ref.stateId, probe.domDigest, probe.roleTreeDigest, probe.screenshot?.digest ?? ''].join('|');
  const existing = run.derivedByDigests.get(key);
  if (existing !== undefined) {
    const capture = run.captures.get(existing);
    if (capture !== undefined) {
      await rm(probePath, { force: true }).catch((cause: unknown) => run.limitations.push(`probe screenshot not removed (${describeError(cause)})`));
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
    kind: 'derived',
    parentStateId: ref.stateId,
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

/**
 * Perform one planned interaction, record what happened and bring the page
 * back to the reference. Returns the reason the run must end, or null.
 */
async function runAction(run: Run, ref: Reference, planned: Planned): Promise<string | null> {
  await performAction(run, ref, planned);
  return run.aborted;
}

async function performAction(run: Run, ref: Reference, planned: Planned): Promise<void> {
  const { session, budget } = run;
  run.progress.current += 1;
  report(run, `${planned.describe} (${ref.stateId})`);
  const stateId = ref.stateId;
  const now = (): number => run.ctx.clock.now().getTime();
  const attempt = (outcome: AttemptedInteraction['outcome'], transitionId: string | null, reason: string | null, started: number): void => {
    run.attempted.push({ stateId, action: actionOf(planned), outcome, transitionId, reason, durationMs: Math.max(0, Math.round(now() - started)) });
  };

  if (planned.node !== null && run.sideEffectPaths.has(planned.node.path)) {
    run.skipped.push(skippedRecord(stateId, planned, bodyOf(ref.capture), 'side effect observed earlier'));
    return;
  }

  const marker = session.markNetwork();
  const started = now();
  const acted = await session.act(toUiAction(planned));
  budget.consumeAction();
  if (!acted.ok) {
    attempt('failed', null, describeError(acted.error), started);
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
    attempt('failed', null, outcome.reason ?? 'action not performed', started);
    await revertUnchanged(run, planned);
    await ensureBase(run, ref, planned, null);
    return;
  }
  const stable = await session.waitForStability(PROBE_STABILITY);
  if (!stable.ok) run.limitations.push(`${planned.describe}: stability wait failed (${describeError(stable.error)})`);
  const network = isSideEffect(session.networkSince(marker));
  // A navigation counts as a side effect like a non-GET request (schema: `sideEffects`); neither is ever repeated.
  const sideEffect = network.nonGet > 0 || outcome.navigated;
  if (sideEffect && planned.node !== null) run.sideEffectPaths.add(planned.node.path);

  if (outcome.navigated && stripHash(outcome.url) !== stripHash(ref.url)) {
    const destination = redactUrl(outcome.url);
    attempt('navigated', null, `navigated to ${destination}`, started);
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
    attempt('failed', null, `probe capture failed: ${describeError(probed.error)}`, started);
    await revertUnchanged(run, planned);
    await finishProbed(run, ref, planned, null, null);
    return;
  }
  const probe = probed.value;
  const domChanged = probe.domDigest !== ref.domDigest;
  const roleTreeChanged = probe.roleTreeDigest !== ref.roleTreeDigest;
  const screenshotChanged = (probe.screenshot?.digest ?? null) !== ref.screenshotDigest;

  if (!domChanged && !roleTreeChanged && !screenshotChanged && !sideEffect) {
    attempt('unchanged', null, null, started);
    await rm(probePath, { force: true }).catch((cause: unknown) => run.limitations.push(`probe screenshot not removed (${describeError(cause)})`));
    await revertUnchanged(run, planned);
    await finishProbed(run, ref, planned, null, null);
    return;
  }

  const transitionId = makeTransitionId(run.transitions.length + 1);
  const stored = await storeDerived(run, ref, probe, probePath, transitionId);
  if (!stored.ok) {
    attempt('failed', null, `derived state not stored: ${describeError(stored.error)}`, started);
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
  attempt(sideEffect ? 'side-effect' : 'changed', transitionId, stored.value.reused ? `same as state ${stored.value.stateId}` : null, started);

  const reverted = await revertChanged(run, ref, planned, { stateId: stored.value.stateId, capture: stored.value.capture }, sideEffect);
  transition.revert = { method: reverted.method, succeeded: reverted.succeeded };
  await finishProbed(run, ref, planned, reverted.snapshot, reverted.method);
}

/* ---------------------------------------------------------------- main */

function sumUsage(a: ScanRecord['budget']['used'], b: ScanRecord['budget']['used']): ScanRecord['budget']['used'] {
  return { timeMs: a.timeMs + b.timeMs, pages: a.pages + b.pages, actions: a.actions + b.actions, resources: a.resources + b.resources };
}

/** Explore the safe interactions of every base state of a scan. See the module comment. */
export async function exploreInteractions(input: ExploreInput): Promise<Result<ExploreOutcome>> {
  const { ctx, budget, evidenceId } = input;
  if (evidenceId.length === 0) return err(uidnaError('validation', 'evidenceId must not be empty'));
  const widths = input.viewportWidths;
  const bases = input.scan.states.filter((state) => state.kind === 'base' && (widths === undefined || widths.includes(state.viewport.width)));
  const first = bases[0];
  if (first === undefined) {
    return err(uidnaError('validation', widths === undefined ? `scan ${input.scan.scanId} has no base state to explore` : `scan ${input.scan.scanId} has no base state at viewport width(s) ${widths.join(', ')}`));
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

  // Progress total from the stored captures; adjusted when a fresh capture yields other candidates.
  let total = 0;
  for (const base of bases) {
    const stored = input.captures.get(base.stateId);
    if (stored) total += plansFor(stored, denyNames).planned.length;
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
    denyNames,
    tmpDir: paths.value.tmpDir,
    assetDir: paths.value.assetDir,
    captures: new Map(input.captures),
    transitions: [],
    attempted: [],
    skipped: [],
    limitations: [],
    unknowns: [],
    newStateIds: [],
    sideEffectPaths: new Set(),
    derivedByDigests: new Map(),
    progress: { current: 0, total },
    discovered: 0,
    partial: false,
    pageConsumed: false,
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
  const savedScan = await ctx.store.saveScan(scan);
  if (!savedScan.ok) return savedScan;

  const record: ExploreRecord = {
    scanId: scan.scanId,
    policy: 'safe',
    startedAt,
    finishedAt,
    evidenceId,
    budget: { limits: { ...budget.limits }, used },
    coverage: { discovered: run.discovered, explored: run.attempted.length, changed: run.newStateIds.length, skipped: run.skipped.length },
    attempted: run.attempted,
    skipped: run.skipped,
    transitionIds: run.transitions.map((t) => t.id),
    newStateIds: [...run.newStateIds],
    limitations: run.limitations,
    unknowns: run.unknowns,
    partial: run.partial,
  };
  const savedExplore = await ctx.store.saveExplore(scan.scanId, record);
  if (!savedExplore.ok) return savedExplore;
  return ok({ scan, record, transitions: run.transitions, captures: run.captures, newStateIds: [...run.newStateIds] });
}

/** Interaction kinds in the order they are explored: state-changing clicks first, so a tight budget covers them at every viewport. */
const ROUNDS: readonly Kind[] = ['click', 'key', 'hover', 'focus'];

interface ScheduleEntry {
  readonly base: StateRecord;
  readonly kind: Kind;
}

/**
 * Explore the base states in rounds (every base state's clicks, then page keys, hovers and
 * focus), stopping and listing the rest as skipped when the budget ends or the browser fails.
 */
async function exploreBases(run: Run, bases: readonly StateRecord[], stored: ReadonlyMap<string, CapturedState>): Promise<void> {
  const schedule: ScheduleEntry[] = ROUNDS.flatMap((kind) => bases.map((base) => ({ base, kind })));
  const counted = new Set<string>();
  const failed = new Set<string>();
  for (const [position, entry] of schedule.entries()) {
    const storedCapture = stored.get(entry.base.stateId);
    if (storedCapture === undefined || failed.has(entry.base.stateId)) continue;
    const stop = stopReason(run);
    if (stop !== null) {
      markRemaining(run, schedule.slice(position), stored, [], stop, failed);
      return;
    }
    const loaded = await loadBase(run, entry.base, storedCapture);
    if (!loaded.ok) {
      run.partial = true;
      run.limitations.push(`base state ${entry.base.stateId} not explored: ${describeError(loaded.error)}`);
      failed.add(entry.base.stateId);
      const laterKinds = new Set(ROUNDS.slice(ROUNDS.indexOf(entry.kind)));
      for (const planned of plansFor(storedCapture, run.denyNames).planned.filter((p) => laterKinds.has(p.kind))) {
        run.skipped.push(skippedRecord(entry.base.stateId, planned, bodyOf(storedCapture), 'base state could not be loaded'));
      }
      if (run.aborted !== null) {
        // The browser can no longer be driven: later entries would fail for the same reason, misattributed to themselves.
        run.limitations.push(`run ended early: ${run.aborted}`);
        markRemaining(run, schedule.slice(position + 1), stored, [], { reason: 'browser failure', detail: run.aborted }, failed);
        return;
      }
      continue;
    }
    const ref = loaded.value;
    const all = plansFor(ref.capture, run.denyNames);
    if (!counted.has(entry.base.stateId)) {
      counted.add(entry.base.stateId);
      run.progress.total += all.planned.length - plansFor(storedCapture, run.denyNames).planned.length;
      run.discovered += ref.capture.nodes.filter((node) => node.interactive && node.visible).length;
      for (const skipped of all.skipped) {
        run.skipped.push({ stateId: ref.stateId, nodeId: skipped.node.id, nodePath: skipped.node.path, role: skipped.node.role, name: skipped.node.name, tag: skipped.node.tag, reason: skipped.reason });
      }
    }
    const plans = all.planned.filter((p) => p.kind === entry.kind);
    for (const [index, planned] of plans.entries()) {
      const stopNow = stopReason(run);
      if (stopNow !== null) {
        markRemaining(run, schedule.slice(position + 1), stored, plans.slice(index).map((p) => ({ stateId: ref.stateId, planned: p, body: bodyOf(ref.capture) })), stopNow, failed);
        return;
      }
      const aborted = await runAction(run, ref, planned);
      if (aborted !== null) {
        run.partial = true;
        run.limitations.push(`run ended early: ${aborted}`);
        markRemaining(
          run,
          schedule.slice(position + 1),
          stored,
          plans.slice(index + 1).map((p) => ({ stateId: ref.stateId, planned: p, body: bodyOf(ref.capture) })),
          { reason: 'browser failure', detail: aborted },
          failed,
        );
        return;
      }
    }
  }
}

/** List every interaction that will not run as skipped with the stop reason, and mark the run partial. */
function markRemaining(
  run: Run,
  entries: readonly ScheduleEntry[],
  stored: ReadonlyMap<string, CapturedState>,
  current: readonly { stateId: string; planned: Planned; body: Pick<UiNode, 'id' | 'path' | 'role' | 'name' | 'tag'> }[],
  stop: Stop,
  failed: ReadonlySet<string>,
): void {
  run.partial = true;
  const reason = `${stop.reason} (${stop.detail})`;
  if (!run.limitations.includes(`exploration stopped: ${reason}`)) run.limitations.push(`exploration stopped: ${reason}`);
  for (const entry of current) run.skipped.push(skippedRecord(entry.stateId, entry.planned, entry.body, reason));
  for (const entry of entries) {
    const capture = stored.get(entry.base.stateId);
    if (capture === undefined || failed.has(entry.base.stateId)) continue;
    for (const planned of plansFor(capture, run.denyNames).planned.filter((p) => p.kind === entry.kind)) {
      run.skipped.push(skippedRecord(entry.base.stateId, planned, bodyOf(capture), reason));
    }
  }
}
