/**
 * Raw DOM tree collection. Two collectors produce the same intermediate
 * shape so that `nodes.ts` can build identical `UiNode`s (and identical
 * digests) from either:
 *
 * - `collectViaSnapshot`: CDP `DOMSnapshot.captureSnapshot` (preferred;
 *   one round trip for structure, attributes, text, layout boxes, computed
 *   styles and pseudo-elements, with backend node ids for AX mapping).
 * - `collectViaEvaluate`: an in-page walk with `getComputedStyle` and
 *   `getBoundingClientRect`, used when the CDP call fails.
 *
 * Boxes are page coordinates (document space, scroll offsets included).
 */
import type { CDPSession, Page } from 'playwright';
import type { Box } from '@rohzzn/uidna-schema';
import { toError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { DomGetDocumentResultSchema, DomSnapshotResultSchema, StyleFillResultSchema, WalkedTreeSchema, type DomNodeData } from './cdp-schemas.js';
import { evaluateInPage } from './in-page.js';

/** Tags whose subtrees are never captured. */
export const SKIPPED_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'head']);

/** Computed style of a rendered pseudo-element with generated content. */
export interface RawPseudo {
  /** Raw computed `content` value, e.g. `"+"`. */
  readonly content: string;
  readonly style: Readonly<Record<string, string>>;
}

/** One element in document order. `elements[0]` is `<body>`. */
export interface RawElement {
  /** Index of the parent element in the same array, or null for `<body>`. */
  readonly parent: number | null;
  /** Index in `parent.children` (element children only, skipped tags included), 0 for `<body>`. */
  readonly childIndex: number;
  /** Lower-case tag name. */
  readonly tag: string;
  /** Raw attributes in source order (not yet filtered). */
  readonly attrs: readonly (readonly [string, string])[];
  /** Direct text-node content joined with spaces (not yet collapsed), or null. */
  readonly text: string | null;
  /** Bounding box in page coordinates, or null when the element has no layout. */
  readonly box: Box | null;
  /** Requested computed-style properties, or null when unknown (no layout entry yet). */
  readonly style: Readonly<Record<string, string>> | null;
  readonly pseudo: { readonly before?: RawPseudo; readonly after?: RawPseudo };
  /** CDP backend node id, or null when collected without CDP. */
  readonly backendNodeId: number | null;
  /** Resolved `currentSrc` for images with `srcset`, when the browser reported it. */
  readonly currentSrc: string | null;
  readonly shadowRoot: 'open' | 'closed' | null;
  /** True for `<iframe>` / `<frame>` elements (their documents are not entered). */
  readonly isFrame: boolean;
}

/** The collected tree plus what the collector could not do. */
export interface RawTree {
  readonly elements: readonly RawElement[];
  readonly url: string;
  readonly title: string;
  readonly source: 'dom-snapshot' | 'evaluate';
  readonly limitations: readonly string[];
}

/** Options shared by the collectors. */
export interface CollectOptions {
  /** Style properties to read for rendered elements. Empty for structure-only (snapshot) collection. */
  readonly styleProperties: readonly string[];
}

/** The `content` property is requested alongside the style properties so pseudo-elements can be detected. */
export const CONTENT_PROPERTY = 'content';

/**
 * Collect the tree with `DOMSnapshot.captureSnapshot`. Elements without a
 * layout entry (display: none subtrees, display: contents) have `style: null`
 * and `box: null`; `fillMissingStyles` resolves their computed style later.
 */
