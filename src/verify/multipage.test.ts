/**
 * Multi-page verification against the real pipeline: Fixture D crawled by
 * `scan_interface` (three linked pages at 1280), a navigation transition
 * recorded by driving the original page (the Features link of the seed page,
 * followed with `allowNavigation: 'same-origin'`), the project generated with
 * react-router, installed and built, then verified page by page: every base
 * state loads at its crawled route, the navigation replays through the
 * generated link and reaches the Features route with the same role tree
 * change, the generated Playwright suite runs against the same static
 * server, and the HTML report groups the states per page.
 */
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transition, UiDnaDocument, UiState } from '@rohzzn/uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { openSession, reassembleDna, scanInterface } from '../application/scan.js';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/index.js';
import { FIXTURE_D_DIR } from '../browser/test-helpers.js';
import { DEFAULT_THRESHOLDS, DiffReportSchema, type DiffReport } from '../contracts/diff-report.js';
import { unwrap } from '../domain/result.js';
import { isSideEffect } from '../domain/safe-policy.js';
import { generateProject } from '../generate/index.js';
import { GeneratedTestRunSchema } from './generated-tests.js';
import { renderReport, verifyReconstruction } from './index.js';

const REPO_ROOT = process.cwd();
const SCANS = join(REPO_ROOT, 'tests', '.tmp', 'verify-multipage-scans');
const PROJECT = join(REPO_ROOT, 'tests', '.tmp', 'verify-multipage-project');

let fixture: StaticServer;
let ctx: WorkflowContext;
let scanId: string;
let scan: ScanRecord;
let dna: UiDnaDocument;
const reports: DiffReport[] = [];

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function tail(path: string | null, lines = 30): Promise<string> {
  if (path === null) return '(no log)';
  try {
    return (await readFile(path, 'utf8')).split('\n').slice(-lines).join('\n');
  } catch {
    return `(no log at ${path})`;
  }
}

/** Ids of `to` nodes whose path has no counterpart in `from` or whose attributes, text, box or visibility differ (what the explorer records). */
function changedNodeIds(from: UiState, to: UiState): string[] {
  const before = new Map(from.nodes.map((n) => [n.path, n] as const));
  return to.nodes
    .filter((n) => {
      const b = before.get(n.path);
      return b === undefined || JSON.stringify([b.tag, b.attrs, b.text, b.box, b.visible]) !== JSON.stringify([n.tag, n.attrs, n.text, n.box, n.visible]);
    })
    .map((n) => n.id);
}

function summarize(report: DiffReport): string {
  return JSON.stringify({
    summary: report.summary,
    visual: report.visual.map((v) => ({ stateId: v.stateId, diffRatio: v.pixels?.diffRatio ?? null, ssim: v.pixels?.ssim ?? null, geometry: v.geometry, styles: v.styles, findings: v.findings.length })),
    behavioral: report.behavioral.map((b) => ({ id: b.transitionId, replayed: b.replayed, reason: b.reason, roleTreeMatch: b.roleTreeMatch, diff: b.roleTreeDiff, diffRatio: b.pixels?.diffRatio ?? null, findings: b.findings.map((f) => f.message) })),
    limitations: report.limitations,
    unknowns: report.unknowns,
  });
}

