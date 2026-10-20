import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { Box, Transition, UiDnaDocument, UiNode } from 'uidna-schema';
import { buildFixtureACapture, findNode } from '../analysis/testing.js';
import { createSampleContext, sampleDocument, SAMPLE_SCAN_ID } from '../application/testing.js';
import type { CapturedState } from '../browser/types.js';
import { DEFAULT_THRESHOLDS, DiffReportSchema, type DiffReport, type Finding } from '../contracts/diff-report.js';
import { renderKindOf } from '../generate/model.js';
import { multiPageFormDocument } from '../generate/testing.js';
import { MAX_REPLAY_CHAIN as SHARED_MAX_REPLAY_CHAIN, traceToBase as sharedTraceToBase } from '../generate/trace.js';
import { unwrap } from '../domain/result.js';
import { diffAttempts, findComponentId, findingKey, findTokenId } from './findings.js';
import { attr, escapeAttr, escapeHtml } from './html.js';
import { derivedGeneratedPaths, matchNodes, normalizeName, placeholderOf } from './match.js';
import { comparePixels } from './pixels.js';
import { renderReport } from './report.js';
import { compareDeltas, diffRoleTrees } from './roles.js';
import { compareStyles } from './styles.js';
import { errorExcerpt, parsePlaywrightReport, transitionIdOfTitle, type GeneratedTestResult } from './generated-tests.js';
import { generatedRoutesFromDocument, generatedRoutesFromManifest, isLiteralRoute, orderByPage, pageNotGenerated, pageOf, pageRoute, pathnameOf, routeReached } from './pages.js';
import {
  actedOn,
  generatedUrl,
  MAX_REPLAY_CHAIN,
  navigationExclusion,
  neverReplayed,
  pathSelector,
  repeatedByGeneratedTest,
  submitExclusion,
  textSelector,
  traceToBase,
  tryLocators,
  type LocatorAttempt,
} from './verify.js';

/* ---------------------------------------------------------------- images */

type Paint = (x: number, y: number) => readonly [number, number, number];

function png(width: number, height: number, paint: Paint): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

const white: Paint = () => [255, 255, 255];
const blockAt =
  (bx: number, by: number, size: number): Paint =>
  (x, y) =>
    x >= bx && x < bx + size && y >= by && y < by + size ? [0, 0, 0] : [255, 255, 255];

describe('comparePixels', () => {
  it('reports no difference for identical images', () => {
    const a = png(64, 48, blockAt(10, 10, 12));
    const diff = unwrap(comparePixels(a, png(64, 48, blockAt(10, 10, 12))));
    expect(diff).toMatchObject({ width: 64, height: 48, comparedPixels: 64 * 48, diffPixels: 0, diffRatio: 0, sizeMismatch: false });
    expect(diff.ssim === null ? diff.ssimReason : diff.ssim).toBe(1);
    expect(diff.diffImage).not.toBeNull();
  });

  it('counts a shifted block and paints the diff image', () => {
    const diff = unwrap(comparePixels(png(64, 48, blockAt(10, 10, 12)), png(64, 48, blockAt(20, 20, 12))));
    expect(diff.diffPixels).toBeGreaterThan(0);
    expect(diff.diffRatio).toBeGreaterThan(0);
    expect(diff.diffRatio).toBeLessThan(1);
    expect(diff.ssim).not.toBeNull();
    expect(diff.ssim ?? 1).toBeLessThan(1);
    const image = PNG.sync.read(diff.diffImage ?? Buffer.alloc(0));
    expect(image.width).toBe(64);
    let painted = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] === 255 && image.data[i + 1] === 0 && image.data[i + 2] === 0) painted += 1;
    }
    expect(painted).toBe(diff.diffPixels);
  });

  it('compares the overlap of images with different sizes and flags the mismatch', () => {
    const diff = unwrap(comparePixels(png(40, 40, white), png(60, 50, white)));
    expect(diff).toMatchObject({ width: 40, height: 40, comparedPixels: 1600, diffPixels: 0, diffRatio: 0, sizeMismatch: true });
    expect(diff.original).toEqual({ width: 40, height: 40 });
    expect(diff.generated).toEqual({ width: 60, height: 50 });
  });

  it('fails with a tagged error when a buffer is not a PNG', () => {
    const result = comparePixels(Buffer.from('not a png'), png(4, 4, white));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe('verify');
  });
});

/* ------------------------------------------------------------- matching */

interface GeneratedOptions {
  /** Write `data-uidna-path` on every generated node. */
  readonly pathAttr?: boolean;
  /** Original paths whose subtree is not generated. */
  readonly drop?: ReadonlySet<string>;
  /** Original path → horizontal shift of the generated box. */
  readonly shift?: Readonly<Record<string, number>>;
  /** Render the hero image as the generator's labeled placeholder. */
  readonly placeholderImage?: boolean;
  /** Wrap the children of `<main>` in an extra div (breaks derived paths below it). */
  readonly wrapMain?: boolean;
  /** Tags whose generated nodes carry no role (as Chromium reports e.g. `<summary>`). */
  readonly stripRoles?: ReadonlySet<string>;
}

