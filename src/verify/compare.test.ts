import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { Box, UiNode } from '@rohzzn/uidna-schema';
import { buildFixtureACapture, findNode } from '../analysis/testing.js';
import { createSampleContext, sampleDocument, SAMPLE_SCAN_ID } from '../application/testing.js';
import type { CapturedState } from '../browser/types.js';
import { DEFAULT_THRESHOLDS, DiffReportSchema, type DiffReport, type Finding } from '../contracts/diff-report.js';
import { renderKindOf } from '../generate/model.js';
import { unwrap } from '../domain/result.js';
import { diffAttempts, findComponentId, findingKey, findTokenId } from './findings.js';
import { attr, escapeAttr, escapeHtml } from './html.js';
import { derivedGeneratedPaths, matchNodes, normalizeName, placeholderOf } from './match.js';
import { comparePixels } from './pixels.js';
import { renderReport } from './report.js';
import { compareDeltas, diffRoleTrees } from './roles.js';
import { compareStyles } from './styles.js';
import { generatedUrl, pathSelector, textSelector } from './verify.js';

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
