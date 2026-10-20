/**
 * Test helpers for the application layer: a small but complete UI DNA
 * document, a scan record that matches it, and a temporary scan store.
 * Not part of the public API.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measured, observed, UI_DNA_VERSION, type UiDnaDocument, type UiNode, type UiState } from 'uidna-schema';
import type { BrowserAvailability, BrowserProvider } from '../browser/types.js';
import { fixedClock, type Clock } from '../domain/clock.js';
import { uidnaError } from '../domain/errors.js';
import { err } from '../domain/result.js';
import { createContext, type WorkflowContext } from './context.js';
import type { ScanRecord } from './records.js';
import { ScanStore } from './scan-store.js';

/** Fixed timestamp used by the sample document. */
export const SAMPLE_AT = '2026-10-13T17:29:00.000Z';

/** Scan id of the sample document. */
export const SAMPLE_SCAN_ID = 'scan_20261013_abcdef';

function node(partial: Partial<UiNode> & Pick<UiNode, 'id' | 'path' | 'tag' | 'styleId'>): UiNode {
  return {
    parentId: null,
    depth: partial.path === '' ? 0 : partial.path.split('/').length,
    role: null,
    name: null,
    attrs: {},
    text: null,
    box: { x: 0, y: 0, width: 100, height: 20 },
    a11y: {},
    visible: true,
    interactive: false,
    inForm: false,
    childIds: [],
    ...partial,
  };
}

function state(id: string, width: number, menuVisible: boolean): UiState {
  const ctx = { stateId: id, viewport: { width, height: 800 }, evidenceId: `ev_${id}00000000`, capturedAt: SAMPLE_AT };
  const nodes: UiNode[] = [
    node({ id: 'n0', path: '', tag: 'body', styleId: 's_body', childIds: ['n1', 'n5'], box: { x: 0, y: 0, width, height: 1200 } }),
    node({ id: 'n1', parentId: 'n0', path: '0', tag: 'header', role: 'banner', styleId: 's_body', childIds: ['n2', 'n3'] }),
    node({
      id: 'n2',
      parentId: 'n1',
      path: '0/0',
      tag: 'button',
      role: 'button',
      name: 'Open menu',
      attrs: { type: 'button', 'aria-expanded': menuVisible ? 'true' : 'false', 'aria-controls': 'primary-menu', class: 'nav-toggle' },
      styleId: 's_button',
      a11y: { expanded: menuVisible, focusable: true, nth: 0 },
      interactive: true,
      box: width < 768 ? { x: 10, y: 10, width: 40, height: 40 } : null,
      visible: width < 768,
    }),
    node({
      id: 'n3',
      parentId: 'n1',
      path: '0/1',
      tag: 'ul',
      role: 'list',
      attrs: { id: 'primary-menu', class: menuVisible ? 'nav-menu is-open' : 'nav-menu' },
      styleId: 's_body',
      childIds: ['n4'],
      box: width >= 768 || menuVisible ? { x: 0, y: 60, width, height: 120 } : null,
      visible: width >= 768 || menuVisible,
    }),
    node({ id: 'n4', parentId: 'n3', path: '0/1/0', tag: 'a', role: 'link', name: 'Features', attrs: { href: '#features', class: 'nav-link' }, text: 'Features', styleId: 's_link', interactive: true, visible: width >= 768 || menuVisible }),
    node({ id: 'n5', parentId: 'n0', path: '1', tag: 'main', role: 'main', styleId: 's_body', childIds: ['n6', 'n7', 'n8'] }),
    node({ id: 'n6', parentId: 'n5', path: '1/0', tag: 'h1', role: 'heading', name: 'Notes that think with you', text: 'Notes that think with you', styleId: 's_h1', a11y: { level: 1 } }),
    node({ id: 'n7', parentId: 'n5', path: '1/1', tag: 'article', styleId: 's_card', childIds: ['n9'], box: { x: 0, y: 300, width: 300, height: 200 } }),
    node({ id: 'n8', parentId: 'n5', path: '1/2', tag: 'article', styleId: 's_card', childIds: ['n10'], box: { x: 320, y: 300, width: 300, height: 200 } }),
    node({ id: 'n9', parentId: 'n7', path: '1/1/0', tag: 'h3', role: 'heading', name: 'Capture quickly', text: 'Capture quickly', styleId: 's_h3', a11y: { level: 3 } }),
    node({ id: 'n10', parentId: 'n8', path: '1/2/0', tag: 'h3', role: 'heading', name: 'Link naturally', text: 'Link naturally', styleId: 's_h3', a11y: { level: 3 } }),
    node({ id: 'n11', parentId: 'n5', path: '1/3', tag: 'img', role: 'img', name: 'Illustration', attrs: { src: 'assets/illustration.svg', alt: 'Illustration' }, styleId: 's_body', box: { x: 0, y: 520, width: 520, height: 400 } }),
  ];
  const main = nodes[5];
  if (main) main.childIds = ['n6', 'n7', 'n8', 'n11'];
  return {
    id,
    pageId: 'pg_01',
    kind: menuVisible ? 'derived' : 'base',
    parentStateId: menuVisible ? 'st_02' : null,
    url: 'http://127.0.0.1:4173/',
    title: 'Lumen',
    viewport: { width, height: 800 },
    capturedAt: SAMPLE_AT,
    evidenceId: ctx.evidenceId,
    screenshot: { path: `states/${id}/screenshot.png`, width, height: 1200, digest: `digest-${id}`, truncated: false },
    roleTreeDigest: `role-${id}-${menuVisible ? 'open' : 'closed'}`,
    domDigest: `dom-${id}-${menuVisible ? 'open' : 'closed'}`,
    document: { width, height: 1200, scrollHeight: 1200 },
    nodeCount: nodes.length,
    nodes,
    styles: {
      s_body: { display: 'block', color: 'rgb(27, 31, 42)', 'font-family': 'Segoe UI, sans-serif', 'font-size': '16px' },
      s_button: { display: width < 768 ? 'flex' : 'none', 'background-color': 'rgb(255, 255, 255)', 'border-top-left-radius': '6px', 'padding-top': '8px' },
      s_link: { display: 'inline-block', color: 'rgb(91, 100, 116)', 'font-size': '15px', 'padding-top': '8px' },
      s_h1: { display: 'block', 'font-size': '48px', 'font-weight': '700', color: 'rgb(27, 31, 42)', 'font-family': 'Segoe UI, sans-serif' },
      s_h3: { display: 'block', 'font-size': '20px', 'font-weight': '600', color: 'rgb(27, 31, 42)', 'font-family': 'Segoe UI, sans-serif' },
      s_card: { display: 'block', 'background-color': 'rgb(255, 255, 255)', 'border-top-left-radius': '12px', 'padding-top': '24px', 'box-shadow': 'rgba(27, 31, 42, 0.08) 0px 8px 24px 0px' },
    },
    roleTree: nodes
      .filter((n) => n.role !== null && n.visible)
      .map((n) => {
        const states: Record<string, string | number | boolean> = {};
        if (n.a11y.expanded !== undefined) states.expanded = n.a11y.expanded;
        return { nodeId: n.id, role: n.role ?? '', name: n.name ?? '', depth: n.depth, states };
      }),
    provenance: { kind: 'measured', source: 'computed-style', stateId: id, viewport: { width, height: 800 }, evidenceId: ctx.evidenceId, capturedAt: SAMPLE_AT, confidence: 1 },
  };
}