beforeAll(async () => {
  await rm(SCANS, { recursive: true, force: true });
  await rm(join(PROJECT, 'dist'), { recursive: true, force: true });
  fixture = unwrap(await serveStatic(FIXTURE_D_DIR, { fixtureApi: true }), 'serve fixture D');
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: REPO_ROOT, outRoot: SCANS });
  const scanned = unwrap(await scanInterface(ctx, { url: fixture.url, viewports: [1280], crawl: { maxPages: 3 } }), 'scan');
  scanId = scanned.result.scanId;
  scan = unwrap(await ctx.store.loadScan(scanId), 'load scan');
  dna = unwrap(await ctx.store.loadDna(scanId), 'load dna');
  expect(dna.app.pages.map((p) => [p.id, new URL(p.url).pathname])).toEqual([
    ['pg_01', '/'],
    ['pg_02', '/features.html'],
    ['pg_03', '/pricing.html'],
  ]);
  const home = dna.states.items.find((s) => s.kind === 'base' && s.pageId === 'pg_01');
  const features = dna.states.items.find((s) => s.kind === 'base' && s.pageId === 'pg_02');
  if (home === undefined || features === undefined) throw new Error('base states of pg_01 and pg_02 missing');
  const link = home.nodes.find((n) => n.tag === 'a' && n.name === 'Features' && (n.attrs.class ?? '').split(/\s+/).includes('nav-link'));
  if (link === undefined) throw new Error('Features nav link not captured in the seed state');

  // Record the navigation by driving the original page: the click follows the same-origin link, and the
  // network counts come from the session, not from assumptions.
  const session = unwrap(await openSession(ctx, { url: fixture.url }, { ...home.viewport }), 'open session');
  let network: { nonGet: number; total: number };
  try {
    unwrap(await session.navigate(home.url), 'load home');
    const marker = session.markNetwork();
    const clicked = unwrap(await session.act({ kind: 'click', target: { nodePath: link.path }, allowNavigation: 'same-origin' }), 'click Features');
    expect(clicked.performed, clicked.reason ?? '').toBe(true);
    expect(clicked.navigated).toBe(true);
    expect(new URL(clicked.url).pathname).toBe('/features.html');
    unwrap(await session.waitForStability({ timeoutMs: 5_000 }));
    network = isSideEffect(session.networkSince(marker));
  } finally {
    await session.close();
  }
  const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId, note: 'multipage.test.ts records the Features link navigation of the seed page' }, scanId });
  // The schema marks a navigation as a side effect (never repeated by the explorer); the verifier replays a recorded
  // same-origin navigation that sent no non-GET request, because the destination is a crawled page of the same app.
  const transition: Transition = {
    id: 'tr_01',
    from: home.id,
    to: features.id,
    action: { type: 'click', target: { nodeId: link.id, nodePath: link.path, role: link.role, name: link.name, tag: link.tag, nth: link.a11y.nth ?? 0 } },
    sideEffects: true,
    network: { requests: network.total, nonGet: network.nonGet },
    revert: { method: 'none', succeeded: false },
    change: {
      domChanged: home.domDigest !== features.domDigest,
      roleTreeChanged: home.roleTreeDigest !== features.roleTreeDigest,
      screenshotChanged: (home.screenshot?.digest ?? null) !== (features.screenshot?.digest ?? null),
      changedNodeIds: changedNodeIds(home, features),
    },
    navigation: { toPageId: features.pageId, url: features.url },
    provenance: { kind: 'observed', source: 'interaction', stateId: home.id, viewport: { ...home.viewport }, evidenceId: evidence.id, capturedAt: features.capturedAt, confidence: 1 },
  };
  expect(network.nonGet).toBe(0);
  unwrap(await reassembleDna(ctx, scan, [transition]), 'reassemble');
  dna = unwrap(await ctx.store.loadDna(scanId), 'reload dna');
  expect(dna.states.transitions.map((t) => [t.id, t.navigation?.toPageId ?? null])).toEqual([['tr_01', 'pg_02']]);
  expect(dna.behavior.map((rule) => rule.effects.map((e) => e.kind))).toEqual([['navigate']]);

  const generated = unwrap(await generateProject({ dna, scanDir: ctx.store.scanDir(scanId), outDir: PROJECT, install: true, build: true, evidenceId: 'ev_verify_multipage_generate' }), 'generate');
  expect(generated.files).toContain('src/pages/Features.tsx');
  expect(generated.files).toContain('tests/behavior.spec.ts');
  expect(generated.install.ok, `npm install failed:\n${await tail(generated.install.logPath)}`).toBe(true);
  expect(generated.build.ok, `vite build failed:\n${await tail(generated.build.logPath)}`).toBe(true);
}, 900_000);

afterAll(async () => {
  await fixture.close();
});