/** A capture shaped like the generated app: body → div#root → the original tree re-indexed, as the generator renders it. */
function toGenerated(original: CapturedState, options: GeneratedOptions = {}): CapturedState {
  const byId = new Map(original.nodes.map((n) => [n.id, n] as const));
  const nodes: UiNode[] = [];
  let counter = 0;
  const nextId = (): string => `g${(counter += 1)}`;
  const body = original.nodes.find((n) => n.path === '');
  if (body === undefined) throw new Error('no body');
  const gBody: UiNode = { ...body, id: nextId(), parentId: null, path: '', attrs: options.pathAttr ? { 'data-uidna-path': '' } : {}, childIds: [] };
  nodes.push(gBody);
  const root: UiNode = { id: nextId(), parentId: gBody.id, path: '0', depth: 1, tag: 'div', role: null, name: null, attrs: { id: 'root' }, text: null, box: body.box, styleId: body.styleId, a11y: {}, visible: true, interactive: false, inForm: false, childIds: [] };
  nodes.push(root);
  gBody.childIds.push(root.id);

  const copyChildren = (node: UiNode, parent: UiNode, depth: number): void => {
    const kept = node.childIds.map((id) => byId.get(id)).filter((c): c is UiNode => c !== undefined && renderKindOf(c).kind !== 'skipped' && !(options.drop?.has(c.path) ?? false));
    if (options.wrapMain && node.tag === 'main') {
      const wrapper: UiNode = { id: nextId(), parentId: parent.id, path: `${parent.path}/0`, depth, tag: 'div', role: null, name: null, attrs: {}, text: null, box: node.box, styleId: node.styleId, a11y: {}, visible: true, interactive: false, inForm: false, childIds: [] };
      nodes.push(wrapper);
      parent.childIds.push(wrapper.id);
      kept.forEach((child, i) => copyNode(child, wrapper, i, depth + 1));
      return;
    }
    kept.forEach((child, i) => copyNode(child, parent, i, depth));
  };
  const copyNode = (node: UiNode, parent: UiNode, index: number, depth: number): void => {
    const path = `${parent.path}/${index}`;
    const dx = options.shift?.[node.path] ?? 0;
    const placeholder = (options.placeholderImage ?? false) && node.tag === 'img';
    const attrs: Record<string, string> = {};
    for (const name of ['id', 'role', 'aria-label', 'aria-expanded', 'open']) if (node.attrs[name] !== undefined) attrs[name] = node.attrs[name];
    if (options.pathAttr) attrs['data-uidna-path'] = node.path;
    if (placeholder) {
      attrs.role = 'img';
      attrs['aria-label'] = node.name ?? '';
    }
    const box: Box | null = node.box === null ? null : dx === 0 ? node.box : { ...node.box, x: node.box.x + dx };
    const generated: UiNode = {
      ...node,
      id: nextId(),
      parentId: parent.id,
      path,
      depth,
      tag: placeholder ? 'div' : node.tag,
      role: options.stripRoles?.has(node.tag) ? null : node.role,
      attrs,
      text: placeholder ? 'Placeholder: image not authorized (ast_01)' : node.text,
      box,
      childIds: [],
    };
    nodes.push(generated);
    parent.childIds.push(generated.id);
    if (!placeholder) copyChildren(node, generated, depth + 1);
  };
  copyChildren(body, root, 2);
  return { ...original, nodes, domDigest: `generated-${original.domDigest}` };
}

