/**
 * Phase 2 acceptance, multi-page (Fixture D): a crawl of three linked pages
 * yields one page each with navigation edges, shared layout and cross-page
 * components; safe exploration records the tab and billing-toggle
 * transitions plus navigation transitions between pages; the generated
 * project routes every page and the verifier replays navigation.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUiDna, type UiDnaDocument } from 'uidna-schema';
import type { DiffReport } from '../src/contracts/diff-report.js';
import { serveStatic, type StaticServer } from '../src/application/static-server.js';
import { REPO_ROOT, runCli, tempDir } from './helpers.js';

interface ReconstructResult {
  scanId: string;
  projectPath: string | null;
  dnaPath: string | null;
  reportPath: string | null;
  diffReport: DiffReport | null;
  steps: { name: string; ok: boolean; error: string | null }[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('Phase 2 loop on Fixture D (multi-page)', () => {
  let server: StaticServer;
  let outRoot: string;
  let projectDir: string;
  let result: ReconstructResult;
  let dna: UiDnaDocument;

  beforeAll(async () => {
    const served = await serveStatic(join(REPO_ROOT, 'fixtures', 'd-multipage'), { fixtureApi: true });
    if (!served.ok) throw new Error(served.error.message);
    server = served.value;
    outRoot = await tempDir('multipage-scans');
    projectDir = await tempDir('multipage-project');
  });

  afterAll(async () => {
    await server.close();
  });

  it('crawls, explores, generates, verifies and reports three pages', async () => {
    const run = await runCli(['reconstruct', server.url, projectDir, '--out-root', outRoot, '--viewports', '1280,390', '--crawl', '{"maxPages":3}']);
    expect(run.error, run.outcome.stderr.slice(-2000)).toBeNull();
    result = run.envelope?.result as ReconstructResult;
    expect(result.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error ?? ''}`)).toEqual([]);
    dna = parseUiDna(JSON.parse(await readFile(result.dnaPath ?? '', 'utf8')));

    // Pages and navigation
    expect(dna.app.pages.map((p) => p.depth)).toEqual([0, 1, 1]);
    const urls = dna.app.pages.map((p) => new URL(p.url).pathname).sort();
    expect(urls).toEqual(['/', '/features.html', '/pricing.html']);
    for (const page of dna.app.pages) expect(dna.states.items.filter((s) => s.pageId === page.id && s.kind === 'base')).toHaveLength(2);
    const followed = dna.app.navigation.filter((n) => n.followed);
    expect(followed.length).toBeGreaterThanOrEqual(2);
    expect(dna.app.navigation.some((n) => !n.to.sameOrigin && !n.followed && n.to.url.startsWith('https://example.com'))).toBe(true);
    expect(dna.app.pages.slice(1).every((p) => p.discoveredVia !== null && dna.app.navigation.some((n) => n.id === p.discoveredVia))).toBe(true);

    // Shared layout and cross-page components
    expect(dna.app.layouts.some((l) => l.pageIds.length === 3)).toBe(true);
    expect(dna.components.definitions.some((d) => (d.pageIds ?? []).length === 3)).toBe(true);

    // Exploration: tabs, billing toggle, navigation transitions
    const transitions = dna.states.transitions;
    expect(transitions.some((t) => t.action.type === 'click' && t.action.target?.role === 'tab')).toBe(true);
    expect(transitions.some((t) => t.action.type === 'click' && t.action.target?.name?.startsWith('Yearly billing'))).toBe(true);
    expect(transitions.some((t) => t.navigation !== null && t.navigation !== undefined)).toBe(true);
    for (const page of dna.app.pages) expect(page.coverage?.discovered ?? 0).toBeGreaterThan(0);

    // Generated project: routes and shared layout
    const app = await readFile(join(projectDir, 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('<Routes>');
    expect(app).toContain('path="/features.html"');
    expect(await exists(join(projectDir, 'src', 'pages'))).toBe(true);
    expect(await exists(join(projectDir, 'dist', 'index.html'))).toBe(true);
    expect(await exists(join(projectDir, 'tests', 'behavior.spec.ts'))).toBe(true);

    // Verification per page and navigation replay
    const report = result.diffReport!;
    expect(report.visual.map((v) => v.stateId).sort()).toEqual(dna.states.items.filter((s) => s.kind === 'base').map((s) => s.id).sort());
    for (const visual of report.visual) {
      expect(visual.geometry.missingNodes, `missing nodes in ${visual.stateId}`).toBe(0);
      expect(visual.pixels?.diffRatio ?? 1, `pixel diff in ${visual.stateId}`).toBeLessThan(0.05);
    }
    const navigationReplays = report.behavioral.filter((b) => transitions.find((t) => t.id === b.transitionId)?.navigation);
    expect(navigationReplays.length).toBeGreaterThan(0);
    expect(navigationReplays.every((b) => b.replayed && b.roleTreeMatch), JSON.stringify(navigationReplays.map((b) => [b.transitionId, b.reason, b.roleTreeDiff]))).toBe(true);
    const tabReplay = report.behavioral.find((b) => b.action.target?.role === 'tab');
    expect(tabReplay?.replayed && tabReplay.roleTreeMatch, JSON.stringify(tabReplay)).toBe(true);
    expect(await exists(result.reportPath ?? '')).toBe(true);
  });

  it('runs the generated Playwright behavior tests', async () => {
    const run = await runCli(['verify', result.scanId, projectDir, '--out-root', outRoot, '--no-build', '--run-generated-tests', '--label', 'generated tests']);
    expect(run.error, run.outcome.stderr.slice(-2000)).toBeNull();
    const report = run.envelope?.result as DiffReport;
    expect(report.limitations.join('\n')).not.toContain('generated tests were not run');
    expect(report.summary.byCategory.behavior, JSON.stringify(report.behavioral.flatMap((b) => b.findings).map((f) => f.message))).toBe(0);
  });
});
