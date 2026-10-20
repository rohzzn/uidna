/**
 * The analysis layer against the real instrument: Fixture A captured by
 * Playwright-launched Chromium at 1280 and 390, then run through tokens,
 * components, layout and assembly. The synthetic captures in `testing.ts`
 * mirror the fixture; this file checks the claims hold on what the capture
 * module actually emits, including where the two differ (the accent nav link
 * has its own style class, `<summary>` has no role).
 */
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComponentsSchema, formatIssues, LayoutConstraintSchema, TokensSchema, validateUiDna } from 'uidna-schema';
import type { StaticServer } from '../application/static-server.js';
import { PlaywrightSession } from '../browser/session.js';
import { DESKTOP, makeTempDir, PHONE, serveFixtureA, type TempDir } from '../browser/test-helpers.js';
import type { CapturedState } from '../browser/types.js';
import { fixedClock } from '../domain/clock.js';
import { unwrap } from '../domain/result.js';
import { assembleDna } from './assemble.js';
import { findComponents } from './components.js';
import { computeLayout } from './layout.js';
import { buildFixtureAScanRecord, FIXTURE_A_SHADOW, findNode, findNodes } from './testing.js';
import { extractTokens } from './tokens.js';

const CAPTURED_AT = '2026-10-13T17:29:00.000Z';
const EVIDENCE = { st_01: 'ev_000000000001', st_02: 'ev_000000000002' } as const;

let server: StaticServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let session: PlaywrightSession;
let temp: TempDir;
let captures: Map<string, CapturedState>;
let desktop: CapturedState;
let phone: CapturedState;

/** Screenshot path relative to the scan directory, as `scan_interface` stores it. */
function relativized(stateId: string, capture: CapturedState): CapturedState {
  return { ...capture, screenshot: capture.screenshot ? { ...capture.screenshot, path: `states/${stateId}/screenshot.png` } : null };
}

/** Every `provenance.kind` found anywhere in a JSON value. */
function provenanceKinds(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) provenanceKinds(item, out);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const provenance = record.provenance as { kind?: unknown } | undefined;
    if (provenance && typeof provenance === 'object' && typeof provenance.kind === 'string') out.add(provenance.kind);
    for (const inner of Object.values(record)) provenanceKinds(inner, out);
  }
  return out;
}

beforeAll(async () => {
  server = await serveFixtureA();
  temp = await makeTempDir('uidna-analysis-');
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { ...DESKTOP }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page = await context.newPage();
  session = new PlaywrightSession({ browser, page, mode: 'launch', clock: fixedClock(CAPTURED_AT), viewport: { ...DESKTOP }, honorRobots: true, ownsBrowser: true });
  unwrap(await session.navigate(server.url));
  desktop = relativized('st_01', unwrap(await session.capture({ screenshotPath: join(temp.path, 'desktop.png') }), 'desktop capture'));
  unwrap(await session.setViewport({ ...PHONE }));
  phone = relativized('st_02', unwrap(await session.capture({ screenshotPath: join(temp.path, 'phone.png') }), 'phone capture'));
  captures = new Map([
    ['st_01', desktop],
    ['st_02', phone],
  ]);
});

afterAll(async () => {
  await session.close();
  await server.close();
  await temp.cleanup();
});

