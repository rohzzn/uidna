/**
 * Decides which captured style properties a node emits as classes, and
 * computes mobile-first responsive class lists across the base states.
 *
 * Computed styles are used values: every rendered block has a pixel width and
 * height even when the author never set one. Emitting all of them would pin
 * the layout to the scanned viewports, so width and height are only emitted
 * when the measured box cannot be explained by the content or the parent
 * (empty boxes, replaced elements, positioned elements, boxes larger than
 * their children). Everything else is emitted as captured.
 */
import type { UiNode, UiState } from '@uidna/schema';
import { RENDERING_STYLE_PROPERTIES, STYLE_DEFAULTS } from '../browser/style-properties.js';
import type { GenNode, GenerationModel, ViewportSlot } from './model.js';
import {
  classesFor,
  compareClasses,
  INHERITED_PROPERTIES,
  parsePx,
  styleValue,
  uaDefaultDisplay,
  type SkippedProperty,
  type StyleRecord,
  type TokenIndex,
} from './tailwind-map.js';

/** Elements whose size is intrinsic rather than content-driven. */
const REPLACED_TAGS: ReadonlySet<string> = new Set(['img', 'video', 'iframe', 'canvas', 'svg', 'object', 'embed', 'audio', 'input', 'select', 'textarea', 'progress', 'meter']);

const SVG_ONLY: ReadonlySet<string> = new Set(['fill', 'stroke', 'stroke-width']);

/** A node as seen in one state, with the context the heuristics need. */
export interface NodeView {
  readonly node: UiNode;
  readonly style: StyleRecord;
  readonly renderedTag: string;
  readonly parent: { readonly node: UiNode; readonly style: StyleRecord; readonly renderedTag: string } | null;
  readonly children: readonly { readonly node: UiNode; readonly style: StyleRecord }[];
}

/** Options for `selectEmitted`. */
export interface EmitOptions {
  /** Skip values the rendered tag gets for free under Tailwind's preflight. */
  readonly skipUaDefaults: boolean;
  /** Returns true when an inherited property equals the parent's value (and may be skipped); null disables the check. */
  readonly inheritedSkip: ((property: string) => boolean) | null;
}

/** Build the view of `gn` in `state` (nodes matched by path). Null when the node is missing there. */
export function viewInState(gn: GenNode, state: UiState, byPath: ReadonlyMap<string, UiNode>): NodeView | null {
  const node = byPath.get(gn.path);
  if (node === undefined) return null;
  const styleOf = (n: UiNode): StyleRecord => state.styles[n.styleId] ?? {};
  const parentNode = gn.parent ? byPath.get(gn.parent.path) : undefined;
  const parent = gn.parent && parentNode ? { node: parentNode, style: styleOf(parentNode), renderedTag: gn.parent.renderedTag } : null;
  const children = gn.children
    .filter((child) => child.kind !== 'skipped')
    .map((child) => byPath.get(child.path))
    .filter((n): n is UiNode => n !== undefined)
    .map((n) => ({ node: n, style: styleOf(n) }));
  return { node, style: styleOf(node), renderedTag: gn.renderedTag, parent, children };
}

/** Build the view of `gn` at a viewport slot. */
export function viewAtSlot(gn: GenNode, slot: ViewportSlot): NodeView | null {
  return viewInState(gn, slot.state, slot.byPath);
}

function px(style: StyleRecord, property: string): number {
  return parsePx(styleValue(style, property)) ?? 0;
}

function isEmptyNode(node: UiNode): boolean {
  return node.text === null && node.childIds.length === 0;
}

/** Content-box size of a rendered node. */
function innerSize(node: UiNode, style: StyleRecord): { width: number; height: number } | null {
  if (!node.box) return null;
  return {
    width: node.box.width - px(style, 'padding-left') - px(style, 'padding-right') - px(style, 'border-left-width') - px(style, 'border-right-width'),
    height: node.box.height - px(style, 'padding-top') - px(style, 'padding-bottom') - px(style, 'border-top-width') - px(style, 'border-bottom-width'),
  };
}

/**
 * Bounding extent of the rendered children including their margins, plus the
 * height without the outermost vertical margins (a block container's first
 * top margin and last bottom margin collapse through it and do not add height).
 */