export async function collectViaSnapshot(cdp: CDPSession, options: CollectOptions): Promise<Result<RawTree>> {
  const wantStyles = options.styleProperties.length > 0;
  const requested = wantStyles ? [...options.styleProperties, CONTENT_PROPERTY] : [];
  let raw: unknown;
  try {
    raw = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: requested, includeDOMRects: true });
  } catch (cause) {
    return err(toError(cause, 'capture', 'DOMSnapshot.captureSnapshot failed'));
  }
  const parsed = DomSnapshotResultSchema.safeParse(raw);
  if (!parsed.success) return err(toError(parsed.error, 'capture', 'DOMSnapshot result did not match the expected shape'));
  const { documents, strings } = parsed.data;
  const doc = documents[0];
  if (!doc) return err(toError(new Error('no documents'), 'capture', 'DOMSnapshot returned no document'));
  const nodes = doc.nodes;
  const nodeType = nodes.nodeType ?? [];
  const nodeName = nodes.nodeName ?? [];
  const nodeValue = nodes.nodeValue ?? [];
  const parentIndex = nodes.parentIndex ?? [];
  const backendIds = nodes.backendNodeId ?? [];
  const attributes = nodes.attributes ?? [];
  const str = (index: number | undefined): string => (index === undefined || index < 0 ? '' : (strings[index] ?? ''));
  const rare = (data: { index: number[]; value: number[] } | undefined): Map<number, string> => {
    const map = new Map<number, string>();
    if (!data) return map;
    data.index.forEach((nodeIdx, k) => map.set(nodeIdx, str(data.value[k])));
    return map;
  };
  const pseudoTypes = rare(nodes.pseudoType);
  const shadowTypes = rare(nodes.shadowRootType);
  const currentSources = rare(nodes.currentSourceURL);
  const frameNodes = new Set<number>(nodes.contentDocumentIndex?.index ?? []);

  const children = new Map<number, number[]>();
  for (let i = 0; i < nodeType.length; i += 1) {
    const parent = parentIndex[i];
    if (parent === undefined || parent < 0) continue;
    const list = children.get(parent);
    if (list) list.push(i);
    else children.set(parent, [i]);
  }

  const layoutByNode = new Map<number, number[]>();
  doc.layout.nodeIndex.forEach((nodeIdx, layoutIdx) => {
    const list = layoutByNode.get(nodeIdx);
    if (list) list.push(layoutIdx);
    else layoutByNode.set(nodeIdx, [layoutIdx]);
  });

  const styleOf = (nodeIdx: number): Readonly<Record<string, string>> | null => {
    const layouts = layoutByNode.get(nodeIdx);
    const first = layouts?.[0];
    if (first === undefined) return null;
    const values = doc.layout.styles[first] ?? [];
    const style: Record<string, string> = {};
    requested.forEach((property, k) => {
      style[property] = str(values[k]);
    });
    return style;
  };
  const boxOf = (nodeIdx: number): Box | null => {
    const layouts = layoutByNode.get(nodeIdx);
    if (!layouts || layouts.length === 0) return null;
    let box: Box | null = null;
    for (const layoutIdx of layouts) {
      const rect = doc.layout.bounds[layoutIdx];
      if (!rect || rect.length < 4) continue;
      const [x = 0, y = 0, width = 0, height = 0] = rect;
      const candidate: Box = { x, y, width, height };
      box = box === null ? candidate : unionBox(box, candidate);
    }
    return box;
  };

  let bodyIndex = -1;
  for (let i = 0; i < nodeType.length; i += 1) {
    if (nodeType[i] === 1 && str(nodeName[i]).toUpperCase() === 'BODY' && !pseudoTypes.has(i)) {
      bodyIndex = i;
      break;
    }
  }
  if (bodyIndex < 0) return err(toError(new Error('no <body>'), 'capture', 'The document has no <body> element'));

  const elements: RawElement[] = [];
  const limitations: string[] = [];
  let shadowRoots = 0;
  const visit = (nodeIdx: number, parent: number | null, childIndex: number): void => {
    const tag = str(nodeName[nodeIdx]).toLowerCase();
    const kids = children.get(nodeIdx) ?? [];
    const textParts: string[] = [];
    let before: RawPseudo | undefined;
    let after: RawPseudo | undefined;
    const elementKids: number[] = [];
    for (const kid of kids) {
      const type = nodeType[kid];
      if (type === 3) {
        textParts.push(str(nodeValue[kid]));
        continue;
      }
      if (type === 11) {
        shadowRoots += 1;
        continue;
      }
      if (type !== 1) continue;
      const pseudo = pseudoTypes.get(kid);
      if (pseudo !== undefined) {
        if ((pseudo === 'before' || pseudo === 'after') && wantStyles) {
          const style = styleOf(kid);
          const content = style?.[CONTENT_PROPERTY];
          if (style && content !== undefined && hasGeneratedContent(content)) {
            const entry: RawPseudo = { content, style };
            if (pseudo === 'before') before = entry;
            else after = entry;
          }
        }
        continue;
      }
      elementKids.push(kid);
    }
    const shadowType = shadowTypes.get(nodeIdx);
    const attrs: [string, string][] = [];
    const flat = attributes[nodeIdx] ?? [];
    for (let k = 0; k + 1 < flat.length; k += 2) attrs.push([str(flat[k]).toLowerCase(), str(flat[k + 1])]);
    const pseudo: { before?: RawPseudo; after?: RawPseudo } = {};
    if (before) pseudo.before = before;
    if (after) pseudo.after = after;
    const style = wantStyles ? stripContent(styleOf(nodeIdx)) : null;
    const index = elements.length;
    elements.push({
      parent,
      childIndex,
      tag,
      attrs,
      text: textParts.length > 0 ? textParts.join(' ') : null,
      box: boxOf(nodeIdx),
      style,
      pseudo,
      backendNodeId: backendIds[nodeIdx] ?? null,
      currentSrc: currentSources.get(nodeIdx) ?? null,
      shadowRoot: shadowType === 'open' ? 'open' : shadowType === 'closed' ? 'closed' : null,
      isFrame: tag === 'iframe' || tag === 'frame' || frameNodes.has(nodeIdx),
    });
    elementKids.forEach((kid, k) => {
      const kidTag = str(nodeName[kid]).toLowerCase();
      if (SKIPPED_TAGS.has(kidTag)) return;
      visit(kid, index, k);
    });
  };
  visit(bodyIndex, null, 0);
  if (shadowRoots > 0) limitations.push(`${shadowRoots} shadow root(s) were not entered: node paths cannot address shadow content.`);
  const frameCount = elements.filter((element) => element.isFrame).length;
  if (frameCount > 0) limitations.push(`${frameCount} iframe(s) were not entered; only the main document is captured.`);
  return ok({
    elements,
    url: str(doc.documentURL),
    title: str(doc.title),
    source: 'dom-snapshot',
    limitations,
  });
}