describe('matchNodes', () => {
  const original = buildFixtureACapture({ viewportWidth: 1280 });
  const visible = original.nodes.filter((n) => n.visible).length;

  it('matches every visible node through data-uidna-path when the capture carries it', () => {
    const result = matchNodes(original, toGenerated(original, { pathAttr: true }));
    expect(result.pathAttribute).toBe(true);
    expect(result.comparedNodes).toBe(visible);
    expect(result.matches).toHaveLength(visible);
    expect(result.matches.every((m) => m.strategy === 'data-path')).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.maxDriftPx).toBe(0);
  });

  it('derives the generator structural path (checked against the rendered tag) when the attribute is absent', () => {
    const derived = derivedGeneratedPaths(original);
    expect(derived.get(findNode(original, 'header')?.id ?? '')?.path).toBe('0/0');
    expect(derived.get(findNode(original, 'footer')?.id ?? '')?.path).toBe('0/2');
    expect(derived.get(findNode(original, 'img')?.id ?? '')?.tags).toEqual(['img', 'div']);
    const result = matchNodes(original, toGenerated(original));
    expect(result.pathAttribute).toBe(false);
    expect(result.matches).toHaveLength(visible);
    expect(result.matches.every((m) => m.strategy === 'derived-path')).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it('falls back to role+name+nth and tag+text when the structure differs', () => {
    // Paragraphs lose their role in the generated capture, so they can only be recovered by tag and text.
    const result = matchNodes(original, toGenerated(original, { wrapMain: true, stripRoles: new Set(['p']) }));
    const strategies = new Set(result.matches.map((m) => m.strategy));
    expect(strategies.has('role-name')).toBe(true);
    expect(strategies.has('tag-text')).toBe(true);
    const h1 = findNode(original, 'h1');
    expect(result.byOriginalId.get(h1?.id ?? '')?.strategy).toBe('role-name');
    const eyebrow = findNode(original, '.eyebrow');
    expect(result.byOriginalId.get(eyebrow?.id ?? '')?.strategy).toBe('tag-text');
    // Three cards share the same paragraph tag but differ in text: each recovers its own counterpart.
    const bodies = original.nodes.filter((n) => n.attrs.class === 'card-body');
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(result.byOriginalId.get(body.id)?.generated.text).toBe(body.text);
    // The wrapper div (generated path 0/1/0) has no counterpart; role-less, text-less divs under <main> (e.g. .hero-copy)
    // cannot be recovered by any fallback, so they are missing on the original side and extra on the generated side.
    expect(result.extra.some((n) => n.path === '0/1/0' && n.tag === 'div')).toBe(true);
    expect(result.extra.every((n) => n.tag === 'div' && n.role === null && n.text === null)).toBe(true);
    expect(result.missing.some((n) => n.attrs.class === 'hero-copy')).toBe(true);
    expect(result.missing.every((n) => n.role === null && n.text === null)).toBe(true);
    // The footer and header are untouched and still match by derived path.
    expect(result.byOriginalId.get(findNode(original, '.footer-brand')?.id ?? '')?.strategy).toBe('derived-path');
  });

  it('collapses a missing subtree to its root and keeps the unmatched list', () => {
    const links = findNode(original, '.footer-links');
    if (links === undefined) throw new Error('no footer links');
    const result = matchNodes(original, toGenerated(original, { drop: new Set([links.path]) }));
    expect(result.missing.map((n) => n.id)).toEqual([links.id]);
    expect(result.missingCount).toBe(7); // ul + 3 li + 3 a
    expect(result.unmatched).toHaveLength(7);
    // The sibling after the dropped list shifted in the generated tree and was recovered by a fallback strategy.
    const copy = result.byOriginalId.get(findNode(original, '.footer-copy')?.id ?? '');
    expect(copy?.strategy).toBe('role-name');
    expect(copy?.generated.text).toBe('Fixture A for UI DNA. No real product.');
    expect(result.matches).toHaveLength(visible - 7);
  });

  it('measures box drift and detects placeholders', () => {
    const h1 = findNode(original, 'h1');
    if (h1 === undefined) throw new Error('no h1');
    const result = matchNodes(original, toGenerated(original, { shift: { [h1.path]: 10 }, placeholderImage: true }));
    expect(result.maxDriftPx).toBe(10);
    const img = findNode(original, 'img');
    const match = result.byOriginalId.get(img?.id ?? '');
    expect(match?.generated.tag).toBe('div');
    expect(placeholderOf(match?.generated ?? h1)).toEqual({ assetId: 'ast_01', kind: 'image' });
    expect(placeholderOf(h1)).toBeNull();
    expect(placeholderOf({ ...h1, attrs: { 'data-placeholder': 'asset:ast_09' } })).toEqual({ assetId: 'ast_09', kind: null });
  });

  it('reports hidden-vs-visible counterparts for the responsive pass', () => {
    const phone = buildFixtureACapture({ viewportWidth: 390 });
    const generated = toGenerated(phone, { pathAttr: true });
    // Hide the hamburger in the generated app and show the menu: both are visibility mismatches.
    const button = generated.nodes.find((n) => n.tag === 'button');
    const menu = generated.nodes.find((n) => n.attrs.id === 'primary-menu');
    if (button === undefined || menu === undefined) throw new Error('fixture nodes missing');
    const mutated: CapturedState = {
      ...generated,
      nodes: generated.nodes.map((n) => (n.id === button.id ? { ...n, visible: false, box: null } : n.id === menu.id ? { ...n, visible: true, box: { x: 0, y: 72, width: 390, height: 120 } } : n)),
    };
    const result = matchNodes(phone, mutated);
    expect(result.hiddenInGenerated.map((c) => c.original.tag)).toEqual(['button']);
    expect(result.hiddenInOriginal.map((c) => c.original.attrs.id)).toEqual(['primary-menu']);
    expect(result.missing.map((n) => n.tag)).toEqual(['button']);
  });
});

describe('normalizeName', () => {
  it('trims, collapses whitespace and strips a trailing marker preceded by a space', () => {
    expect(normalizeName('Is there a free plan? +')).toBe('Is there a free plan?');
    expect(normalizeName('Can I export my notes? −')).toBe('Can I export my notes?');
    expect(normalizeName('  Open   menu ')).toBe('Open menu');
    expect(normalizeName('More ▾')).toBe('More');
    expect(normalizeName('C++')).toBe('C++');
    expect(normalizeName(null)).toBe('');
  });
});

describe('diffRoleTrees', () => {
  it('lists the entries a transition added and removed, and compares deltas', () => {
    const doc = sampleDocument();
    const closed = doc.states.items.find((s) => s.id === 'st_02');
    const open = doc.states.items.find((s) => s.id === 'st_03');
    if (closed === undefined || open === undefined) throw new Error('sample states missing');
    const delta = diffRoleTrees(closed.roleTree, open.roleTree);
    expect(delta).toEqual({ added: ['button|Open menu|expanded=true', 'link|Features', 'list|'], removed: ['button|Open menu|expanded=false'] });
    expect(compareDeltas(delta, delta)).toEqual({ match: true, missing: [], extra: [] });
    const partial = diffRoleTrees(closed.roleTree, open.roleTree.filter((e) => e.role !== 'list' && e.role !== 'link'));
    expect(compareDeltas(delta, partial)).toEqual({ match: false, missing: ['+link|Features', '+list|'], extra: [] });
    const unchanged = diffRoleTrees(closed.roleTree, closed.roleTree);
    expect(compareDeltas(delta, unchanged).missing).toEqual(['+button|Open menu|expanded=true', '+link|Features', '+list|', '-button|Open menu|expanded=false']);
  });
});

describe('compareStyles', () => {
  it('applies the color, typography and layout thresholds', () => {
    const original = { color: 'rgb(47, 91, 234)', 'background-color': 'rgb(255, 255, 255)', 'font-family': '"Segoe UI", Roboto, sans-serif', 'font-size': '13.333px', 'padding-top': '16px', 'padding-left': '16px', display: 'block', 'line-height': '24px' };
    const generated = { color: 'rgb(50, 91, 234)', 'background-color': 'rgb(255, 0, 0)', 'font-family': 'Segoe UI, Arial', 'font-size': '13.3333px', 'padding-top': '24px', 'padding-left': '18px', display: 'flex', 'line-height': '24px', 'margin-top': '8px' };
    const result = compareStyles(original, generated, DEFAULT_THRESHOLDS);
    const byProperty = new Map(result.differences.map((d) => [d.property, d]));
    expect(byProperty.has('color')).toBe(false); // distance 3 ≤ 12
    expect(byProperty.get('background-color')).toMatchObject({ category: 'color', delta: expect.any(Number) as number });
    expect(byProperty.has('font-family')).toBe(false); // first family equal after normalization
    expect(byProperty.has('font-size')).toBe(false); // sub-pixel rounding
    expect(byProperty.get('padding-top')).toMatchObject({ category: 'layout', delta: 8 });
    expect(byProperty.has('padding-left')).toBe(false); // 2px ≤ boxDriftPx
    expect(byProperty.get('display')).toMatchObject({ category: 'layout', original: 'block', generated: 'flex', delta: null });
    expect(byProperty.get('margin-top')).toMatchObject({ category: 'layout', original: '0px', generated: '8px', delta: 8 }); // UA default read back
    expect(result.compared).toBeGreaterThan(result.differences.length);
    expect(compareStyles(undefined, undefined, DEFAULT_THRESHOLDS)).toEqual({ compared: expect.any(Number) as number, differences: [] });
  });
});

/* ------------------------------------------------------------- findings */

function finding(partial: Partial<Finding> & Pick<Finding, 'id' | 'category' | 'property'>): Finding {
  const base: Finding = {
    severity: 'medium',
    stateId: 'st_01',
    viewport: { width: 1280, height: 800 },
    nodeId: null,
    nodePath: null,
    role: null,
    name: null,
    componentId: null,
    tokenId: null,
    transitionId: null,
    original: null,
    generated: null,
    delta: null,
    message: 'test',
    evidence: [],
    key: '',
    ...partial,
  };
  return { ...base, key: findingKey(base) };
}

describe('findingKey and diffAttempts', () => {
  it('builds stable keys and reports regressions and resolved findings', () => {
    const a = finding({ id: 'f_1', category: 'color', property: 'background-color', nodePath: '1/0/0' });
    const b = finding({ id: 'f_2', category: 'layout', property: 'pixels' });
    const c = finding({ id: 'f_3', category: 'behavior', property: 'role-tree', transitionId: 'tr_01', stateId: 'st_02' });
    expect(a.key).toBe('color|st_01|1/0/0|background-color');
    expect(b.key).toBe('layout|st_01|-|pixels');
    expect(c.key).toBe('behavior|st_02|tr_01|role-tree');
    const renamed: Finding = { ...a, id: 'f_99', message: 'other' };
    expect(findingKey(renamed)).toBe(a.key);
    // Two transitions on the same target node (a click and a hover on one button) are distinct findings, not one key.
    const click = finding({ id: 'f_4', category: 'behavior', property: 'role-tree', nodePath: '0/0/1', transitionId: 'tr_01' });
    const hover = finding({ id: 'f_5', category: 'behavior', property: 'role-tree', nodePath: '0/0/1', transitionId: 'tr_02' });
    expect(click.key).toBe('behavior|st_01|tr_01|role-tree');
    expect(hover.key).not.toBe(click.key);
    const previous = { visual: [{ findings: [a, b] }], behavioral: [{ findings: [] }] } as unknown as DiffReport;
    const diff = diffAttempts(previous, [b, c]);
    expect(diff.regressions.map((f) => f.key)).toEqual([c.key]);
    expect(diff.resolved.map((f) => f.key)).toEqual([a.key]);
    expect(diffAttempts(null, [a])).toEqual({ regressions: [], resolved: [] });
  });

  it('attributes findings to tokens and components of the document', () => {
    const doc = sampleDocument();
    expect(findTokenId(doc, 'color', 'rgb(27, 31, 42)')).toBe('tok_color_01');
    expect(findTokenId(doc, 'color', 'rgb(1, 2, 3)')).toBeNull();
    expect(findTokenId(doc, 'font-size', '16px')).toBe('tok_font-size_01');
    expect(findComponentId(doc, 'st_01', { id: 'n7', path: '1/1' })).toBe('cmp_01');
    expect(findComponentId(doc, 'st_01', { id: 'n9', path: '1/1/0' })).toBe('cmp_01'); // inside the card
    expect(findComponentId(doc, 'st_01', { id: 'n6', path: '1/0' })).toBeNull();
  });
});

/* ------------------------------------------------------------- locators */

describe('locators and URLs', () => {
  it('builds selectors only from safe input', () => {
    expect(pathSelector('0/1/3')).toBe('[data-uidna-path="0/1/3"]');
    expect(pathSelector('')).toBe('[data-uidna-path=""]');
    expect(pathSelector('0/1"]')).toBeNull();
    expect(pathSelector('a/b')).toBeNull();
    expect(textSelector('summary', 'Is there a "free" plan?')).toBe('summary:text-is("Is there a \\"free\\" plan?")');
    expect(textSelector('div>x', 'text')).toBeNull();
    expect(textSelector('p', '   ')).toBeNull();
  });

  it('maps original state URLs onto the served generated app', () => {
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://127.0.0.1:4173/')).toBe('http://127.0.0.1:5000/');
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://example.com/pricing?x=1#top')).toBe('http://127.0.0.1:5000/pricing?x=1#top');
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://example.com/index.html#start')).toBe('http://127.0.0.1:5000/#start');
    expect(generatedUrl('http://127.0.0.1:5000/', 'not a url')).toBe('http://127.0.0.1:5000/');
  });

  it('sends a state to its page route when the document registers one (crawled .html paths included)', () => {
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://example.com/features.html#tabs', '/features.html')).toBe('http://127.0.0.1:5000/features.html#tabs');
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://example.com/pricing.html?plan=pro', '/pricing.html')).toBe('http://127.0.0.1:5000/pricing.html?plan=pro');
    // A parameterized pattern cannot be loaded: the original path decides as before.
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://example.com/users/42', '/users/:id')).toBe('http://127.0.0.1:5000/users/42');
    expect(generatedUrl('http://127.0.0.1:5000/', 'not a url', '/features.html')).toBe('http://127.0.0.1:5000/features.html');
  });
});

/* ------------------------------------------------------ replay policies */

function uiNode(partial: Partial<UiNode> & Pick<UiNode, 'id' | 'tag'>): UiNode {
  return { parentId: null, path: '0', depth: 1, role: null, name: null, attrs: {}, text: null, box: { x: 0, y: 0, width: 10, height: 10 }, styleId: 's', a11y: {}, visible: true, interactive: true, inForm: false, childIds: [], ...partial };
}

describe('navigationExclusion and submitExclusion', () => {
  const doc = sampleDocument();
  const seed = doc.app.pages[0];
  if (seed === undefined) throw new Error('sample page missing');
  const dna = { app: { ...doc.app, pages: [...doc.app.pages, { ...seed, id: 'pg_02', url: new URL('/features.html', seed.url).href, stateIds: [] }] } };
  const from = { url: seed.url, pageId: seed.id };
  const link = (href: string, extra: Partial<UiNode> = {}): UiNode => uiNode({ id: 'a1', tag: 'a', role: 'link', name: 'Features', attrs: { href }, text: 'Features', ...extra });

  it('follows a navigation only through a same-origin link to another crawled page, outside any form, without a denied name', () => {
    expect(navigationExclusion(dna, from, link('/features.html'), null)).toBeNull();
    expect(navigationExclusion(dna, from, link('features.html'), null)).toBeNull();
    expect(navigationExclusion(dna, from, link('/features.html', { inForm: true }), null)).toBe('inside a form');
    expect(navigationExclusion(dna, from, link('#features'), null)).toBe('fragment link: scroll only');
    expect(navigationExclusion(dna, from, link('https://example.com/'), null)).toBe('link navigates to another origin');
    expect(navigationExclusion(dna, from, link('/pricing.html'), null)).toBe('link navigates to an uncrawled page');
    expect(navigationExclusion(dna, from, link('/'), null)).toBe('link navigates to the current page');
    expect(navigationExclusion(dna, from, link('/features.html', { name: 'Checkout' }), null)).toBe('denied name: checkout');
    expect(navigationExclusion(dna, from, link('/features.html'), 'Delete everything')).toBe('denied name: delete');
    // A submit control or any non-link never replays a navigation, whatever the document's navigation field says.
    expect(navigationExclusion(dna, from, uiNode({ id: 'b1', tag: 'button', role: 'button', name: 'Features', attrs: { type: 'submit' } }), null)).toContain('is not a link');
  });

  it('never replays a side-effect transition, except a crawled navigation that sent no non-GET request', () => {
    const quiet = { requests: 3, nonGet: 0 };
    const posted = { requests: 3, nonGet: 1 };
    expect(neverReplayed({ sideEffects: false, network: quiet })).toBe(false);
    expect(neverReplayed({ sideEffects: true, network: posted })).toBe(true);
    // A hash change or a blocked navigation is a side effect without a request: never repeated outside a crawled navigation.
    expect(neverReplayed({ sideEffects: true, network: quiet })).toBe(true);
    expect(neverReplayed({ sideEffects: true, network: quiet, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } })).toBe(false);
    expect(neverReplayed({ sideEffects: true, network: posted, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } })).toBe(true);
    expect(neverReplayed({ sideEffects: true, network: quiet, navigation: null })).toBe(true);
  });

  it('submits only through the form itself or a submit control, never one with a denied name', () => {
    expect(submitExclusion(uiNode({ id: 'b1', tag: 'button', attrs: { type: 'submit' }, name: 'Create account' }), null)).toBeNull();
    expect(submitExclusion(uiNode({ id: 'b2', tag: 'button', name: 'Continue' }), null)).toBeNull();
    expect(submitExclusion(uiNode({ id: 'b3', tag: 'input', attrs: { type: 'image' }, name: 'Go' }), null)).toBeNull();
    expect(submitExclusion(uiNode({ id: 'f1', tag: 'form', name: 'Sign up' }), null)).toBeNull();
    expect(submitExclusion(uiNode({ id: 'f2', tag: 'form', attrs: { 'aria-label': 'Checkout' } }), null)).toBe('denied name: checkout');
    expect(submitExclusion(uiNode({ id: 'b4', tag: 'button', attrs: { type: 'submit' }, name: 'Pay now' }), null)).toBe('denied name: pay');
    expect(submitExclusion(uiNode({ id: 'b5', tag: 'button', attrs: { type: 'submit' } }), 'Confirm order')).toBe('denied name: confirm');
    expect(submitExclusion(uiNode({ id: 'b6', tag: 'button', attrs: { type: 'button' }, name: 'Fill example' }), null)).toContain('neither a form nor a submit control');
    expect(submitExclusion(uiNode({ id: 'i1', tag: 'input', attrs: { type: 'email' } }), null)).toContain('neither a form nor a submit control');
  });
});

