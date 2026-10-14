/**
 * The explorer against the real instrument: Fixture A served by the static
 * server, scanned by the real `scan_interface` workflow into a temp root
 * under tests/.tmp, then explored at 390 and 1280 with the safe policy.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type Transition, type UiDnaDocument } from '@rohzzn/uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord, StateRecord } from '../application/records.js';
import { reassembleDna, scanInterface } from '../application/scan.js';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/index.js';
import type { BrowserProvider, BrowserSession, CapturedState, UiNode } from '../browser/types.js';
import { BudgetTracker, resolveBudget, type ProgressEvent } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { FIXTURE_A, tempDir } from '../../tests/helpers.js';
import { exploreInteractions, MAX_CHANGED_NODE_IDS, type ExploreOutcome } from './explorer.js';

// Generous: with files in parallel, several Chromium suites share the machine.
const RUN_TIMEOUT = 240_000;

let server: StaticServer;
let ctx: WorkflowContext;
let outRoot: string;
let scanId: string;
let outcome: ExploreOutcome;
let budget: BudgetTracker;
let base1280: StateRecord;
let base390: StateRecord;
let baseCaptures: Map<string, CapturedState>;
const sessions: BrowserSession[] = [];
const progress: ProgressEvent[] = [];

/** The real provider, with every launched session recorded so the test can prove it was closed. */
function recordingProvider(): BrowserProvider {
  const real = createPlaywrightProvider();
  return {
    launch: async (options) => {
      const launched = await real.launch(options);
      if (launched.ok) sessions.push(launched.value);
      return launched;
    },
    attach: (options) => real.attach(options),
    probe: (endpoint) => real.probe(endpoint),
  };
}

function nodesWithClass(capture: CapturedState, cls: string): UiNode[] {
  return capture.nodes.filter((n) => (n.attrs.class ?? '').split(/\s+/).includes(cls));
}

function transitionsFrom(stateId: string, type: Transition['action']['type']): Transition[] {
  return outcome.transitions.filter((t) => t.from === stateId && t.action.type === type);
}

beforeAll(async () => {
  server = unwrap(await serveStatic(FIXTURE_A), 'serve fixture A');
  outRoot = await tempDir('explore-unit');
  ctx = createContext({ provider: recordingProvider(), toolVersion: '0.1.0', cwd: outRoot, outRoot, progress: { report: (event) => progress.push(event) } });
  const scanned = unwrap(await scanInterface(ctx, { url: server.url, viewports: [390, 1280] }), 'scan');
  scanId = scanned.result.scanId;
  const scan = unwrap(await ctx.store.loadScan(scanId), 'load scan');
  baseCaptures = unwrap(await ctx.store.loadAllCaptures(scanId, scan), 'load captures');
  base1280 = scan.states.find((s) => s.viewport.width === 1280)!;
  base390 = scan.states.find((s) => s.viewport.width === 390)!;
  budget = new BudgetTracker(resolveBudget({ actions: 120 }), ctx.clock);
  const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId }, scanId });
  outcome = unwrap(await exploreInteractions({ ctx, scan, captures: baseCaptures, budget, evidenceId: evidence.id }), 'explore');
}, RUN_TIMEOUT);

afterAll(async () => {
  for (const session of sessions) await session.close();
  await server.close();
});

