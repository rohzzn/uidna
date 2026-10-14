/**
 * Multi-page assembly on the synthetic two-page crawl (`buildMultiPageFixture`):
 * pages, routes, navigation edges matched to crawled pages, the shared layout,
 * cross-page component candidates, per-page breakpoints, per-page coverage from
 * the explore record, data assets, and the honest fallbacks (unresolved
 * discoveredVia, unlisted pages, scans without a page list).
 */
import { describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type UiDnaDocument } from '@rohzzn/uidna-schema';
import type { ExploreRecord, ScanRecord } from '../application/records.js';
import type { CapturedAsset, CapturedState } from '../browser/types.js';
import { fixedClock } from '../domain/clock.js';
import { assembleDna, type AssembleInput } from './assemble.js';
import { buildFixtureACapture, buildFixtureAScanRecord, buildMultiPageFixture, FIXTURE_A_FEATURES_URL, FIXTURE_A_URL, findNode, findNodes, MULTI_PAGE_NAV_LINKS } from './testing.js';

const clock = fixedClock('2026-10-13T12:30:00.000Z');
const fixture = buildMultiPageFixture();

function assemble(extra: Partial<AssembleInput> = {}): UiDnaDocument {
  const result = assembleDna({ scan: fixture.scan, captures: fixture.captures, toolVersion: '0.1.0', clock, ...extra });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
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

describe('assembleDna over a two-page crawl', () => {
  const doc = assemble();
  const seed = fixture.captures.get('st_01')!;

  it('validates, stays deterministic and never infers', () => {
    expect(formatIssues(validateUiDna(doc))).toEqual([]);
    expect(provenanceKinds(JSON.parse(JSON.stringify(doc)))).toEqual(new Set(['measured', 'observed']));
    expect(JSON.stringify(assemble())).toBe(JSON.stringify(doc));
  });

  it('lists one page per crawled page with depth, states, title and the navigation edge that discovered it', () => {
    expect(doc.app.pages.map((p) => [p.id, p.url, p.depth, p.stateIds])).toEqual([
      ['pg_01', FIXTURE_A_URL, 0, ['st_01', 'st_02']],
      ['pg_02', FIXTURE_A_FEATURES_URL, 1, ['st_03', 'st_04']],
    ]);
    expect(doc.app.pages[0]!.discoveredVia).toBeNull();
    expect(doc.app.pages[1]!.title).toMatchObject({ value: 'Lumen — Features', provenance: { kind: 'measured', source: 'a11y-tree', stateId: 'st_03' } });
    const via = doc.app.navigation.find((e) => e.id === doc.app.pages[1]!.discoveredVia);
    expect(via).toMatchObject({ fromPageId: 'pg_01', via: { nodePath: fixture.featuresLinkPath, name: 'Features' }, to: { pageId: 'pg_02', sameOrigin: true, fragment: false }, followed: true });
    for (const state of doc.states.items) expect(doc.app.pages.find((p) => p.id === state.pageId)!.stateIds).toContain(state.id);
    expect(doc.app.routes).toEqual([
      expect.objectContaining({ id: 'rt_01', pattern: '/', pageId: 'pg_01' }),
      expect.objectContaining({ id: 'rt_02', pattern: '/features.html', pageId: 'pg_02' }),
    ]);
    expect(doc.app.routes[1]!.provenance).toMatchObject({ kind: 'measured', source: 'network', stateId: 'st_03' });
  });

  it('resolves every page’s links against its own URL and matches them to crawled pages', () => {
    const fromSeed = doc.app.navigation.filter((e) => e.fromPageId === 'pg_01');
    const fromFeatures = doc.app.navigation.filter((e) => e.fromPageId === 'pg_02');
    expect(fromSeed).toHaveLength(seed.nodes.filter((n) => n.tag === 'a' && n.attrs.href).length);
    expect(fromFeatures).toHaveLength(fixture.captures.get('st_03')!.nodes.filter((n) => n.tag === 'a' && n.attrs.href).length);
    expect(doc.app.navigation.map((e) => e.id)).toEqual(doc.app.navigation.map((_, i) => `nav_${(i + 1).toString().padStart(2, '0')}`));

    const byName = (edges: typeof fromSeed, name: string) => edges.find((e) => e.via.name === name && e.via.role === 'link')!;
    expect(byName(fromSeed, 'Features').to).toEqual({ url: FIXTURE_A_FEATURES_URL, pageId: 'pg_02', sameOrigin: true, fragment: false });
    expect(byName(fromSeed, 'Pricing')).toMatchObject({ to: { url: 'http://127.0.0.1:4173/pricing.html', pageId: null, sameOrigin: true, fragment: false }, followed: false });
    expect(byName(fromSeed, 'FAQ')).toMatchObject({ to: { url: `${FIXTURE_A_URL}#faq`, pageId: 'pg_01', sameOrigin: true, fragment: true }, followed: false });
    expect(byName(fromSeed, 'Status')).toMatchObject({ to: { url: 'https://example.com/status', pageId: null, sameOrigin: false, fragment: false }, followed: false });
    // From the features page, "Features" is a link to itself and "FAQ" a fragment of the features page, not of the seed.
    expect(byName(fromFeatures, 'Features').to).toEqual({ url: FIXTURE_A_FEATURES_URL, pageId: 'pg_02', sameOrigin: true, fragment: false });
    expect(byName(fromFeatures, 'FAQ').to).toEqual({ url: `${FIXTURE_A_FEATURES_URL}#faq`, pageId: 'pg_02', sameOrigin: true, fragment: true });
    expect(byName(fromFeatures, 'FAQ').provenance).toMatchObject({ kind: 'measured', source: 'a11y-tree', stateId: 'st_03' });
  });

  it('shares one layout between pages whose header and footer agree, with regions from the first page', () => {
    expect(doc.app.layouts).toHaveLength(1);
    expect(doc.app.layouts[0]).toMatchObject({ id: 'lay_01', pageIds: ['pg_01', 'pg_02'], provenance: { kind: 'measured', source: 'a11y-tree', stateId: 'st_01' } });
    expect(doc.app.layouts[0]!.regions.map((r) => r.role)).toEqual(['banner', 'navigation', 'main', 'contentinfo']);
    expect(doc.app.layouts[0]!.regions[0]!.nodeId).toBe(findNode(seed, '.site-header')!.id);
  });

  it('splits the layout when a page’s footer differs structurally', () => {
    const different = buildFixtureACapture({ navLinks: fixture.scan.pages![0] ? undefined : undefined, viewportWidth: 1280, stateId: 'st_03', url: FIXTURE_A_FEATURES_URL, withEmbeds: true });
    const captures = new Map([...fixture.captures, ['st_03', different]]);
    const result = assembleDna({ scan: fixture.scan, captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.app.layouts.map((l) => [l.id, l.pageIds])).toEqual([
      ['lay_01', ['pg_01']],
      ['lay_02', ['pg_02']],
    ]);
  });

  it('lists the pages every component candidate appears on', () => {
    const navLinks = findNodes(seed, '.nav-link');
    const navDefinition = doc.components.definitions.find((d) => doc.components.instances.some((i) => i.definitionId === d.id && i.stateId === 'st_01' && i.nodePath === navLinks[0]!.path))!;
    expect(navDefinition.pageIds).toEqual(['pg_01', 'pg_02']);
    // At 390 the menu is closed, so the links are only visible (and only instances) in the 1280 states.
    expect(navDefinition.matchesByState).toEqual({ st_01: 4, st_03: 4 });
    for (const definition of doc.components.definitions) {
      const pages = new Set(doc.components.instances.filter((i) => i.definitionId === definition.id).map((i) => doc.states.items.find((s) => s.id === i.stateId)!.pageId));
      expect(definition.pageIds).toEqual([...pages].sort());
    }
  });

  it('detects breakpoints per page and merges equal widths with their evidence added up', () => {
    const single = assembleDna({ scan: buildFixtureAScanRecord(), captures: new Map([...fixture.captures].filter(([id]) => id === 'st_01' || id === 'st_02')), toolVersion: '0.1.0', clock });
    if (!single.ok) throw new Error(single.error.message);
    const one = single.value.visual.tokens.breakpoints[0]!;
    expect(doc.visual.tokens.breakpoints).toHaveLength(1);
    const merged = doc.visual.tokens.breakpoints[0]!;
    expect(merged).toMatchObject({ id: 'tok_bp_01', generatedName: 'bp-01', value: { value: '390px' } });
    expect(merged.usage.stateIds).toEqual(['st_02', 'st_01', 'st_04', 'st_03']);
    expect(merged.cluster.sampleCount).toBeGreaterThan(one.cluster.sampleCount);
    expect(merged.usage.count).toBe(merged.cluster.sampleCount);
    expect(merged.cluster.members).toEqual([
      { value: '390px', count: 2 },
      { value: '1280px', count: 2 },
    ]);
  });

  it('copies per-page coverage from the explore record and falls back to the run total for one page only', () => {
    const explore: ExploreRecord = {
      scanId: fixture.scan.scanId,
      policy: 'safe',
      startedAt: '2026-10-13T12:10:00.000Z',
      finishedAt: '2026-10-13T12:11:00.000Z',
      evidenceId: 'ev_0000000000ex',
      budget: fixture.scan.budget,
      coverage: { discovered: 30, explored: 20, changed: 5, skipped: 3 },
      coverageByPage: { pg_01: { discovered: 18, explored: 12, changed: 3, skipped: 2 }, pg_02: { discovered: 12, explored: 8, changed: 2, skipped: 1 } },
      attempted: [],
      skipped: [],
      transitionIds: [],
      newStateIds: [],
      limitations: [],
      unknowns: [],
      partial: false,
    };
    const withCoverage = assemble({ explore });
    expect(withCoverage.app.pages.map((p) => p.coverage)).toEqual([
      { discovered: 18, explored: 12, changed: 3, skipped: 2 },
      { discovered: 12, explored: 8, changed: 2, skipped: 1 },
    ]);
    expect(doc.app.pages.every((p) => p.coverage === undefined)).toBe(true);

    const { coverageByPage, ...legacy } = explore;
    expect(coverageByPage).toBeDefined();
    const twoPagesLegacy = assemble({ explore: legacy });
    expect(twoPagesLegacy.app.pages.every((p) => p.coverage === undefined)).toBe(true);
    const singlePage = assembleDna({ scan: buildFixtureAScanRecord(), captures: new Map([...fixture.captures].filter(([id]) => id === 'st_01' || id === 'st_02')), explore: legacy, toolVersion: '0.1.0', clock });
    if (!singlePage.ok) throw new Error(singlePage.error.message);
    expect(singlePage.value.app.pages[0]!.coverage).toEqual({ discovered: 30, explored: 20, changed: 5, skipped: 3 });
  });

  it('reports an unresolvable discoveredVia as null with a limitation instead of guessing', () => {
    const scan: ScanRecord = { ...fixture.scan, pages: fixture.scan.pages!.map((p) => (p.pageId === 'pg_02' ? { ...p, discoveredVia: 'pg_01:9/9/9' } : p)) };
    const result = assembleDna({ scan, captures: fixture.captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.app.pages[1]!.discoveredVia).toBeNull();
    expect(result.value.limitations).toEqual([expect.objectContaining({ kind: 'not-observed', subject: 'page pg_02' })]);
    expect(result.value.limitations[0]!.reason).toContain('pg_01:9/9/9');
  });

  it('assembles a scan without a page list as one seed page, and reconstructs an unlisted page from its states', () => {
    const legacy = buildFixtureAScanRecord();
    expect(legacy.pages).toBeUndefined();
    expect(legacy.states.every((s) => s.pageId === undefined)).toBe(true);
    const captures = new Map([...fixture.captures].filter(([id]) => id === 'st_01' || id === 'st_02'));
    const single = assembleDna({ scan: legacy, captures, toolVersion: '0.1.0', clock });
    if (!single.ok) throw new Error(single.error.message);
    expect(single.value.app.pages).toEqual([expect.objectContaining({ id: 'pg_01', url: FIXTURE_A_URL, depth: 0, discoveredVia: null, stateIds: ['st_01', 'st_02'] })]);
    expect(single.value.limitations).toEqual([]);

    const unlisted: ScanRecord = { ...fixture.scan, pages: fixture.scan.pages!.filter((p) => p.pageId === 'pg_01') };
    const result = assembleDna({ scan: unlisted, captures: fixture.captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    expect(result.value.app.pages.map((p) => [p.id, p.depth, p.discoveredVia, p.stateIds])).toEqual([
      ['pg_01', 0, null, ['st_01', 'st_02']],
      ['pg_02', undefined, undefined, ['st_03', 'st_04']],
    ]);
    expect(result.value.limitations).toEqual([expect.objectContaining({ kind: 'not-observed', subject: 'page pg_02', stateId: 'st_03' })]);
  });

  it('records a page without any capture with an unknown title and a limitation', () => {
    const scan: ScanRecord = { ...fixture.scan, pages: [...fixture.scan.pages!, { pageId: 'pg_03', url: 'http://127.0.0.1:4173/pricing.html', depth: 1, discoveredVia: 'pg_01:0/0/2/1/0', title: '' }] };
    const result = assembleDna({ scan, captures: fixture.captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    const page = result.value.app.pages[2]!;
    expect(page).toMatchObject({ id: 'pg_03', url: 'http://127.0.0.1:4173/pricing.html', stateIds: [], depth: 1 });
    expect(page.title).toEqual({ value: null, provenance: { kind: 'unknown', reason: 'no state of this page was captured' } });
    expect(result.value.app.routes[2]).toMatchObject({ id: 'rt_03', pattern: '/pricing.html', pageId: 'pg_03' });
    expect(result.value.limitations.some((l) => l.subject === 'page pg_03' && l.reason === 'no state of this page was captured')).toBe(true);
    // The seed's "Pricing" link now points at a crawled page.
    expect(result.value.app.navigation.find((e) => e.fromPageId === 'pg_01' && e.via.name === 'Pricing')).toMatchObject({ to: { pageId: 'pg_03' }, followed: true });
  });
});

describe('data assets', () => {
  const itemsAsset: CapturedAsset = {
    id: 'as_10',
    kind: 'data',
    url: 'http://127.0.0.1:4173/api/items.json',
    origin: 'same-origin',
    mime: 'application/json',
    bytes: 312,
    digest: 'd1',
    usedBy: [],
    localPath: 'assets\\data\\d1.json',
    request: { method: 'GET', status: 200, mime: 'application/json' },
  };
  const signupAsset: CapturedAsset = { ...itemsAsset, id: 'as_11', url: 'http://127.0.0.1:4173/api/signup', bytes: 27, digest: 'd2', localPath: 'assets/data/d2.json', request: { method: 'POST', status: 200, mime: 'application/json' } };

  function withAssets(assets: readonly CapturedAsset[], stateId: string, width: number): CapturedState {
    return buildFixtureACapture({ viewportWidth: width, stateId, extraAssets: assets });
  }

  it('turns captured JSON responses into data assets with their request, local copy and network provenance', () => {
    const captures = new Map([
      ['st_01', withAssets([itemsAsset], 'st_01', 1280)],
      ['st_02', withAssets([itemsAsset, signupAsset], 'st_02', 390)],
    ]);
    const result = assembleDna({ scan: buildFixtureAScanRecord({ captures }), captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    const data = result.value.assets.filter((a) => a.kind === 'data');
    expect(data).toHaveLength(2);
    expect(data[0]).toEqual({
      id: 'ast_02',
      kind: 'data',
      url: 'http://127.0.0.1:4173/api/items.json',
      origin: 'same-origin',
      mime: 'application/json',
      bytes: 312,
      digest: 'd1',
      localPath: 'assets/data/d1.json',
      request: { method: 'GET', status: 200, mime: 'application/json' },
      authorization: 'unknown',
      usage: [],
      provenance: { kind: 'measured', source: 'network', stateId: 'st_01', viewport: { width: 1280, height: 800 }, evidenceId: 'ev_000000000001', capturedAt: captures.get('st_01')!.capturedAt, confidence: 1 },
    });
    expect(data[1]).toMatchObject({ id: 'ast_03', url: 'http://127.0.0.1:4173/api/signup', request: { method: 'POST' }, provenance: { stateId: 'st_02' } });
    expect(result.value.limitations).toEqual([]);
  });

  it('keeps different URLs and different responses of one URL apart, and merges identical responses', () => {
    const other: CapturedAsset = { ...itemsAsset, id: 'as_12', digest: 'd3', bytes: 400, localPath: 'assets/data/d3.json' };
    const captures = new Map([
      ['st_01', withAssets([itemsAsset, other], 'st_01', 1280)],
      ['st_02', withAssets([itemsAsset], 'st_02', 390)],
    ]);
    const result = assembleDna({ scan: buildFixtureAScanRecord({ captures }), captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.assets.filter((a) => a.kind === 'data').map((a) => [a.url, a.digest])).toEqual([
      ['http://127.0.0.1:4173/api/items.json', 'd1'],
      ['http://127.0.0.1:4173/api/items.json', 'd3'],
    ]);
  });

  it('keeps an agent authorization of a data asset across re-assembly', () => {
    const captures = new Map([['st_01', withAssets([itemsAsset], 'st_01', 1280)]]);
    const scan = buildFixtureAScanRecord({ captures });
    const first = assembleDna({ scan, captures, toolVersion: '0.1.0', clock });
    if (!first.ok) throw new Error(first.error.message);
    const previous: UiDnaDocument = JSON.parse(JSON.stringify(first.value)) as UiDnaDocument;
    previous.assets.find((a) => a.kind === 'data')!.authorization = 'authorized';
    const again = assembleDna({ scan, captures, previous, toolVersion: '0.1.0', clock });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.assets.find((a) => a.kind === 'data')!.authorization).toBe('authorized');
  });

  it('never carries an authorization over to a different response body of the same endpoint', () => {
    const captures = new Map([['st_01', withAssets([itemsAsset], 'st_01', 1280)]]);
    const scan = buildFixtureAScanRecord({ captures });
    const first = assembleDna({ scan, captures, toolVersion: '0.1.0', clock });
    if (!first.ok) throw new Error(first.error.message);
    const previous: UiDnaDocument = JSON.parse(JSON.stringify(first.value)) as UiDnaDocument;
    previous.assets.find((a) => a.kind === 'data')!.authorization = 'authorized';
    // The endpoint now answers with another body (digest d3) next to the authorized one.
    const other: CapturedAsset = { ...itemsAsset, id: 'as_12', digest: 'd3', bytes: 400, localPath: 'assets/data/d3.json' };
    const rescanned = new Map([['st_01', withAssets([itemsAsset, other], 'st_01', 1280)]]);
    const again = assembleDna({ scan: buildFixtureAScanRecord({ captures: rescanned }), captures: rescanned, previous, toolVersion: '0.1.0', clock });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.assets.filter((a) => a.kind === 'data').map((a) => [a.digest, a.authorization])).toEqual([
      ['d1', 'authorized'],
      ['d3', 'unknown'],
    ]);
  });
});

describe('page membership and page-scoped identities', () => {
  const pages = fixture.scan.pages!;
  const pageIdByState = { st_01: 'pg_01', st_02: 'pg_01', st_03: 'pg_02', st_04: 'pg_02' } as const;

  it('places a derived state recorded without a page id on the page of the state it derives from, not on the seed', () => {
    // The explorer records derived states without a page id; a menu opened on the features page belongs to the features page.
    const derived = buildFixtureACapture({ navLinks: MULTI_PAGE_NAV_LINKS, viewportWidth: 390, stateId: 'st_05', url: FIXTURE_A_FEATURES_URL, title: 'Lumen — Features', openFaq: 0, menuOpen: true });
    const captures = new Map([...fixture.captures, ['st_05', derived]]);
    const recorded = buildFixtureAScanRecord({ captures, pages, pageIdByState, derived: { st_05: { parentStateId: 'st_04', viaTransitionId: 'tr_01' } } });
    const scan: ScanRecord = {
      ...recorded,
      states: recorded.states.map((state) => {
        if (state.stateId !== 'st_05') return state;
        const { pageId, ...withoutPage } = state;
        expect(pageId).toBeDefined();
        return withoutPage;
      }),
    };
    const result = assembleDna({ scan, captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    expect(result.value.app.pages.map((p) => [p.id, p.stateIds])).toEqual([
      ['pg_01', ['st_01', 'st_02']],
      ['pg_02', ['st_03', 'st_04', 'st_05']],
    ]);
    expect(result.value.states.items.find((s) => s.id === 'st_05')).toMatchObject({ pageId: 'pg_02', kind: 'derived', parentStateId: 'st_04' });
    expect(result.value.limitations).toEqual([]);

    // A record that names a page id is trusted as written.
    const explicit = assembleDna({ scan: recorded, captures, toolVersion: '0.1.0', clock });
    if (!explicit.ok) throw new Error(explicit.error.message);
    expect(explicit.value.states.items.find((s) => s.id === 'st_05')?.pageId).toBe('pg_01');
  });

  it('keeps inline assets at the same structural path on different pages apart', () => {
    const inlineAsset = (c: CapturedState, selector: string, url: string): CapturedState => {
      const node = findNode(c, selector)!;
      return { ...c, assets: [...c.assets, { id: 'as_09', kind: 'svg', url, origin: 'inline', usedBy: [node.id] }] };
    };
    const common = { navLinks: MULTI_PAGE_NAV_LINKS, viewportWidth: 1280, withEmbeds: true } as const;
    const home = inlineAsset(buildFixtureACapture({ ...common, stateId: 'st_01' }), 'svg', 'inline:n900');
    const features = inlineAsset(buildFixtureACapture({ ...common, stateId: 'st_03', url: FIXTURE_A_FEATURES_URL, title: 'Lumen — Features' }), 'svg', 'inline:n900');
    expect(findNode(home, 'svg')!.path).toBe(findNode(features, 'svg')!.path);
    const captures = new Map([
      ['st_01', home],
      ['st_03', features],
    ]);
    const scan = buildFixtureAScanRecord({ captures, pages, pageIdByState });
    const result = assembleDna({ scan, captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    const inline = result.value.assets.filter((a) => a.origin === 'inline');
    expect(inline.map((a) => a.usage.map((u) => u.stateId))).toEqual([['st_01'], ['st_03']]);
    expect(result.value.limitations.filter((l) => l.subject.startsWith('inline svg')).map((l) => l.stateId)).toEqual(['st_01', 'st_03']);
  });

  it('records a route whose page URL cannot be parsed with unknown provenance instead of a made-up "/"', () => {
    const scan: ScanRecord = { ...fixture.scan, pages: [...pages, { pageId: 'pg_03', url: 'not a url', depth: 1, discoveredVia: null, title: '' }] };
    const result = assembleDna({ scan, captures: fixture.captures, toolVersion: '0.1.0', clock });
    if (!result.ok) throw new Error(result.error.message);
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    const route = result.value.app.routes[2]!;
    expect(route).toMatchObject({ id: 'rt_03', pattern: 'not a url', pageId: 'pg_03', provenance: { kind: 'unknown', source: 'network' } });
    if (route.provenance.kind === 'unknown') expect(route.provenance.reason).toContain('could not be parsed');
    expect(result.value.app.routes.slice(0, 2).every((r) => r.provenance.kind === 'measured')).toBe(true);
  });
});