/* ---------------------------------------------------------------- pages */

describe('pages and routes', () => {
  it('derives the route the generator registers and recognises its alias', () => {
    const doc = sampleDocument();
    expect(pageRoute(doc, 'pg_01')).toBe('/');
    expect(pageRoute(doc, 'pg_99')).toBeNull();
    const seed = doc.app.pages[0];
    if (seed === undefined) throw new Error('sample page missing');
    const unrouted: UiDnaDocument = { ...doc, app: { ...doc.app, routes: [], pages: [...doc.app.pages, { id: 'pg_02', url: 'http://127.0.0.1:4173/features.html', title: seed.title, stateIds: [] }] } };
    expect(pageRoute(unrouted, 'pg_01')).toBe('/');
    expect(pageRoute(unrouted, 'pg_02')).toBe('/features.html');
    expect(pageOf(unrouted, { pageId: 'pg_02' })?.url).toBe('http://127.0.0.1:4173/features.html');
    expect(isLiteralRoute('/features.html')).toBe(true);
    expect(isLiteralRoute('/users/:id')).toBe(false);
    expect(isLiteralRoute('/docs/*')).toBe(false);
    expect(isLiteralRoute('features')).toBe(false);
    expect(routeReached('/features.html', '/features.html')).toBe(true);
    expect(routeReached('/features.html', '/features')).toBe(true);
    expect(routeReached('/features.html', '/features/')).toBe(true);
    expect(routeReached('/features.html', '/pricing.html')).toBe(false);
    expect(routeReached('/', '/')).toBe(true);
    expect(routeReached('/', '/features.html')).toBe(false);
    expect(routeReached('/users/:id', '/users/42')).toBe(false);
    expect(pathnameOf('http://127.0.0.1:5000/features.html?x=1#y')).toBe('/features.html');
    expect(pathnameOf('nope')).toBe('/');
  });

  it('treats a pattern as literal by react-router rules: a colon inside a segment is literal, a leading colon or a star is not', () => {
    expect(isLiteralRoute('/wiki/Help:Contents')).toBe(true);
    expect(isLiteralRoute('/a:b/c')).toBe(true);
    expect(isLiteralRoute('/wiki/:page')).toBe(false);
    expect(isLiteralRoute('/wiki/Help:Contents/:id')).toBe(false);
    expect(isLiteralRoute('/files/a*b')).toBe(false);
    expect(isLiteralRoute('*')).toBe(false);
    expect(routeReached('/wiki/Help:Contents', '/wiki/Help:Contents')).toBe(true);
    expect(generatedUrl('http://127.0.0.1:5000/', 'http://example.com/wiki/Help:Contents', '/wiki/Help:Contents')).toBe('http://127.0.0.1:5000/wiki/Help:Contents');
  });

  it('reads the generated pages and routes from the manifest, and derives them from the document only as a fallback', () => {
    const manifest = {
      scanId: 'scan_x',
      router: 'react-router',
      pages: [
        { pageId: 'pg_01', name: 'Home', file: 'src/pages/Home.tsx', route: '/' },
        { pageId: 'pg_03', name: 'Pricing', file: 'src/pages/Pricing.tsx', route: '/pricing.html' },
      ],
      files: [],
    };
    const routes = unwrap(generatedRoutesFromManifest(manifest, 'scan_x'));
    expect(routes.source).toBe('manifest');
    expect(routes.router).toBe('react-router');
    expect([...routes.routeByPageId]).toEqual([
      ['pg_01', '/'],
      ['pg_03', '/pricing.html'],
    ]);
    // A page the generator left out (here pg_02: its pattern was taken, or router "none") is not generated.
    expect(pageNotGenerated(routes, 'pg_02')).toBe(true);
    expect(pageNotGenerated(routes, 'pg_03')).toBe(false);
    const single = unwrap(generatedRoutesFromManifest({ scanId: 'scan_x', router: 'none', pages: [{ pageId: 'pg_01', route: '/' }] }, 'scan_x'));
    expect(single.router).toBe('none');
    expect(pageNotGenerated(single, 'pg_02')).toBe(true);
    // A manifest written before pages were recorded, one that names no scan, or not a manifest at all, is refused with a tagged error.
    for (const bad of [{ scanId: 'scan_x', files: ['README.md'] }, { scanId: 'scan_x', router: 'none', pages: [] }, { router: 'none', pages: [{ pageId: 'pg_01', route: '/' }] }, null, 'text']) {
      const refused = generatedRoutesFromManifest(bad, 'scan_x');
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error._tag).toBe('validation');
        expect(refused.error.message).toContain('uidna.generated.json does not record the scan and pages it was generated from');
      }
    }
    // A manifest generated from another scan is refused even when it is well formed: page ids are numbered per scan in
    // crawl order, so its pg_02 may be another page, and the pages it left out say nothing about this scan's pages.
    const foreign = generatedRoutesFromManifest(manifest, 'scan_y');
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error._tag).toBe('validation');
      expect(foreign.error.message).toBe('uidna.generated.json was generated from scan scan_x, not scan_y; page ids are numbered per scan, so its page ids may name other pages');
    }
    // The fallback derives a route for every page of the document and never reports a page as not generated.
    const doc = sampleDocument();
    const fallback = generatedRoutesFromDocument(doc);
    expect(fallback).toEqual({ source: 'document', router: null, routeByPageId: new Map([['pg_01', '/']]) });
    expect(pageNotGenerated(fallback, 'pg_99')).toBe(false);
  });

  it('orders base states by page (document order), widest first, unlisted pages last', () => {
    const doc = sampleDocument();
    const [st1, st2] = doc.states.items;
    const seed = doc.app.pages[0];
    if (st1 === undefined || st2 === undefined || seed === undefined) throw new Error('sample states missing');
    const pg2 = { ...st1, id: 'st_10', pageId: 'pg_02' };
    const orphan = { ...st2, id: 'st_11', pageId: 'pg_zz' };
    const twoPages: UiDnaDocument = { ...doc, app: { ...doc.app, pages: [{ ...seed, id: 'pg_02', stateIds: [] }, ...doc.app.pages] } };
    expect(orderByPage(twoPages, [orphan, st2, pg2, st1]).map((s) => s.id)).toEqual(['st_10', 'st_01', 'st_02', 'st_11']);
  });
});

