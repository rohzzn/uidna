/**
 * Multi-page assembly against the real instrument: Fixture D
 * (`fixtures/d-multipage`, three linked pages with a shared header and
 * footer) crawled by the real `scan_interface` workflow in Playwright-launched
 * Chromium at 1280, then assembled from the stored scan record and captures.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type UiDnaDocument } from '@rohzzn/uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { scanInterface } from '../application/scan.js';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/playwright-provider.js';
import { makeTempDir, type TempDir } from '../browser/test-helpers.js';
import type { CapturedState } from '../browser/types.js';
import { unwrap } from '../domain/result.js';
import { assembleDna } from './assemble.js';

/** Absolute path of Fixture D. */
const FIXTURE_D_DIR = fileURLToPath(new URL('../../fixtures/d-multipage/', import.meta.url));

let server: StaticServer;
let temp: TempDir;
let ctx: WorkflowContext;
let scan: ScanRecord;
let captures: Map<string, CapturedState>;
let stored: UiDnaDocument;
let doc: UiDnaDocument;

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

const pathOf = (url: string): string => new URL(url).pathname;

beforeAll(async () => {
  server = unwrap(await serveStatic(FIXTURE_D_DIR, { fixtureApi: true }), 'serve fixture D');
  temp = await makeTempDir('uidna-multipage-');
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: temp.path, outRoot: temp.path });
  const scanned = unwrap(await scanInterface(ctx, { url: server.url, viewports: [1280], crawl: { maxPages: 3 } }), 'scan');
  scan = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
  captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
  stored = unwrap(await ctx.store.loadDna(scan.scanId), 'load dna');
  const responsive = unwrap(await ctx.store.loadResponsive(scan.scanId), 'load responsive');
  const assembled = assembleDna({ scan, captures, responsive, toolVersion: '0.1.0' });
  if (!assembled.ok) throw new Error(assembled.error.message);
  doc = assembled.value;
});

afterAll(async () => {
  await server.close();
  await temp.cleanup();
});

