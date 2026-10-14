/**
 * Synthetic UI DNA documents for tests. `fixtureDocument` builds a small but
 * realistic document with the structure of Fixture A (navbar with a hamburger
 * toggle, hero, three cards, an image, a details accordion, a footer) at two
 * viewports, with consistent style tables and boxes produced by a tiny layout
 * engine, two component definitions, tokens, assets and observed transitions.
 * `multiPageFormDocument` builds a two-page document sharing a header and a
 * footer, with a signup form whose submit transition shows two validation
 * messages, fill transitions, a navigation transition and a data asset.
 * Everything is built with the schema helpers so `validateUiDna` passes.
 */
import {
  measured,
  observed,
  inferred,
  UI_DNA_VERSION,
  type A11yProps,
  type Asset,
  type Box,
  type ComponentDefinition,
  type ComponentInstance,
  type RoleTreeNode,
  type Token,
  type Transition,
  type UiDnaDocument,
  type UiNode,
  type UiState,
} from '@rohzzn/uidna-schema';
import { STYLE_DEFAULTS } from '../browser/style-properties.js';
import { digestValue, stableStringify } from '../domain/digest.js';

/** Fixed capture time used throughout the synthetic document. */
export const FIXTURE_CAPTURED_AT = '2026-10-13T17:29:00.000Z';
/** Scan id of the synthetic document. */
export const FIXTURE_SCAN_ID = 'scan_20261013_abcdef';
/** Page URL of the synthetic document. */
export const FIXTURE_URL = 'http://127.0.0.1:4173/';

const FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const COLORS = {
  white: 'rgb(255, 255, 255)',
  surface: 'rgb(245, 247, 251)',
  text: 'rgb(27, 31, 42)',
  muted: 'rgb(91, 100, 116)',
  primary: 'rgb(47, 91, 234)',
  primaryDark: 'rgb(36, 72, 191)',
  green: 'rgb(31, 157, 106)',
  amber: 'rgb(217, 138, 31)',
  border: 'rgb(223, 227, 236)',
  transparent: 'rgba(0, 0, 0, 0)',
};

type Style = Record<string, string>;
type PerViewport<T> = T | readonly [T, T];

/** Declarative node of the synthetic page. */
export interface Spec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  role?: string | null;
  name?: string | null;
  style?: Style;
  /** Overrides applied at the desktop viewport. */
  desktop?: Style;
  /** Intrinsic content width for inline-level nodes (per viewport). */
  w?: PerViewport<number>;
  /** Own content height for empty leaves (per viewport). */
  h?: PerViewport<number>;
  /** Text lines (per viewport) for text leaves. */
  lines?: PerViewport<number>;
  /** Grid column count (per viewport) for grid containers. */
  gridColumns?: PerViewport<number>;
  /** Intrinsic aspect ratio (width / height) for replaced elements. */
  aspect?: number;
  children?: Spec[];
  pseudoAfter?: { content: string; style: Style };
  a11y?: A11yProps;
  interactive?: boolean;
  /** Form-control facts (input, select, textarea, button). */
  form?: UiNode['form'];
}

/** Edits applied to a derived state (keyed by node path). */
export interface Variation {
  readonly attrs?: Readonly<Record<string, Record<string, string | null>>>;
  readonly style?: Readonly<Record<string, Style>>;
  readonly pseudoAfter?: Readonly<Record<string, string>>;
  /** Own text replaced on a node. */
  readonly text?: Readonly<Record<string, string>>;
  /** Form facts merged into a control. */
  readonly form?: Readonly<Record<string, Partial<NonNullable<UiNode['form']>>>>;
  /** Accessibility properties merged into a node. */
  readonly a11y?: Readonly<Record<string, A11yProps>>;
}

const INHERITED = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'cursor', 'text-align', 'letter-spacing', 'list-style-type', 'visibility'] as const;
const BLOCK_TAGS = new Set(['body', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'figure', 'figcaption', 'details', 'form']);
const INLINE_BLOCK_TAGS = new Set(['button', 'input', 'select', 'textarea']);

function per<T>(value: PerViewport<T> | undefined, viewport: number, fallback: T): T {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return (value as readonly [T, T])[viewport === 0 ? 0 : 1];
  return value as T;
}

function px(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && value.endsWith('px') ? n : 0;
}

function fmt(n: number): string {
  return `${Number(n.toFixed(2))}px`;
}

function uaDisplay(tag: string): string {
  if (tag === 'li' || tag === 'summary') return 'list-item';
  if (INLINE_BLOCK_TAGS.has(tag)) return 'inline-block';
  if (BLOCK_TAGS.has(tag)) return 'block';
  return 'inline';
}

interface LaidOut {
  spec: Spec;
  style: Style;
  box: Box | null;
  children: LaidOut[];
  pseudoAfter: { content: string; style: Style } | null;
}

interface LayoutContext {
  viewport: number;
  variation: Variation;
  path: string;
}

