/**
 * The generation model: which states are rendered, how viewports map to
 * Tailwind breakpoints, and the node tree matched across viewports by path.
 */
import type { Page, UiDnaDocument, UiNode, UiState } from '@rohzzn/uidna-schema';
import { uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { compareStrings } from './jsx.js';
import { PLACEHOLDER_TAGS } from './tailwind-map.js';

/** Tags that are never rendered (scripts, styles, metadata, svg internals). */
export const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'head',
  'title',
  'base',
  'source',
  'track',
  'param',
  'map',
  'area',
  'slot',
  // svg internals (the svg root becomes a placeholder)
  'path',
  'g',
  'defs',
  'use',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'ellipse',
  'text',
  'tspan',
  'clippath',
  'mask',
  'pattern',
  'lineargradient',
  'radialgradient',
  'stop',
  'symbol',
  'filter',
  'fegaussianblur',
  'feoffset',
  'feblend',
  'femerge',
  'femergenode',
  'fecolormatrix',
  'image',
  'foreignobject',
  'marker',
  'desc',
  'metadata',
]);

/** HTML tags kept as-is in the generated JSX; everything else becomes a `div`. */
export const SEMANTIC_TAGS: ReadonlySet<string> = new Set([
  'header',
  'nav',
  'main',
  'section',
  'article',
  'aside',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'a',
  'button',
  'img',
  'figure',
  'figcaption',
  'details',
  'summary',
  'form',
  'input',
  'label',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'span',
  'div',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'code',
  'pre',
  'blockquote',
  'hr',
  'br',
  'textarea',
  'select',
  'option',
  'optgroup',
  'time',
  'address',
  'dl',
  'dt',
  'dd',
  'cite',
  'abbr',
  'sup',
  'sub',
  'mark',
  'kbd',
  's',
  'u',
  'del',
  'ins',
  'legend',
  'fieldset',
  'menu',
  'q',
  'wbr',
  'picture',
  'dialog',
  'progress',
  'meter',
  'output',
  'samp',
  'var',
  'dfn',
  'data',
  'bdi',
  'bdo',
]);

/** Void elements (self-closing in JSX). */
export const VOID_TAGS: ReadonlySet<string> = new Set(['img', 'input', 'br', 'hr', 'wbr', 'col', 'source', 'track', 'area', 'embed', 'param', 'meta', 'link', 'base']);

/** A base state with its breakpoint name (`null` for the narrowest viewport). */
export interface ViewportSlot {
  readonly index: number;
  readonly state: UiState;
  readonly width: number;
  /** Tailwind breakpoint name, or null for the mobile-first base. */
  readonly breakpoint: string | null;
  /** Nodes of this state keyed by path. */
  readonly byPath: ReadonlyMap<string, UiNode>;
  /** Nodes of this state keyed by id. */
  readonly byId: ReadonlyMap<string, UiNode>;
}

/** How an element is rendered. */
export type RenderKind = 'element' | 'placeholder' | 'skipped';

/** A node of the narrowest base state with its counterparts at every wider viewport. */
export interface GenNode {
  readonly path: string;
  /** The node of the narrowest base state. */
  readonly node: UiNode;
  /** The node at each viewport slot (index aligned with `ViewportSlot.index`), or null when missing. */
  readonly perViewport: readonly (UiNode | null)[];
  readonly parent: GenNode | null;
  readonly children: GenNode[];
  readonly kind: RenderKind;
  /** Tag written to the JSX (`div` for unknown tags; the original tag for placeholders). */
  readonly renderedTag: string;
}

/** The selected page, its base states in viewport order and the node tree. */
export interface GenerationModel {
  readonly pageId: string;
  readonly pageTitle: string;
  /** URL of the page as recorded in the document. */
  readonly pageUrl: string;
  readonly slots: readonly ViewportSlot[];
  readonly narrowest: ViewportSlot;
  readonly body: GenNode;
  /** Every rendered node keyed by path (narrowest state). */
  readonly byPath: ReadonlyMap<string, GenNode>;
  /** Every state of the document keyed by id (for behavior diffs). */
  readonly statesById: ReadonlyMap<string, UiState>;
}