/** In-page walk used when DOMSnapshot is unavailable. Produces the same shape as `collectViaSnapshot` (without backend ids). */
export async function collectViaEvaluate(page: Page, options: CollectOptions): Promise<Result<RawTree>> {
  let raw: unknown;
  try {
    raw = await evaluateInPage(page, walkDocument, {
      styleProperties: [...options.styleProperties],
      skipped: [...SKIPPED_TAGS],
      contentProperty: CONTENT_PROPERTY,
    });
  } catch (cause) {
    return err(toError(cause, 'capture', 'In-page DOM walk failed'));
  }
  const parsed = WalkedTreeSchema.safeParse(raw);
  if (!parsed.success) return err(toError(parsed.error, 'capture', 'In-page DOM walk returned an unexpected shape'));
  const limitations: string[] = ['DOMSnapshot was unavailable; the DOM was walked in-page with getComputedStyle and getBoundingClientRect.'];
  const elements: RawElement[] = parsed.data.elements.map((element) => ({
    parent: element.parent,
    childIndex: element.childIndex,
    tag: element.tag,
    attrs: element.attrs,
    text: element.text,
    box: element.box ? { x: element.box[0], y: element.box[1], width: element.box[2], height: element.box[3] } : null,
    style: element.style,
    pseudo: element.pseudo,
    backendNodeId: null,
    currentSrc: element.currentSrc,
    shadowRoot: element.shadowRoot,
    isFrame: element.isFrame,
  }));
  const shadowRoots = elements.filter((element) => element.shadowRoot !== null).length;
  if (shadowRoots > 0) limitations.push(`${shadowRoots} shadow root(s) were not entered: node paths cannot address shadow content.`);
  const frameCount = elements.filter((element) => element.isFrame).length;
  if (frameCount > 0) limitations.push(`${frameCount} iframe(s) were not entered; only the main document is captured.`);
  if (elements.length === 0) return err(toError(new Error('no <body>'), 'capture', 'The document has no <body> element'));
  return ok({ elements, url: parsed.data.url, title: parsed.data.title, source: 'evaluate', limitations });
}

/**
 * Attach CDP backend node ids to a tree collected in-page by walking
 * `DOM.getDocument` with the same element-child indexing. Returns the tree
 * unchanged (with a limitation) when the DOM domain is unavailable.
 */