/** A complete, valid sample document: two base states (1280, 390) and one derived state (menu open at 390). */
export function sampleDocument(): UiDnaDocument {
  const st1 = state('st_01', 1280, false);
  const st2 = state('st_02', 390, false);
  const st3 = state('st_03', 390, true);
  const ctx = (s: UiState) => ({ stateId: s.id, viewport: s.viewport, evidenceId: s.evidenceId, capturedAt: SAMPLE_AT });
  return {
    dnaVersion: UI_DNA_VERSION,
    target: {
      kind: 'url',
      url: 'http://127.0.0.1:4173/',
      scanId: SAMPLE_SCAN_ID,
      scannedAt: SAMPLE_AT,
      viewports: [
        { width: 1280, height: 800 },
        { width: 390, height: 800 },
      ],
      budget: { limits: { timeMs: 180000, pages: 1, actions: 60, resources: 400 }, used: { timeMs: 4200, pages: 1, actions: 2, resources: 4 } },
      tool: { name: 'uidna', version: '0.1.0' },
    },
    app: {
      pages: [{ id: 'pg_01', url: 'http://127.0.0.1:4173/', title: measured('Lumen', 'a11y-tree', ctx(st1)), stateIds: ['st_01', 'st_02', 'st_03'] }],
      routes: [{ id: 'rt_01', pattern: '/', pageId: 'pg_01', provenance: st1.provenance }],
      layouts: [{ id: 'ly_01', pageIds: ['pg_01'], regions: [{ role: 'banner', name: null, nodePath: '0', nodeId: 'n1' }, { role: 'main', name: null, nodePath: '1', nodeId: 'n5' }], provenance: st1.provenance }],
      navigation: [
        {
          id: 'nav_01',
          fromPageId: 'pg_01',
          to: { url: 'http://127.0.0.1:4173/#features', pageId: 'pg_01', sameOrigin: true, fragment: true },
          via: { nodeId: 'n4', nodePath: '0/1/0', role: 'link', name: 'Features' },
          followed: false,
          provenance: st1.provenance,
        },
      ],
    },
    states: {
      items: [st1, st2, st3],
      transitions: [
        {
          id: 'tr_01',
          from: 'st_02',
          to: 'st_03',
          action: { type: 'click', target: { nodeId: 'n2', nodePath: '0/0', role: 'button', name: 'Open menu', tag: 'button', nth: 0 } },
          sideEffects: false,
          network: { requests: 0, nonGet: 0 },
          revert: { method: 'toggle', succeeded: true },
          change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: ['n2', 'n3', 'n4'] },
          provenance: { kind: 'observed', source: 'interaction', stateId: 'st_02', viewport: st2.viewport, evidenceId: 'ev_tr0100000000', capturedAt: SAMPLE_AT, confidence: 1 },
        },
      ],
    },
    components: {
      definitions: [
        {
          id: 'cmp_01',
          fingerprint: 'fp-card',
          generatedName: 'Component01',
          structure: { tag: 'article', role: null, signature: 'article>h3', depth: 1, childCount: 1 },
          props: [{ name: 'heading', kind: 'text', relativePath: '0', values: ['Capture quickly', 'Link naturally'] }],
          variants: [],
          instanceCount: 4,
          matchesByState: { st_01: 2, st_02: 2 },
          confidence: 0.85,
          provenance: st1.provenance,
        },
      ],
      instances: [
        { id: 'inst_001', definitionId: 'cmp_01', stateId: 'st_01', nodeId: 'n7', nodePath: '1/1', box: measured({ x: 0, y: 300, width: 300, height: 200 }, 'bounding-box', ctx(st1)), variantId: null, props: { heading: 'Capture quickly' } },
        { id: 'inst_002', definitionId: 'cmp_01', stateId: 'st_01', nodeId: 'n8', nodePath: '1/2', box: measured({ x: 320, y: 300, width: 300, height: 200 }, 'bounding-box', ctx(st1)), variantId: null, props: { heading: 'Link naturally' } },
        { id: 'inst_003', definitionId: 'cmp_01', stateId: 'st_02', nodeId: 'n7', nodePath: '1/1', box: measured({ x: 0, y: 300, width: 300, height: 200 }, 'bounding-box', ctx(st2)), variantId: null, props: { heading: 'Capture quickly' } },
        { id: 'inst_004', definitionId: 'cmp_01', stateId: 'st_02', nodeId: 'n8', nodePath: '1/2', box: measured({ x: 320, y: 300, width: 300, height: 200 }, 'bounding-box', ctx(st2)), variantId: null, props: { heading: 'Link naturally' } },
      ],
    },
    visual: {
      tokens: {
        colors: [
          {
            id: 'tok_color_01',
            kind: 'color',
            generatedName: 'color-01',
            value: measured('#1b1f2a', 'computed-style', ctx(st1)),
            cluster: { sampleCount: 6, members: [{ value: 'rgb(27, 31, 42)', count: 6 }], properties: ['color'] },
            usage: { count: 6, stateIds: ['st_01', 'st_02'] },
          },
        ],
        typography: [],
        fontFamilies: [],
        fontSizes: [
          {
            id: 'tok_font-size_01',
            kind: 'font-size',
            generatedName: 'text-01',
            value: measured('16px', 'computed-style', ctx(st1)),
            cluster: { sampleCount: 4, members: [{ value: '16px', count: 4 }], properties: ['font-size'] },
            usage: { count: 4, stateIds: ['st_01', 'st_02'] },
          },
        ],
        spacing: [],
        radii: [],
        shadows: [],
        breakpoints: [
          {
            id: 'tok_breakpoint_01',
            kind: 'breakpoint',
            generatedName: 'bp-01',
            value: observed('390px', 'bounding-box', ctx(st2)),
            cluster: { sampleCount: 2, members: [{ value: '390', count: 1 }, { value: '1280', count: 1 }], properties: ['viewport'] },
            usage: { count: 1, stateIds: ['st_02'] },
          },
        ],
      },
      layout: [
        {
          stateId: 'st_01',
          nodeId: 'n0',
          nodePath: '',
          box: measured({ x: 0, y: 0, width: 1280, height: 1200 }, 'bounding-box', ctx(st1)),
          display: measured('block', 'computed-style', ctx(st1)),
          position: measured('static', 'computed-style', ctx(st1)),
          sizing: { width: measured('1280px', 'computed-style', ctx(st1)), height: measured('1200px', 'computed-style', ctx(st1)) },
          spacing: { margin: measured('0px 0px 0px 0px', 'computed-style', ctx(st1)), padding: measured('0px 0px 0px 0px', 'computed-style', ctx(st1)) },
        },
      ],
    },
    behavior: [
      {
        id: 'bh_01',
        event: { type: 'click', target: { nodeId: 'n2', nodePath: '0/0', role: 'button', name: 'Open menu', tag: 'button', nth: 0 } },
        transitionId: 'tr_01',
        effects: [
          { kind: 'toggle-attribute', attribute: 'aria-expanded', from: 'false', to: 'true', targetNodeId: 'n2', targetNodePath: '0/0' },
          { kind: 'show', targetNodeId: 'n3', targetNodePath: '0/1' },
        ],
        provenance: { kind: 'observed', source: 'interaction', stateId: 'st_02', viewport: st2.viewport, capturedAt: SAMPLE_AT, confidence: 1 },
      },
    ],
    assets: [
      {
        id: 'as_01',
        kind: 'svg',
        url: 'http://127.0.0.1:4173/assets/illustration.svg',
        origin: 'same-origin',
        mime: 'image/svg+xml',
        bytes: 1800,
        digest: 'svgdigest',
        width: 520,
        height: 400,
        authorization: 'unknown',
        usage: [
          { stateId: 'st_01', nodeId: 'n11', nodePath: '1/3' },
          { stateId: 'st_02', nodeId: 'n11', nodePath: '1/3' },
        ],
        provenance: { kind: 'measured', source: 'network', stateId: 'st_01', capturedAt: SAMPLE_AT, confidence: 1 },
      },
    ],
    limitations: [{ kind: 'not-observed', subject: 'hover states', reason: 'exploration not run' }],
    evidence: [
      { id: st1.evidenceId, kind: 'scan', artifacts: ['states/st_01/capture.json', 'states/st_01/screenshot.png'], capturedAt: SAMPLE_AT },
      { id: st2.evidenceId, kind: 'scan', artifacts: ['states/st_02/capture.json', 'states/st_02/screenshot.png'], capturedAt: SAMPLE_AT },
      { id: st3.evidenceId, kind: 'explore', artifacts: ['states/st_03/capture.json', 'states/st_03/screenshot.png'], capturedAt: SAMPLE_AT },
    ],
    annotations: [],
  };
}