/** Lay out a spec tree. */
function layout(spec: Spec, ctx: LayoutContext, parent: { style: Style; hidden: boolean } | null, x: number, y: number, available: number): LaidOut {
  const viewport = ctx.viewport;
  const raw: Style = { ...(spec.style ?? {}), ...(viewport === 1 ? (spec.desktop ?? {}) : {}), ...(ctx.variation.style?.[ctx.path] ?? {}) };
  const attrEdits = ctx.variation.attrs?.[ctx.path] ?? {};
  const attrs: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...(spec.attrs ?? {}), ...attrEdits })) if (value !== null) attrs[name] = value;
  const style: Style = { 'box-sizing': 'border-box' };
  if (parent) for (const prop of INHERITED) if (parent.style[prop] !== undefined) style[prop] = parent.style[prop];
  Object.assign(style, raw);
  const tag = spec.tag;
  style.display = raw.display ?? uaDisplay(tag);
  const hidden = (parent?.hidden ?? false) || style.display === 'none';
  const fontSize = px(style['font-size']) || 16;
  const lineHeight = px(style['line-height']) || Math.round(fontSize * 1.5 * 100) / 100;
  const pad = { t: px(style['padding-top']), r: px(style['padding-right']), b: px(style['padding-bottom']), l: px(style['padding-left']) };
  const bor = { t: px(style['border-top-width']), r: px(style['border-right-width']), b: px(style['border-bottom-width']), l: px(style['border-left-width']) };
  const mar = { t: px(style['margin-top']), r: px(style['margin-right']), b: px(style['margin-bottom']), l: px(style['margin-left']) };
  const display = style.display;
  const parentDisplay = parent?.style.display ?? 'block';
  const parentFlexRow = parentDisplay === 'flex' && (parent?.style['flex-direction'] ?? 'row') === 'row';
  const parentFlexColumn = parentDisplay === 'flex' && parent?.style['flex-direction'] === 'column';
  const inlineLevel = display.startsWith('inline');
  const position = style.position ?? 'static';
  const text = ctx.variation.text?.[ctx.path] ?? spec.text;
  const childSpecs = spec.children ?? [];
  const lines = per(spec.lines, viewport, 1);

  const childrenHidden = hidden || (tag === 'details' && attrs.open === undefined);
  const detailsChildHidden = (child: Spec): boolean => childrenHidden && !(tag === 'details' && child.tag === 'summary' && !hidden);

  const contentWidthOf = (): number => {
    const explicit = spec.w !== undefined ? per(spec.w, viewport, 0) : null;
    if (explicit !== null) return explicit + pad.l + pad.r + bor.l + bor.r;
    if (text !== undefined && childSpecs.length === 0) return Math.round(text.length * fontSize * 0.5) + pad.l + pad.r + bor.l + bor.r;
    return 0;
  };

  let width: number;
  const explicitWidth = raw.width !== undefined && raw.width !== 'auto' && raw.width.endsWith('px') ? px(raw.width) : null;
  const percentWidth = raw.width === '100%';
  if (hidden) width = 0;
  else if (explicitWidth !== null) width = explicitWidth;
  else if (position === 'absolute' && style.left !== undefined && style.right !== undefined) width = available - px(style.left) - px(style.right);
  else if (percentWidth) width = available;
  else if (inlineLevel || parentFlexRow || (display === 'flex' && parentFlexRow)) width = Math.max(contentWidthOf(), 0);
  else {
    width = available - mar.l - mar.r;
    const maxWidth = raw['max-width'] !== undefined && raw['max-width'] !== 'none' ? px(raw['max-width']) : null;
    if (maxWidth !== null) width = Math.min(width, maxWidth);
  }
  const columnStretch = parentFlexColumn && ['stretch', 'normal'].includes(parent?.style['align-items'] ?? 'normal');
  if (!hidden && columnStretch && explicitWidth === null && !inlineLevel) width = available;
  const columnContent = parentFlexColumn && !columnStretch;
  if (!hidden && columnContent && explicitWidth === null && !percentWidth) width = Math.max(contentWidthOf(), 0);
  const contentSized =
    !hidden &&
    explicitWidth === null &&
    !percentWidth &&
    !(position === 'absolute' && style.left !== undefined && style.right !== undefined) &&
    (inlineLevel || parentFlexRow || columnContent) &&
    spec.w === undefined &&
    childSpecs.length > 0;

  const startX = position === 'absolute' ? x + px(style.left) : x + mar.l;
  const startY = position === 'absolute' ? y + px(style.top) : y + mar.t;
  let inner = width - pad.l - pad.r - bor.l - bor.r;
  const contentX = startX + pad.l + bor.l;
  const contentY = startY + pad.t + bor.t;
  const outerWidth = (c: LaidOut): number => (c.box?.width ?? 0) + px(c.style['margin-left']) + px(c.style['margin-right']);
  const outerHeight = (c: LaidOut): number => (c.box?.height ?? 0) + px(c.style['margin-top']) + px(c.style['margin-bottom']);

  // Lay out children (temporarily at content origin; flex/grid adjust after measuring).
  const children: LaidOut[] = [];
  let contentHeight = 0;
  const gap = px(style.gap) || px(style['row-gap']);
  const childPath = (index: number): string => (ctx.path === '' ? `${index}` : `${ctx.path}/${index}`);
  const childCtx = (index: number): LayoutContext => ({ ...ctx, path: childPath(index) });

  if (display === 'flex' && (style['flex-direction'] ?? 'row') === 'row') {
    const laid = childSpecs.map((child, i) => layout(child, childCtx(i), { style, hidden: detailsChildHidden(child) }, contentX, contentY, inner));
    const visible = laid.filter((c) => c.box !== null);
    let totalWidth = visible.reduce((sum, c) => sum + outerWidth(c), 0) + gap * Math.max(0, visible.length - 1);
    let rowHeight = visible.reduce((max, c) => Math.max(max, outerHeight(c)), 0);
    if (childSpecs.length === 0 && text !== undefined) {
      totalWidth = spec.w !== undefined ? per(spec.w, viewport, 0) : Math.round(text.length * fontSize * 0.5);
      rowHeight = lines * lineHeight;
    }
    if (contentSized) {
      width = totalWidth + pad.l + pad.r + bor.l + bor.r;
      inner = totalWidth;
    }
    let cursor = contentX;
    let step = gap;
    const justify = style['justify-content'] ?? 'normal';
    if (justify === 'space-between' && visible.length > 1) step = gap + (inner - totalWidth) / (visible.length - 1);
    if (justify === 'center') cursor = contentX + (inner - totalWidth) / 2;
    for (const child of visible) {
      const box = child.box;
      if (!box) continue;
      const dx = cursor + px(child.style['margin-left']) - box.x;
      const align = style['align-items'] ?? 'normal';
      const dy = align === 'center' ? contentY + (rowHeight - box.height) / 2 - box.y : contentY + px(child.style['margin-top']) - box.y;
      shift(child, dx, dy);
      cursor += box.width + px(child.style['margin-left']) + px(child.style['margin-right']) + step;
    }
    children.push(...laid);
    contentHeight = rowHeight;
  } else if (display === 'grid') {
    const columns = per(spec.gridColumns, viewport, 1);
    const columnGap = px(style['column-gap']) || gap;
    const trackWidth = (inner - columnGap * (columns - 1)) / columns;
    style['grid-template-columns'] = Array.from({ length: columns }, () => fmt(trackWidth)).join(' ');
    let rowTop = contentY;
    let rowHeight = 0;
    const laid: LaidOut[] = [];
    childSpecs.forEach((child, i) => {
      const column = i % columns;
      if (column === 0 && i > 0) {
        rowTop += rowHeight + gap;
        rowHeight = 0;
      }
      const cx = contentX + column * (trackWidth + columnGap);
      const node = layout(child, childCtx(i), { style, hidden: detailsChildHidden(child) }, cx, rowTop, trackWidth);
      laid.push(node);
      if (node.box) rowHeight = Math.max(rowHeight, node.box.height + px(node.style['margin-top']) + px(node.style['margin-bottom']));
    });
    if ((style['align-items'] ?? 'normal') === 'center') {
      laid.forEach((node, i) => {
        if (!node.box) return;
        const rowIndex = Math.floor(i / columns);
        const rowNodes = laid.filter((_, j) => Math.floor(j / columns) === rowIndex && laid[j]?.box);
        const height = rowNodes.reduce((max, n) => Math.max(max, n.box?.height ?? 0), 0);
        const top = rowNodes.reduce((min, n) => Math.min(min, n.box?.y ?? min), Number.POSITIVE_INFINITY);
        shift(node, 0, top + (height - node.box.height) / 2 - node.box.y);
      });
    }
    children.push(...laid);
    contentHeight = laid.length === 0 ? 0 : rowTop + rowHeight - contentY;
  } else {
    // block / flex column / list-item: vertical stacking
    let cursor = contentY;
    const isColumn = display === 'flex';
    childSpecs.forEach((child, i) => {
      const node = layout(child, childCtx(i), { style, hidden: detailsChildHidden(child) }, contentX, cursor, inner);
      children.push(node);
      if (node.box && (node.style.position ?? 'static') !== 'absolute') {
        cursor = node.box.y + node.box.height + px(node.style['margin-bottom']) + (isColumn && i < childSpecs.length - 1 ? gap : 0);
      }
    });
    contentHeight = Math.max(0, cursor - contentY);
    if (text !== undefined && childSpecs.length === 0) contentHeight = lines * lineHeight;
    if (text === undefined && childSpecs.length === 0) contentHeight = per(spec.h, viewport, 0);
    if (text !== undefined && childSpecs.length > 0) contentHeight += lines * lineHeight;
    if (contentSized) {
      const widest = children.reduce((max, c) => Math.max(max, outerWidth(c)), 0);
      width = widest + pad.l + pad.r + bor.l + bor.r;
      inner = widest;
    }
  }

  let height: number;
  const explicitHeight = raw.height !== undefined && raw.height !== 'auto' && raw.height.endsWith('px') ? px(raw.height) : null;
  if (hidden) height = 0;
  else if (explicitHeight !== null) height = explicitHeight;
  else if (spec.aspect !== undefined) height = width / spec.aspect;
  else height = contentHeight + pad.t + pad.b + bor.t + bor.b;
  if (display === 'flex' && (style['flex-direction'] ?? 'row') === 'row' && (style['justify-content'] === 'center' || style['align-items'] === 'center') && explicitHeight !== null) {
    // children were centered against the content height; re-center against the explicit height
    const innerHeight = height - pad.t - pad.b - bor.t - bor.b;
    for (const child of children) if (child.box) shift(child, 0, (innerHeight - contentHeight) / 2);
  }
  if (display === 'flex' && style['flex-direction'] === 'column' && style['justify-content'] === 'center' && explicitHeight !== null) {
    const innerHeight = height - pad.t - pad.b - bor.t - bor.b;
    for (const child of children) if (child.box) shift(child, 0, (innerHeight - contentHeight) / 2);
  }

  const box: Box | null = hidden ? null : { x: round(startX), y: round(startY), width: round(width), height: round(height) };
  if (hidden) {
    style.width = 'auto';
    style.height = 'auto';
  } else {
    style.width = fmt(width);
    style.height = fmt(height);
  }
  const pseudoContent = ctx.variation.pseudoAfter?.[ctx.path] ?? spec.pseudoAfter?.content;
  const pseudoAfter = spec.pseudoAfter && pseudoContent !== undefined ? { content: pseudoContent, style: { ...spec.pseudoAfter.style } } : null;
  const formEdit = ctx.variation.form?.[ctx.path];
  const form = spec.form === undefined ? undefined : formEdit === undefined ? spec.form : { ...spec.form, ...formEdit };
  const a11yEdit = ctx.variation.a11y?.[ctx.path];
  const a11y = a11yEdit === undefined ? spec.a11y : { ...(spec.a11y ?? {}), ...a11yEdit };
  const edited: Spec = { ...spec, attrs, ...(text === undefined ? {} : { text }), ...(form === undefined ? {} : { form }), ...(a11y === undefined ? {} : { a11y }) };
  return { spec: edited, style: dropDefaults(style), box, children, pseudoAfter };
}

function round(n: number): number {
  return Number(n.toFixed(2));
}

function shift(node: LaidOut, dx: number, dy: number): void {
  if (node.box) node.box = { ...node.box, x: round(node.box.x + dx), y: round(node.box.y + dy) };
  for (const child of node.children) shift(child, dx, dy);
}

