import { describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type Transition, type UiDnaDocument } from '@uidna/schema';
import type { CapturedState } from '../browser/types.js';
import { fixedClock } from '../domain/clock.js';
import { assembleDna } from './assemble.js';
import { buildFixtureACapture, buildFixtureACaptures, buildFixtureAScanRecord, FIXTURE_A_CAPTURED_AT, FIXTURE_A_SCAN_ID, FIXTURE_A_URL, findNode } from './testing.js';

const captures = buildFixtureACaptures();
const scan = buildFixtureAScanRecord({ captures });
const clock = fixedClock('2026-10-13T12:30:00.000Z');

function assemble(extra: Partial<Parameters<typeof assembleDna>[0]> = {}): UiDnaDocument {
  const result = assembleDna({ scan, captures, toolVersion: '0.1.0', clock, ...extra });
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

describe('assembleDna', () => {
  const doc = assemble();

  it('returns a document that validates with no issues', () => {
    const validation = validateUiDna(doc);
    expect(formatIssues(validation)).toEqual([]);
    expect(doc.dnaVersion).toBe('0.1.0');
    expect(doc.target).toMatchObject({ kind: 'url', url: FIXTURE_A_URL, scanId: FIXTURE_A_SCAN_ID, scannedAt: FIXTURE_A_CAPTURED_AT, tool: { name: 'uidna', version: '0.1.0' } });
    expect(doc.target.viewports).toEqual([
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]);
  });

  it('never writes inferred provenance anywhere in the document', () => {
    const kinds = provenanceKinds(JSON.parse(JSON.stringify(doc)));
    expect(kinds.has('inferred')).toBe(false);
    expect(kinds.has('measured')).toBe(true);
    expect(kinds.has('observed')).toBe(true);
  });

  it('describes the app: one page, one route, landmark layout and fragment navigation', () => {
    expect(doc.app.pages).toHaveLength(1);
    const page = doc.app.pages[0]!;
    expect(page.id).toBe('pg_01');
    expect(page.title.value).toBe('Lumen — Notes that think with you');
    expect(page.title.provenance).toMatchObject({ kind: 'measured', source: 'a11y-tree', stateId: 'st_01' });
    expect(page.stateIds).toEqual(['st_01', 'st_02']);
    expect(doc.app.routes).toEqual([expect.objectContaining({ id: 'rt_01', pattern: '/', pageId: 'pg_01' })]);
    expect(doc.app.layouts[0]!.regions.map((r) => r.role)).toEqual(['banner', 'navigation', 'main', 'contentinfo']);
    expect(doc.app.layouts[0]!.regions[1]).toMatchObject({ role: 'navigation', name: 'Primary' });
    const links = findNode(captures.get('st_01')!, '.brand')!;
    const edge = doc.app.navigation.find((e) => e.via.nodeId === links.id)!;
    expect(edge).toMatchObject({ fromPageId: 'pg_01', to: { url: `${FIXTURE_A_URL}#top`, pageId: 'pg_01', sameOrigin: true, fragment: true }, followed: false });
    expect(doc.app.navigation.length).toBe(captures.get('st_01')!.nodes.filter((n) => n.tag === 'a' && n.attrs.href).length);
  });

  it('builds one state per capture with its own provenance context', () => {
    expect(doc.states.items.map((s) => [s.id, s.kind, s.parentStateId, s.viewport.width])).toEqual([
      ['st_01', 'base', null, 1280],
      ['st_02', 'base', null, 390],
    ]);
    const state = doc.states.items[0]!;
    expect(state.provenance).toEqual({
      kind: 'measured',
      source: 'computed-style',
      stateId: 'st_01',
      viewport: { width: 1280, height: 800 },
      evidenceId: 'ev_000000000001',
      capturedAt: FIXTURE_A_CAPTURED_AT,
      confidence: 1,
    });
    expect(state.screenshot?.path).toBe('states/st_01/screenshot.png');
    expect(state.nodeCount).toBe(state.nodes.length);
    expect(doc.evidence.map((e) => e.id)).toEqual(['ev_000000000001', 'ev_000000000002']);
    expect(doc.evidence[0]!.artifacts).toEqual(['states/st_01/capture.json', 'states/st_01/screenshot.png']);
  });

  it('fills components, tokens, layout, assets and evidence', () => {
    expect(doc.components.definitions.length).toBeGreaterThan(3);
    expect(doc.visual.tokens.colors.length).toBeGreaterThan(5);
    expect(doc.visual.tokens.breakpoints.map((t) => t.value.value)).toEqual(['390px']);
    expect(doc.visual.layout.length).toBeGreaterThan(20);
    expect(doc.assets).toHaveLength(1);
    const asset = doc.assets[0]!;
    expect(asset).toMatchObject({ id: 'ast_01', kind: 'image', origin: 'same-origin', authorization: 'unknown' });
    expect(asset.provenance).toMatchObject({ kind: 'measured', source: 'network', stateId: 'st_01' });
    expect(asset.usage).toEqual([
      { stateId: 'st_01', nodeId: expect.any(String), nodePath: '1/0/1/0' },
      { stateId: 'st_02', nodeId: expect.any(String), nodePath: '1/0/1/0' },
    ]);
    expect(doc.behavior).toEqual([]);
    expect(doc.limitations).toEqual([]);
    expect(doc.annotations).toEqual([]);
  });

  it('derives behavior from transitions to derived states', () => {
    const open = buildFixtureACapture({ viewportWidth: 390, menuOpen: true, stateId: 'st_03', capturedAt: '2026-10-13T12:01:00.000Z' });
    const withDerived = new Map([...captures, ['st_03', open]]);
    const toggle = findNode(captures.get('st_02')!, '.nav-toggle')!;
    const transition: Transition = {
      id: 'tr_01',
      from: 'st_02',
      action: { type: 'click', target: { nodeId: toggle.id, nodePath: toggle.path, role: 'button', name: 'Open menu', tag: 'button', nth: 0 } },
      to: 'st_03',
      sideEffects: false,
      network: { requests: 0, nonGet: 0 },
      revert: { method: 'toggle', succeeded: true },
      change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: [toggle.id] },
      provenance: { kind: 'observed', source: 'interaction', stateId: 'st_02', capturedAt: '2026-10-13T12:01:00.000Z', confidence: 1 },
    };
    const explored = buildFixtureAScanRecord({ captures: withDerived, derived: { st_03: { parentStateId: 'st_02', viaTransitionId: 'tr_01' } } });
    const result = assembleDna({ scan: explored, captures: withDerived, transitions: [transition], toolVersion: '0.1.0', clock });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    expect(result.value.states.transitions).toHaveLength(1);
    expect(result.value.states.items.find((s) => s.id === 'st_03')).toMatchObject({ kind: 'derived', parentStateId: 'st_02' });
    expect(result.value.behavior).toHaveLength(1);
    expect(result.value.behavior[0]!.effects.map((e) => e.kind)).toEqual(expect.arrayContaining(['toggle-attribute', 'show', 'toggle-class']));
    expect(result.value.evidence.map((e) => e.kind)).toEqual(['scan', 'scan', 'explore']);
  });

  it('carries over names, authorization, inferred rules, agent limitations and annotations from the previous document', () => {
    const named: UiDnaDocument = JSON.parse(JSON.stringify(doc)) as UiDnaDocument;
    const inferredAt = { kind: 'inferred' as const, source: 'agent' as const, capturedAt: '2026-10-13T12:10:00.000Z', confidence: 0.7, rationale: 'looks like it' };
    const blue = named.visual.tokens.colors.find((t) => t.value.value === '#2f5bea')!;
    blue.name = { value: 'brand-primary', provenance: inferredAt };
    const card = named.components.definitions.find((d) => d.structure.signature === 'article>div+h3+p')!;
    card.name = { value: 'FeatureCard', provenance: inferredAt };
    named.visual.tokens.typography[0]!.name = { value: 'body-small', provenance: inferredAt };
    named.assets[0]!.authorization = 'authorized';
    named.behavior.push({
      id: 'bhv_agent_01',
      event: { type: 'key', target: { nodeId: 'n000', nodePath: '', role: null, name: null, tag: 'body', nth: 0 }, key: 'Escape' },
      transitionId: null,
      effects: [{ kind: 'set-attribute', attribute: 'aria-expanded', to: 'false' }],
      provenance: inferredAt,
    });
    const limitation = { kind: 'not-observed' as const, subject: 'hover states', reason: 'the scan did not hover the nav links' };
    named.limitations.push(limitation);
    named.annotations.push({ id: 'ann_01', appliedAt: '2026-10-13T12:10:00.000Z', path: '/limitations/-', op: 'limitation', value: limitation, provenance: inferredAt });
    named.annotations.push({ id: 'ann_02', appliedAt: '2026-10-13T12:10:00.000Z', path: '/visual/tokens/colors/0/name', op: 'name', value: 'brand-primary', provenance: inferredAt });
    expect(formatIssues(validateUiDna(named))).toEqual([]);

    const next = assemble({ previous: named });
    expect(formatIssues(validateUiDna(next))).toEqual([]);
    expect(next.visual.tokens.colors.find((t) => t.value.value === '#2f5bea')!.name?.value).toBe('brand-primary');
    expect(next.components.definitions.find((d) => d.structure.signature === 'article>div+h3+p')!.name?.value).toBe('FeatureCard');
    expect(next.visual.tokens.typography[0]!.name?.value).toBe('body-small');
    expect(next.assets[0]!.authorization).toBe('authorized');
    expect(next.behavior.map((r) => r.id)).toEqual(['bhv_agent_01']);
    expect(next.limitations).toEqual([limitation]);
    expect(next.annotations.map((a) => a.id)).toEqual(['ann_01', 'ann_02']);
    const kinds = provenanceKinds(JSON.parse(JSON.stringify(next)));
    expect(kinds.has('inferred')).toBe(true);
    // The only inferred provenance comes from the carried-over agent work.
    const stripped: UiDnaDocument = JSON.parse(JSON.stringify(next)) as UiDnaDocument;
    stripped.behavior = stripped.behavior.filter((r) => r.provenance.kind !== 'inferred');
    stripped.annotations = [];
    for (const token of [...stripped.visual.tokens.colors, ...stripped.visual.tokens.typography]) delete token.name;
    for (const definition of stripped.components.definitions) delete definition.name;
    expect(provenanceKinds(JSON.parse(JSON.stringify(stripped))).has('inferred')).toBe(false);
  });

  it('records limitations for truncated screenshots, capture limitations, iframes, inline svg and cross-origin assets', () => {
    const limited = new Map([
      ['st_01', buildFixtureACapture({ viewportWidth: 1280, stateId: 'st_01', screenshot: { truncated: true }, limitations: ['fonts.ready timed out'], withEmbeds: true })],
      ['st_02', buildFixtureACapture({ viewportWidth: 390, stateId: 'st_02', withEmbeds: true })],
    ]);
    const result = assembleDna({ scan: buildFixtureAScanRecord({ captures: limited }), captures: limited, toolVersion: '0.1.0', clock });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(formatIssues(validateUiDna(result.value))).toEqual([]);
    const kinds = result.value.limitations.map((l) => `${l.kind}:${l.subject}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'not-observed:state st_01',
        'not-observed:screenshot of st_01',
        'not-accessible:iframe https://maps.example.com/embed',
        'not-reconstructable:asset https://maps.example.com/embed',
      ]),
    );
    expect(result.value.limitations.some((l) => l.kind === 'not-reconstructable' && l.subject.startsWith('inline svg'))).toBe(true);
    expect(result.value.limitations.find((l) => l.subject === 'state st_01')!.reason).toBe('fonts.ready timed out');
    expect(result.value.limitations.find((l) => l.subject === 'screenshot of st_01')!.reason).toContain('truncated');
    expect(result.value.assets.find((a) => a.origin === 'cross-origin')!.authorization).toBe('unknown');
  });

  it('identifies inline assets by node path across states, never by positional node id', () => {
    const inlineAsset = (c: CapturedState, selector: string, url: string): CapturedState => {
      const node = findNode(c, selector)!;
      return { ...c, assets: [...c.assets, { id: 'as_09', kind: 'svg', url, origin: 'inline', usedBy: [node.id] }] };
    };
    const desktop = buildFixtureACapture({ viewportWidth: 1280, stateId: 'st_01', withEmbeds: true });
    const phone = buildFixtureACapture({ viewportWidth: 390, stateId: 'st_02', withEmbeds: true });

    // Same element (same path) under different node ids: one asset used in both states.
    const samePath = new Map([
      ['st_01', inlineAsset(desktop, 'svg', 'inline:n900')],
      ['st_02', inlineAsset(phone, 'svg', 'inline:n901')],
    ]);
    const merged = assembleDna({ scan: buildFixtureAScanRecord({ captures: samePath }), captures: samePath, toolVersion: '0.1.0', clock });
    if (!merged.ok) throw new Error(merged.error.message);
    const inline = merged.value.assets.filter((a) => a.origin === 'inline');
    expect(inline).toHaveLength(1);
    expect(inline[0]!.usage.map((u) => u.stateId)).toEqual(['st_01', 'st_02']);

    // Same node id but different elements: two assets.
    const sameId = new Map([
      ['st_01', inlineAsset(desktop, 'svg', 'inline:n900')],
      ['st_02', inlineAsset(phone, 'iframe', 'inline:n900')],
    ]);
    const split = assembleDna({ scan: buildFixtureAScanRecord({ captures: sameId }), captures: sameId, toolVersion: '0.1.0', clock });
    if (!split.ok) throw new Error(split.error.message);
    expect(split.value.assets.filter((a) => a.origin === 'inline')).toHaveLength(2);
  });

  it('reports states without captures as limitations and refuses captures the scan does not list', () => {
    const partial = new Map([['st_01', captures.get('st_01')!]]);
    const result = assembleDna({ scan, captures: partial, toolVersion: '0.1.0', clock });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.states.items.map((s) => s.id)).toEqual(['st_01']);
    expect(result.value.limitations).toEqual([expect.objectContaining({ kind: 'not-observed', subject: 'state st_02' })]);
    expect(result.value.visual.tokens.breakpoints).toEqual([]);

    const extra = new Map([...captures, ['st_09', captures.get('st_01')!]]);
    const refused = assembleDna({ scan, captures: extra, toolVersion: '0.1.0', clock });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error._tag).toBe('validation');
  });

  it('is deterministic', () => {
    expect(JSON.stringify(assemble())).toBe(JSON.stringify(doc));
  });
});
