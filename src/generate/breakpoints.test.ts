/**
 * Located breakpoints in the generator: the plan names them in ascending
 * order, adds a scanned-width step only where none was located, and attributes
 * each style change to the breakpoint whose rule records it. The project's
 * tokens.css declares them and the classes use them; a document without
 * located breakpoints keeps the 0.2.0 output (one step per scanned width).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Responsive, UiDnaDocument } from '@rohzzn/uidna-schema';
import { fixedClock } from '../domain/clock.js';
import { unwrap } from '../domain/result.js';
import { generateProject } from './index.js';
import { planBreakpoints } from './model.js';
import { FIXTURE_CAPTURED_AT, FIXTURE_PATHS, fixtureDocument } from './testing.js';

const AT = FIXTURE_CAPTURED_AT;

function located(): Responsive {
  const measuredCss = { kind: 'measured' as const, source: 'stylesheet' as const, capturedAt: AT, evidenceId: 'ev_000000000001', confidence: 1 };
  const observed = { kind: 'observed' as const, source: 'computed-style' as const, capturedAt: AT, evidenceId: 'ev_000000000001', confidence: 1 };
  return {
    breakpoints: [
      { id: 'bp_01', minWidth: 768, source: 'css', bracket: { lower: 767, upper: 768 }, observed: true, conditionIds: ['mq_01'], pageIds: ['pg_01'], provenance: measuredCss },
      { id: 'bp_02', minWidth: 1024, source: 'css', bracket: { lower: 1023, upper: 1024 }, observed: true, conditionIds: ['mq_02'], pageIds: ['pg_01'], provenance: measuredCss },
    ],
    conditions: [
      { id: 'mq_01', text: '(max-width: 767px)', kind: 'media', thresholds: [768], never: false, unsupported: [], stylesheet: { url: null, origin: 'inline' }, ruleCount: 2, pageIds: ['pg_01'], observedEffect: true, provenance: measuredCss },
      { id: 'mq_02', text: '(min-width: 1024px)', kind: 'media', thresholds: [1024], never: false, unsupported: [], stylesheet: { url: null, origin: 'inline' }, ruleCount: 1, pageIds: ['pg_01'], observedEffect: true, provenance: measuredCss },
    ],
    rules: [
      { id: 'rr_001', breakpointId: 'bp_01', pageId: 'pg_01', nodePath: FIXTURE_PATHS.toggle, property: 'display', below: 'flex', above: 'none', provenance: observed },
      { id: 'rr_002', breakpointId: 'bp_01', pageId: 'pg_01', nodePath: FIXTURE_PATHS.menu, property: 'rendered', below: 'false', above: 'true', provenance: observed },
      { id: 'rr_003', breakpointId: 'bp_02', pageId: 'pg_01', nodePath: FIXTURE_PATHS.cardGrid, property: 'grid-columns', below: '1', above: '3', provenance: observed },
    ],
    probes: [{ pageId: 'pg_01', height: 800, widths: [390, 767, 768, 1023, 1024, 1280], maxProbes: 32, exhausted: false, blockedRequests: 0, evidenceId: 'ev_000000000001' }],
  };
}

function withBreakpoints(): UiDnaDocument {
  const dna = fixtureDocument();
  dna.visual.responsive = located();
  return dna;
}

describe('planBreakpoints', () => {
  it('names located breakpoints in order and attributes changes by their rules', () => {
    const plan = planBreakpoints(withBreakpoints(), ['pg_01']);
    expect(plan.ordered.map((bp) => [bp.name, bp.minWidth, bp.source])).toEqual([
      ['md', 768, 'css'],
      ['lg', 1024, 'css'],
    ]);
    expect(Object.fromEntries(plan.nameAt)).toEqual({ 390: null, 1280: 'lg' });
    expect(plan.attribute('pg_01', FIXTURE_PATHS.toggle, 'display', 390, 1280).minWidth).toBe(768);
    expect(plan.attribute('pg_01', FIXTURE_PATHS.menu, 'display', 390, 1280).minWidth).toBe(768);
    expect(plan.attribute('pg_01', FIXTURE_PATHS.cardGrid, 'grid-template-columns', 390, 1280).minWidth).toBe(1024);
    // A change no rule records lands at the breakpoint nearest the wider capture.
    expect(plan.attribute('pg_01', FIXTURE_PATHS.hero, 'font-size', 390, 1280).minWidth).toBe(1024);
  });

  it('keeps one step per scanned width when nothing was located', () => {
    const plan = planBreakpoints(fixtureDocument(), ['pg_01']);
    expect(plan.ordered.map((bp) => [bp.name, bp.minWidth, bp.source])).toEqual([['md', 1280, 'scanned']]);
  });

  it('ignores located breakpoints outside the scanned range and adds a step where an interval has none', () => {
    const dna = withBreakpoints();
    const responsive = dna.visual.responsive;
    if (responsive === undefined) throw new Error('no responsive facet');
    responsive.breakpoints = responsive.breakpoints.map((bp) => (bp.id === 'bp_02' ? { ...bp, minWidth: 1440, bracket: { lower: 1439, upper: 1440 } } : bp));
    const plan = planBreakpoints(dna, ['pg_01']);
    expect(plan.ordered.map((bp) => bp.minWidth)).toEqual([768]);
  });
});

describe('generated project with located breakpoints', () => {
  let root: string;
  let withPlan: string;
  let without: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'uidna-breakpoints-'));
    withPlan = join(root, 'located');
    without = join(root, 'scanned');
    const generate = async (dna: UiDnaDocument, outDir: string): Promise<void> => {
      unwrap(await generateProject({ dna, scanDir: join(root, 'scan'), outDir, install: false, build: false, clock: fixedClock('2026-10-14T12:00:00.000Z'), evidenceId: 'ev_000000000010' }), 'generate');
    };
    await generate(withBreakpoints(), withPlan);
    await generate(fixtureDocument(), without);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('declares the located breakpoints in tokens.css with their stylesheet condition', async () => {
    const tokens = await readFile(join(withPlan, 'src', 'styles', 'tokens.css'), 'utf8');
    expect(tokens).toContain('--breakpoint-md: 768px; /* bp_01 stylesheet "(max-width: 767px)" */');
    expect(tokens).toContain('--breakpoint-lg: 1024px; /* bp_02 stylesheet "(min-width: 1024px)" */');
    expect(tokens).not.toContain('1280px');
    const legacy = await readFile(join(without, 'src', 'styles', 'tokens.css'), 'utf8');
    expect(legacy).toContain('--breakpoint-md: 1280px;');
  });

  it('switches the toggle at 768 and the card grid at 1024', async () => {
    const sources = (await Promise.all(['src/App.tsx', 'src/sections/Header.tsx', 'src/sections/Main.tsx'].map((f) => readFile(join(withPlan, f), 'utf8').catch(() => '')))).join('\n');
    const classesAt = (path: string): string => new RegExp(`className="([^"]*)"[^>]*data-uidna-path="${path}"`).exec(sources)?.[1] ?? '';
    expect(classesAt(FIXTURE_PATHS.toggle).split(' ')).toContain('md:hidden');
    expect(classesAt(FIXTURE_PATHS.cardGrid)).toMatch(/(^| )lg:grid-cols-3( |$)/);
    expect(classesAt(FIXTURE_PATHS.cardGrid)).not.toMatch(/(^| )md:grid-cols/);
  });
});
