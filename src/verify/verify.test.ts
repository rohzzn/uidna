/**
 * The verification layer against the real pipeline: Fixture A served by the
 * static server, scanned by Playwright-launched Chromium, generated into a
 * React project that is installed and built, then verified attempt after
 * attempt: baseline, a real transition recorded by driving the original
 * page, a broken primary color, a blocked click handler, and the HTML report.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transition, UiDnaDocument } from '@rohzzn/uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { captureState, openSession, reassembleDna, scanInterface } from '../application/scan.js';
import type { StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/index.js';
import { DESKTOP, serveFixtureA } from '../browser/test-helpers.js';
import { DEFAULT_THRESHOLDS, DiffReportSchema, type DiffReport } from '../contracts/diff-report.js';
import { BudgetTracker } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { generateProject } from '../generate/index.js';
import { escapeHtml } from './html.js';
import { renderReport, verifyReconstruction } from './index.js';

const REPO_ROOT = process.cwd();
const SCANS = join(REPO_ROOT, 'tests', '.tmp', 'verify-scans');
const PROJECT = join(REPO_ROOT, 'tests', '.tmp', 'verify-project');
/** First FAQ accordion summary, stable across both base states. */
const SUMMARY_PATH = '1/2/1/0/0';

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

async function attempt(n: number, label: string, build: boolean): Promise<DiffReport> {
  const previous = reports[n - 2] ?? null;
  const report = unwrap(
    await verifyReconstruction({ ctx, scan, dna, outDir: PROJECT, attempt: n, previous, thresholds: DEFAULT_THRESHOLDS, build, label, evidenceId: `ev_verify_attempt_${n}` }),
    `attempt ${n}`,
  );
  reports[n - 1] = report;
  console.log(
    `[verify attempt ${n}: ${label}]`,
    JSON.stringify({
      summary: report.summary,
      visual: report.visual.map((v) => ({
        stateId: v.stateId,
        viewport: v.viewport.width,
        diffRatio: v.pixels?.diffRatio ?? null,
        ssim: v.pixels?.ssim ?? null,
        sizeMismatch: v.pixels?.sizeMismatch ?? null,
        overlap: v.pixels === null ? null : `${v.pixels.width}x${v.pixels.height}`,
        geometry: v.geometry,
        styles: v.styles,
        findings: v.findings.length,
      })),
      behavioral: report.behavioral.map((b) => ({ id: b.transitionId, replayed: b.replayed, reason: b.reason, roleTreeMatch: b.roleTreeMatch, diff: b.roleTreeDiff, diffRatio: b.pixels?.diffRatio ?? null })),
      regressions: report.regressions.map((f) => f.key),
      resolved: report.resolved.map((f) => f.key),
      limitations: report.limitations,
      unknowns: report.unknowns,
    }),
  );
  return report;
}

beforeAll(async () => {
  await rm(SCANS, { recursive: true, force: true });
  await rm(join(PROJECT, 'dist'), { recursive: true, force: true });
  fixture = await serveFixtureA();
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: REPO_ROOT, outRoot: SCANS });
  const scanned = unwrap(await scanInterface(ctx, { url: fixture.url, viewports: [390, 1280] }), 'scan');
  scanId = scanned.result.scanId;
  scan = unwrap(await ctx.store.loadScan(scanId), 'load scan');
  dna = unwrap(await ctx.store.loadDna(scanId), 'load dna');
  expect(dna.states.items.map((s) => [s.id, s.viewport.width])).toEqual([
    ['st_01', 1280],
    ['st_02', 390],
  ]);
  const generated = unwrap(await generateProject({ dna, scanDir: ctx.store.scanDir(scanId), outDir: PROJECT, install: true, build: true, evidenceId: 'ev_verify_generate' }), 'generate');
  expect(generated.install.ok, `npm install failed:\n${await tail(generated.install.logPath)}`).toBe(true);
  expect(generated.build.ok, `vite build failed:\n${await tail(generated.build.logPath)}`).toBe(true);
}, 600_000);

afterAll(async () => {
  await fixture.close();
});