describe('exploreInteractions on Fixture A (real Chromium, real scan)', () => {
  it('(a) clicks the hamburger at 390, records the open menu, and reverts with Escape as a transition back to the base', () => {
    const click = transitionsFrom(base390.stateId, 'click').find((t) => t.action.target?.name === 'Open menu');
    expect(click).toBeDefined();
    if (!click) return;
    expect(click.action.target).toMatchObject({ role: 'button', tag: 'button', nth: 0 });
    const derived = outcome.captures.get(click.to);
    expect(derived).toBeDefined();
    if (!derived) return;
    const button = derived.nodes.find((n) => n.id === click.action.target?.nodeId)!;
    expect(button.attrs['aria-expanded']).toBe('true');
    expect(button.name).toBe('Close menu');
    const menu = derived.nodes.find((n) => n.attrs.id === 'primary-menu')!;
    expect(menu.visible).toBe(true);
    expect(menu.box?.height).toBeGreaterThan(0);
    expect(click.change).toMatchObject({ domChanged: true, roleTreeChanged: true, screenshotChanged: true });
    expect(click.change.changedNodeIds).toEqual(expect.arrayContaining([button.id, menu.id]));
    expect(click.sideEffects).toBe(false);
    expect(click.network.nonGet).toBe(0);
    expect(click.revert).toEqual({ method: 'escape', succeeded: true });
    expect(click.provenance).toMatchObject({ kind: 'observed', source: 'interaction', stateId: base390.stateId, viewport: { width: 390, height: 844 }, evidenceId: outcome.record.evidenceId, confidence: 1 });

    const back = outcome.transitions.find((t) => t.from === click.to && t.to === base390.stateId && t.action.type === 'key' && t.action.key === 'Escape');
    expect(back).toBeDefined();
    if (!back) return;
    expect(back.action.target?.nodeId).toBe(click.action.target?.nodeId);
    expect(back.change.domChanged).toBe(true);
    expect(back.revert).toEqual({ method: 'none', succeeded: true });
    expect(back.provenance.stateId).toBe(click.to);

    const record = outcome.scan.states.find((s) => s.stateId === click.to)!;
    expect(record).toMatchObject({ kind: 'derived', parentStateId: base390.stateId, viaTransitionId: click.id, viewport: { width: 390, height: 844 } });
    const attempted = outcome.record.attempted.find((a) => a.transitionId === click.id)!;
    expect(attempted).toMatchObject({ stateId: base390.stateId, outcome: 'changed', action: { type: 'click' } });
  });

  it('(b) clicks a summary to a state whose details element is open, reverted by clicking again', () => {
    const summaries = outcome.transitions.filter((t) => t.action.type === 'click' && t.action.target?.tag === 'summary');
    expect(summaries.length).toBeGreaterThanOrEqual(3);
    const first = summaries[0]!;
    const derived = outcome.captures.get(first.to)!;
    const summary = derived.nodes.find((n) => n.id === first.action.target?.nodeId)!;
    expect(summary.tag).toBe('summary');
    expect(summary.a11y.expanded).toBe(true);
    const details = derived.nodes.find((n) => n.id === summary.parentId)!;
    expect(details.tag).toBe('details');
    expect(details.attrs.open).toBeDefined();
    const baseDetails = baseCaptures.get(first.from)!.nodes.find((n) => n.path === details.path)!;
    expect(baseDetails.attrs.open).toBeUndefined();
    expect(first.change.domChanged).toBe(true);
    // Escape does not close a <details>; clicking the summary again does.
    for (const t of summaries) expect(t.revert).toEqual({ method: 'toggle', succeeded: true });
    // Escape does not close a <details>, so no Escape transition leads back from this state.
    expect(outcome.transitions.some((t) => t.from === first.to && t.action.type === 'key')).toBe(false);
  });

  it('derived captures are faithful: hover and focus change exactly their target, closed panels stay hidden', () => {
    for (const t of outcome.transitions.filter((x) => x.action.type === 'hover' || x.action.type === 'focus')) {
      expect(t.change.changedNodeIds).toEqual([t.action.target?.nodeId]);
    }
    for (const t of outcome.transitions.filter((x) => x.from === base1280.stateId || x.from === base390.stateId)) {
      const derived = outcome.captures.get(t.to)!;
      const openPanels = nodesWithClass(derived, 'accordion-panel').filter((n) => n.visible);
      const opened = derived.nodes.find((n) => n.id === t.action.target?.nodeId);
      const expected = t.action.type === 'click' && opened?.tag === 'summary' ? 1 : 0;
      expect(openPanels.map((n) => n.parentId)).toEqual(expected === 1 ? [opened?.parentId] : []);
    }
  });

  it('(c) hovers a nav link at 1280 and records a screenshot-only change', () => {
    const navLinkIds = new Set(nodesWithClass(baseCaptures.get(base1280.stateId)!, 'nav-link').map((n) => n.id));
    expect(navLinkIds.size).toBe(4);
    const hovers = transitionsFrom(base1280.stateId, 'hover').filter((t) => t.action.target !== null && navLinkIds.has(t.action.target.nodeId));
    expect(hovers.length).toBeGreaterThanOrEqual(1);
    for (const hover of hovers) {
      expect(hover.change).toMatchObject({ domChanged: false, roleTreeChanged: false, screenshotChanged: true });
      expect(hover.change.changedNodeIds).toEqual([hover.action.target?.nodeId]);
      expect(hover.revert).toEqual({ method: 'none', succeeded: true });
      expect(hover.sideEffects).toBe(false);
      const derived = outcome.captures.get(hover.to)!;
      expect(derived.domDigest).toBe(baseCaptures.get(base1280.stateId)!.domDigest);
      expect(derived.screenshot?.digest).not.toBe(baseCaptures.get(base1280.stateId)!.screenshot?.digest);
    }
  });

  it('(d) never clicks links: nav and footer links are skipped with a link reason, hover and focus still run', () => {
    const base = baseCaptures.get(base1280.stateId)!;
    const links = [...nodesWithClass(base, 'nav-link'), ...nodesWithClass(base, 'footer-link')];
    expect(links).toHaveLength(7);
    for (const link of links) {
      const skipped = outcome.record.skipped.filter((s) => s.stateId === base1280.stateId && s.nodeId === link.id);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.reason).toContain('link');
      expect(skipped[0]!.reason.startsWith('click:')).toBe(true);
      const kinds = outcome.record.attempted.filter((a) => a.stateId === base1280.stateId && a.action.target?.nodeId === link.id).map((a) => a.action.type);
      expect(kinds.sort()).toEqual(['focus', 'hover']);
    }
    expect(outcome.transitions.some((t) => t.action.type === 'click' && t.action.target?.tag === 'a')).toBe(false);
    expect(outcome.record.attempted.some((a) => a.outcome === 'navigated')).toBe(false);
    expect(outcome.record.unknowns).toEqual([]);
  });

  it('(e) reports coverage that matches the lists it carries', () => {
    const { coverage } = outcome.record;
    expect(coverage.discovered).toBeGreaterThan(0);
    expect(coverage.explored).toBeLessThanOrEqual(coverage.discovered * 3 + 4);
    expect(coverage.explored).toBe(outcome.record.attempted.length);
    expect(coverage.explored).toBe(budget.usage().actions);
    const derivedStates = outcome.scan.states.filter((s) => s.kind === 'derived');
    expect(coverage.changed).toBe(derivedStates.length);
    expect(coverage.changed).toBe(outcome.newStateIds.length);
    expect(new Set(outcome.newStateIds).size).toBe(outcome.newStateIds.length);
    expect(coverage.skipped).toBe(outcome.record.skipped.length);
    // Discovered = visible interactive nodes of both base states (13 at 1280, 10 at 390 on Fixture A).
    const visibleInteractive = [base1280, base390].map((b) => baseCaptures.get(b.stateId)!.nodes.filter((n) => n.interactive && n.visible).length);
    expect(visibleInteractive).toEqual([13, 10]);
    expect(coverage.discovered).toBe(23);
    // Every action was performed: Fixture A has nothing the browser refuses.
    expect(outcome.record.attempted.filter((a) => a.outcome === 'failed')).toEqual([]);
    expect(outcome.record.attempted.every((a) => a.durationMs >= 0)).toBe(true);
    // Page-level keys ran once per base state.
    for (const base of [base1280, base390]) {
      const keys = outcome.record.attempted.filter((a) => a.stateId === base.stateId && a.action.type === 'key').map((a) => a.action.key);
      expect(keys).toEqual(['Escape', 'Tab']);
    }
    // Transitions are numbered sequentially and every derived state was produced by one of them.
    expect(outcome.transitions.map((t) => t.id)).toEqual(outcome.transitions.map((_, i) => `tr_${String(i + 1).padStart(2, '0')}`));
    expect(outcome.record.transitionIds).toEqual(outcome.transitions.map((t) => t.id));
    const transitionIds = new Set(outcome.transitions.map((t) => t.id));
    for (const state of derivedStates) expect(state.viaTransitionId !== null && transitionIds.has(state.viaTransitionId)).toBe(true);
    for (const t of outcome.transitions) expect(t.change.changedNodeIds.length).toBeLessThanOrEqual(MAX_CHANGED_NODE_IDS);
    expect(outcome.record.policy).toBe('safe');
    expect(outcome.record.partial).toBe(false);
    expect(outcome.record.budget.limits.actions).toBe(120);
    expect(outcome.record.budget.used.actions).toBe(coverage.explored);
    expect(progress.some((e) => e.message.includes('Open menu') && e.current !== undefined && e.total !== undefined)).toBe(true);
  });

  it('(f) restored the base states after every action, closed the browser and removed its temp files', async () => {
    expect(outcome.record.limitations.filter((l) => /could not restore|could not verify|cleanup_incomplete|ended early/.test(l))).toEqual([]);
    for (const t of outcome.transitions) expect(t.revert.succeeded).toBe(true);
    const explorer = sessions[sessions.length - 1]!;
    const afterClose = await explorer.snapshot();
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) expect(afterClose.error.message).toContain('closed');
    await expect(stat(join(ctx.store.scanDir(scanId), 'tmp'))).rejects.toThrow();
    // Stored artifacts are where the records say they are, with forward slashes.
    for (const state of outcome.scan.states) {
      expect(state.capturePath).toBe(`states/${state.stateId}/capture.json`);
      expect(state.screenshotPath).toBe(`states/${state.stateId}/screenshot.png`);
      const shot = await stat(ctx.store.resolvePath(scanId, state.screenshotPath!));
      expect(shot.size).toBeGreaterThan(0);
      const stored = unwrap(await ctx.store.loadCapture(scanId, state.stateId));
      expect(stored.screenshot?.path).toBe(state.screenshotPath);
      expect(stored.domDigest).toBe(state.domDigest);
    }
    const saved = unwrap(await ctx.store.loadScan(scanId));
    expect(saved.status).toBe('explored');
    expect(saved.states.map((s) => s.stateId)).toEqual(outcome.scan.states.map((s) => s.stateId));
    expect(saved.steps.explore).toMatchObject({ evidenceId: outcome.record.evidenceId, recordPath: 'explore.json' });
    expect(saved.budget.used.actions).toBe(budget.usage().actions);
    const explore = unwrap(await ctx.store.loadExplore(scanId));
    expect(explore).toEqual(outcome.record);
    // Identical derived states are stored once per base state.
    const keys = outcome.scan.states.filter((s) => s.kind === 'derived').map((s) => `${s.parentStateId}|${s.domDigest}|${s.roleTreeDigest}|${outcome.captures.get(s.stateId)?.screenshot?.digest ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('(g) re-assembles a valid dna.json whose behavior rules carry the aria-expanded toggle', async () => {
    const dnaPath = unwrap(await reassembleDna(ctx, outcome.scan, outcome.transitions), 'reassemble');
    expect(dnaPath.endsWith('dna.json')).toBe(true);
    const dna: UiDnaDocument = unwrap(await ctx.store.loadDna(scanId), 'load dna');
    expect(formatIssues(validateUiDna(dna))).toEqual([]);
    expect(dna.states.items.map((s) => s.id)).toEqual(outcome.scan.states.map((s) => s.stateId));
    expect(dna.states.transitions).toHaveLength(outcome.transitions.length);
    expect(dna.behavior).toHaveLength(outcome.transitions.length);
    const toggle = dna.behavior.find((rule) => rule.event.target.name === 'Open menu' && rule.effects.some((e) => e.kind === 'toggle-attribute' && e.attribute === 'aria-expanded'));
    expect(toggle).toBeDefined();
    expect(toggle?.effects).toContainEqual(expect.objectContaining({ kind: 'toggle-attribute', attribute: 'aria-expanded', from: 'false', to: 'true' }));
    expect(toggle?.provenance.kind).toBe('observed');
    expect(dna.behavior.every((rule) => rule.provenance.kind === 'observed')).toBe(true);
    expect(JSON.stringify(dna)).not.toContain('"inferred"');
  });
});

describe('exploreInteractions with a budget of two actions', () => {
  let limited: ExploreOutcome;
  let limitedBudget: BudgetTracker;
  let limitedScan: ScanRecord;

  beforeAll(async () => {
    const scanned = unwrap(await scanInterface(ctx, { url: server.url, viewports: [390] }), 'scan 390');
    limitedScan = unwrap(await ctx.store.loadScan(scanned.result.scanId));
    const captures = unwrap(await ctx.store.loadAllCaptures(limitedScan.scanId, limitedScan));
    limitedBudget = new BudgetTracker(resolveBudget({ actions: 2 }), ctx.clock);
    const evidence = await ctx.ledger.record({ kind: 'explore', inputs: {}, scanId: limitedScan.scanId });
    limited = unwrap(await exploreInteractions({ ctx, scan: limitedScan, captures, budget: limitedBudget, evidenceId: evidence.id, viewportWidths: [390] }), 'explore limited');
  }, 60_000);

  it('(h) performs exactly two actions, marks the run partial and lists the rest as budget-exhausted', async () => {
    expect(limited.record.attempted).toHaveLength(2);
    expect(limited.record.coverage.explored).toBe(2);
    expect(limitedBudget.usage().actions).toBe(2);
    expect(limited.record.partial).toBe(true);
    expect(limited.scan.status).toBe('partial');
    // The two actions are the highest-priority clicks: the hamburger, then the first summary.
    expect(limited.record.attempted.map((a) => [a.action.type, a.action.target?.name])).toEqual([
      ['click', 'Open menu'],
      ['click', 'Is there a free plan? +'],
    ]);
    const exhausted = limited.record.skipped.filter((s) => s.reason.includes('budget exhausted'));
    // 10 visible interactive nodes: 1 hamburger (3 kinds) + 3 summaries (3 kinds) + 6 links (hover, focus) = 24 candidates, plus Escape and Tab.
    expect(exhausted).toHaveLength(26 - 2);
    expect(exhausted.every((s) => s.stateId === limitedScan.states[0]?.stateId)).toBe(true);
    expect(exhausted.map((s) => s.reason.split(':')[0])).toEqual(expect.arrayContaining(['click', 'hover', 'focus', 'key Escape', 'key Tab']));
    expect(limited.record.limitations).toContainEqual(expect.stringContaining('budget exhausted'));
    expect(limited.transitions.length).toBeGreaterThanOrEqual(2);
    expect(limited.newStateIds.length).toBe(limited.record.coverage.changed);
    const saved = unwrap(await ctx.store.loadScan(limitedScan.scanId));
    expect(saved.status).toBe('partial');
  });

  it('rejects a viewport filter that matches no base state without opening a browser', async () => {
    const launches = sessions.length;
    const captures = unwrap(await ctx.store.loadAllCaptures(limitedScan.scanId, limitedScan));
    const result = await exploreInteractions({ ctx, scan: limitedScan, captures, budget: new BudgetTracker(), evidenceId: 'ev_000000000000', viewportWidths: [1280] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe('validation');
    expect(sessions.length).toBe(launches);
  });
});