describe('tokens of a real Fixture A capture', () => {
  it('finds the stylesheet palette, font stack, radii, spacing and shadow with measured provenance only', () => {
    const tokens = extractTokens(captures, { capturedAt: CAPTURED_AT, evidenceIdByState: EVIDENCE });
    expect(TokensSchema.safeParse(tokens).success).toBe(true);
    const colors = tokens.colors.map((t) => t.value.value);
    expect(colors).toEqual(expect.arrayContaining(['#ffffff', '#f5f7fb', '#1b1f2a', '#5b6474', '#2f5bea', '#1f9d6a', '#d98a1f', '#dfe3ec']));
    expect(colors).not.toContain('rgba(0, 0, 0, 0)');
    for (const token of tokens.colors) {
      expect(token.value.provenance).toMatchObject({ kind: 'measured', source: 'computed-style', capturedAt: CAPTURED_AT });
      expect(token.cluster.sampleCount).toBe(token.cluster.members.reduce((s, m) => s + m.count, 0));
      expect(token.usage.count).toBe(token.cluster.sampleCount);
    }
    const border = tokens.colors.find((t) => t.value.value === '#dfe3ec')!;
    expect(border.cluster.properties).toEqual(['border-bottom-color', 'border-left-color', 'border-right-color', 'border-top-color']);
    expect(border.cluster.members).toEqual([{ value: 'rgb(223, 227, 236)', count: border.cluster.sampleCount }]);

    expect(tokens.fontFamilies.map((t) => t.value.value)).toEqual(['Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif']);
    expect(tokens.fontSizes.map((t) => t.value.value)).toEqual(expect.arrayContaining(['48px', '32px', '26px', '20px', '18px', '17px', '16px', '15px', '14px', '13px']));
    expect(new Set(tokens.radii.map((t) => t.value.value))).toEqual(new Set(['12px', '6px', '2px', '999px']));
    expect(tokens.spacing.map((t) => t.value.value)).toEqual(expect.arrayContaining(['4px', '8px', '16px', '24px', '32px', '48px', '64px']));
    expect(tokens.shadows.map((t) => t.value.value)).toEqual([FIXTURE_A_SHADOW]);

    const h1 = tokens.typography.find((t) => t.fontSize.value === '48px')!;
    expect(h1).toMatchObject({ fontWeight: { value: '700' }, lineHeight: { value: '52.8px' }, stateIds: ['st_01'] });
    expect(h1.fontFamily.provenance).toMatchObject({ kind: 'measured', stateId: 'st_01', evidenceId: 'ev_000000000001' });

    expect(tokens.breakpoints.map((t) => [t.value.value, t.cluster.properties])).toEqual([['390px', ['box', 'visible']]]);
    expect(tokens.breakpoints[0]!.value.provenance).toMatchObject({ kind: 'observed', source: 'bounding-box' });
    expect(provenanceKinds(JSON.parse(JSON.stringify(tokens)))).toEqual(new Set(['measured', 'observed']));
  });
});

describe('components of a real Fixture A capture', () => {
  it('finds the cards, the accordion items and the two button variants', () => {
    const components = findComponents(captures, { evidenceIdByState: EVIDENCE });
    expect(ComponentsSchema.safeParse(components).success).toBe(true);

    const card = components.definitions.find((d) => d.structure.signature === 'article>div+h3+p')!;
    expect(card).toMatchObject({ matchesByState: { st_01: 3, st_02: 3 }, instanceCount: 6, confidence: 1, structure: { tag: 'article', role: 'article', childCount: 3 } });
    expect(card.props.map((p) => [p.name, p.kind, p.relativePath])).toEqual([
      ['h3-text', 'text', '1'],
      ['p-text', 'text', '2'],
    ]);
    expect(card.props[0]!.values).toEqual(['Capture quickly', 'Link naturally', 'Review calmly']);
    const cardInstances = components.instances.filter((i) => i.definitionId === card.id && i.stateId === 'st_01');
    expect(cardInstances.map((i) => i.nodePath)).toEqual(findNodes(desktop, '.card').map((n) => n.path));
    expect(cardInstances[0]!.box.provenance).toMatchObject({ kind: 'measured', source: 'bounding-box', stateId: 'st_01', evidenceId: 'ev_000000000001' });

    const details = components.definitions.find((d) => d.structure.signature === 'details>summary+div')!;
    expect(details).toMatchObject({ matchesByState: { st_01: 3, st_02: 3 }, structure: { role: 'group' } });
    // Chromium gives <summary> no role; the instrument reports null rather than guessing.
    expect(components.definitions.find((d) => d.structure.tag === 'summary')!.structure.role).toBeNull();

    const buttons = findNodes(desktop, '.button');
    const button = components.definitions.find((d) => components.instances.some((i) => i.definitionId === d.id && i.stateId === 'st_01' && i.nodePath === buttons[0]!.path))!;
    expect(button.instanceCount).toBe(4);
    expect(button.variants).toHaveLength(2);
    expect(button.variants[0]!.differences.map((d) => d.property)).toEqual(expect.arrayContaining(['background-color', 'color']));
    expect(button.confidence).toBeLessThan(1);
    expect(button.confidence).toBeGreaterThan(0.5);
  });

  it('separates the accent nav link from the three plain ones by its style class', () => {
    // The synthetic fixture models four identical nav links; the real stylesheet styles "Get started" as a pill.
    const components = findComponents(captures, { evidenceIdByState: EVIDENCE });
    const links = findNodes(desktop, '.nav-link');
    expect(links).toHaveLength(4);
    const accent = findNode(desktop, '.nav-link-accent')!;
    const plain = links.filter((n) => n.id !== accent.id);
    const byPath = (path: string) => components.definitions.find((d) => components.instances.some((i) => i.definitionId === d.id && i.stateId === 'st_01' && i.nodePath === path));
    const plainDefinition = byPath(plain[0]!.path)!;
    for (const link of plain) expect(byPath(link.path)?.id).toBe(plainDefinition.id);
    expect(plainDefinition.matchesByState).toEqual({ st_01: 3 });
    expect(byPath(accent.path)).toBeUndefined();
  });
});