describe('verifyReconstruction on Fixture A', () => {
  it(
    'attempt 1: compares both base states with pixels, geometry, styles and placeholders',
    async () => {
      const report = await attempt(1, 'baseline', true);
      const parsed = DiffReportSchema.safeParse(report);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 5))).toBe(true);
      expect(report.attempt).toBe(1);
      expect(report.previousAttempt).toBeNull();
      expect(report.visual.map((v) => v.viewport.width)).toEqual([1280, 390]);
      for (const visual of report.visual) {
        expect(visual.pixels).not.toBeNull();
        expect(visual.pixels?.comparedPixels ?? 0).toBeGreaterThan(0);
        expect(visual.pixels?.diffRatio).not.toBeNull();
        expect(visual.pixels?.ssim).not.toBeNull();
        expect(visual.generatedScreenshot).not.toBeNull();
        expect(await exists(ctx.store.resolvePath(scanId, visual.generatedScreenshot ?? ''))).toBe(true);
        expect(visual.pixels?.diffImagePath).not.toBeNull();
        expect(visual.geometry.comparedNodes).toBeGreaterThan(50);
        expect(visual.geometry.matchedNodes).toBeGreaterThan(50);
        // Observed on Fixture A: every visible node of both base states has a counterpart. The only mismatch is the
        // closed accordion panels, which Chromium reports visible at 390px but the generated app hides (a responsive
        // finding, not a missing node), so truly-absent nodes stay small.
        expect(visual.geometry.missingNodes).toBeLessThanOrEqual(1);
        expect(visual.geometry.extraNodes).toBeLessThanOrEqual(1);
        expect(visual.styles.comparedProperties).toBeGreaterThan(visual.styles.differingProperties);
        expect(visual.findings.some((f) => f.category === 'asset' && f.name === 'Abstract illustration of connected notes')).toBe(true);
      }
      expect(report.summary.states).toBe(2);
      expect(report.summary.transitions).toBe(0);
      const responsiveFindings = (report.responsive ?? []).flatMap((r) => r.findings);
      expect(report.summary.findings).toBe(report.visual.reduce((n, v) => n + v.findings.length, 0) + responsiveFindings.length);
      expect(report.regressions).toEqual([]);
      expect(report.resolved).toEqual([]);
      expect(report.artifacts.length).toBeGreaterThanOrEqual(7);
      for (const artifact of report.artifacts) expect(await exists(ctx.store.resolvePath(scanId, artifact)), artifact).toBe(true);
      expect(scan.steps.verify.map((v) => [v.attempt, v.label])).toEqual([[1, 'baseline']]);
      const stored = unwrap(await ctx.store.loadDiffReport(scanId, 1));
      expect(stored.id).toBe(report.id);
    },
    240_000,
  );

  it(
    'attempt 2: replays a transition recorded by driving the original page',
    async () => {
      // Record a click on the first FAQ accordion summary at desktop as a derived state and a transition.
      // (The hamburger menu toggle is NOT reproduced by the current generator — the nav items are extracted
      // into their own component, so the click spans Header.tsx and that component, and the baseline does not
      // hoist state across files; verify flags that honestly. The <details> accordion is a single component with
      // controlled `open`, so its click is reproduced and makes a clean matched-replay demonstration.)
      const session = unwrap(await openSession(ctx, { url: fixture.url }, { ...DESKTOP }), 'open session');
      let capturedAt = '';
      try {
        unwrap(await session.navigate(fixture.url));
        unwrap(await session.stabilize());
        const click = unwrap(await session.act({ kind: 'click', target: { nodePath: SUMMARY_PATH } }));
        expect(click.performed).toBe(true);
        unwrap(await session.waitForStability({ timeoutMs: 5_000 }));
        const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId, note: 'verify.test.ts records the first accordion summary click' }, scanId });
        const captured = unwrap(
          await captureState(ctx, session, scan, { stateId: 'st_03', kind: 'derived', parentStateId: 'st_01', viaTransitionId: 'tr_01', evidenceId: evidence.id, budget: new BudgetTracker() }),
          'capture st_03',
        );
        capturedAt = captured.capture.capturedAt;
        scan.states.push(captured.record);
        const base = unwrap(await ctx.store.loadCapture(scanId, 'st_01'));
        const summary = base.nodes.find((n) => n.path === SUMMARY_PATH);
        if (summary === undefined) throw new Error('accordion summary not captured in st_01');
        expect(summary.tag).toBe('summary');
        const changed = captured.capture.nodes.filter((n) => {
          const before = base.nodes.find((b) => b.path === n.path);
          return before === undefined || JSON.stringify([before.attrs, before.text, before.box, before.visible]) !== JSON.stringify([n.attrs, n.text, n.box, n.visible]);
        });
        const transition: Transition = {
          id: 'tr_01',
          from: 'st_01',
          to: 'st_03',
          action: { type: 'click', target: { nodeId: summary.id, nodePath: summary.path, role: summary.role, name: summary.name, tag: summary.tag, nth: summary.a11y.nth ?? 0 } },
          sideEffects: false,
          network: { requests: 0, nonGet: 0 },
          revert: { method: 'toggle', succeeded: true },
          change: { domChanged: captured.capture.domDigest !== base.domDigest, roleTreeChanged: captured.capture.roleTreeDigest !== base.roleTreeDigest, screenshotChanged: true, changedNodeIds: changed.map((n) => n.id) },
          provenance: { kind: 'observed', source: 'interaction', stateId: 'st_01', viewport: { ...DESKTOP }, evidenceId: evidence.id, capturedAt, confidence: 1 },
        };
        unwrap(await ctx.store.saveScan(scan));
        unwrap(await reassembleDna(ctx, scan, [transition]), 'reassemble');
      } finally {
        await session.close();
      }
      dna = unwrap(await ctx.store.loadDna(scanId));
      expect(dna.states.transitions.map((t) => t.id)).toEqual(['tr_01']);
      expect(dna.states.items.map((s) => s.id)).toEqual(['st_01', 'st_02', 'st_03']);
      expect(capturedAt.length).toBeGreaterThan(0);
      // Regenerate the sources so the transition is implemented; the attempt rebuilds them.
      const regenerated = unwrap(await generateProject({ dna, scanDir: ctx.store.scanDir(scanId), outDir: PROJECT, install: false, build: false, evidenceId: 'ev_verify_regenerate' }), 'regenerate');
      expect(regenerated.files).toContain('src/sections/Header.tsx');

      const report = await attempt(2, 'with hamburger transition', true);
      expect(DiffReportSchema.safeParse(report).success).toBe(true);
      expect(report.visual).toHaveLength(2);
      expect(report.behavioral).toHaveLength(1);
      const replay = report.behavioral[0];
      if (replay === undefined) throw new Error('no behavioral entry');
      console.log('[verify attempt 2 role tree deltas]', JSON.stringify(replay.roleTreeDiff), 'locator', JSON.stringify(replay.locator));
      expect(replay.transitionId).toBe('tr_01');
      expect(replay.replayed).toBe(true);
      expect(replay.reason).toBeNull();
      expect(replay.roleTreeMatch).toBe(true);
      expect(replay.roleTreeDiff).toEqual({ missing: [], extra: [] });
      expect(replay.pixels).not.toBeNull();
      expect(replay.generatedScreenshot).not.toBeNull();
      expect(await exists(ctx.store.resolvePath(scanId, replay.generatedScreenshot ?? ''))).toBe(true);
      expect(replay.findings).toEqual([]);
      expect(report.summary.transitionsReplayed).toBe(1);
      expect(report.summary.transitionsMatched).toBe(1);
      expect(report.previousAttempt).toBe(1);
      expect(report.regressions).toEqual([]);
    },
    300_000,
  );

  it(
    'attempts 3 and 4: a changed primary color regresses and is resolved once restored',
    async () => {
      const assetsDir = join(PROJECT, 'dist', 'assets');
      const cssFiles = (await readdir(assetsDir)).filter((f) => f.endsWith('.css'));
      expect(cssFiles.length).toBeGreaterThan(0);
      const originals = new Map<string, string>();
      let replaced = 0;
      for (const file of cssFiles) {
        const path = join(assetsDir, file);
        const css = await readFile(path, 'utf8');
        originals.set(path, css);
        const mutated = css.replace(/#2f5bea/gi, () => {
          replaced += 1;
          return '#ff0000';
        }).replace(/rgb\(47,\s*91,\s*234\)/g, () => {
          replaced += 1;
          return '#ff0000';
        });
        await writeFile(path, mutated, 'utf8');
      }
      expect(replaced).toBeGreaterThan(0);

      const broken = await attempt(3, 'primary color broken', false);
      const colorRegressions = broken.regressions.filter((f) => f.category === 'color');
      expect(colorRegressions.length).toBeGreaterThan(0);
      expect(colorRegressions.every((f) => f.generated === 'rgb(255, 0, 0)')).toBe(true);
      expect(colorRegressions.some((f) => f.tokenId !== null)).toBe(true);
      expect(broken.previousAttempt).toBe(2);

      for (const [path, css] of originals) await writeFile(path, css, 'utf8');
      const restored = await attempt(4, 'primary color restored', false);
      expect(restored.regressions).toEqual([]);
      for (const regression of colorRegressions) expect(restored.resolved.map((f) => f.key)).toContain(regression.key);
      expect(restored.summary.findings).toBe(reports[1]?.summary.findings);
      expect(restored.summary.byCategory).toEqual(reports[1]?.summary.byCategory);
    },
    240_000,
  );

  it(
    'attempts 5 and 6: a blocked click handler regresses the behavior replay and is resolved once restored',
    async () => {
      const indexPath = join(PROJECT, 'dist', 'index.html');
      const html = await readFile(indexPath, 'utf8');
      expect(html).toContain('<head>');
      await writeFile(indexPath, html.replace('<head>', '<head><script>document.addEventListener("click", function (event) { event.stopPropagation(); event.preventDefault(); }, true);</script>'), 'utf8');

      const blocked = await attempt(5, 'clicks blocked', false);
      const replay = blocked.behavioral[0];
      if (replay === undefined) throw new Error('no behavioral entry');
      expect(replay.replayed).toBe(true);
      expect(replay.roleTreeMatch).toBe(false);
      expect(replay.roleTreeDiff.missing.length).toBeGreaterThan(0);
      const regression = blocked.regressions.find((f) => f.category === 'behavior');
      expect(regression).toBeDefined();
      expect(regression?.severity).toBe('high');
      expect(regression?.transitionId).toBe('tr_01');
      expect(regression?.message).toContain('missing:');
      expect(blocked.summary.transitionsMatched).toBe(0);

      await writeFile(indexPath, html, 'utf8');
      const restored = await attempt(6, 'clicks restored', false);
      expect(restored.regressions).toEqual([]);
      expect(restored.resolved.map((f) => f.key)).toContain(regression?.key);
      expect(restored.behavioral[0]?.roleTreeMatch).toBe(true);
      expect(restored.summary.findings).toBe(reports[3]?.summary.findings);
    },
    240_000,
  );

  it(
    'renders the HTML report over all attempts with escaped names and existing relative image paths',
    async () => {
      expect(reports.filter((r) => r !== undefined)).toHaveLength(6);
      const outPath = ctx.store.resolvePath(scanId, 'report.html');
      const rendered = unwrap(await renderReport({ ctx, scan, dna, attempts: reports, outPath }), 'render');
      expect(rendered).toEqual({ path: outPath, attempts: 6, findings: reports[5]?.summary.findings, states: 2 });
      const html = await readFile(outPath, 'utf8');
      expect(html).toContain(scanId);
      for (const label of ['baseline', 'with hamburger transition', 'primary color broken', 'primary color restored', 'clicks blocked', 'clicks restored']) expect(html).toContain(escapeHtml(label));
      expect(html).toContain(escapeHtml('Lumen — Notes that think with you'));
      expect(html).toContain(escapeHtml('Abstract illustration of connected notes'));
      expect(html).toContain('tr_01');
      expect(html).not.toContain('<script');
      const sources = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1] ?? '');
      expect(sources.length).toBeGreaterThanOrEqual(6);
      for (const src of sources) {
        expect(src.startsWith('/')).toBe(false);
        expect(src).not.toContain('\\');
        expect(await exists(resolve(dirname(outPath), src)), src).toBe(true);
      }
      expect(html).toContain('class="box box-original"');
      expect(html).toContain('class="box box-generated"');
      console.log('[verify report]', outPath, `${html.length} bytes, ${sources.length} images`);
    },
    60_000,
  );
});