/** A scan record consistent with `sampleDocument()`. */
export function sampleScanRecord(): ScanRecord {
  const doc = sampleDocument();
  return {
    scanId: SAMPLE_SCAN_ID,
    toolVersion: '0.1.0',
    createdAt: SAMPLE_AT,
    updatedAt: SAMPLE_AT,
    target: { kind: 'url', url: doc.target.url },
    browser: { mode: 'launch', name: 'chromium', version: null },
    viewports: doc.target.viewports,
    pageId: 'pg_01',
    status: 'explored',
    budget: doc.target.budget,
    states: doc.states.items.map((s) => ({
      stateId: s.id,
      kind: s.kind,
      parentStateId: s.parentStateId,
      viewport: s.viewport,
      url: s.url,
      title: s.title,
      capturePath: `states/${s.id}/capture.json`,
      screenshotPath: s.screenshot?.path ?? null,
      domDigest: s.domDigest,
      roleTreeDigest: s.roleTreeDigest,
      nodeCount: s.nodeCount,
      capturedAt: s.capturedAt,
      evidenceId: s.evidenceId,
      viaTransitionId: s.kind === 'derived' ? 'tr_01' : null,
    })),
    limitations: [],
    unknowns: [],
    steps: { scan: { at: SAMPLE_AT, evidenceId: 'ev_scan00000000' }, explore: null, generate: null, verify: [], report: null },
  };
}