/* --------------------------------------------------------------- chains */

describe('traceToBase', () => {
  it('walks derived states back to their base through replayable transitions, bounded', () => {
    const doc = sampleDocument();
    const statesById = new Map(doc.states.items.map((s) => [s.id, s] as const));
    const st3 = statesById.get('st_03');
    const st2 = statesById.get('st_02');
    const tr = doc.states.transitions[0];
    if (st3 === undefined || st2 === undefined || tr === undefined) throw new Error('sample states missing');
    const traced = traceToBase(doc.states.transitions, statesById, st3);
    expect(traced).toMatchObject({ ok: true, base: { id: 'st_02' } });
    if (traced.ok) expect(traced.steps.map((t) => t.id)).toEqual(['tr_01']);
    expect(traceToBase(doc.states.transitions, statesById, st2)).toMatchObject({ ok: true, steps: [] });
    // A side-effect producer cannot be replayed, so the state it produced cannot be re-entered.
    const sideEffect = doc.states.transitions.map((t) => ({ ...t, sideEffects: true }));
    const blocked = traceToBase(sideEffect, statesById, st3);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain('no replayable transition produces st_03');
    // A chain longer than MAX_REPLAY_CHAIN is refused.
    const chain = new Map(statesById);
    const long = [...doc.states.transitions];
    let previous = 'st_03';
    for (let i = 0; i < MAX_REPLAY_CHAIN + 1; i += 1) {
      const id = `st_${(20 + i).toString()}`;
      chain.set(id, { ...st3, id, parentStateId: previous });
      long.push({ ...tr, id: `tr_${(20 + i).toString()}`, from: previous, to: id });
      previous = id;
    }
    const last = chain.get(previous);
    if (last === undefined) throw new Error('chain state missing');
    const tooLong = traceToBase(long, chain, last);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.reason).toContain(`longer than ${MAX_REPLAY_CHAIN} steps`);
  });

  it('is the tracer the generated behavior tests use, so neither repeats a producer the other refuses', () => {
    expect(traceToBase).toBe(sharedTraceToBase);
    expect(MAX_REPLAY_CHAIN).toBe(SHARED_MAX_REPLAY_CHAIN);
  });
});