/** Tailwind breakpoint names for `count` viewports wider than the narrowest one. */
export function breakpointNames(count: number): string[] {
  const all = ['sm', 'md', 'lg', 'xl', '2xl'];
  if (count <= 0) return [];
  if (count === 1) return ['md'];
  if (count === 2) return ['md', 'lg'];
  if (count <= all.length) return all.slice(0, count);
  const extra: string[] = [];
  for (let i = all.length; i < count; i += 1) extra.push(`bp${i + 1}`);
  return [...all, ...extra];
}

/** Index a state's nodes by path and id. */
export function indexState(state: UiState): { byPath: Map<string, UiNode>; byId: Map<string, UiNode> } {
  const byPath = new Map<string, UiNode>();
  const byId = new Map<string, UiNode>();
  for (const node of state.nodes) {
    byPath.set(node.path, node);
    byId.set(node.id, node);
  }
  return { byPath, byId };
}

/** Decide how a captured node is rendered. */
export function renderKindOf(node: UiNode): { kind: RenderKind; renderedTag: string } {
  const tag = node.tag.toLowerCase();
  if (SKIPPED_TAGS.has(tag)) return { kind: 'skipped', renderedTag: tag };
  if (PLACEHOLDER_TAGS.has(tag)) return { kind: 'placeholder', renderedTag: tag };
  if (tag === 'img') return { kind: 'element', renderedTag: 'img' };
  if (SEMANTIC_TAGS.has(tag)) return { kind: 'element', renderedTag: tag === 'picture' ? 'div' : tag };
  return { kind: 'element', renderedTag: 'div' };
}

/**
 * Breakpoint name per base-state width across the given pages: the narrowest
 * width is the mobile-first base (null) and wider widths get Tailwind names,
 * so every page of a multi-page document uses the same `md:`/`lg:` prefixes.
 */
export function siteBreakpoints(dna: UiDnaDocument, pageIds: readonly string[]): Map<number, string | null> {
  const ids = new Set(pageIds);
  const widths = [...new Set(dna.states.items.filter((s) => s.kind === 'base' && ids.has(s.pageId)).map((s) => s.viewport.width))].sort((a, b) => a - b);
  const names = breakpointNames(widths.length - 1);
  const out = new Map<number, string | null>();
  widths.forEach((width, index) => out.set(width, index === 0 ? null : (names[index - 1] ?? `bp${index}`)));
  return out;
}

/**
 * Build the generation model of one page: its base states sorted by viewport
 * width, breakpoint names (from `breakpoints` when given, so pages of one
 * document agree; the page's narrowest width is always the base), and the
 * node tree of the narrowest state matched to the wider states by path.
 */