describe('assembleDna over a real crawl of Fixture D', () => {
  it('validates, matches the document scan_interface stored, and never infers', () => {
    expect(formatIssues(validateUiDna(doc))).toEqual([]);
    expect(JSON.stringify(doc)).toBe(JSON.stringify(stored));
    expect(provenanceKinds(JSON.parse(JSON.stringify(doc)))).toEqual(new Set(['measured']));
    expect(doc.limitations).toEqual([]);
  });

  it('lists three pages at depths 0/1/1, each discovered through a navigation edge that exists', () => {
    expect(scan.pages?.map((p) => p.pageId)).toEqual(['pg_01', 'pg_02', 'pg_03']);
    expect(doc.app.pages.map((p) => [p.id, pathOf(p.url), p.depth])).toEqual([
      ['pg_01', '/', 0],
      ['pg_02', '/features.html', 1],
      ['pg_03', '/pricing.html', 1],
    ]);
    expect(doc.app.pages.map((p) => p.title.value)).toEqual(['Lumen — Home', 'Lumen — Features', 'Lumen — Pricing']);
    expect(doc.app.pages[0]!.discoveredVia).toBeNull();
    for (const page of doc.app.pages.slice(1)) {
      const edge = doc.app.navigation.find((e) => e.id === page.discoveredVia);
      expect(edge, `discoveredVia of ${page.id}`).toBeDefined();
      expect(edge).toMatchObject({ fromPageId: 'pg_01', to: { pageId: page.id, sameOrigin: true, fragment: false }, followed: true, via: { role: 'link' } });
      expect(pathOf(edge!.to.url)).toBe(pathOf(page.url));
      const raw = scan.pages!.find((p) => p.pageId === page.id)!.discoveredVia!;
      expect(`${edge!.fromPageId}:${edge!.via.nodePath}`).toBe(raw);
    }
    expect(doc.app.routes.map((r) => [r.pattern, r.pageId])).toEqual([
      ['/', 'pg_01'],
      ['/features.html', 'pg_02'],
      ['/pricing.html', 'pg_03'],
    ]);
  });

  it('gives every state the page id of its scan record and every page exactly its states', () => {
    expect(doc.states.items).toHaveLength(3);
    for (const state of doc.states.items) {
      const record = scan.states.find((s) => s.stateId === state.id)!;
      expect(state.pageId).toBe(record.pageId);
      expect(state.kind).toBe('base');
      expect(pathOf(state.url)).toBe(pathOf(doc.app.pages.find((p) => p.id === state.pageId)!.url));
    }
    for (const page of doc.app.pages) {
      expect(page.stateIds).toEqual(scan.states.filter((s) => s.pageId === page.id).map((s) => s.stateId));
      expect(page.stateIds).toHaveLength(1);
    }
  });

  it('follows same-origin edges to crawled pages and records the cross-origin footer link as not followed', () => {
    const fromSeed = doc.app.navigation.filter((e) => e.fromPageId === 'pg_01');
    const seedLinks = captures.get(doc.app.pages[0]!.stateIds[0]!)!.nodes.filter((n) => n.tag === 'a' && n.attrs.href !== undefined);
    expect(fromSeed).toHaveLength(seedLinks.length);
    const toFeatures = fromSeed.filter((e) => pathOf(e.to.url) === '/features.html');
    const toPricing = fromSeed.filter((e) => pathOf(e.to.url) === '/pricing.html');
    expect(toFeatures.length).toBeGreaterThanOrEqual(2);
    expect(toPricing.length).toBeGreaterThanOrEqual(2);
    for (const edge of toFeatures) expect(edge).toMatchObject({ to: { pageId: 'pg_02', sameOrigin: true, fragment: false }, followed: true });
    for (const edge of toPricing) expect(edge).toMatchObject({ to: { pageId: 'pg_03', sameOrigin: true, fragment: false }, followed: true });
    // 10 links on the home page, 9 on features, 11 on pricing; every same-origin target is a crawled page, one cross-origin link per footer.
    expect(doc.app.navigation).toHaveLength(30);
    expect(doc.app.pages.map((p) => doc.app.navigation.filter((e) => e.fromPageId === p.id).length)).toEqual([10, 9, 11]);
    expect(doc.app.navigation.filter((e) => e.followed)).toHaveLength(27);
    expect(doc.app.navigation.filter((e) => e.to.sameOrigin && e.to.pageId === null)).toEqual([]);
    expect(doc.app.navigation.filter((e) => e.to.fragment)).toEqual([]);
    const status = doc.app.navigation.filter((e) => e.to.url.startsWith('https://example.com/'));
    expect(status).toHaveLength(3);
    for (const edge of status) expect(edge).toMatchObject({ to: { pageId: null, sameOrigin: false, fragment: false }, followed: false, via: { name: 'Status page' } });
    // Every page links back home; "/" is the seed.
    for (const page of doc.app.pages) {
      const home = doc.app.navigation.find((e) => e.fromPageId === page.id && e.via.name === 'Home');
      expect(home).toMatchObject({ to: { pageId: 'pg_01', sameOrigin: true, fragment: false } });
    }
    expect(doc.app.navigation.every((e) => e.provenance.kind === 'measured' && e.provenance.source === 'a11y-tree')).toBe(true);
  });

  it('finds one shared layout covering all three pages with banner, navigation and contentinfo regions', () => {
    expect(doc.app.layouts).toHaveLength(1);
    const layout = doc.app.layouts[0]!;
    expect(layout.pageIds).toEqual(['pg_01', 'pg_02', 'pg_03']);
    expect(layout.regions.map((r) => r.role)).toEqual(['banner', 'navigation', 'main', 'contentinfo']);
    expect(layout.regions[1]).toMatchObject({ role: 'navigation', name: 'Primary' });
    expect(layout.provenance).toMatchObject({ kind: 'measured', source: 'a11y-tree', stateId: doc.app.pages[0]!.stateIds[0] });
  });

  it('lists all three pages on the nav links candidate and only the pages a candidate appears on', () => {
    const seedState = doc.states.items.find((s) => s.pageId === 'pg_01')!;
    const navLinks = seedState.nodes.filter((n) => (n.attrs.class ?? '').split(/\s+/).includes('nav-link'));
    expect(navLinks).toHaveLength(3);
    const candidate = doc.components.definitions.find((d) => doc.components.instances.some((i) => i.definitionId === d.id && i.stateId === seedState.id && i.nodePath === navLinks[0]!.path))!;
    expect(candidate.pageIds).toEqual(['pg_01', 'pg_02', 'pg_03']);
    expect(candidate.instanceCount).toBe(9);
    expect(Object.keys(candidate.matchesByState)).toHaveLength(3);
    const cards = doc.components.definitions.find((d) => d.structure.signature === 'article>h3+p')!;
    expect(cards.pageIds).toEqual(['pg_01']);
    // Nav links, footer links and their list items span all three pages; the plan cards and tabs belong to one page each.
    expect(doc.components.definitions).toHaveLength(9);
    expect(doc.components.definitions.filter((d) => d.pageIds?.length === 3).map((d) => [d.structure.signature, d.instanceCount])).toEqual([
      ['li>a', 21],
      ['a', 12],
      ['a', 9],
    ]);
    expect(doc.visual.tokens.breakpoints).toEqual([]);
    for (const definition of doc.components.definitions) {
      const pages = new Set(doc.components.instances.filter((i) => i.definitionId === definition.id).map((i) => doc.states.items.find((s) => s.id === i.stateId)!.pageId));
      expect(definition.pageIds).toEqual([...pages].sort());
    }
  });
});