/* ---------------------------------------------------- generated test runs */

describe('repeatedByGeneratedTest', () => {
  const doc = multiPageFormDocument();
  const statesById = new Map(doc.states.items.map((s) => [s.id, s] as const));
  const result = (transitionId: string | null, status: GeneratedTestResult['status'] = 'passed'): Pick<GeneratedTestResult, 'title' | 'transitionId' | 'status'> => ({ title: `${transitionId ?? 'no id'}: test`, transitionId, status });

  it('reports a test that ran a transition the verifier never replays', () => {
    expect(repeatedByGeneratedTest(doc.states.transitions, statesById, result('tr_05'))).toBe(
      'generated test "tr_05: test" exercised tr_05, which caused side effects when it was observed (1 non-GET request(s)); the verifier never replays it, and the generated suite runs outside UI DNA\'s network guard',
    );
    expect(repeatedByGeneratedTest(doc.states.transitions, statesById, result('tr_05', 'skipped'))).toBeNull();
    expect(repeatedByGeneratedTest(doc.states.transitions, statesById, result('tr_04'))).toBeNull();
    expect(repeatedByGeneratedTest(doc.states.transitions, statesById, result(null))).toBeNull();
    expect(repeatedByGeneratedTest(doc.states.transitions, statesById, result('tr_99'))).toBeNull();
  });

  it('reports a test whose setup has to repeat the side effect that alone reaches its from-state', () => {
    // The empty submit sent a blocked POST and the fills start from the state it produced: a test of a fill repeats the submit.
    const transitions = doc.states.transitions.map((t) => (t.id === 'tr_02' ? { ...t, sideEffects: true, network: { requests: 1, nonGet: 1 } } : t.id === 'tr_03' ? { ...t, from: 'st_05' } : t));
    const states = new Map(statesById);
    const st06 = statesById.get('st_06');
    if (st06 === undefined) throw new Error('st_06 missing');
    states.set('st_06', { ...st06, parentStateId: 'st_05' });
    for (const [id, from] of [
      ['tr_03', 'st_05'],
      ['tr_04', 'st_06'],
    ] as const) {
      expect(repeatedByGeneratedTest(transitions, states, result(id, 'failed'))).toBe(
        `generated test "${id}: test" exercised tr_02 to reach the from-state ${from} of ${id}, which caused side effects when it was observed (a non-GET request); the verifier never replays it on the way to a state, and the generated suite runs outside UI DNA's network guard`,
      );
    }
    expect(repeatedByGeneratedTest(transitions, states, result('tr_03', 'skipped'))).toBeNull();
    // A navigation that alone reaches a derived from-state is never replayed on the way either.
    const navigated = doc.states.transitions.map((t) => (t.id === 'tr_06' ? { ...t, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } } : t));
    const tr06 = navigated.find((t) => t.id === 'tr_06');
    if (tr06 === undefined) throw new Error('tr_06 missing');
    const fromSt09: Transition = { ...tr06, id: 'tr_07', from: 'st_09', to: 'st_01', navigation: null };
    expect(repeatedByGeneratedTest([...navigated, fromSt09], statesById, result('tr_07'))).toBe(
      'generated test "tr_07: test" exercised tr_06 to reach the from-state st_09 of tr_07, which is a navigation to page pg_02; the verifier never replays it on the way to a state, and the generated suite runs outside UI DNA\'s network guard',
    );
  });
});