export function buildPageModel(dna: UiDnaDocument, page: Page, breakpoints?: ReadonlyMap<number, string | null>): Result<GenerationModel> {
  const base = dna.states.items.filter((s) => s.kind === 'base' && s.pageId === page.id).sort((a, b) => a.viewport.width - b.viewport.width || compareStrings(a.id, b.id));
  if (base.length === 0) return err(uidnaError('generate', `page ${page.id} has no base state`));

  // One state per width: keep the first (by id) when a width was captured twice.
  const unique: UiState[] = [];
  for (const state of base) {
    if (!unique.some((s) => s.viewport.width === state.viewport.width)) unique.push(state);
  }
  const names = breakpointNames(unique.length - 1);
  const slots: ViewportSlot[] = unique.map((state, index) => {
    const { byPath, byId } = indexState(state);
    const own = index === 0 ? null : (names[index - 1] ?? `bp${index}`);
    const shared = breakpoints?.get(state.viewport.width);
    const breakpoint = index === 0 ? null : shared === undefined || shared === null ? own : shared;
    return { index, state, width: state.viewport.width, breakpoint, byPath, byId };
  });
  const narrowest = slots[0];
  if (narrowest === undefined) return err(uidnaError('generate', 'no viewport slot'));

  const bodyNode = narrowest.state.nodes.find((n) => n.path === '') ?? narrowest.state.nodes[0];
  if (bodyNode === undefined) return err(uidnaError('generate', `state ${narrowest.state.id} has no nodes`));

  const byPath = new Map<string, GenNode>();
  const build = (node: UiNode, parent: GenNode | null, depth: number): GenNode | null => {
    if (depth > 512) return null;
    const { kind, renderedTag } = renderKindOf(node);
    const perViewport = slots.map((slot) => slot.byPath.get(node.path) ?? null);
    const children: GenNode[] = [];
    const gen: GenNode = { path: node.path, node, perViewport, parent, children, kind, renderedTag };
    byPath.set(node.path, gen);
    if (kind !== 'skipped' && kind !== 'placeholder') {
      for (const childId of node.childIds) {
        const child = narrowest.byId.get(childId);
        if (child === undefined) continue;
        const built = build(child, gen, depth + 1);
        if (built !== null) children.push(built);
      }
    }
    return gen;
  };
  const body = build(bodyNode, null, 0);
  if (body === null) return err(uidnaError('generate', 'node tree is too deep'));

  const statesById = new Map(dna.states.items.map((s) => [s.id, s] as const));
  const title = page.title.value ?? narrowest.state.title;
  return ok({ pageId: page.id, pageTitle: title, pageUrl: page.url, slots, narrowest, body, byPath, statesById });
}

/**
 * Build the generation model of the document's first page (the single-page
 * baseline): see `buildPageModel`.
 */
export function buildModel(dna: UiDnaDocument): Result<GenerationModel> {
  const page = dna.app.pages[0];
  if (page === undefined) return err(uidnaError('generate', 'the UI DNA document has no page'));
  return buildPageModel(dna, page);
}

/** True when `ancestor` is a strict ancestor path of `path`. */
export function isAncestorPath(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  if (ancestor === '') return true;
  return path.startsWith(ancestor + '/');
}

/** Path of `path` relative to `root` (`root` must be `path` or an ancestor); `''` for the root itself. */
export function relativePath(root: string, path: string): string | null {
  if (root === path) return '';
  if (root === '') return path;
  if (!path.startsWith(root + '/')) return null;
  return path.slice(root.length + 1);
}

/** Join a root path and a relative path. */
export function joinPath(root: string, relative: string): string {
  if (relative === '') return root;
  if (root === '') return relative;
  return `${root}/${relative}`;
}

/** Depth-first walk of rendered nodes (skipped nodes are not visited). */
export function walk(node: GenNode, visit: (node: GenNode) => void): void {
  if (node.kind === 'skipped') return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** True for a top-level node that belongs in the header (banner/navigation landmark). */
export function isHeaderish(node: GenNode): boolean {
  const role = (node.node.attrs.role ?? node.node.role ?? '').toLowerCase();
  return node.renderedTag === 'header' || node.renderedTag === 'nav' || role === 'banner' || role === 'navigation';
}

/** True for a top-level node that belongs in the footer (contentinfo landmark). */
export function isFooterish(node: GenNode): boolean {
  const role = (node.node.attrs.role ?? node.node.role ?? '').toLowerCase();
  return node.renderedTag === 'footer' || role === 'contentinfo';
}

/**
 * Split the body's children into leading header roots, main roots and trailing
 * footer roots. Only direct children of `<body>` count: a header nested in a
 * wrapper is part of the main content and cannot be hoisted into a layout.
 */
export function splitLandmarks(model: GenerationModel): { header: GenNode[]; main: GenNode[]; footer: GenNode[] } {
  const children = model.body.children.filter((child) => child.kind !== 'skipped');
  let headerEnd = 0;
  for (const child of children) {
    if (!isHeaderish(child)) break;
    headerEnd += 1;
  }
  let footerStart = children.length;
  while (footerStart > headerEnd) {
    const candidate = children[footerStart - 1];
    if (candidate === undefined || !isFooterish(candidate)) break;
    footerStart -= 1;
  }
  return { header: children.slice(0, headerEnd), main: children.slice(headerEnd, footerStart), footer: children.slice(footerStart) };
}