function childrenExtent(children: NodeView['children']): { width: number; height: number; coreHeight: number } | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minYBox = Number.POSITIVE_INFINITY;
  let maxYBox = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const child of children) {
    const box = child.node.box;
    if (!box) continue;
    any = true;
    minX = Math.min(minX, box.x - px(child.style, 'margin-left'));
    maxX = Math.max(maxX, box.x + box.width + px(child.style, 'margin-right'));
    minY = Math.min(minY, box.y - px(child.style, 'margin-top'));
    maxY = Math.max(maxY, box.y + box.height + px(child.style, 'margin-bottom'));
    minYBox = Math.min(minYBox, box.y);
    maxYBox = Math.max(maxYBox, box.y + box.height);
  }
  if (!any) return null;
  return { width: maxX - minX, height: maxY - minY, coreHeight: maxYBox - minYBox };
}

function displayOf(view: { style: StyleRecord; renderedTag: string }): string {
  return styleValue(view.style, 'display') ?? uaDefaultDisplay(view.renderedTag);
}

/** Decide whether `width` is evidence of an authored size. Returns the value to emit or null. */
function widthToEmit(view: NodeView, extentMismatch: { width: boolean; height: boolean; allEmpty: boolean; overflow: boolean }): string | null {
  const { node, style } = view;
  const value = style.width;
  if (value === undefined || value === 'auto' || !node.box) return null;
  const tag = node.tag.toLowerCase();
  const parentInner = view.parent?.node.box ? innerSize(view.parent.node, view.parent.style) : null;
  const fillsParent = parentInner !== null && Math.abs(parentInner.width - node.box.width) <= 1;
  if (REPLACED_TAGS.has(tag)) return fillsParent ? '100%' : value;
  if (isEmptyNode(node)) return fillsParent ? '100%' : value;
  const position = styleValue(style, 'position');
  if (position === 'absolute' || position === 'fixed') {
    if (styleValue(style, 'left') !== 'auto' && styleValue(style, 'right') !== 'auto') return null;
    return value;
  }
  const maxWidth = parsePx(styleValue(style, 'max-width'));
  if (maxWidth !== null && Math.abs(maxWidth - node.box.width) <= 1) return null;
  const minWidth = parsePx(styleValue(style, 'min-width'));
  if (minWidth !== null && minWidth > 0 && Math.abs(minWidth - node.box.width) <= 1) return null;
  const display = displayOf(view);
  const parentDisplay = view.parent ? displayOf(view.parent) : 'block';
  const contentSized =
    display.startsWith('inline') || display === 'table' || /^(?:inline-)?(?:flex|grid)$/.test(parentDisplay) || (styleValue(style, 'float') ?? 'none') !== 'none';
  if (contentSized) {
    if (node.text !== null) return null;
    if (extentMismatch.width) return value;
    // A sized control: empty decorative children fill one dimension while the other is explicitly larger.
    return extentMismatch.height && extentMismatch.allEmpty ? value : null;
  }
  if (parentInner === null) return null;
  const available = parentInner.width - px(style, 'margin-left') - px(style, 'margin-right');
  if (Math.abs(available - node.box.width) <= 1) return null;
  return value;
}

/** Decide whether `height` is evidence of an authored size. Returns the value to emit or null. */
function heightToEmit(view: NodeView, extentMismatch: { width: boolean; height: boolean; allEmpty: boolean; overflow: boolean }): string | null {
  const { node, style } = view;
  const value = style.height;
  if (value === undefined || value === 'auto' || !node.box) return null;
  const tag = node.tag.toLowerCase();
  // A height that follows from the width and an aspect ratio is not an authored height.
  const ratio = /^(?:auto\s+)?([\d.]+)\s*\/\s*([\d.]+)$/.exec(styleValue(style, 'aspect-ratio') ?? 'auto');
  if (ratio?.[1] !== undefined && ratio[2] !== undefined && node.box.height > 0) {
    const expected = Number(ratio[1]) / Number(ratio[2]);
    if (Number.isFinite(expected) && expected > 0 && Math.abs(node.box.width / node.box.height - expected) < 0.01) return null;
  }
  if (REPLACED_TAGS.has(tag)) return value;
  if (isEmptyNode(node)) return value;
  const position = styleValue(style, 'position');
  if ((position === 'absolute' || position === 'fixed') && styleValue(style, 'top') !== 'auto' && styleValue(style, 'bottom') !== 'auto') return null;
  const minHeight = parsePx(styleValue(style, 'min-height'));
  if (minHeight !== null && minHeight > 0 && Math.abs(minHeight - node.box.height) <= 1) return null;
  const maxHeight = parsePx(styleValue(style, 'max-height'));
  if (maxHeight !== null && Math.abs(maxHeight - node.box.height) <= 1) return null;
  if (node.text !== null) return null;
  // A container with flowing children only proves an authored height when the content does
  // not fit (clipping or scrolling); extra space can be collapsed margins, so it is not evidence.
  // A control whose children are all empty decorative boxes (a hamburger button, an icon
  // wrapper) has no flowing content, so its measured height is the authored one.
  if (extentMismatch.overflow) return value;
  if (extentMismatch.height && extentMismatch.allEmpty) return value;
  return extentMismatch.width && extentMismatch.allEmpty ? value : null;
}