/* --------------------------------------------------------------- locators */

describe('tryLocators and actedOn', () => {
  const attempt = (performed: boolean, blockedRequests: readonly string[] = [], reason: string | null = null): LocatorAttempt => ({ performed, reason, blockedRequests });
  const locators = [{ label: 'role button "Create account" #0' }, { label: 'selector [data-uidna-path="1/0/2/2/0"]' }, { label: 'selector button:text-is("Create account")' }];

  it('counts a request the session blocked as acting on the target', () => {
    expect(actedOn(attempt(true))).toBe(true);
    expect(actedOn(attempt(false, ['http://127.0.0.1:4173/signup']))).toBe(true);
    expect(actedOn(attempt(false))).toBe(false);
  });

  it('stops at the first locator whose action the session blocked as a request, so the form is never submitted twice', async () => {
    const tried: string[] = [];
    const outcomes = [attempt(false, [], 'no element'), attempt(false, ['http://127.0.0.1:4173/signup'], 'The action would have navigated to http://127.0.0.1:4173/signup; the navigation was blocked'), attempt(true)];
    const result = await tryLocators(locators, (located) => {
      tried.push(located.label);
      return Promise.resolve(outcomes[tried.length - 1] ?? attempt(false));
    });
    expect(tried).toEqual([locators[0]?.label, locators[1]?.label]);
    expect(result.attempt?.blockedRequests).toEqual(['http://127.0.0.1:4173/signup']);
    expect(result.reasons).toEqual(['role button "Create account" #0: no element']);
  });

  it('returns the first performed attempt, or every reason when no locator acted', async () => {
    let calls = 0;
    const first = await tryLocators(locators, () => {
      calls += 1;
      return Promise.resolve(attempt(true));
    });
    expect(calls).toBe(1);
    expect(first.attempt?.performed).toBe(true);
    const none = await tryLocators(locators, (located) => Promise.resolve(attempt(false, [], located.label === locators[0]?.label ? 'hidden' : null)));
    expect(none.attempt).toBeNull();
    expect(none.reasons).toEqual(['role button "Create account" #0: hidden', 'selector [data-uidna-path="1/0/2/2/0"]: not performed', 'selector button:text-is("Create account"): not performed']);
  });
});

/* ------------------------------------------------------- generated tests */