export async function attachBackendIds(cdp: CDPSession, tree: RawTree): Promise<RawTree> {
  let raw: unknown;
  try {
    raw = await cdp.send('DOM.getDocument', { depth: -1, pierce: false });
  } catch (cause) {
    const error = toError(cause, 'capture');
    return { ...tree, limitations: [...tree.limitations, `Accessibility roles are unknown: DOM.getDocument failed (${error.message}).`] };
  }
  const parsed = DomGetDocumentResultSchema.safeParse(raw);
  if (!parsed.success) {
    return { ...tree, limitations: [...tree.limitations, 'Accessibility roles are unknown: DOM.getDocument returned an unexpected shape.'] };
  }
  const body = findBody(parsed.data.root);
  if (!body) return { ...tree, limitations: [...tree.limitations, 'Accessibility roles are unknown: DOM.getDocument has no <body>.'] };
  const byPath = new Map<string, number>();
  const walk = (node: DomNodeData, path: string): void => {
    byPath.set(path, node.backendNodeId);
    let k = 0;
    for (const child of node.children ?? []) {
      if (child.nodeType !== 1) continue;
      const childPath = path === '' ? `${k}` : `${path}/${k}`;
      k += 1;
      if (SKIPPED_TAGS.has(child.nodeName.toLowerCase())) continue;
      walk(child, childPath);
    }
  };
  walk(body, '');
  const paths = elementPaths(tree.elements);
  const elements = tree.elements.map((element, i) => ({ ...element, backendNodeId: byPath.get(paths[i] ?? '') ?? null }));
  return { ...tree, elements };
}

/** Structural paths (element-child indices from `<body>`) for every element, by index. */
export function elementPaths(elements: readonly RawElement[]): string[] {
  const paths: string[] = [];
  elements.forEach((element, i) => {
    if (element.parent === null) {
      paths[i] = '';
      return;
    }
    const parentPath = paths[element.parent] ?? '';
    paths[i] = parentPath === '' ? `${element.childIndex}` : `${parentPath}/${element.childIndex}`;
  });
  return paths;
}

/**
 * Resolve computed styles for elements whose style is still unknown
 * (display: none subtrees have no layout entry in DOMSnapshot). Uses
 * `getComputedStyle` in-page; elements that cannot be resolved keep `null`
 * and are reported in the returned limitation.
 */
export async function fillMissingStyles(page: Page, tree: RawTree, styleProperties: readonly string[]): Promise<{ tree: RawTree; limitation: string | null }> {
  const paths = elementPaths(tree.elements);
  const missing: number[] = [];
  tree.elements.forEach((element, i) => {
    if (element.style === null) missing.push(i);
  });
  if (missing.length === 0) return { tree, limitation: null };
  let raw: unknown;
  try {
    raw = await evaluateInPage(page, readStylesByPath, { paths: missing.map((i) => paths[i] ?? ''), styleProperties: [...styleProperties] });
  } catch (cause) {
    const error = toError(cause, 'capture');
    return { tree, limitation: `${missing.length} unrendered node(s) have no computed style: ${error.message}` };
  }
  const parsed = StyleFillResultSchema.safeParse(raw);
  if (!parsed.success) return { tree, limitation: `${missing.length} unrendered node(s) have no computed style: unexpected in-page result` };
  const elements = [...tree.elements];
  let unresolved = 0;
  missing.forEach((elementIndex, k) => {
    const style = parsed.data[k] ?? null;
    if (style === null) {
      unresolved += 1;
      return;
    }
    const element = elements[elementIndex];
    if (element) elements[elementIndex] = { ...element, style };
  });
  return {
    tree: { ...tree, elements },
    limitation: unresolved > 0 ? `${unresolved} unrendered node(s) could not be resolved by path for computed style.` : null,
  };
}

/** True when a computed `content` value renders something. */
export function hasGeneratedContent(content: string): boolean {
  const value = content.trim();
  return value !== '' && value !== 'none' && value !== 'normal' && value !== '""' && value !== "''";
}

