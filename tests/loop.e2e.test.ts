/**
 * Phase 1 exit criteria, enforced with a real Chromium against Fixture A:
 * 1. `uidna reconstruct` yields a validating dna.json, a project that builds,
 *    a DiffReport with visual findings per viewport and behavioral findings for
 *    the hamburger and accordion transitions, and a report.html.
 * 2. Both recorded transitions replay on the generated app and match.
 * 3. A deliberate CSS regression and a deliberate behavior regression are each
 *    caught; reverting clears them without regressing other findings.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUiDna } from 'uidna-schema';
import type { DiffReport, Finding } from '../src/contracts/diff-report.js';
import type { StaticServer } from '../src/application/static-server.js';
import { runCli, serveFixtureA, tempDir } from './helpers.js';

interface ReconstructResult {
  scanId: string;
  scanDir: string;
  projectPath: string | null;
  dnaPath: string | null;
  reportPath: string | null;
  diffReport: DiffReport | null;
  steps: { name: string; ok: boolean; error: string | null }[];
  findings: Finding[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const isHamburger = (b: DiffReport['behavioral'][number]): boolean => b.action.type === 'click' && /menu/i.test(b.action.target?.name ?? b.locator.name ?? '');
const isAccordion = (b: DiffReport['behavioral'][number]): boolean => b.action.type === 'click' && b.action.target?.tag === 'summary';

describe('Phase 1 loop on Fixture A', () => {
  let server: StaticServer;
  let outRoot: string;
  let projectDir: string;
  let reconstruct: ReconstructResult;
  let baseline: DiffReport;

  beforeAll(async () => {
    server = await serveFixtureA();
    outRoot = await tempDir('loop-scans');
    projectDir = await tempDir('loop-project');
  });

  afterAll(async () => {
    await server.close();
  });

  it('reconstruct produces a validating document, a built project, a DiffReport and a report', async () => {
    const run = await runCli(['reconstruct', server.url, projectDir, '--out-root', outRoot, '--viewports', '1280,768,390']);
    expect(run.error, run.outcome.stderr.slice(-2000)).toBeNull();
    expect(run.envelope, run.outcome.stderr.slice(-2000)).not.toBeNull();
    reconstruct = run.envelope?.result as ReconstructResult;
    expect(reconstruct.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error ?? ''}`)).toEqual([]);

    expect(reconstruct.dnaPath).not.toBeNull();
    const dna = parseUiDna(JSON.parse(await readFile(reconstruct.dnaPath ?? '', 'utf8')));
    expect(dna.states.items.filter((s) => s.kind === 'base').map((s) => s.viewport.width)).toEqual([1280, 768, 390]);
    expect(dna.states.transitions.length).toBeGreaterThanOrEqual(2);

    expect(reconstruct.projectPath).not.toBeNull();
    expect(await exists(join(reconstruct.projectPath ?? '', 'dist', 'index.html'))).toBe(true);

    expect(reconstruct.diffReport).not.toBeNull();
    baseline = reconstruct.diffReport!;
    expect(baseline.visual.map((v) => v.viewport.width).sort((a, b) => b - a)).toEqual([1280, 768, 390]);
    for (const visual of baseline.visual) {
      expect(visual.pixels, `pixels at ${visual.viewport.width}`).not.toBeNull();
      expect(visual.pixels?.diffRatio, `diff ratio at ${visual.viewport.width}`).not.toBeNull();
      expect(visual.geometry.comparedNodes, `compared nodes at ${visual.viewport.width}`).toBeGreaterThan(0);
      expect(visual.geometry.matchedNodes, `matched nodes at ${visual.viewport.width}`).toBe(visual.geometry.comparedNodes);
      // The unauthorized illustration is a placeholder, so every viewport carries at least one concrete finding.
      expect(visual.findings.length, `findings at ${visual.viewport.width}`).toBeGreaterThan(0);
      expect(visual.findings.every((f) => f.original !== undefined && f.generated !== undefined && f.evidence.length > 0)).toBe(true);
    }
    expect(baseline.behavioral.some(isHamburger)).toBe(true);
    expect(baseline.behavioral.some(isAccordion)).toBe(true);

    expect(reconstruct.reportPath).not.toBeNull();
    const report = await readFile(reconstruct.reportPath ?? '', 'utf8');
    expect(report).toContain('<html');
    expect(report).toContain(reconstruct.scanId);
  });

  it('both recorded transitions replay on the generated app and match', () => {
    const hamburger = baseline.behavioral.find(isHamburger);
    const accordion = baseline.behavioral.find(isAccordion);
    expect(hamburger?.replayed, hamburger?.reason ?? '').toBe(true);
    expect(hamburger?.roleTreeMatch, JSON.stringify(hamburger?.roleTreeDiff)).toBe(true);
    expect(accordion?.replayed, accordion?.reason ?? '').toBe(true);
    expect(accordion?.roleTreeMatch, JSON.stringify(accordion?.roleTreeDiff)).toBe(true);
  });

  it('a deliberate CSS regression is caught and reverting clears it without regressing other findings', async () => {
    const tokensPath = join(projectDir, 'src', 'styles', 'tokens.css');
    const original = await readFile(tokensPath, 'utf8');
    const hexes = [...original.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
    const primary = hexes.find((h) => h.toLowerCase() === '#2f5bea');
    expect(primary, 'the primary brand color must be a token').toBeDefined();
    await writeFile(tokensPath, original.replaceAll(primary ?? '', '#ff0000'), 'utf8');

    const broken = await runCli(['verify', reconstruct.scanId, projectDir, '--out-root', outRoot, '--label', 'css regression']);
    expect(broken.error, broken.outcome.stderr.slice(-2000)).toBeNull();
    const brokenReport = broken.envelope?.result as DiffReport;
    expect(brokenReport.attempt).toBe(baseline.attempt + 1);
    expect(brokenReport.regressions.some((f) => f.category === 'color')).toBe(true);

    await writeFile(tokensPath, original, 'utf8');
    const fixed = await runCli(['verify', reconstruct.scanId, projectDir, '--out-root', outRoot, '--label', 'css reverted']);
    expect(fixed.error, fixed.outcome.stderr.slice(-2000)).toBeNull();
    const fixedReport = fixed.envelope?.result as DiffReport;
    expect(fixedReport.regressions).toEqual([]);
    expect(fixedReport.resolved.some((f) => f.category === 'color')).toBe(true);
    expect(fixedReport.summary.findings).toBe(baseline.summary.findings);
    baseline = fixedReport;
  });

  it('a deliberate behavior regression is caught and reverting clears it without regressing other findings', async () => {
    const mainPath = join(projectDir, 'src', 'main.tsx');
    const original = await readFile(mainPath, 'utf8');
    const sabotage = `\ndocument.addEventListener('click', (event) => { event.stopPropagation(); event.preventDefault(); }, true);\n`;
    await writeFile(mainPath, original + sabotage, 'utf8');

    const broken = await runCli(['verify', reconstruct.scanId, projectDir, '--out-root', outRoot, '--label', 'behavior regression']);
    expect(broken.error, broken.outcome.stderr.slice(-2000)).toBeNull();
    const brokenReport = broken.envelope?.result as DiffReport;
    expect(brokenReport.regressions.some((f) => f.category === 'behavior')).toBe(true);
    expect(brokenReport.behavioral.find(isHamburger)?.roleTreeMatch).toBe(false);

    await writeFile(mainPath, original, 'utf8');
    const fixed = await runCli(['verify', reconstruct.scanId, projectDir, '--out-root', outRoot, '--label', 'behavior reverted']);
    expect(fixed.error, fixed.outcome.stderr.slice(-2000)).toBeNull();
    const fixedReport = fixed.envelope?.result as DiffReport;
    expect(fixedReport.regressions).toEqual([]);
    expect(fixedReport.resolved.some((f) => f.category === 'behavior')).toBe(true);
    expect(fixedReport.summary.findings).toBe(baseline.summary.findings);
  });

  it('report and export cover every attempt', async () => {
    const report = await runCli(['report', reconstruct.scanId, '--out-root', outRoot]);
    expect(report.error).toBeNull();
    const result = report.envelope?.result as { reportPath: string; attempts: number };
    expect(result.attempts).toBe(5);
    expect(await exists(result.reportPath)).toBe(true);

    const exported = await runCli(['export', reconstruct.scanId, '--out-root', outRoot]);
    expect(exported.error).toBeNull();
    const bundle = exported.envelope?.result as { manifestPath: string; files: number };
    expect(bundle.files).toBeGreaterThan(10);
    expect(await exists(bundle.manifestPath)).toBe(true);
  });
});
