/**
 * Per-page exploration and navigation transitions against the real
 * instrument: Fixture D (three linked pages) crawled by the real
 * `scan_interface` workflow, then explored with the safe policy. Every base
 * state is explored on its own page; links to crawled pages become
 * navigation transitions to that page's base state; the tabs and the
 * billing toggle are ordinary transitions on their own pages; coverage is
 * reported per page and lands on the pages of the re-assembled document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type Transition, type UiDnaDocument } from '@rohzzn/uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord, StateRecord } from '../application/records.js';
import { reassembleDna, scanInterface } from '../application/scan.js';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/index.js';
import { FIXTURE_D_DIR } from '../browser/test-helpers.js';
import type { CapturedState } from '../browser/types.js';
import { BudgetTracker, resolveBudget, type ProgressEvent } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { tempDir } from '../../tests/helpers.js';
import { exploreInteractions, type ExploreOutcome } from './explorer.js';

const RUN_TIMEOUT = 420_000;

let server: StaticServer;
let ctx: WorkflowContext;
let scan: ScanRecord;
let captures: Map<string, CapturedState>;
let outcome: ExploreOutcome;
let home: StateRecord;
let features: StateRecord;
let pricing: StateRecord;
let pageByPath: Map<string, string>;
const progress: ProgressEvent[] = [];

function navigations(from: StateRecord): Transition[] {
  return outcome.transitions.filter((t) => t.from === from.stateId && t.navigation !== null && t.navigation !== undefined);
}

function baseOf(pageId: string): StateRecord {
  const state = scan.states.find((s) => s.kind === 'base' && s.pageId === pageId);
  if (!state) throw new Error(`no base state on ${pageId}`);
  return state;
}

beforeAll(async () => {
  server = unwrap(await serveStatic(FIXTURE_D_DIR, { fixtureApi: true }), 'serve fixture D');
  const outRoot = await tempDir('explore-navigation');
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: outRoot, outRoot, progress: { report: (event) => progress.push(event) } });
  const scanned = unwrap(await scanInterface(ctx, { url: server.url, viewports: [1280], crawl: { maxPages: 3 } }), 'scan');
  scan = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
  captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
  pageByPath = new Map((scan.pages ?? []).map((page) => [new URL(page.url).pathname, page.pageId]));
  home = baseOf(pageByPath.get('/') ?? '');
  features = baseOf(pageByPath.get('/features.html') ?? '');
  pricing = baseOf(pageByPath.get('/pricing.html') ?? '');
  const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId }, scanId: scan.scanId });
  // The workflow passes the scan's limits (a crawl of three pages has a page budget of three) with the caller's overrides.
  outcome = unwrap(await exploreInteractions({ ctx, scan, captures, budget: new BudgetTracker(resolveBudget({ ...scan.budget.limits, actions: 200 }), ctx.clock), evidenceId: evidence.id }), 'explore');
}, RUN_TIMEOUT);

afterAll(async () => {
  await server.close();
});

describe('exploreInteractions over a crawl of Fixture D (real Chromium, real scan)', () => {
  it('crawled three pages with one base state each', () => {
    expect(scan.pages?.map((p) => p.pageId)).toEqual(['pg_01', 'pg_02', 'pg_03']);
    expect([...pageByPath.keys()].sort()).toEqual(['/', '/features.html', '/pricing.html']);
    expect(home.pageId).toBe('pg_01');
    expect(scan.states.filter((s) => s.kind === 'base')).toHaveLength(3);
  });

  it('records navigation transitions from the home page to the features and pricing pages, ending at their base states', () => {
    const fromHome = navigations(home);
    const toFeatures = fromHome.filter((t) => t.navigation?.toPageId === features.pageId);
    const toPricing = fromHome.filter((t) => t.navigation?.toPageId === pricing.pageId);
    // Home links to features: nav "Features", "Explore features", footer "Features"; to pricing: nav, "See pricing", footer.
    expect(toFeatures.map((t) => t.action.target?.name)).toEqual(['Features', 'Explore features', 'Features']);
    expect(toPricing.map((t) => t.action.target?.name)).toEqual(['Pricing', 'See pricing', 'Pricing']);
    for (const t of fromHome) {
      expect(t.to, t.id).toBe(t.navigation?.toPageId === features.pageId ? features.stateId : pricing.stateId);
      expect(t.action.type, t.id).toBe('click');
      expect(t.action.target?.tag, t.id).toBe('a');
      expect(t.sideEffects, t.id).toBe(false);
      expect(t.network.nonGet, t.id).toBe(0);
      expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
      expect(t.change.domChanged, t.id).toBe(true);
      expect(t.change.roleTreeChanged, t.id).toBe(true);
      expect(t.change.changedNodeIds.length, t.id).toBeGreaterThan(0);
      expect(new URL(t.navigation?.url ?? '').pathname, t.id).toBe(t.navigation?.toPageId === features.pageId ? '/features.html' : '/pricing.html');
      expect(t.provenance, t.id).toMatchObject({ kind: 'observed', source: 'interaction', stateId: home.stateId, viewport: { width: 1280 }, evidenceId: outcome.record.evidenceId });
      const attempted = outcome.record.attempted.find((a) => a.transitionId === t.id);
      expect(attempted, t.id).toMatchObject({ stateId: home.stateId, outcome: 'navigated', action: { type: 'click' } });
    }
    // No derived state was stored for a navigation: every `to` is a base state.
    for (const t of outcome.transitions.filter((x) => x.navigation)) expect(scan.states.find((s) => s.stateId === t.to)?.kind, t.id).toBe('base');
    // Navigations are explored after clicks and before keys, hovers and focus.
    const order = outcome.record.attempted.filter((a) => a.stateId === home.stateId).map((a) => a.action.type);
    const firstNavigation = order.indexOf('click');
    expect(firstNavigation).toBeGreaterThanOrEqual(0);
    expect(order.slice(firstNavigation + 6)).not.toContain('click');
    expect(order.slice(0, firstNavigation)).toEqual([]);
  });

  it('skips links to the current page and to other origins with a reason, and never reports an unexplained navigation', () => {
    const homeSkipped = outcome.record.skipped.filter((s) => s.stateId === home.stateId && s.tag === 'a');
    expect(homeSkipped.filter((s) => s.reason === 'click: link navigates to the current page').map((s) => s.name)).toEqual(['Lumen', 'Home', 'Home']);
    expect(homeSkipped.filter((s) => s.reason === 'click: link navigates to another origin').map((s) => s.name)).toEqual(['Status page']);
    expect(homeSkipped.some((s) => s.reason === 'click: link navigates')).toBe(false);
    expect(outcome.record.unknowns).toEqual([]);
    expect(outcome.record.attempted.filter((a) => a.outcome === 'navigated' && a.transitionId === null)).toEqual([]);
    expect(outcome.record.attempted.filter((a) => a.outcome === 'failed')).toEqual([]);
    // Every page navigates to the others; the counts follow the fixture's links.
    expect(navigations(features).map((t) => t.navigation?.toPageId)).toEqual([home.pageId, home.pageId, pricing.pageId, pricing.pageId, home.pageId, pricing.pageId]);
    expect(navigations(pricing).filter((t) => t.navigation?.toPageId === home.pageId)).toHaveLength(5);
    expect(navigations(pricing).filter((t) => t.navigation?.toPageId === features.pageId)).toHaveLength(3);
  });

  it('records the tab clicks on the features page and the billing toggle on the pricing page as ordinary transitions on their own pages', () => {
    const tabs = outcome.transitions.filter((t) => t.from === features.stateId && t.action.type === 'click' && t.action.target?.role === 'tab');
    // The fixture focuses the clicked tab and writes its tabindex, so even the selected "Write" tab changes the page; the others switch panels.
    expect(tabs.map((t) => t.action.target?.name)).toEqual(['Write', 'Link', 'Review']);
    expect(tabs.every((t) => t.change.domChanged)).toBe(true);
    for (const t of tabs) {
      const derived = outcome.scan.states.find((s) => s.stateId === t.to);
      expect(derived, t.id).toMatchObject({ kind: 'derived', pageId: features.pageId, parentStateId: features.stateId, viaTransitionId: t.id });
      const capture = outcome.captures.get(t.to);
      const tab = capture?.nodes.find((n) => n.id === t.action.target?.nodeId);
      expect(tab?.attrs['aria-selected'], t.id).toBe('true');
      expect(t.navigation ?? null, t.id).toBeNull();
      expect(t.revert.succeeded, t.id).toBe(true);
    }
    const billing = outcome.transitions.find((t) => t.from === pricing.stateId && t.action.type === 'click' && t.action.target?.name?.startsWith('Yearly billing'));
    expect(billing).toBeDefined();
    if (!billing) return;
    expect(outcome.scan.states.find((s) => s.stateId === billing.to)).toMatchObject({ kind: 'derived', pageId: pricing.pageId, parentStateId: pricing.stateId });
    const toggled = outcome.captures.get(billing.to)?.nodes.find((n) => n.id === billing.action.target?.nodeId);
    expect(toggled?.attrs['aria-pressed']).toBe('true');
    expect(toggled?.name).toBe('Monthly billing');
    expect(billing.revert).toEqual({ method: 'toggle', succeeded: true });
    // Every derived state belongs to the page of its parent.
    for (const state of outcome.scan.states.filter((s) => s.kind === 'derived')) {
      const parent = outcome.scan.states.find((s) => s.stateId === state.parentStateId);
      expect(state.pageId, state.stateId).toBe(parent?.pageId);
    }
  });

  it('reports coverage per page that adds up to the totals, and per-page progress', () => {
    const byPage = outcome.record.coverageByPage;
    expect(byPage).toBeDefined();
    expect(Object.keys(byPage ?? {})).toEqual(['pg_01', 'pg_02', 'pg_03']);
    const sum = (field: 'discovered' | 'explored' | 'changed' | 'skipped'): number => Object.values(byPage ?? {}).reduce((total, page) => total + page[field], 0);
    expect(sum('discovered')).toBe(outcome.record.coverage.discovered);
    expect(sum('explored')).toBe(outcome.record.coverage.explored);
    expect(sum('changed')).toBe(outcome.record.coverage.changed);
    expect(sum('skipped')).toBe(outcome.record.coverage.skipped);
    for (const page of Object.values(byPage ?? {})) {
      expect(page.discovered).toBeGreaterThan(0);
      expect(page.explored).toBeGreaterThan(0);
    }
    // 10 links on the home page, 9 links + 3 tabs on features, 11 links + 1 toggle on pricing.
    expect([byPage?.pg_01?.discovered, byPage?.pg_02?.discovered, byPage?.pg_03?.discovered]).toEqual([10, 12, 12]);
    expect(outcome.record.coverage.explored).toBe(outcome.record.attempted.length);
    expect(outcome.record.partial).toBe(false);
    expect(outcome.record.policy).toBe('safe');
    expect(outcome.scan.budget.used.pages).toBe(scan.budget.used.pages + 3);
    expect(progress.some((e) => e.message.startsWith('page pg_02: loading base state'))).toBe(true);
    expect(progress.some((e) => e.message.includes('Yearly billing') && e.message.includes('pg_03'))).toBe(true);
    expect(outcome.record.limitations.filter((l) => /could not restore|could not verify|cleanup_incomplete|ended early/.test(l))).toEqual([]);
  });

  it('re-assembles a valid document whose pages carry their coverage and whose navigation rules point at the links', async () => {
    unwrap(await reassembleDna(ctx, outcome.scan, outcome.transitions), 'reassemble');
    const dna: UiDnaDocument = unwrap(await ctx.store.loadDna(scan.scanId), 'load dna');
    expect(formatIssues(validateUiDna(dna))).toEqual([]);
    expect(dna.app.pages.map((p) => p.id)).toEqual(['pg_01', 'pg_02', 'pg_03']);
    for (const page of dna.app.pages) expect(page.coverage, page.id).toEqual(outcome.record.coverageByPage?.[page.id]);
    expect(dna.states.transitions.filter((t) => t.navigation).length).toBe(outcome.transitions.filter((t) => t.navigation).length);
    for (const state of dna.states.items) expect(state.pageId, state.id).toBe(outcome.scan.states.find((s) => s.stateId === state.id)?.pageId);
    const navigationRules = dna.behavior.filter((rule) => rule.effects.some((e) => e.kind === 'navigate'));
    expect(navigationRules.length).toBe(outcome.transitions.filter((t) => t.navigation).length);
    for (const rule of navigationRules) expect(rule.event.target.tag).toBe('a');
    expect(JSON.stringify(dna)).not.toContain('"inferred"');
  });
});

describe('page selection', () => {
  it('explores only the requested page and reports coverage for it alone', async () => {
    const pricingId = pricing.pageId ?? '';
    const saved = unwrap(await ctx.store.loadScan(scan.scanId), 'reload scan');
    const allCaptures = unwrap(await ctx.store.loadAllCaptures(saved.scanId, saved), 'reload captures');
    const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId, pages: [pricingId] }, scanId: scan.scanId });
    const budget = new BudgetTracker(resolveBudget({ actions: 3 }), ctx.clock);
    const limited = unwrap(await exploreInteractions({ ctx, scan: saved, captures: allCaptures, budget, evidenceId: evidence.id, pageIds: [pricingId] }), 'explore one page');
    expect(Object.keys(limited.record.coverageByPage ?? {})).toEqual([pricingId]);
    expect(limited.record.attempted).toHaveLength(3);
    expect(limited.record.attempted.every((a) => a.stateId === pricing.stateId)).toBe(true);
    expect(limited.record.attempted[0]).toMatchObject({ action: { type: 'click', target: { name: 'Yearly billing (save 20%)' } }, outcome: 'changed' });
    expect(limited.record.partial).toBe(true);
    expect(limited.record.skipped.every((s) => s.stateId === pricing.stateId)).toBe(true);
    expect(limited.scan.states.filter((s) => s.kind === 'derived' && !saved.states.some((known) => known.stateId === s.stateId)).every((s) => s.pageId === pricing.pageId)).toBe(true);
  }, 120_000);

  it('rejects an unknown page id without opening a browser', async () => {
    const result = await exploreInteractions({ ctx, scan, captures, budget: new BudgetTracker(), evidenceId: 'ev_000000000000', pageIds: ['pg_99'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe('validation');
      expect(result.error.message).toContain('pg_99');
    }
  });
});