function stripContent(style: Readonly<Record<string, string>> | null): Readonly<Record<string, string>> | null {
  if (style === null) return null;
  const rest: Record<string, string> = {};
  for (const [property, value] of Object.entries(style)) if (property !== CONTENT_PROPERTY) rest[property] = value;
  return rest;
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function findBody(root: DomNodeData): DomNodeData | null {
  if (root.nodeType === 1 && root.nodeName.toUpperCase() === 'BODY') return root;
  for (const child of root.children ?? []) {
    const found = findBody(child);
    if (found) return found;
  }
  return null;
}

/* ------------------------------------------------------------ in-page code */
/* These functions run inside the page: they must not reference module scope. */

interface WalkArgs {
  styleProperties: string[];
  skipped: string[];
  contentProperty: string;
}

interface WalkedElement {
  parent: number | null;
  childIndex: number;
  tag: string;
  attrs: [string, string][];
  text: string | null;
  box: [number, number, number, number] | null;
  style: Record<string, string> | null;
  pseudo: { before?: { content: string; style: Record<string, string> }; after?: { content: string; style: Record<string, string> } };
  currentSrc: string | null;
  shadowRoot: 'open' | 'closed' | null;
  isFrame: boolean;
}

function walkDocument(args: WalkArgs): { elements: WalkedElement[]; url: string; title: string } {
  const elements: WalkedElement[] = [];
  const skipped = new Set(args.skipped);
  const wantStyles = args.styleProperties.length > 0;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const readStyle = (el: Element, pseudo: string | null): Record<string, string> => {
    const computed = pseudo ? getComputedStyle(el, pseudo) : getComputedStyle(el);
    const style: Record<string, string> = {};
    for (const property of args.styleProperties) style[property] = computed.getPropertyValue(property);
    return style;
  };
  const isGenerated = (content: string): boolean => {
    const value = content.trim();
    return value !== '' && value !== 'none' && value !== 'normal' && value !== '""' && value !== "''";
  };
  const visit = (el: Element, parent: number | null, childIndex: number): void => {
    const tag = el.tagName.toLowerCase();
    const attrs: [string, string][] = [];
    for (const attribute of Array.from(el.attributes)) attrs.push([attribute.name.toLowerCase(), attribute.value]);
    const textParts: string[] = [];
    for (const child of Array.from(el.childNodes)) if (child.nodeType === 3) textParts.push(child.nodeValue ?? '');
    const rects = el.getClientRects();
    let box: [number, number, number, number] | null = null;
    if (rects.length > 0) {
      const rect = el.getBoundingClientRect();
      box = [rect.x + scrollX, rect.y + scrollY, rect.width, rect.height];
    }
    const pseudo: WalkedElement['pseudo'] = {};
    let style: Record<string, string> | null = null;
    if (wantStyles) {
      style = readStyle(el, null);
      if (box !== null) {
        for (const which of ['before', 'after'] as const) {
          const computed = getComputedStyle(el, `::${which}`);
          const content = computed.getPropertyValue(args.contentProperty);
          if (computed.display !== 'none' && isGenerated(content)) pseudo[which] = { content, style: readStyle(el, `::${which}`) };
        }
      }
    }
    const image = el instanceof HTMLImageElement ? el : null;
    const index = elements.length;
    elements.push({
      parent,
      childIndex,
      tag,
      attrs,
      text: textParts.length > 0 ? textParts.join(' ') : null,
      box,
      style,
      pseudo,
      currentSrc: image && image.currentSrc !== '' ? image.currentSrc : null,
      shadowRoot: el.shadowRoot ? 'open' : null,
      isFrame: tag === 'iframe' || tag === 'frame',
    });
    Array.from(el.children).forEach((child, k) => {
      if (skipped.has(child.tagName.toLowerCase())) return;
      visit(child, index, k);
    });
  };
  if (document.body) visit(document.body, null, 0);
  return { elements, url: document.URL, title: document.title };
}

function readStylesByPath(args: { paths: string[]; styleProperties: string[] }): (Record<string, string> | null)[] {
  const resolve = (path: string): Element | null => {
    let el: Element | null = document.body;
    if (path === '') return el;
    for (const part of path.split('/')) {
      if (el === null) return null;
      el = el.children[Number(part)] ?? null;
    }
    return el;
  };
  return args.paths.map((path) => {
    const el = resolve(path);
    if (el === null) return null;
    const computed = getComputedStyle(el);
    const style: Record<string, string> = {};
    for (const property of args.styleProperties) style[property] = computed.getPropertyValue(property);
    return style;
  });
}