describe('parsePlaywrightReport', () => {
  const ansi = (text: string): string => `\u001b[31m${text}\u001b[39m`;
  const report = JSON.stringify({
    config: { version: '1.64.0' },
    suites: [
      {
        title: 'behavior.spec.ts',
        specs: [],
        suites: [
          {
            title: 'transitions recorded by scan scan_x',
            specs: [
              { title: 'tr_01: click tab "Link" at 1/1/1/0/1 (1280×800)', ok: true, tests: [{ status: 'expected', results: [{ status: 'passed', duration: 310, errors: [] }] }] },
              {
                title: 'tr_02: click button "Yearly billing (save 20%)" at 1/0/2 (1280×800)',
                ok: false,
                tests: [
                  {
                    status: 'unexpected',
                    results: [
                      {
                        status: 'failed',
                        duration: 5100,
                        error: { message: `${ansi('Error: expect(locator).toHaveAttribute(expected)')}\n\nLocator: locator('[data-uidna-path="1/0/2"]')\nExpected string: "true"` },
                        errors: [{ message: `${ansi('Error: expect(locator).toHaveAttribute(expected)')}\n\nExpected string: "true"\nReceived string: "false"` }],
                      },
                    ],
                  },
                ],
              },
              { title: 'tr_03: hover link "Home" at 0/0/0: not reproduced', ok: true, tests: [{ status: 'skipped', results: [{ status: 'skipped', duration: 0, errors: [] }] }] },
              {
                title: 'tr_04: click summary at 2/0 (390×844)',
                ok: true,
                tests: [{ status: 'flaky', projectName: 'chromium', results: [{ status: 'failed', duration: 100, errors: [{ message: 'boom' }] }, { status: 'passed', duration: 90, errors: [] }] }],
              },
            ],
          },
        ],
      },
    ],
    errors: [{ message: "Error: browserType.launch: Executable doesn't exist" }],
    stats: { expected: 1, unexpected: 1, skipped: 1, flaky: 1 },
  });

  it('flattens nested suites into one record per test with status, transition id and a clean error excerpt', () => {
    const parsed = unwrap(parsePlaywrightReport(report));
    expect(parsed.stats).toEqual({ passed: 1, failed: 1, skipped: 1, flaky: 1 });
    expect(parsed.tests.map((t) => [t.transitionId, t.status])).toEqual([
      ['tr_01', 'passed'],
      ['tr_02', 'failed'],
      ['tr_03', 'skipped'],
      ['tr_04', 'flaky'],
    ]);
    const failed = parsed.tests[1];
    expect(failed?.error).toBe('Error: expect(locator).toHaveAttribute(expected) Expected string: "true" Received string: "false"');
    expect(failed?.durationMs).toBe(5100);
    expect(parsed.tests[3]?.title).toBe('tr_04: click summary at 2/0 (390×844) [chromium]');
    expect(parsed.tests[3]?.error).toBe('boom');
    expect(parsed.tests[3]?.durationMs).toBe(90);
    expect(parsed.errors).toEqual(["Error: browserType.launch: Executable doesn't exist"]);
  });

  it('rejects text that is not a report with a tagged error and never throws', () => {
    const notJson = parsePlaywrightReport('> playwright test\n');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.error._tag).toBe('validation');
    const wrongShape = parsePlaywrightReport('{"suites": "nope"}');
    expect(wrongShape.ok).toBe(false);
    expect(unwrap(parsePlaywrightReport('{}'))).toEqual({ tests: [], stats: { passed: 0, failed: 0, skipped: 0, flaky: 0 }, errors: [] });
  });

  it('reads transition ids from generated titles and bounds error excerpts', () => {
    expect(transitionIdOfTitle('tr_12: fill textbox "Email" at 1/0/1/1/1 (1280×800)')).toBe('tr_12');
    expect(transitionIdOfTitle('no transition was recorded')).toBeNull();
    expect(errorExcerpt('  a\u001b[2m   b \n c  ')).toBe('a b c');
    expect(errorExcerpt('x'.repeat(1000))).toHaveLength(401);
  });
});

/* ----------------------------------------------------------------- html */

describe('escapeHtml', () => {
  it('neutralizes markup in node names and attribute values', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml("Tom & Jerry's")).toBe('Tom &amp; Jerry&#39;s');
    expect(escapeAttr('a"b\nc')).toBe('a&quot;b&#10;c');
    expect(attr('title', '<img src=x onerror=alert(1)>')).toBe(' title="&lt;img src=x onerror=alert(1)&gt;"');
    expect(attr('bad name', 'x')).toBe('');
  });
});

describe('renderReport (no browser)', () => {
  it('writes a self-contained page with escaped page content and no broken image references', async () => {
    const sample = await createSampleContext();
    try {
      const scan = unwrap(await sample.ctx.store.loadScan(SAMPLE_SCAN_ID));
      const dna = sampleDocument();
      const st01 = dna.states.items[0];
      if (st01 === undefined) throw new Error('no state');
      st01.title = '<script>alert("title")</script>';
      const hostile = '<img src=x onerror=alert(1)>';
      const report: DiffReport = {
        id: 'r1',
        scanId: SAMPLE_SCAN_ID,
        outDir: 'C:/out',
        attempt: 1,
        createdAt: '2026-10-13T18:00:00.000Z',
        thresholds: DEFAULT_THRESHOLDS,
        summary: {
          states: 1,
          transitions: 0,
          findings: 1,
          byCategory: { layout: 0, typography: 0, color: 1, missing: 0, asset: 0, responsive: 0, behavior: 0 },
          bySeverity: { high: 0, medium: 1, low: 0 },
          transitionsReplayed: 0,
          transitionsMatched: 0,
        },
        visual: [
          {
            stateId: 'st_01',
            viewport: { width: 1280, height: 800 },
            originalScreenshot: 'states/st_01/screenshot.png',
            generatedScreenshot: 'verify/attempt-1/st_01.generated.png',
            pixels: null,
            geometry: { comparedNodes: 10, matchedNodes: 9, missingNodes: 1, extraNodes: 0, maxDriftPx: 2 },
            styles: { comparedProperties: 40, differingProperties: 1 },
            findings: [finding({ id: 'f_1', category: 'color', property: 'color', nodePath: '1/0', name: hostile, message: `color differs on ${hostile}` })],
            limitations: [`limitation about ${hostile}`],
          },
        ],
        behavioral: [],
        regressions: [],
        resolved: [],
        previousAttempt: null,
        limitations: [],
        unknowns: [],
        artifacts: [],
      };
      expect(DiffReportSchema.safeParse(report).success).toBe(true);
      scan.steps.verify = [{ attempt: 1, at: report.createdAt, evidenceId: 'ev_000000000001', reportPath: 'verify/attempt-1/diff-report.json', label: 'first <b>try</b>' }];
      const outPath = join(sample.root, 'reports', 'report.html');
      const rendered = unwrap(await renderReport({ ctx: sample.ctx, scan, dna, attempts: [report], outPath }));
      expect(rendered).toEqual({ path: outPath, attempts: 1, findings: 1, states: 2 });
      const html = await readFile(outPath, 'utf8');
      expect(html).toContain(SAMPLE_SCAN_ID);
      expect(html).toContain('first &lt;b&gt;try&lt;/b&gt;');
      expect(html).toContain('&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<script');
      expect(html).not.toContain(hostile);
      expect(html).toContain('Component01');
      expect(html).toContain('article&gt;h3');
      expect(html).toContain('tok_color_01');
      expect(html).toContain('background:#1b1f2a');
      // The sample scan stores no PNGs, so no <img> may reference a missing file.
      expect(html).not.toMatch(/<img /);
      expect(html).toContain('no image on disk');
    } finally {
      await sample.cleanup();
    }
  });
});