describe('layout and assembly of a real Fixture A capture', () => {
  it('describes every visible container with measured values and no unknowns for this fixture', () => {
    const layout = computeLayout(captures, { evidenceIdByState: EVIDENCE });
    for (const constraint of layout) expect(LayoutConstraintSchema.safeParse(constraint).success).toBe(true);
    const containers = [...captures.values()].flatMap((c) => c.nodes.filter((n) => n.visible && n.childIds.length > 0));
    expect(layout).toHaveLength(containers.length);
    const hero = findNode(desktop, '.hero')!;
    const constraint = layout.find((c) => c.stateId === 'st_01' && c.nodeId === hero.id)!;
    expect(constraint.display.value).toBe('grid');
    expect(constraint.grid!.templateColumns!.value).toBe('512px 512px');
    expect(constraint.grid!.gap!.value).toBe('48px');
    expect(constraint.spacing.margin.value).toBe('0px 80px 0px 80px');
    expect(constraint.spacing.padding.value).toBe('64px 24px 64px 24px');
    expect(constraint.box.value).toEqual(hero.box);
    expect(provenanceKinds(JSON.parse(JSON.stringify(layout)))).toEqual(new Set(['measured']));
  });

  it('assembles a valid, deterministic document with no inferred provenance', () => {
    const scan = buildFixtureAScanRecord({ captures });
    const clock = fixedClock('2026-10-13T17:30:00.000Z');
    const result = assembleDna({ scan, captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    const doc = result.value;
    expect(formatIssues(validateUiDna(doc))).toEqual([]);
    expect(provenanceKinds(JSON.parse(JSON.stringify(doc)))).toEqual(new Set(['measured', 'observed']));
    expect(doc.states.items.map((s) => [s.id, s.viewport.width, s.screenshot?.path])).toEqual([
      ['st_01', 1280, 'states/st_01/screenshot.png'],
      ['st_02', 390, 'states/st_02/screenshot.png'],
    ]);
    expect(doc.app.layouts[0]!.regions.map((r) => r.role)).toEqual(['banner', 'navigation', 'main', 'contentinfo']);
    expect(doc.app.navigation).toHaveLength(desktop.nodes.filter((n) => n.tag === 'a' && n.attrs.href !== undefined).length);
    expect(doc.app.navigation.every((e) => e.to.sameOrigin && e.to.fragment && !e.followed)).toBe(true);
    expect(doc.assets).toHaveLength(1);
    expect(doc.assets[0]).toMatchObject({ kind: 'svg', origin: 'same-origin', authorization: 'unknown' });
    expect(doc.assets[0]!.usage.map((u) => u.stateId)).toEqual(['st_01', 'st_02']);
    expect(doc.assets[0]!.provenance).toMatchObject({ kind: 'measured', source: 'network', stateId: 'st_01' });
    expect(doc.limitations).toEqual([]);
    expect(doc.behavior).toEqual([]);
    const again = assembleDna({ scan, captures, toolVersion: '0.1.0', clock });
    if (!again.ok) throw new Error(again.error.message);
    expect(JSON.stringify(again.value)).toBe(JSON.stringify(doc));
  });
});