describe('verifyReconstruction on Fixture D (three pages)', () => {
  it(
    'compares every base state at its page route and replays the navigation through the generated link',
    async () => {
      const report = unwrap(
        await verifyReconstruction({ ctx, scan, dna, outDir: PROJECT, attempt: 1, previous: null, thresholds: DEFAULT_THRESHOLDS, build: false, label: 'multipage baseline', evidenceId: 'ev_verify_multipage_1' }),
        'attempt 1',
      );
      reports.push(report);
      console.log('[verify multipage attempt 1]', summarize(report));
      const parsed = DiffReportSchema.safeParse(report);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 5))).toBe(true);
      // One visual entry per base state, grouped by page in document order.
      expect(report.visual.map((v) => v.stateId)).toEqual(dna.app.pages.flatMap((p) => dna.states.items.filter((s) => s.kind === 'base' && s.pageId === p.id).map((s) => s.id)));
      expect(report.visual).toHaveLength(3);
      for (const visual of report.visual) {
        expect(visual.generatedScreenshot).not.toBeNull();
        expect(await exists(ctx.store.resolvePath(scanId, visual.generatedScreenshot ?? ''))).toBe(true);
        expect(visual.geometry.comparedNodes).toBeGreaterThan(20);
        expect(visual.geometry.missingNodes, `missing nodes in ${visual.stateId}: ${visual.findings.filter((f) => f.category === 'missing').map((f) => f.message).join('; ')}`).toBe(0);
        expect(visual.pixels?.diffRatio ?? 1, `pixel diff in ${visual.stateId}`).toBeLessThan(0.05);
      }
      // The navigation replay: clicked through the generated app, landed on the Features route, same role tree change.
      expect(report.behavioral).toHaveLength(1);
      const replay = report.behavioral[0];
      if (replay === undefined) throw new Error('no behavioral entry');
      expect(replay.transitionId).toBe('tr_01');
      expect(replay.replayed, replay.reason ?? '').toBe(true);
      expect(replay.roleTreeMatch, JSON.stringify({ diff: replay.roleTreeDiff, findings: replay.findings.map((f) => f.message) })).toBe(true);
      expect(replay.findings).toEqual([]);
      expect(replay.locator).toEqual({ role: 'link', name: 'Features', nth: 0 });
      expect(replay.pixels?.diffRatio ?? 1).toBeLessThan(0.05);
      expect(report.summary).toMatchObject({ states: 3, transitions: 1, transitionsReplayed: 1, transitionsMatched: 1 });
      expect(report.summary.byCategory.behavior).toBe(0);
      expect(report.summary.byCategory.missing).toBe(0);
      expect(report.unknowns.filter((u) => u.startsWith('transition'))).toEqual([]);
      expect(report.limitations.join('\n')).not.toContain('generated tests');
      for (const artifact of report.artifacts) expect(await exists(ctx.store.resolvePath(scanId, artifact)), artifact).toBe(true);
    },
    300_000,
  );

  it(
    'runs the generated Playwright suite against the served build and records every result',
    async () => {
      const report = unwrap(
        await verifyReconstruction({
          ctx,
          scan,
          dna,
          outDir: PROJECT,
          attempt: 2,
          previous: reports[0] ?? null,
          thresholds: DEFAULT_THRESHOLDS,
          build: false,
          label: 'generated tests',
          evidenceId: 'ev_verify_multipage_2',
          runGeneratedTests: true,
        }),
        'attempt 2',
      );
      reports.push(report);
      const stored = unwrap(await ctx.store.readJson(scanId, 'verify/attempt-2/generated-tests.json', GeneratedTestRunSchema), 'generated-tests.json');
      console.log(
        '[verify multipage generated tests]',
        JSON.stringify({ ran: stored.ran, reason: stored.reason, exitCode: stored.exitCode, timedOut: stored.timedOut, durationMs: stored.durationMs, stats: stored.stats, parseError: stored.parseError, tests: stored.tests.map((t) => [t.title, t.status, t.error]) }),
      );
      console.log('[verify multipage attempt 2]', summarize(report));
      expect(report.limitations.join('\n')).not.toContain('generated tests were not run');
      expect(stored.ran).toBe(true);
      expect(stored.parseError).toBeNull();
      expect(stored.timedOut).toBe(false);
      expect(stored.exitCode).toBe(0);
      expect(stored.stats.failed).toBe(0);
      expect(stored.stats.passed).toBeGreaterThanOrEqual(1);
      expect(stored.tests.some((t) => t.transitionId === 'tr_01' && t.status === 'passed')).toBe(true);
      expect(stored.reportPath).toBe('verify/attempt-2/generated-tests.report.json');
      expect(stored.logPath).toBe('verify/attempt-2/generated-tests.log');
      expect(report.artifacts).toContain('verify/attempt-2/generated-tests.json');
      for (const artifact of report.artifacts) expect(await exists(ctx.store.resolvePath(scanId, artifact)), artifact).toBe(true);
      // The suite reused the verifier's static server: no second preview server was started (the log says so).
      const log = await readFile(ctx.store.resolvePath(scanId, stored.logPath ?? ''), 'utf8');
      expect(log).not.toContain('vite preview');
      expect(report.summary.byCategory.behavior, JSON.stringify(report.behavioral.flatMap((b) => b.findings).map((f) => f.message))).toBe(0);
      expect(report.previousAttempt).toBe(1);
      expect(report.regressions).toEqual([]);
      expect(report.summary.findings).toBe(reports[0]?.summary.findings);
    },
    400_000,
  );

  it(
    'renders the HTML report with one section per page, the navigation replay and the generated-test table',
    async () => {
      expect(reports).toHaveLength(2);
      const outPath = ctx.store.resolvePath(scanId, 'report.html');
      const rendered = unwrap(await renderReport({ ctx, scan, dna, attempts: reports, outPath }), 'render');
      expect(rendered).toEqual({ path: outPath, attempts: 2, findings: reports[1]?.summary.findings, states: 3 });
      const html = await readFile(outPath, 'utf8');
      for (const page of dna.app.pages) {
        expect(html).toContain(`id="page-${page.id}"`);
        expect(html).toContain(`${page.id} · ${page.url}`);
      }
      expect(html).toContain('route /features.html');
      expect(html).toContain('coverage not recorded');
      expect(html).toContain('the original left for page pg_02');
      expect(html).toContain('Generated behavior tests (attempt 2)');
      expect(html).toContain('status-passed');
      expect(html).toContain('tr_01: click link');
      expect(html).not.toContain('<script');
      const sources = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(sources.length).toBeGreaterThanOrEqual(9);
      for (const src of sources) expect(await exists(join(ctx.store.scanDir(scanId), ...src.split('/'))), src).toBe(true);
    },
    60_000,
  );
});