/** A provider that refuses to launch; for tests that never touch a browser. */
export const noBrowserProvider: BrowserProvider = {
  launch: () => Promise.resolve(err(uidnaError('unsupported', 'no browser in this test'))),
  attach: () => Promise.resolve(err(uidnaError('unsupported', 'no browser in this test'))),
  probe: (): Promise<BrowserAvailability> =>
    Promise.resolve({ playwrightVersion: null, chromium: { available: false, executablePath: null, detail: 'test provider' }, cdp: null }),
};

/** A temporary scan store with the sample scan written into it. Call `cleanup()` when done. */
export async function createSampleContext(options: { clock?: Clock; provider?: BrowserProvider } = {}): Promise<{ ctx: WorkflowContext; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'uidna-test-'));
  const clock = options.clock ?? fixedClock(SAMPLE_AT, 1000);
  const store = new ScanStore(root, clock);
  const created = await store.createScan(sampleScanRecord());
  if (!created.ok) throw new Error(created.error.message);
  const saved = await store.saveDna(SAMPLE_SCAN_ID, sampleDocument());
  if (!saved.ok) throw new Error(saved.error.message);
  const ctx = createContext({ provider: options.provider ?? noBrowserProvider, toolVersion: '0.1.0', cwd: root, outRoot: root, clock });
  return { ctx, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