/** Compare the content box with the children's extent (including margins). */
function extentMismatchOf(view: NodeView): { width: boolean; height: boolean; allEmpty: boolean; overflow: boolean } {
  const inner = view.node.box ? innerSize(view.node, view.style) : null;
  const extent = childrenExtent(view.children);
  const allEmpty = view.children.length > 0 && view.children.every((child) => isEmptyNode(child.node));
  if (inner === null) return { width: false, height: false, allEmpty, overflow: false };
  if (extent === null) {
    const nonEmptyChildren = view.children.length > 0;
    return { width: nonEmptyChildren && inner.width > 1, height: nonEmptyChildren && inner.height > 1, allEmpty, overflow: false };
  }
  // The content height is only evidence of an authored height when it matches neither the
  // children's full extent nor the extent without collapsed outer margins; content that does
  // not fit (overflow) is the strongest evidence.
  const heightMismatch = Math.abs(extent.height - inner.height) > 1.5 && Math.abs(extent.coreHeight - inner.height) > 1.5;
  const overflow = inner.height < extent.coreHeight - 1.5;
  return { width: Math.abs(extent.width - inner.width) > 1.5, height: heightMismatch, allEmpty, overflow };
}

/**
 * Select the properties a node emits in one state. The result maps property
 * names to the value to emit (usually the captured value; `100%` for boxes
 * that fill their parent).
 */