function dropDefaults(style: Style): Style {
  const out: Style = {};
  for (const [prop, value] of Object.entries(style)) {
    if ((STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[prop] === value) continue;
    out[prop] = value;
  }
  return out;
}

/* ------------------------------------------------------------- the page */

const link = (text: string, href: string, extra: Partial<Spec> = {}): Spec => ({
  tag: 'a',
  attrs: { class: 'nav-link', href },
  text,
  role: 'link',
  name: text,
  interactive: true,
  style: { display: 'block', 'padding-top': '8px', 'padding-bottom': '8px', 'font-size': '15px', 'font-weight': '500', color: COLORS.muted, cursor: 'pointer', 'line-height': '22.5px' },
  desktop: { display: 'inline-block', 'padding-left': '4px', 'padding-right': '4px' },
  w: [Math.round(text.length * 7.5), Math.round(text.length * 7.5)],
  ...extra,
});

const card = (color: string, title: string, body: string, bodyLines: readonly [number, number]): Spec => ({
  tag: 'article',
  attrs: { class: 'card' },
  role: 'article',
  style: {
    'padding-top': '24px',
    'padding-right': '24px',
    'padding-bottom': '24px',
    'padding-left': '24px',
    'border-top-left-radius': '12px',
    'border-top-right-radius': '12px',
    'border-bottom-right-radius': '12px',
    'border-bottom-left-radius': '12px',
    'background-color': COLORS.white,
    ...border(),
    'box-shadow': 'rgba(27, 31, 42, 0.08) 0px 8px 24px 0px',
  },
  children: [
    { tag: 'div', attrs: { class: 'card-icon', 'aria-hidden': 'true' }, style: { width: '40px', height: '40px', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'margin-bottom': '16px', 'background-color': color } },
    { tag: 'h3', attrs: { class: 'card-title' }, text: title, role: 'heading', name: title, a11y: { level: 3 }, style: { 'font-size': '20px', 'font-weight': '600', 'margin-bottom': '8px', 'line-height': '30px' } },
    { tag: 'p', attrs: { class: 'card-body' }, text: body, style: { color: COLORS.muted, 'font-size': '15px', 'line-height': '22.5px' }, lines: bodyLines },
  ],
});

function border(): Style {
  return {
    'border-top-width': '1px',
    'border-right-width': '1px',
    'border-bottom-width': '1px',
    'border-left-width': '1px',
    'border-top-style': 'solid',
    'border-right-style': 'solid',
    'border-bottom-style': 'solid',
    'border-left-style': 'solid',
    'border-top-color': COLORS.border,
    'border-right-color': COLORS.border,
    'border-bottom-color': COLORS.border,
    'border-left-color': COLORS.border,
  };
}

const accordionItem = (question: string, answer: string): Spec => ({
  tag: 'details',
  attrs: { class: 'accordion-item' },
  role: 'group',
  style: { ...border(), 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'background-color': COLORS.white, 'margin-bottom': '16px' },
  children: [
    {
      tag: 'summary',
      attrs: { class: 'accordion-summary' },
      text: question,
      role: 'button',
      name: question,
      interactive: true,
      a11y: { expanded: false },
      style: { cursor: 'pointer', 'padding-top': '16px', 'padding-right': '24px', 'padding-bottom': '16px', 'padding-left': '24px', 'font-size': '17px', 'font-weight': '600', 'list-style-type': 'none', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'line-height': '25.5px' },
      pseudoAfter: { content: '"+"', style: { 'font-size': '20px', color: COLORS.muted, display: 'inline', 'font-family': FONT, 'font-weight': '600', 'line-height': '30px' } },
    },
    {
      tag: 'div',
      attrs: { class: 'accordion-panel' },
      style: { 'padding-right': '24px', 'padding-bottom': '24px', 'padding-left': '24px', color: COLORS.muted },
      children: [{ tag: 'p', text: answer, lines: [3, 1] }],
    },
  ],
});

/** The Fixture A page as a spec tree (body is the root). */
export function fixtureSpec(): Spec {
  return {
    tag: 'body',
    style: { 'font-family': FONT, color: COLORS.text, 'background-color': COLORS.white, 'line-height': '24px', 'font-size': '16px', 'font-weight': '400' },
    children: [
      {
        tag: 'header',
        attrs: { class: 'site-header' },
        role: 'banner',
        style: { 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': COLORS.border, 'background-color': COLORS.white },
        children: [
          {
            tag: 'nav',
            attrs: { class: 'navbar', 'aria-label': 'Primary' },
            role: 'navigation',
            name: 'Primary',
            style: { position: 'relative', 'max-width': '1120px', 'padding-top': '16px', 'padding-right': '24px', 'padding-bottom': '16px', 'padding-left': '24px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '24px' },
            desktop: { 'margin-left': '80px', 'margin-right': '80px' },
            children: [
              {
                tag: 'a',
                attrs: { class: 'brand', href: '#top' },
                role: 'link',
                name: 'Lumen',
                interactive: true,
                style: { display: 'flex', 'align-items': 'center', gap: '8px', 'font-weight': '700', 'font-size': '20px', cursor: 'pointer', 'line-height': '30px' },
                w: 86,
                children: [
                  { tag: 'span', attrs: { class: 'brand-mark', 'aria-hidden': 'true' }, style: { display: 'inline-block', width: '24px', height: '24px', 'border-top-left-radius': '6px', 'border-top-right-radius': '6px', 'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '6px', 'background-color': COLORS.primary } },
                  { tag: 'span', attrs: { class: 'brand-name' }, text: 'Lumen', w: 54 },
                ],
              },
              {
                tag: 'button',
                attrs: { class: 'nav-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'primary-menu', 'aria-label': 'Open menu' },
                role: 'button',
                name: 'Open menu',
                interactive: true,
                a11y: { expanded: false, controls: ['primary-menu'] },
                style: {
                  display: 'flex',
                  'flex-direction': 'column',
                  'justify-content': 'center',
                  gap: '4px',
                  width: '40px',
                  height: '40px',
                  'padding-top': '8px',
                  'padding-right': '8px',
                  'padding-bottom': '8px',
                  'padding-left': '8px',
                  ...border(),
                  'border-top-left-radius': '6px',
                  'border-top-right-radius': '6px',
                  'border-bottom-right-radius': '6px',
                  'border-bottom-left-radius': '6px',
                  'background-color': COLORS.white,
                  cursor: 'pointer',
                  'font-size': '13.333px',
                  'font-family': 'Arial',
                  'line-height': 'normal',
                },
                desktop: { display: 'none' },
                children: [0, 1, 2].map(() => ({ tag: 'span', attrs: { class: 'nav-toggle-bar', 'aria-hidden': 'true' }, style: { display: 'block', height: '2px', width: '100%', 'background-color': COLORS.text, 'border-top-left-radius': '2px', 'border-top-right-radius': '2px', 'border-bottom-right-radius': '2px', 'border-bottom-left-radius': '2px' } })),
              },
              {
                tag: 'ul',
                attrs: { class: 'nav-menu', id: 'primary-menu' },
                role: 'list',
                style: {
                  display: 'none',
                  position: 'absolute',
                  top: '73px',
                  left: '0px',
                  right: '0px',
                  'flex-direction': 'column',
                  'align-items': 'stretch',
                  'padding-top': '8px',
                  'padding-right': '24px',
                  'padding-bottom': '16px',
                  'padding-left': '24px',
                  'background-color': COLORS.white,
                  'border-bottom-width': '1px',
                  'border-bottom-style': 'solid',
                  'border-bottom-color': COLORS.border,
                  'z-index': '10',
                  'list-style-type': 'none',
                },
                desktop: { display: 'flex', position: 'static', top: 'auto', left: 'auto', right: 'auto', 'flex-direction': 'row', 'align-items': 'center', gap: '24px', 'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px', 'background-color': COLORS.transparent, 'border-bottom-width': '0px', 'border-bottom-style': 'none', 'z-index': 'auto' },
                children: [
                  { tag: 'li', role: 'listitem', children: [link('Features', '#features')] },
                  { tag: 'li', role: 'listitem', children: [link('Pricing', '#pricing')] },
                  { tag: 'li', role: 'listitem', children: [link('FAQ', '#faq')] },
                  {
                    tag: 'li',
                    role: 'listitem',
                    children: [
                      link('Get started', '#start', {
                        attrs: { class: 'nav-link nav-link-accent', href: '#start' },
                        style: { display: 'block', 'padding-top': '8px', 'padding-right': '16px', 'padding-bottom': '8px', 'padding-left': '16px', 'margin-top': '8px', 'text-align': 'center', 'border-top-left-radius': '999px', 'border-top-right-radius': '999px', 'border-bottom-right-radius': '999px', 'border-bottom-left-radius': '999px', 'background-color': COLORS.primary, color: COLORS.white, 'font-size': '15px', 'font-weight': '500', cursor: 'pointer', 'line-height': '22.5px' },
                        desktop: { display: 'inline-block', 'margin-top': '0px', 'text-align': 'start' },
                      }),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        tag: 'main',
        attrs: { id: 'top' },
        role: 'main',
        children: [
          {
            tag: 'section',
            attrs: { class: 'hero', 'aria-labelledby': 'hero-title' },
            role: 'region',
            name: 'Notes that think with you',
            style: { 'max-width': '1120px', 'padding-top': '48px', 'padding-right': '16px', 'padding-bottom': '48px', 'padding-left': '16px', display: 'grid', 'align-items': 'center', gap: '32px' },
            desktop: { 'padding-top': '64px', 'padding-right': '24px', 'padding-bottom': '64px', 'padding-left': '24px', gap: '48px', 'margin-left': '80px', 'margin-right': '80px' },
            gridColumns: [1, 2],
            children: [
              {
                tag: 'div',
                attrs: { class: 'hero-copy' },
                children: [
                  { tag: 'p', attrs: { class: 'eyebrow' }, text: 'Now in public beta', style: { display: 'inline-block', 'padding-top': '4px', 'padding-right': '16px', 'padding-bottom': '4px', 'padding-left': '16px', 'border-top-left-radius': '999px', 'border-top-right-radius': '999px', 'border-bottom-right-radius': '999px', 'border-bottom-left-radius': '999px', 'background-color': COLORS.surface, color: COLORS.primary, 'font-size': '13px', 'font-weight': '600', 'letter-spacing': '0.26px', 'text-transform': 'uppercase', 'line-height': '19.5px' }, w: 140 },
                  { tag: 'h1', attrs: { class: 'hero-title', id: 'hero-title' }, text: 'Notes that think with you', role: 'heading', name: 'Notes that think with you', a11y: { level: 1 }, style: { 'margin-top': '16px', 'font-size': '32px', 'line-height': '35.2px', 'font-weight': '700', 'letter-spacing': '-0.64px' }, desktop: { 'font-size': '48px', 'line-height': '52.8px', 'letter-spacing': '-0.96px' }, lines: [2, 2] },
                  { tag: 'p', attrs: { class: 'hero-lead' }, text: 'Lumen keeps your ideas connected. Write, link and revisit, and let structure appear on its own.', style: { 'margin-top': '16px', 'font-size': '16px', color: COLORS.muted, 'max-width': '480px', 'line-height': '24px' }, desktop: { 'font-size': '18px', 'line-height': '27px' }, lines: [4, 3] },
                  {
                    tag: 'div',
                    attrs: { class: 'hero-actions' },
                    style: { 'margin-top': '24px', display: 'flex', 'flex-wrap': 'wrap', gap: '16px' },
                    children: [
                      { tag: 'a', attrs: { class: 'button button-primary', href: '#start' }, text: 'Start writing', role: 'link', name: 'Start writing', interactive: true, w: 100, style: { display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', 'padding-top': '12px', 'padding-right': '20px', 'padding-bottom': '12px', 'padding-left': '20px', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'font-size': '16px', 'font-weight': '600', ...border(), 'border-top-color': COLORS.transparent, 'border-right-color': COLORS.transparent, 'border-bottom-color': COLORS.transparent, 'border-left-color': COLORS.transparent, 'background-color': COLORS.primary, color: COLORS.white, cursor: 'pointer' } },
                      { tag: 'a', attrs: { class: 'button button-secondary', href: '#features' }, text: 'See how it works', role: 'link', name: 'See how it works', interactive: true, w: 124, style: { display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', 'padding-top': '12px', 'padding-right': '20px', 'padding-bottom': '12px', 'padding-left': '20px', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'font-size': '16px', 'font-weight': '600', ...border(), 'background-color': COLORS.white, color: COLORS.text, cursor: 'pointer' } },
                    ],
                  },
                ],
              },
              {
                tag: 'figure',
                attrs: { class: 'hero-figure' },
                role: 'figure',
                children: [
                  { tag: 'img', attrs: { class: 'hero-image', src: 'assets/illustration.svg', alt: 'Abstract illustration of connected notes', width: '520', height: '400' }, role: 'img', name: 'Abstract illustration of connected notes', style: { display: 'block', width: '100%', height: 'auto', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'aspect-ratio': 'auto 520 / 400' }, aspect: 520 / 400 },
                ],
              },
            ],
          },
          {
            tag: 'section',
            attrs: { class: 'features', id: 'features', 'aria-labelledby': 'features-title' },
            role: 'region',
            name: 'Everything in one place',
            style: { 'max-width': '1120px', 'padding-top': '32px', 'padding-right': '16px', 'padding-bottom': '32px', 'padding-left': '16px' },
            desktop: { 'padding-top': '48px', 'padding-right': '24px', 'padding-bottom': '48px', 'padding-left': '24px', 'margin-left': '80px', 'margin-right': '80px' },
            children: [
              { tag: 'h2', attrs: { class: 'section-title', id: 'features-title' }, text: 'Everything in one place', role: 'heading', name: 'Everything in one place', a11y: { level: 2 }, style: { 'font-size': '26px', 'line-height': '31.2px', 'font-weight': '700', 'margin-bottom': '32px' }, desktop: { 'font-size': '32px', 'line-height': '38.4px' } },
              {
                tag: 'div',
                attrs: { class: 'card-grid' },
                style: { display: 'grid', gap: '24px' },
                gridColumns: [1, 3],
                children: [
                  card(COLORS.primary, 'Capture quickly', 'Jot down a thought in a second. Lumen files it where it belongs and keeps it searchable.', [3, 3]),
                  card(COLORS.green, 'Link naturally', 'Mention a note and the link is made. Backlinks show you what connects to what.', [3, 3]),
                  card(COLORS.amber, 'Review calmly', 'A daily digest surfaces the notes that matter today, so nothing important is lost.', [3, 3]),
                ],
              },
            ],
          },
          {
            tag: 'section',
            attrs: { class: 'faq', id: 'faq', 'aria-labelledby': 'faq-title' },
            role: 'region',
            name: 'Frequently asked questions',
            style: { 'background-color': COLORS.surface, 'padding-top': '32px', 'padding-right': '16px', 'padding-bottom': '32px', 'padding-left': '16px' },
            desktop: { 'padding-top': '48px', 'padding-right': '24px', 'padding-bottom': '48px', 'padding-left': '24px' },
            children: [
              { tag: 'h2', attrs: { class: 'section-title', id: 'faq-title' }, text: 'Frequently asked questions', role: 'heading', name: 'Frequently asked questions', a11y: { level: 2 }, style: { 'font-size': '26px', 'line-height': '31.2px', 'font-weight': '700', 'margin-bottom': '32px', 'max-width': '1120px' }, desktop: { 'font-size': '32px', 'line-height': '38.4px', 'margin-left': '56px', 'margin-right': '56px' } },
              {
                tag: 'div',
                attrs: { class: 'accordion' },
                style: { 'max-width': '760px' },
                desktop: { 'margin-left': '236px', 'margin-right': '236px' },
                children: [
                  accordionItem('Is there a free plan?', 'Yes. The free plan includes unlimited notes on one device and seven days of history.'),
                  accordionItem('Can I export my notes?', 'Every note can be exported as Markdown at any time, individually or as a full archive.'),
                  accordionItem('Does Lumen work offline?', 'Lumen is offline first. Changes sync when you are back online, with no merge conflicts.'),
                ],
              },
            ],
          },
        ],
      },
      {
        tag: 'footer',
        attrs: { class: 'site-footer', id: 'start' },
        role: 'contentinfo',
        style: { 'border-top-width': '1px', 'border-top-style': 'solid', 'border-top-color': COLORS.border, 'background-color': COLORS.white },
        children: [
          {
            tag: 'div',
            attrs: { class: 'footer-inner' },
            style: { 'max-width': '1120px', 'padding-top': '32px', 'padding-right': '24px', 'padding-bottom': '32px', 'padding-left': '24px', display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-start', 'justify-content': 'space-between', gap: '24px', 'flex-wrap': 'wrap' },
            desktop: { 'flex-direction': 'row', 'align-items': 'center', 'margin-left': '80px', 'margin-right': '80px' },
            children: [
              { tag: 'p', attrs: { class: 'footer-brand' }, text: 'Lumen', style: { 'font-weight': '700', 'font-size': '18px', 'line-height': '27px' }, w: 54 },
              {
                tag: 'ul',
                attrs: { class: 'footer-links' },
                role: 'list',
                style: { display: 'flex', gap: '24px', 'list-style-type': 'none' },
                children: ['Home', 'Features', 'FAQ'].map((label, i) => ({
                  tag: 'li',
                  role: 'listitem',
                  children: [{ tag: 'a', attrs: { class: 'footer-link', href: ['#top', '#features', '#faq'][i] ?? '#' }, text: label, role: 'link', name: label, interactive: true, style: { 'font-size': '14px', color: COLORS.muted, 'line-height': '21px', cursor: 'pointer' }, w: label.length * 7 }],
                })),
              },
              { tag: 'p', attrs: { class: 'footer-copy' }, text: 'Fixture A for UI DNA. No real product.', style: { 'font-size': '13px', color: COLORS.muted, 'line-height': '19.5px' }, w: 240 },
            ],
          },
        ],
      },
      { tag: 'script', attrs: { src: 'app.js' }, style: { display: 'none' } },
    ],
  };
}

/* ---------------------------------------------------------- states */

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

/** Identity of a synthetic state. */
interface StateSpec {
  readonly id: string;
  readonly viewportIndex: 0 | 1;
  readonly kind: 'base' | 'derived';
  readonly parentStateId: string | null;
  readonly variation: Variation;
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
}

/** Build a `UiState` from a laid-out tree. */
function buildStateFrom(spec: Spec, options: StateSpec): UiState {
  const { id, viewportIndex, kind, parentStateId, variation } = options;
  const viewport = VIEWPORTS[viewportIndex];
  const root = layout(spec, { viewport: viewportIndex, variation, path: '' }, null, 0, 0, viewport.width);
  const nodes: UiNode[] = [];
  const styles: Record<string, string> = {};
  const styleTable: Record<string, Record<string, string>> = {};
  const styleId = (style: Style): string => {
    const key = stableStringify(style);
    const existing = styles[key];
    if (existing !== undefined) return existing;
    const next = `s${(Object.keys(styleTable).length + 1).toString().padStart(3, '0')}`;
    styles[key] = next;
    styleTable[next] = { ...style };
    return next;
  };
  const roleTree: RoleTreeNode[] = [];
  const visit = (node: LaidOut, parentId: string | null, path: string, depth: number, inForm: boolean): string => {
    const id = `n${(nodes.length + 1).toString().padStart(3, '0')}`;
    const index = nodes.length;
    const nodeInForm = inForm || node.spec.tag === 'form';
    const placeholder: UiNode = {
      id,
      parentId,
      path,
      depth,
      tag: node.spec.tag,
      role: node.spec.role ?? null,
      name: node.spec.name ?? null,
      attrs: { ...(node.spec.attrs ?? {}) },
      text: node.spec.text ?? null,
      box: node.box,
      styleId: styleId(node.style),
      a11y: { ...(node.spec.a11y ?? {}) },
      visible: node.box !== null,
      interactive: node.spec.interactive ?? false,
      inForm: nodeInForm,
      childIds: [],
      ...(node.spec.form === undefined ? {} : { form: { ...node.spec.form } }),
    };
    nodes.push(placeholder);
    if (node.spec.role && node.box !== null) roleTree.push({ nodeId: id, role: node.spec.role, name: node.spec.name ?? '', depth, states: node.spec.a11y?.expanded === undefined ? {} : { expanded: node.spec.a11y.expanded } });
    const childIds = node.children.map((child, i) => visit(child, id, path === '' ? `${i}` : `${path}/${i}`, depth + 1, nodeInForm));
    const pseudo = node.pseudoAfter ? { after: { content: node.pseudoAfter.content, styleId: styleId(node.pseudoAfter.style) } } : undefined;
    nodes[index] = { ...placeholder, childIds, ...(pseudo ? { pseudo } : {}) };
    return id;
  };
  visit(root, null, '', 0, false);
  const bodyBox = root.box ?? { x: 0, y: 0, width: viewport.width, height: 0 };
  const height = Math.round(bodyBox.height);
  return {
    id,
    pageId: options.pageId,
    kind,
    parentStateId,
    url: options.url,
    title: options.title,
    viewport: { width: viewport.width, height: viewport.height },
    capturedAt: FIXTURE_CAPTURED_AT,
    evidenceId: 'ev_000000000001',
    screenshot: { path: `states/${id}/screenshot.png`, width: viewport.width, height: Math.max(height, 1), digest: digestValue({ id, height }), truncated: false },
    roleTreeDigest: digestValue(roleTree),
    domDigest: digestValue(nodes.map((n) => [n.path, n.tag, n.attrs, n.text])),
    document: { width: viewport.width, height, scrollHeight: height },
    nodeCount: nodes.length,
    nodes,
    styles: styleTable,
    roleTree,
    provenance: { kind: 'measured', source: 'computed-style', stateId: id, viewport: { width: viewport.width, height: viewport.height }, evidenceId: 'ev_000000000001', capturedAt: FIXTURE_CAPTURED_AT, confidence: 1 },
  };
}

/** Build a Fixture A state. */
function buildState(id: string, viewportIndex: 0 | 1, kind: 'base' | 'derived', parentStateId: string | null, variation: Variation): UiState {
  return buildStateFrom(fixtureSpec(), { id, viewportIndex, kind, parentStateId, variation, pageId: 'pg_01', url: FIXTURE_URL, title: 'Lumen — Notes that think with you' });
}

/** Node paths of interest in the synthetic page. */
export const FIXTURE_PATHS = {
  header: '0',
  nav: '0/0',
  brand: '0/0/0',
  toggle: '0/0/1',
  menu: '0/0/2',
  navItems: ['0/0/2/0', '0/0/2/1', '0/0/2/2', '0/0/2/3'],
  firstNavLink: '0/0/2/0/0',
  main: '1',
  hero: '1/0',
  heroImage: '1/0/1/0',
  cardGrid: '1/1/1',
  cards: ['1/1/1/0', '1/1/1/1', '1/1/1/2'],
  accordion: '1/2/1',
  details: ['1/2/1/0', '1/2/1/1', '1/2/1/2'],
  firstSummary: '1/2/1/0/0',
  footer: '2',
} as const;

function nodeAt(state: UiState, path: string): UiNode {
  const node = state.nodes.find((n) => n.path === path);
  if (node === undefined) throw new Error(`fixture: no node at ${path} in ${state.id}`);
  return node;
}

function tokenOf(id: string, kind: Token['kind'], generatedName: string, value: string, sampleCount: number, properties: string[], stateIds: string[], name?: string): Token {
  const ctx = { capturedAt: FIXTURE_CAPTURED_AT, evidenceId: 'ev_000000000002' };
  return {
    id,
    kind,
    generatedName,
    ...(name === undefined ? {} : { name: inferred(name, { capturedAt: FIXTURE_CAPTURED_AT, rationale: 'test annotation' }, 0.8) }),
    value: measured(value, 'computed-style', ctx),
    cluster: { sampleCount, members: [{ value, count: sampleCount }], properties },
    usage: { count: sampleCount, stateIds },
  };
}

/** Build the synthetic Fixture A document. */
export function fixtureDocument(): UiDnaDocument {
  const st01 = buildState('st_01', 0, 'base', null, {});
  const st02 = buildState('st_02', 1, 'base', null, {});
  const menuOpen: Variation = {
    attrs: { [FIXTURE_PATHS.toggle]: { 'aria-expanded': 'true', 'aria-label': 'Close menu' } },
    style: { [FIXTURE_PATHS.menu]: { display: 'flex' } },
  };
  const st03 = buildState('st_03', 0, 'derived', 'st_01', menuOpen);
  const detailsOpen: Variation = {
    attrs: { [FIXTURE_PATHS.details[0]]: { open: '' } },
    pseudoAfter: { [FIXTURE_PATHS.firstSummary]: '"−"' },
  };
  const st04 = buildState('st_04', 0, 'derived', 'st_01', detailsOpen);
  const hover: Variation = { style: { [FIXTURE_PATHS.firstNavLink]: { color: COLORS.text } } };
  const st05 = buildState('st_05', 1, 'derived', 'st_02', hover);
  const states = [st01, st02, st03, st04, st05];

  const observedCtx = { capturedAt: FIXTURE_CAPTURED_AT, evidenceId: 'ev_000000000003' };
  const transitionOf = (id: string, from: UiState, to: UiState, action: Transition['action'], revert: Transition['revert'], changed: string[]): Transition => ({
    id,
    from: from.id,
    action,
    to: to.id,
    sideEffects: false,
    network: { requests: 0, nonGet: 0 },
    revert,
    change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: changed.map((p) => nodeAt(to, p).id) },
    provenance: observed(true, 'interaction', { ...observedCtx, stateId: from.id, viewport: from.viewport }).provenance as Transition['provenance'],
  });
  const target = (state: UiState, path: string, nth = 0): NonNullable<Transition['action']['target']> => {
    const node = nodeAt(state, path);
    return { nodeId: node.id, nodePath: path, role: node.role, name: node.name, tag: node.tag, nth };
  };
  const transitions: Transition[] = [
    transitionOf('tr_01', st01, st03, { type: 'click', target: target(st01, FIXTURE_PATHS.toggle) }, { method: 'escape', succeeded: true }, [FIXTURE_PATHS.toggle, FIXTURE_PATHS.menu]),
    transitionOf('tr_02', st03, st01, { type: 'key', target: target(st03, FIXTURE_PATHS.toggle), key: 'Escape' }, { method: 'none', succeeded: true }, [FIXTURE_PATHS.toggle, FIXTURE_PATHS.menu]),
    transitionOf('tr_03', st01, st04, { type: 'click', target: target(st01, FIXTURE_PATHS.firstSummary) }, { method: 'toggle', succeeded: true }, [FIXTURE_PATHS.details[0]]),
    transitionOf('tr_04', st02, st05, { type: 'hover', target: target(st02, FIXTURE_PATHS.firstNavLink) }, { method: 'none', succeeded: true }, [FIXTURE_PATHS.firstNavLink]),
  ];

  const cardDefinition: ComponentDefinition = {
    id: 'cmp_01',
    fingerprint: 'fp_card',
    generatedName: 'Component01',
    structure: { tag: 'article', role: 'article', signature: 'article>div+h3+p', depth: 2, childCount: 3 },
    props: [
      { name: 'title', kind: 'text', relativePath: '1', values: ['Capture quickly', 'Link naturally', 'Review calmly'] },
      { name: 'body', kind: 'text', relativePath: '2', values: FIXTURE_PATHS.cards.map((p) => nodeAt(st01, `${p}/2`).text ?? '') },
    ],
    variants: [],
    instanceCount: 3,
    matchesByState: { st_01: 3, st_02: 3 },
    confidence: 0.92,
    provenance: measured(true, 'computed-style', { capturedAt: FIXTURE_CAPTURED_AT }).provenance,
  };
  const navDefinition: ComponentDefinition = {
    id: 'cmp_02',
    fingerprint: 'fp_navitem',
    generatedName: 'Component02',
    name: inferred('nav item', { capturedAt: FIXTURE_CAPTURED_AT, rationale: 'test annotation' }, 0.9),
    structure: { tag: 'li', role: 'listitem', signature: 'li>a', depth: 1, childCount: 1 },
    props: [{ name: 'link', kind: 'link', relativePath: '0', values: ['#features', '#pricing', '#faq', '#start'] }],
    variants: [
      { id: 'var_01', instanceIds: ['inst_004', 'inst_005', 'inst_006'], differences: [] },
      { id: 'var_02', instanceIds: ['inst_007'], differences: [{ property: 'background-color', values: ['rgb(47, 91, 234)'] }] },
    ],
    instanceCount: 4,
    matchesByState: { st_01: 4, st_02: 4 },
    confidence: 0.88,
    provenance: measured(true, 'computed-style', { capturedAt: FIXTURE_CAPTURED_AT }).provenance,
  };
  const instances: ComponentInstance[] = [];
  let instanceIndex = 0;
  const addInstance = (definitionId: string, state: UiState, path: string, variantId: string | null, props: Record<string, string>): void => {
    instanceIndex += 1;
    const node = nodeAt(state, path);
    instances.push({
      id: `inst_${instanceIndex.toString().padStart(3, '0')}`,
      definitionId,
      stateId: state.id,
      nodeId: node.id,
      nodePath: path,
      box: node.box === null ? { value: null, provenance: { kind: 'unknown', reason: 'not rendered' } } : measured(node.box, 'bounding-box', { capturedAt: FIXTURE_CAPTURED_AT, stateId: state.id }),
      variantId,
      props,
    });
  };
  for (const path of FIXTURE_PATHS.cards) addInstance('cmp_01', st01, path, null, { title: nodeAt(st01, `${path}/1`).text ?? '', body: nodeAt(st01, `${path}/2`).text ?? '' });
  FIXTURE_PATHS.navItems.forEach((path, i) => addInstance('cmp_02', st01, path, i === 3 ? 'var_02' : 'var_01', { link: nodeAt(st01, `${path}/0`).attrs.href ?? '' }));
  for (const path of FIXTURE_PATHS.cards) addInstance('cmp_01', st02, path, null, { title: nodeAt(st02, `${path}/1`).text ?? '', body: nodeAt(st02, `${path}/2`).text ?? '' });
  FIXTURE_PATHS.navItems.forEach((path, i) => addInstance('cmp_02', st02, path, i === 3 ? 'var_02' : 'var_01', { link: nodeAt(st02, `${path}/0`).attrs.href ?? '' }));

  const stateIds = ['st_01', 'st_02'];
  const image: Asset = {
    id: 'asset_01',
    kind: 'image',
    url: `${FIXTURE_URL}assets/illustration.svg`,
    origin: 'same-origin',
    mime: 'image/svg+xml',
    bytes: 1734,
    width: 520,
    height: 400,
    authorization: 'unknown',
    usage: [st01, st02].map((state) => ({ stateId: state.id, nodeId: nodeAt(state, FIXTURE_PATHS.heroImage).id, nodePath: FIXTURE_PATHS.heroImage })),
    provenance: measured(true, 'network', { capturedAt: FIXTURE_CAPTURED_AT }).provenance,
  };

  return {
    dnaVersion: UI_DNA_VERSION,
    target: {
      kind: 'url',
      url: FIXTURE_URL,
      scanId: FIXTURE_SCAN_ID,
      scannedAt: FIXTURE_CAPTURED_AT,
      viewports: VIEWPORTS.map((v) => ({ width: v.width, height: v.height })),
      budget: { limits: { timeMs: 180000, pages: 1, actions: 60, resources: 400 }, used: { timeMs: 4200, pages: 1, actions: 4, resources: 6 } },
      tool: { name: 'uidna', version: '0.1.0' },
    },
    app: {
      pages: [{ id: 'pg_01', url: FIXTURE_URL, title: measured('Lumen — Notes that think with you', 'a11y-tree', { capturedAt: FIXTURE_CAPTURED_AT, stateId: 'st_01' }), stateIds: states.map((s) => s.id) }],
      routes: [],
      layouts: [],
      navigation: [],
    },
    states: { items: states, transitions },
    components: { definitions: [cardDefinition, navDefinition], instances },
    visual: {
      tokens: {
        colors: [
          tokenOf('tok_color_01', 'color', 'color-01', '#2f5bea', 9, ['background-color', 'color'], stateIds, 'brand'),
          tokenOf('tok_color_02', 'color', 'color-02', '#1b1f2a', 14, ['color', 'background-color'], stateIds),
          tokenOf('tok_color_03', 'color', 'color-03', '#5b6474', 11, ['color'], stateIds),
        ],
        typography: [],
        fontFamilies: [tokenOf('tok_font-family_01', 'font-family', 'font-01', FONT, 40, ['font-family'], stateIds)],
        fontSizes: [tokenOf('tok_font-size_01', 'font-size', 'size-01', '16px', 12, ['font-size'], stateIds), tokenOf('tok_font-size_02', 'font-size', 'size-02', '20px', 5, ['font-size'], stateIds)],
        spacing: [tokenOf('tok_spacing_01', 'spacing', 'space-01', '16px', 22, ['padding-top', 'margin-top'], stateIds), tokenOf('tok_spacing_02', 'spacing', 'space-02', '24px', 18, ['padding-left', 'gap'], stateIds)],
        radii: [tokenOf('tok_radius_01', 'radius', 'radius-01', '12px', 10, ['border-top-left-radius'], stateIds)],
        shadows: [tokenOf('tok_shadow_01', 'shadow', 'shadow-01', 'rgba(27, 31, 42, 0.08) 0px 8px 24px 0px', 3, ['box-shadow'], stateIds)],
        breakpoints: [],
      },
      layout: [],
    },
    behavior: [],
    assets: [image],
    limitations: [],
    evidence: [
      { id: 'ev_000000000001', kind: 'scan', artifacts: ['states/st_01/capture.json', 'states/st_02/capture.json'], capturedAt: FIXTURE_CAPTURED_AT },
      { id: 'ev_000000000002', kind: 'tokens', artifacts: [], capturedAt: FIXTURE_CAPTURED_AT },
      { id: 'ev_000000000003', kind: 'explore', artifacts: ['states/st_03/capture.json', 'states/st_04/capture.json', 'states/st_05/capture.json'], capturedAt: FIXTURE_CAPTURED_AT },
    ],
    annotations: [],
  };
}

/* ------------------------------------------------- multi-page + form */

/** URL of the second page of the multi-page document. */
export const FIXTURE_FORM_URL = 'http://127.0.0.1:4173/features.html';
/** Scan id of the multi-page document. */
export const FIXTURE_MULTI_SCAN_ID = 'scan_20261013_fedcba';

/** Node paths of interest in the multi-page document (header, footer and main paths are the same on both pages). */
export const MULTI_PATHS = {
  header: '0',
  nav: '0/0',
  brand: '0/0/0',
  navMenu: '0/0/1',
  navItems: ['0/0/1/0', '0/0/1/1'],
  homeLink: '0/0/1/0/0',
  featuresLink: '0/0/1/1/0',
  main: '1',
  heroCta: '1/0/3/0',
  form: '1/0/2',
  nameInput: '1/0/2/0/1',
  nameError: '1/0/2/0/2',
  emailInput: '1/0/2/1/1',
  emailError: '1/0/2/1/2',
  submit: '1/0/2/2/0',
  status: '1/0/2/3',
  footer: '2',
  footerLinks: '2/0/1',
  statusPageLink: '2/0/1/2',
} as const;

const plainLink = (text: string, href: string, extra: Partial<Spec> = {}): Spec => ({
  tag: 'a',
  attrs: { class: 'nav-link', href },
  text,
  role: 'link',
  name: text,
  interactive: true,
  style: { display: 'inline-block', 'padding-top': '8px', 'padding-bottom': '8px', 'font-size': '15px', 'font-weight': '500', color: COLORS.muted, cursor: 'pointer', 'line-height': '22.5px' },
  w: Math.round(text.length * 7.5),
  ...extra,
});

function sharedHeader(): Spec {
  return {
    tag: 'header',
    attrs: { class: 'site-header' },
    role: 'banner',
    style: { 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': COLORS.border, 'background-color': COLORS.white },
    children: [
      {
        tag: 'nav',
        attrs: { class: 'navbar', 'aria-label': 'Primary' },
        role: 'navigation',
        name: 'Primary',
        style: { 'max-width': '1120px', 'padding-top': '16px', 'padding-right': '24px', 'padding-bottom': '16px', 'padding-left': '24px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '24px' },
        desktop: { 'margin-left': '80px', 'margin-right': '80px' },
        children: [
          { tag: 'a', attrs: { class: 'brand', href: '/' }, text: 'Lumen', role: 'link', name: 'Lumen', interactive: true, w: 54, style: { display: 'inline-block', 'font-weight': '700', 'font-size': '20px', cursor: 'pointer', 'line-height': '30px' } },
          {
            tag: 'ul',
            attrs: { class: 'nav-menu' },
            role: 'list',
            style: { display: 'flex', 'align-items': 'center', gap: '24px', 'list-style-type': 'none' },
            children: [
              { tag: 'li', role: 'listitem', children: [plainLink('Home', '/')] },
              { tag: 'li', role: 'listitem', children: [plainLink('Features', '/features.html')] },
            ],
          },
        ],
      },
    ],
  };
}

function sharedFooter(): Spec {
  const footerLink = (text: string, href: string, extra: Record<string, string> = {}): Spec => ({
    tag: 'a',
    attrs: { class: 'footer-link', href, ...extra },
    text,
    role: 'link',
    name: text,
    interactive: true,
    style: { display: 'inline-block', 'font-size': '14px', color: COLORS.muted, 'line-height': '21px', cursor: 'pointer' },
    w: text.length * 7,
  });
  return {
    tag: 'footer',
    attrs: { class: 'site-footer' },
    role: 'contentinfo',
    style: { 'border-top-width': '1px', 'border-top-style': 'solid', 'border-top-color': COLORS.border, 'background-color': COLORS.white },
    children: [
      {
        tag: 'div',
        attrs: { class: 'footer-inner' },
        style: { 'max-width': '1120px', 'padding-top': '32px', 'padding-right': '24px', 'padding-bottom': '32px', 'padding-left': '24px', display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-start', gap: '24px' },
        desktop: { 'flex-direction': 'row', 'align-items': 'center', 'justify-content': 'space-between', 'margin-left': '80px', 'margin-right': '80px' },
        children: [
          { tag: 'p', attrs: { class: 'footer-brand' }, text: 'Lumen', style: { 'font-weight': '700', 'font-size': '18px', 'line-height': '27px' }, w: 54 },
          {
            tag: 'div',
            attrs: { class: 'footer-links' },
            style: { display: 'flex', gap: '24px' },
            children: [footerLink('Home', '/'), footerLink('Features', '/features.html'), footerLink('Status page', 'https://example.com/', { rel: 'noopener' })],
          },
          { tag: 'p', attrs: { class: 'footer-copy' }, text: 'Fixture for UI DNA. No real product.', style: { 'font-size': '13px', color: COLORS.muted, 'line-height': '19.5px' }, w: 240 },
        ],
      },
    ],
  };
}

const BODY_STYLE: Style = { 'font-family': FONT, color: COLORS.text, 'background-color': COLORS.white, 'line-height': '24px', 'font-size': '16px', 'font-weight': '400' };

/** The home page of the multi-page document. */
export function homePageSpec(): Spec {
  return {
    tag: 'body',
    style: BODY_STYLE,
    children: [
      sharedHeader(),
      {
        tag: 'main',
        role: 'main',
        children: [
          {
            tag: 'section',
            attrs: { class: 'hero', 'aria-labelledby': 'hero-title' },
            role: 'region',
            name: 'Notes that think with you',
            style: { 'max-width': '1120px', 'padding-top': '48px', 'padding-right': '16px', 'padding-bottom': '48px', 'padding-left': '16px' },
            desktop: { 'padding-top': '64px', 'padding-right': '24px', 'padding-bottom': '64px', 'padding-left': '24px', 'margin-left': '80px', 'margin-right': '80px' },
            children: [
              { tag: 'p', attrs: { class: 'eyebrow' }, text: 'Now in public beta', style: { display: 'inline-block', color: COLORS.primary, 'font-size': '13px', 'font-weight': '600', 'text-transform': 'uppercase', 'line-height': '19.5px' }, w: 140 },
              { tag: 'h1', attrs: { class: 'hero-title', id: 'hero-title' }, text: 'Notes that think with you', role: 'heading', name: 'Notes that think with you', a11y: { level: 1 }, style: { 'margin-top': '16px', 'font-size': '32px', 'line-height': '35.2px', 'font-weight': '700' }, desktop: { 'font-size': '48px', 'line-height': '52.8px' }, lines: [2, 1] },
              { tag: 'p', attrs: { class: 'hero-lead' }, text: 'Lumen keeps your ideas connected across every page of your work.', style: { 'margin-top': '16px', color: COLORS.muted, 'max-width': '480px' }, lines: [3, 2] },
              {
                tag: 'div',
                attrs: { class: 'hero-actions' },
                style: { 'margin-top': '24px', display: 'flex', gap: '16px' },
                children: [
                  { tag: 'a', attrs: { class: 'button button-primary', href: '/features.html' }, text: 'See features', role: 'link', name: 'See features', interactive: true, w: 100, style: { display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', 'padding-top': '12px', 'padding-right': '20px', 'padding-bottom': '12px', 'padding-left': '20px', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'font-size': '16px', 'font-weight': '600', 'background-color': COLORS.primary, color: COLORS.white, cursor: 'pointer' } },
                ],
              },
            ],
          },
        ],
      },
      sharedFooter(),
    ],
  };
}

const INPUT_STYLE: Style = { display: 'block', width: '100%', 'padding-top': '10px', 'padding-right': '12px', 'padding-bottom': '10px', 'padding-left': '12px', ...border(), 'border-top-left-radius': '8px', 'border-top-right-radius': '8px', 'border-bottom-right-radius': '8px', 'border-bottom-left-radius': '8px', 'font-size': '16px', 'line-height': '24px', 'font-family': FONT };
const ERROR_STYLE: Style = { display: 'none', 'margin-top': '6px', color: 'rgb(185, 28, 28)', 'font-size': '13px', 'line-height': '19.5px' };

function field(id: string, label: string, type: string, extra: Record<string, string> = {}): Spec {
  return {
    tag: 'div',
    attrs: { class: 'field' },
    style: { 'margin-bottom': '16px' },
    children: [
      { tag: 'label', attrs: { class: 'label', for: id }, text: label, style: { display: 'block', 'font-weight': '600', 'margin-bottom': '6px', 'font-size': '14px', 'line-height': '21px' } },
      {
        tag: 'input',
        attrs: { class: 'input', id, name: id, type, ...extra },
        role: 'textbox',
        name: label,
        interactive: true,
        h: 24,
        style: INPUT_STYLE,
        form: { valid: false, validationMessage: 'Please fill out this field.', required: true, type, hasValue: false },
      },
      { tag: 'p', attrs: { class: 'error', id: `${id}-error`, role: 'alert', hidden: '' }, role: 'alert', text: '', style: ERROR_STYLE },
    ],
  };
}

/** The signup page of the multi-page document. */
export function formPageSpec(): Spec {
  return {
    tag: 'body',
    style: BODY_STYLE,
    children: [
      sharedHeader(),
      {
        tag: 'main',
        role: 'main',
        children: [
          {
            tag: 'section',
            attrs: { class: 'panel', 'aria-labelledby': 'signup-title' },
            role: 'region',
            name: 'Create your account',
            style: { 'max-width': '480px', 'padding-top': '32px', 'padding-right': '16px', 'padding-bottom': '32px', 'padding-left': '16px' },
            desktop: { 'margin-left': '80px', 'margin-right': '80px' },
            children: [
              { tag: 'h1', attrs: { class: 'panel-title', id: 'signup-title' }, text: 'Create your account', role: 'heading', name: 'Create your account', a11y: { level: 1 }, style: { 'font-size': '28px', 'line-height': '33.6px', 'font-weight': '700' } },
              { tag: 'p', attrs: { class: 'panel-lead' }, text: 'Free for one device. No credit card.', style: { 'margin-top': '8px', 'margin-bottom': '24px', color: COLORS.muted } },
              {
                tag: 'form',
                attrs: { class: 'form', id: 'signup', novalidate: '' },
                role: 'form',
                children: [
                  field('name', 'Full name', 'text', { autocomplete: 'name' }),
                  field('email', 'Email', 'email', { autocomplete: 'email' }),
                  {
                    tag: 'div',
                    attrs: { class: 'actions' },
                    style: { display: 'flex', gap: '12px', 'margin-top': '8px' },
                    children: [
                      { tag: 'button', attrs: { class: 'button button-primary', type: 'submit' }, text: 'Create account', role: 'button', name: 'Create account', interactive: true, w: 120, style: { display: 'inline-flex', 'align-items': 'center', 'padding-top': '12px', 'padding-right': '20px', 'padding-bottom': '12px', 'padding-left': '20px', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px', 'font-size': '16px', 'font-weight': '600', 'background-color': COLORS.primary, color: COLORS.white, cursor: 'pointer', 'font-family': FONT, 'line-height': '24px' } },
                    ],
                  },
                  { tag: 'p', attrs: { class: 'status', id: 'status', role: 'status', hidden: '' }, role: 'status', text: '', style: { display: 'none', 'margin-top': '16px', color: COLORS.green } },
                ],
              },
            ],
          },
        ],
      },
      sharedFooter(),
    ],
  };
}

/** Build the two-page document: home (`/`) and signup (`/features.html`) sharing header and footer. */
export function multiPageFormDocument(): UiDnaDocument {
  const home = (id: string, viewportIndex: 0 | 1): UiState => buildStateFrom(homePageSpec(), { id, viewportIndex, kind: 'base', parentStateId: null, variation: {}, pageId: 'pg_01', url: FIXTURE_URL, title: 'Lumen — Home' });
  const form = (id: string, viewportIndex: 0 | 1, kind: 'base' | 'derived', parentStateId: string | null, variation: Variation): UiState => buildStateFrom(formPageSpec(), { id, viewportIndex, kind, parentStateId, variation, pageId: 'pg_02', url: FIXTURE_FORM_URL, title: 'Lumen — Create your account' });
  const st01 = home('st_01', 0);
  const st02 = home('st_02', 1);
  const st03 = form('st_03', 0, 'base', null, {});
  const st04 = form('st_04', 1, 'base', null, {});
  const errors: Variation = {
    attrs: {
      [MULTI_PATHS.nameInput]: { 'aria-invalid': 'true', 'aria-errormessage': 'name-error' },
      [MULTI_PATHS.emailInput]: { 'aria-invalid': 'true', 'aria-errormessage': 'email-error' },
      [MULTI_PATHS.nameError]: { hidden: null },
      [MULTI_PATHS.emailError]: { hidden: null },
    },
    style: { [MULTI_PATHS.nameError]: { display: 'block' }, [MULTI_PATHS.emailError]: { display: 'block' } },
    text: { [MULTI_PATHS.nameError]: 'Enter your full name.', [MULTI_PATHS.emailError]: 'Enter a valid email address.' },
    a11y: { [MULTI_PATHS.nameInput]: { invalid: true, errorMessage: 'Enter your full name.', focused: true }, [MULTI_PATHS.emailInput]: { invalid: true, errorMessage: 'Enter a valid email address.' } },
  };
  const st05 = form('st_05', 0, 'derived', 'st_03', errors);
  const filledName: Variation = { form: { [MULTI_PATHS.nameInput]: { valid: true, validationMessage: null, hasValue: true } } };
  const st06 = form('st_06', 0, 'derived', 'st_03', filledName);
  const filledBoth: Variation = { form: { ...filledName.form, [MULTI_PATHS.emailInput]: { valid: true, validationMessage: null, hasValue: true } } };
  const st07 = form('st_07', 0, 'derived', 'st_06', filledBoth);
  const submitted: Variation = {
    ...filledBoth,
    attrs: { [MULTI_PATHS.status]: { hidden: null } },
    style: { [MULTI_PATHS.status]: { display: 'block' } },
    text: { [MULTI_PATHS.status]: 'Could not reach the server.' },
  };
  const st08 = form('st_08', 0, 'derived', 'st_07', submitted);
  const st09 = buildStateFrom(homePageSpec(), { id: 'st_09', viewportIndex: 0, kind: 'derived', parentStateId: 'st_01', variation: { style: { [MULTI_PATHS.brand]: { color: COLORS.primary } } }, pageId: 'pg_01', url: FIXTURE_URL, title: 'Lumen — Home' });
  const states = [st01, st02, st03, st04, st05, st06, st07, st08, st09];

  const observedCtx = { capturedAt: FIXTURE_CAPTURED_AT, evidenceId: 'ev_000000000003' };
  const provenanceOf = (from: UiState): Transition['provenance'] => observed(true, 'interaction', { ...observedCtx, stateId: from.id, viewport: from.viewport }).provenance as Transition['provenance'];
  const target = (state: UiState, path: string): NonNullable<Transition['action']['target']> => {
    const node = nodeAt(state, path);
    return { nodeId: node.id, nodePath: path, role: node.role, name: node.name, tag: node.tag, nth: 0 };
  };
  const changed = (state: UiState, paths: readonly string[]): string[] => paths.map((p) => nodeAt(state, p).id);
  const transitions: Transition[] = [
    {
      id: 'tr_01',
      from: st01.id,
      action: { type: 'click', target: target(st01, MULTI_PATHS.featuresLink) },
      to: st03.id,
      sideEffects: true,
      network: { requests: 1, nonGet: 0 },
      revert: { method: 'reload', succeeded: true },
      change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: [] },
      navigation: { toPageId: 'pg_02', url: FIXTURE_FORM_URL },
      provenance: provenanceOf(st01),
    },
    {
      id: 'tr_02',
      from: st03.id,
      action: { type: 'submit', target: target(st03, MULTI_PATHS.submit) },
      to: st05.id,
      sideEffects: false,
      network: { requests: 0, nonGet: 0 },
      revert: { method: 'reload', succeeded: true },
      change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: changed(st05, [MULTI_PATHS.nameInput, MULTI_PATHS.nameError, MULTI_PATHS.emailInput, MULTI_PATHS.emailError]) },
      navigation: null,
      provenance: provenanceOf(st03),
    },
    {
      id: 'tr_03',
      from: st03.id,
      action: { type: 'fill', target: target(st03, MULTI_PATHS.nameInput), value: 'Ada Lovelace' },
      to: st06.id,
      sideEffects: false,
      network: { requests: 0, nonGet: 0 },
      revert: { method: 'none', succeeded: false },
      change: { domChanged: false, roleTreeChanged: false, screenshotChanged: true, changedNodeIds: changed(st06, [MULTI_PATHS.nameInput]) },
      navigation: null,
      provenance: provenanceOf(st03),
    },
    {
      id: 'tr_04',
      from: st06.id,
      action: { type: 'fill', target: target(st06, MULTI_PATHS.emailInput), value: 'ada@example.com' },
      to: st07.id,
      sideEffects: false,
      network: { requests: 0, nonGet: 0 },
      revert: { method: 'none', succeeded: false },
      change: { domChanged: false, roleTreeChanged: false, screenshotChanged: true, changedNodeIds: changed(st07, [MULTI_PATHS.emailInput]) },
      navigation: null,
      provenance: provenanceOf(st06),
    },
    {
      id: 'tr_05',
      from: st07.id,
      action: { type: 'submit', target: target(st07, MULTI_PATHS.submit) },
      to: st08.id,
      sideEffects: true,
      network: { requests: 1, nonGet: 1 },
      revert: { method: 'reload', succeeded: true },
      change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: changed(st08, [MULTI_PATHS.status]) },
      navigation: null,
      provenance: provenanceOf(st07),
    },
    {
      id: 'tr_06',
      from: st01.id,
      action: { type: 'key', target: target(st01, MULTI_PATHS.brand), key: 'Tab' },
      to: st09.id,
      sideEffects: false,
      network: { requests: 0, nonGet: 0 },
      revert: { method: 'none', succeeded: true },
      change: { domChanged: false, roleTreeChanged: false, screenshotChanged: true, changedNodeIds: changed(st09, [MULTI_PATHS.brand]) },
      navigation: null,
      provenance: provenanceOf(st01),
    },
  ];

  const navDefinition: ComponentDefinition = {
    id: 'cmp_01',
    fingerprint: 'fp_navitem_multi',
    generatedName: 'Component01',
    structure: { tag: 'li', role: 'listitem', signature: 'li>a', depth: 1, childCount: 1 },
    props: [{ name: 'link', kind: 'link', relativePath: '0', values: ['/', '/features.html'] }],
    variants: [],
    instanceCount: 2,
    matchesByState: { st_01: 2, st_02: 2, st_03: 2, st_04: 2 },
    pageIds: ['pg_01', 'pg_02'],
    confidence: 0.9,
    provenance: measured(true, 'computed-style', { capturedAt: FIXTURE_CAPTURED_AT }).provenance,
  };
  const instances: ComponentInstance[] = [];
  for (const state of [st01, st02, st03, st04]) {
    for (const path of MULTI_PATHS.navItems) {
      const node = nodeAt(state, path);
      instances.push({
        id: `inst_${(instances.length + 1).toString().padStart(3, '0')}`,
        definitionId: 'cmp_01',
        stateId: state.id,
        nodeId: node.id,
        nodePath: path,
        box: node.box === null ? { value: null, provenance: { kind: 'unknown', reason: 'not rendered' } } : measured(node.box, 'bounding-box', { capturedAt: FIXTURE_CAPTURED_AT, stateId: state.id }),
        variantId: null,
        props: { link: nodeAt(state, `${path}/0`).attrs.href ?? '' },
      });
    }
  }

  const widestHome = st02;
  const region = (role: string, path: string): { role: string; name: string | null; nodePath: string; nodeId: string } => {
    const node = nodeAt(widestHome, path);
    return { role, name: node.name, nodePath: path, nodeId: node.id };
  };
  const navProvenance = measured(null, 'a11y-tree', { capturedAt: FIXTURE_CAPTURED_AT, stateId: st02.id }, 1).provenance;
  const edge = (id: string, fromState: UiState, fromPageId: string, path: string, to: { url: string; pageId: string | null; sameOrigin: boolean; fragment: boolean }, followed: boolean) => {
    const node = nodeAt(fromState, path);
    return { id, fromPageId, to, via: { nodeId: node.id, nodePath: path, role: node.role, name: node.name }, followed, provenance: navProvenance };
  };
  const data: Asset = {
    id: 'ast_01',
    kind: 'data',
    url: `${FIXTURE_URL}api/items.json`,
    origin: 'same-origin',
    mime: 'application/json',
    bytes: 240,
    localPath: 'assets/items.json',
    request: { method: 'GET', status: 200, mime: 'application/json' },
    authorization: 'unknown',
    usage: [],
    provenance: measured(true, 'network', { capturedAt: FIXTURE_CAPTURED_AT }).provenance,
  };
  const stateIds = ['st_01', 'st_02', 'st_03', 'st_04'];

  return {
    dnaVersion: UI_DNA_VERSION,
    target: {
      kind: 'url',
      url: FIXTURE_URL,
      scanId: FIXTURE_MULTI_SCAN_ID,
      scannedAt: FIXTURE_CAPTURED_AT,
      viewports: VIEWPORTS.map((v) => ({ width: v.width, height: v.height })),
      budget: { limits: { timeMs: 180000, pages: 3, actions: 60, resources: 400 }, used: { timeMs: 9100, pages: 2, actions: 5, resources: 9 } },
      tool: { name: 'uidna', version: '0.2.0' },
    },
    app: {
      pages: [
        { id: 'pg_01', url: FIXTURE_URL, title: measured('Lumen — Home', 'a11y-tree', { capturedAt: FIXTURE_CAPTURED_AT, stateId: 'st_01' }), stateIds: ['st_01', 'st_02', 'st_09'], depth: 0, discoveredVia: null },
        { id: 'pg_02', url: FIXTURE_FORM_URL, title: measured('Lumen — Create your account', 'a11y-tree', { capturedAt: FIXTURE_CAPTURED_AT, stateId: 'st_03' }), stateIds: ['st_03', 'st_04', 'st_05', 'st_06', 'st_07', 'st_08'], depth: 1, discoveredVia: 'nav_01' },
      ],
      routes: [
        { id: 'rt_01', pattern: '/', pageId: 'pg_01', provenance: navProvenance },
        { id: 'rt_02', pattern: '/features.html', pageId: 'pg_02', provenance: navProvenance },
      ],
      layouts: [{ id: 'lay_01', pageIds: ['pg_01', 'pg_02'], regions: [region('banner', MULTI_PATHS.header), region('navigation', MULTI_PATHS.nav), region('main', MULTI_PATHS.main), region('contentinfo', MULTI_PATHS.footer)], provenance: navProvenance }],
      navigation: [
        edge('nav_01', st02, 'pg_01', MULTI_PATHS.featuresLink, { url: FIXTURE_FORM_URL, pageId: 'pg_02', sameOrigin: true, fragment: false }, true),
        edge('nav_02', st02, 'pg_01', MULTI_PATHS.homeLink, { url: FIXTURE_URL, pageId: 'pg_01', sameOrigin: true, fragment: false }, false),
        edge('nav_03', st02, 'pg_01', MULTI_PATHS.statusPageLink, { url: 'https://example.com/', pageId: null, sameOrigin: false, fragment: false }, false),
        edge('nav_04', st04, 'pg_02', MULTI_PATHS.homeLink, { url: FIXTURE_URL, pageId: 'pg_01', sameOrigin: true, fragment: false }, false),
      ],
    },
    states: { items: states, transitions },
    components: { definitions: [navDefinition], instances },
    visual: {
      tokens: {
        colors: [tokenOf('tok_color_01', 'color', 'color-01', '#2f5bea', 6, ['background-color', 'color'], stateIds), tokenOf('tok_color_02', 'color', 'color-02', '#1b1f2a', 10, ['color'], stateIds)],
        typography: [],
        fontFamilies: [tokenOf('tok_font-family_01', 'font-family', 'font-01', FONT, 30, ['font-family'], stateIds)],
        fontSizes: [tokenOf('tok_font-size_01', 'font-size', 'size-01', '16px', 9, ['font-size'], stateIds)],
        spacing: [],
        radii: [tokenOf('tok_radius_01', 'radius', 'radius-01', '12px', 4, ['border-top-left-radius'], stateIds)],
        shadows: [],
        breakpoints: [],
      },
      layout: [],
    },
    behavior: [],
    assets: [data],
    limitations: [],
    evidence: [
      { id: 'ev_000000000001', kind: 'scan', artifacts: ['states/st_01/capture.json', 'states/st_02/capture.json', 'states/st_03/capture.json', 'states/st_04/capture.json'], capturedAt: FIXTURE_CAPTURED_AT },
      { id: 'ev_000000000002', kind: 'tokens', artifacts: [], capturedAt: FIXTURE_CAPTURED_AT },
      { id: 'ev_000000000003', kind: 'explore', artifacts: ['states/st_05/capture.json', 'states/st_06/capture.json', 'states/st_07/capture.json', 'states/st_08/capture.json', 'states/st_09/capture.json'], capturedAt: FIXTURE_CAPTURED_AT },
    ],
    annotations: [],
  };
}