export function selectEmitted(view: NodeView, options: EmitOptions): Map<string, string> {
  const out = new Map<string, string>();
  const { style, renderedTag } = view;
  const tag = view.node.tag.toLowerCase();
  const get = (property: string): string | undefined => styleValue(style, property);
  const anyBorder = ['top', 'right', 'bottom', 'left'].some((side) => px(style, `border-${side}-width`) > 0);
  const backgroundImage = get('background-image') ?? 'none';
  const gradient = backgroundImage !== 'none' && /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(backgroundImage) && !backgroundImage.includes('url(');
  const mismatch = extentMismatchOf(view);

  for (const property of RENDERING_STYLE_PROPERTIES) {
    const value = style[property];
    if (value === undefined) continue;
    const defaultValue = (STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[property];
    if (value === defaultValue) continue;
    if (SVG_ONLY.has(property)) continue;
    if (INHERITED_PROPERTIES.has(property) && options.inheritedSkip?.(property) === true) {
      if (!(property === 'list-style-type' && (renderedTag === 'ul' || renderedTag === 'ol' || renderedTag === 'menu'))) continue;
    }
    switch (property) {
      case 'display':
        if (options.skipUaDefaults && value === uaDefaultDisplay(renderedTag)) continue;
        break;
      case 'box-sizing':
        if (value === 'border-box') continue;
        break;
      case 'width': {
        const emit = widthToEmit(view, mismatch);
        if (emit === null) continue;
        out.set(property, emit);
        continue;
      }
      case 'height': {
        const emit = heightToEmit(view, mismatch);
        if (emit === null) continue;
        out.set(property, emit);
        continue;
      }
      case 'grid-template-columns':
      case 'grid-template-rows': {
        const display = get('display') ?? '';
        if (display !== 'grid' && display !== 'inline-grid') continue;
        if (property === 'grid-template-rows') {
          const tracks = value.split(/\s+/);
          if (tracks.every((t) => parsePx(t) !== null)) continue; // implicit rows sized by content
        }
        break;
      }
      case 'grid-auto-flow':
      case 'grid-auto-columns':
      case 'grid-auto-rows': {
        const display = get('display') ?? '';
        if (display !== 'grid' && display !== 'inline-grid') continue;
        break;
      }
      case 'background-size':
      case 'background-position':
      case 'background-repeat':
      case 'background-clip':
        if (!gradient) continue;
        break;
      case 'text-decoration-color':
        if ((get('text-decoration-line') ?? 'none') === 'none') continue;
        break;
      case 'transform-origin':
        if ((get('transform') ?? 'none') === 'none') continue;
        break;
      case 'outline-width':
      case 'outline-color':
      case 'outline-offset':
        if ((get('outline-style') ?? 'none') === 'none') continue;
        break;
      case 'border-top-color':
      case 'border-right-color':
      case 'border-bottom-color':
      case 'border-left-color':
      case 'border-top-style':
      case 'border-right-style':
      case 'border-bottom-style':
      case 'border-left-style':
        if (!anyBorder) continue;
        break;
      case 'cursor':
        if (options.skipUaDefaults && value === 'pointer' && tag === 'a' && view.node.attrs.href !== undefined) continue;
        break;
      case 'vertical-align':
        if (options.skipUaDefaults && value === 'middle' && REPLACED_TAGS.has(tag)) continue;
        break;
      case 'max-width':
        break;
      default:
        break;
    }
    out.set(property, value);
  }

  // Tailwind's preflight removes list markers from ul/ol; restore the captured marker.
  if (renderedTag === 'ul' || renderedTag === 'ol' || renderedTag === 'menu') {
    const marker = style['list-style-type'] ?? 'disc';
    if (marker !== 'none') out.set('list-style-type', marker);
    else out.delete('list-style-type');
  }
  // Tailwind's preflight constrains images to max-width: 100%; keep the captured value.
  if (tag === 'img' && style['max-width'] === undefined) out.set('max-width', 'none');
  return out;
}

/** Virtual style of a pseudo-element: its style table entry plus a `content` property. */
export function pseudoStyle(state: UiState, pseudo: { content: string; styleId: string }): StyleRecord {
  const base = state.styles[pseudo.styleId] ?? {};
  const raw = pseudo.content.trim();
  const content = /^["'].*["']$/.test(raw) || raw === 'none' || raw === 'normal' ? raw : `"${raw.replace(/"/g, '')}"`;
  return { ...base, content };
}

/** Properties a pseudo-element emits (a subset: UA display `inline`, auto sizes and host-equal inherited values are skipped). */
export function selectPseudoEmitted(style: StyleRecord, host: StyleRecord): Map<string, string> {
  const out = new Map<string, string>();
  const content = style.content;
  if (content === undefined || content === 'none' || content === 'normal') return out;
  out.set('content', content);
  for (const property of RENDERING_STYLE_PROPERTIES) {
    const value = style[property];
    if (value === undefined) continue;
    const defaultValue = (STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[property];
    if (value === defaultValue) continue;
    if (SVG_ONLY.has(property)) continue;
    if (property === 'display' && value === 'inline') continue;
    if ((property === 'width' || property === 'height') && value === 'auto') continue;
    if (property === 'box-sizing') continue;
    if (property === 'transform-origin' && (styleValue(style, 'transform') ?? 'none') === 'none') continue;
    if (INHERITED_PROPERTIES.has(property) && styleValue(host, property) === value) continue;
    out.set(property, value);
  }
  return out;
}

/**
 * Difference between two emission maps: changed values plus resets for
 * dropped properties. Size resets are skipped when the node is not rendered
 * in the next state (a hidden box has no size to reset).
 */
export function emissionDiff(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>, nextStyle: StyleRecord, nextHidden = false): Map<string, string> {
  const diff = new Map<string, string>();
  for (const [property, value] of next) if (previous.get(property) !== value) diff.set(property, value);
  for (const property of previous.keys()) {
    if (next.has(property)) continue;
    if (property === 'width' || property === 'height') {
      if (!nextHidden) diff.set(property, 'auto');
    } else if (property === 'content') diff.set(property, 'none');
    else diff.set(property, styleValue(nextStyle, property) ?? 'auto');
  }
  return diff;
}

/** Classes for an emission map over a style (context comes from `style`, values from `emitted`). */
export function classesForEmission(style: StyleRecord, emitted: ReadonlyMap<string, string>, tokens: TokenIndex, prefix: string): { classes: string[]; skipped: SkippedProperty[] } {
  if (emitted.size === 0) return { classes: [], skipped: [] };
  const merged: Record<string, string> = { ...style };
  for (const [property, value] of emitted) merged[property] = value;
  const mapping = classesFor(merged, { tokens, only: new Set(emitted.keys()), prefix });
  return { classes: [...mapping.classes], skipped: [...mapping.skipped] };
}

/** Per-state emission of a node including its pseudo-elements. */
export interface StateEmission {
  readonly node: Map<string, string>;
  readonly before: Map<string, string>;
  readonly after: Map<string, string>;
  readonly style: StyleRecord;
  readonly beforeStyle: StyleRecord;
  readonly afterStyle: StyleRecord;
  /** True when the node is not rendered in this state (no box). */
  readonly hidden: boolean;
}

/** Compute what a node emits in one state. */
export function emissionInState(view: NodeView, state: UiState, options: EmitOptions): StateEmission {
  const node = selectEmitted(view, options);
  const beforeStyle = view.node.pseudo?.before ? pseudoStyle(state, view.node.pseudo.before) : {};
  const afterStyle = view.node.pseudo?.after ? pseudoStyle(state, view.node.pseudo.after) : {};
  return {
    node,
    before: selectPseudoEmitted(beforeStyle, view.style),
    after: selectPseudoEmitted(afterStyle, view.style),
    style: view.style,
    beforeStyle,
    afterStyle,
    hidden: view.node.box === null,
  };
}

/** Classes of one state emission, with a variant prefix (e.g. `md:`), sorted. */
export function emissionClasses(emission: StateEmission, tokens: TokenIndex, prefix: string): { classes: string[]; skipped: SkippedProperty[] } {
  const node = classesForEmission(emission.style, emission.node, tokens, prefix);
  const before = classesForEmission(emission.beforeStyle, emission.before, tokens, `${prefix}before:`);
  const after = classesForEmission(emission.afterStyle, emission.after, tokens, `${prefix}after:`);
  return {
    classes: [...node.classes, ...before.classes, ...after.classes].sort(compareClasses),
    skipped: [...node.skipped, ...before.skipped, ...after.skipped],
  };
}

/** Classes that turn emission `from` into emission `to` (changed values plus resets), prefixed. */
export function transitionClasses(from: StateEmission, to: StateEmission, tokens: TokenIndex, prefix: string): { classes: string[]; skipped: SkippedProperty[] } {
  const node = classesForEmission(to.style, emissionDiff(from.node, to.node, to.style, to.hidden), tokens, prefix);
  const before = classesForEmission(to.beforeStyle, emissionDiff(from.before, to.before, to.beforeStyle), tokens, `${prefix}before:`);
  const after = classesForEmission(to.afterStyle, emissionDiff(from.after, to.after, to.afterStyle), tokens, `${prefix}after:`);
  return {
    classes: [...node.classes, ...before.classes, ...after.classes].sort(compareClasses),
    skipped: [...node.skipped, ...before.skipped, ...after.skipped],
  };
}

/** Static responsive classes of a node across the base states. */
export interface NodeClasses {
  /** Ordered class list: base (sorted), then each breakpoint's variants (sorted) in ascending width. */
  readonly classes: readonly string[];
  readonly skipped: readonly SkippedProperty[];
  /** Emission per viewport slot (null when the node is missing at that viewport). */
  readonly emissions: readonly (StateEmission | null)[];
}

/** Inherited-property skip rule: the child equals its parent at every viewport where both exist. Never for the root. */
export function inheritedSkipFor(views: readonly (NodeView | null)[]): (property: string) => boolean {
  return (property) =>
    views.every((view) => {
      if (view === null) return true;
      if (view.parent === null) return false;
      return styleValue(view.style, property) === styleValue(view.parent.style, property);
    });
}

/** Compute the mobile-first responsive class list of a node. */
export function responsiveClasses(gn: GenNode, model: GenerationModel, tokens: TokenIndex): NodeClasses {
  const views = model.slots.map((slot) => viewAtSlot(gn, slot));
  const inheritedSkip = inheritedSkipFor(views);
  const emissions = views.map((view, i) => {
    const slot = model.slots[i];
    if (view === null || slot === undefined) return null;
    return emissionInState(view, slot.state, { skipUaDefaults: true, inheritedSkip });
  });
  const classes: string[] = [];
  const skipped: SkippedProperty[] = [];
  let previous: StateEmission | null = null;
  for (let i = 0; i < emissions.length; i += 1) {
    const emission = emissions[i];
    const slot = model.slots[i];
    if (emission === null || emission === undefined || slot === undefined) continue;
    const prefix = slot.breakpoint === null ? '' : `${slot.breakpoint}:`;
    const result = previous === null ? emissionClasses(emission, tokens, prefix) : transitionClasses(previous, emission, tokens, prefix);
    classes.push(...result.classes);
    skipped.push(...result.skipped);
    previous = emission;
  }
  return { classes, skipped, emissions };
}
