/**
 * Computed style → Tailwind 4 utility classes. Every rendering property that
 * UI DNA captures maps to a utility here; values that have no named utility
 * use arbitrary values (`p-[16px]`), values that match a token use the theme
 * class (`bg-color-01`), and values that cannot be expressed as a class are
 * reported as skipped rather than silently dropped.
 */
import { STYLE_DEFAULTS } from '../browser/style-properties.js';

/** Computed style record as stored in a state's style table (defaults dropped). */
export type StyleRecord = Readonly<Record<string, string>>;

/** Token lookup tables: normalized value → theme token name. */
export interface TokenIndex {
  readonly colors: ReadonlyMap<string, string>;
  readonly fontSizes: ReadonlyMap<string, string>;
  readonly radii: ReadonlyMap<string, string>;
  readonly fontFamilies: ReadonlyMap<string, string>;
}

/** An index without tokens: every value becomes an arbitrary value. */
export const EMPTY_TOKEN_INDEX: TokenIndex = {
  colors: new Map(),
  fontSizes: new Map(),
  radii: new Map(),
  fontFamilies: new Map(),
};

/** A property that could not be turned into a class. */
export interface SkippedProperty {
  readonly property: string;
  readonly value: string;
  readonly reason: string;
}

/** Result of mapping a style to classes. */
export interface ClassMapping {
  readonly classes: readonly string[];
  readonly skipped: readonly SkippedProperty[];
}

/** Options for `classesFor`. */
export interface ClassOptions {
  readonly tokens?: TokenIndex;
  /** Only these properties produce classes; other properties are context only. Omit for all. */
  readonly only?: ReadonlySet<string>;
  /** Variant prefix such as `md:`, `hover:` or `after:`, prepended to every class. */
  readonly prefix?: string;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const SIDE_SUFFIX = { top: 't', right: 'r', bottom: 'b', left: 'l' } as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
const CORNER_SUFFIX = { 'top-left': 'tl', 'top-right': 'tr', 'bottom-right': 'br', 'bottom-left': 'bl' } as const;

const DISPLAY_CLASSES: Readonly<Record<string, string>> = {
  none: 'hidden',
  block: 'block',
  inline: 'inline',
  'inline-block': 'inline-block',
  flex: 'flex',
  'inline-flex': 'inline-flex',
  grid: 'grid',
  'inline-grid': 'inline-grid',
  'list-item': 'list-item',
  contents: 'contents',
  'flow-root': 'flow-root',
  table: 'table',
  'inline-table': 'inline-table',
  'table-row': 'table-row',
  'table-cell': 'table-cell',
  'table-caption': 'table-caption',
  'table-column': 'table-column',
  'table-column-group': 'table-column-group',
  'table-header-group': 'table-header-group',
  'table-footer-group': 'table-footer-group',
  'table-row-group': 'table-row-group',
};

const FONT_WEIGHTS: Readonly<Record<string, string>> = {
  '100': 'font-thin',
  '200': 'font-extralight',
  '300': 'font-light',
  '400': 'font-normal',
  '500': 'font-medium',
  '600': 'font-semibold',
  '700': 'font-bold',
  '800': 'font-extrabold',
  '900': 'font-black',
};

const JUSTIFY: Readonly<Record<string, string>> = {
  normal: 'justify-normal',
  'flex-start': 'justify-start',
  start: 'justify-start',
  'flex-end': 'justify-end',
  end: 'justify-end',
  center: 'justify-center',
  'space-between': 'justify-between',
  'space-around': 'justify-around',
  'space-evenly': 'justify-evenly',
  stretch: 'justify-stretch',
};

const ALIGN_ITEMS: Readonly<Record<string, string>> = {
  'flex-start': 'items-start',
  start: 'items-start',
  'self-start': 'items-start',
  'flex-end': 'items-end',
  end: 'items-end',
  'self-end': 'items-end',
  center: 'items-center',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
};

const ALIGN_CONTENT: Readonly<Record<string, string>> = {
  normal: 'content-normal',
  'flex-start': 'content-start',
  start: 'content-start',
  'flex-end': 'content-end',
  end: 'content-end',
  center: 'content-center',
  'space-between': 'content-between',
  'space-around': 'content-around',
  'space-evenly': 'content-evenly',
  stretch: 'content-stretch',
  baseline: 'content-baseline',
};

const ALIGN_SELF: Readonly<Record<string, string>> = {
  auto: 'self-auto',
  'flex-start': 'self-start',
  start: 'self-start',
  'flex-end': 'self-end',
  end: 'self-end',
  center: 'self-center',
  stretch: 'self-stretch',
  baseline: 'self-baseline',
};

const JUSTIFY_ITEMS: Readonly<Record<string, string>> = {
  normal: 'justify-items-normal',
  start: 'justify-items-start',
  end: 'justify-items-end',
  center: 'justify-items-center',
  stretch: 'justify-items-stretch',
};

const JUSTIFY_SELF: Readonly<Record<string, string>> = {
  auto: 'justify-self-auto',
  start: 'justify-self-start',
  end: 'justify-self-end',
  center: 'justify-self-center',
  stretch: 'justify-self-stretch',
};

const CURSORS = new Set([
  'auto',
  'default',
  'pointer',
  'wait',
  'text',
  'move',
  'help',
  'not-allowed',
  'none',
  'context-menu',
  'progress',
  'cell',
  'crosshair',
  'vertical-text',
  'alias',
  'copy',
  'no-drop',
  'grab',
  'grabbing',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'zoom-in',
  'zoom-out',
]);

const BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'plus-darker',
  'plus-lighter',
]);

/** Characters that cannot appear inside a Tailwind arbitrary value. */
const UNSAFE_ARBITRARY = /[\s"'`;{}[\]\\<>]/;

/**
 * Normalize a CSS color to lowercase hex (`#rrggbb` or `#rrggbbaa`),
 * `transparent`, or the trimmed input when it is not a hex/rgb color.
 */
export function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return 'transparent';
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex?.[1] !== undefined) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const expanded = digits
        .split('')
        .map((d) => d + d)
        .join('');
      return finishHex(expanded);
    }
    if (digits.length === 6 || digits.length === 8) return finishHex(digits);
    return v;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const channel = (text: string | undefined): string => {
      const n = Math.max(0, Math.min(255, Math.round(Number(text ?? '0'))));
      return n.toString(16).padStart(2, '0');
    };
    let alpha = 1;
    const alphaText = rgb[4];
    if (alphaText !== undefined) alpha = alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
    if (Number.isNaN(alpha)) alpha = 1;
    if (alpha <= 0) return 'transparent';
    const base = `#${channel(rgb[1])}${channel(rgb[2])}${channel(rgb[3])}`;
    if (alpha >= 1) return base;
    return base + Math.round(alpha * 255).toString(16).padStart(2, '0');
  }
  return v;
}

function finishHex(digits: string): string {
  if (digits.length === 8 && digits.endsWith('ff')) return `#${digits.slice(0, 6)}`;
  if (digits.length === 8 && digits.endsWith('00')) return 'transparent';
  return `#${digits}`;
}

/**
 * Turn a CSS value into a Tailwind arbitrary value: spaces inside functions are
 * removed, remaining spaces become underscores. Returns `null` when the value
 * contains characters that cannot live inside a class name.
 */
export function arbitraryValue(value: string): string | null {
  let v = value.trim();
  if (v.length === 0) return null;
  v = v.replace(/\s*,\s*/g, ',').replace(/\s*\/\s*/g, '/').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  v = v.replace(/\s+/g, '_');
  if (UNSAFE_ARBITRARY.test(v)) return null;
  return v;
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const COLOR_TOKEN = /^(rgba?\(|hsla?\(|color\(|oklch\(|oklab\(|lab\(|lch\(|#|transparent$|currentcolor$|[a-z]+$)/i;

/**
 * Reorder each layer of a computed `box-shadow` (`<color> <x> <y> <blur> <spread> [inset]`)
 * into Tailwind's expected `[inset] <x> <y> <blur> <spread> <color>` form. Tailwind reads an
 * arbitrary shadow that starts with a color as a shadow *color*, which drops the shadow.
 */
export function normalizeBoxShadow(value: string): string {
  return splitTopLevel(value, ',')
    .map((layer) => {
      const tokens = splitTopLevel(layer, ' ');
      const inset = tokens.filter((t) => t.toLowerCase() === 'inset');
      const colors = tokens.filter((t) => t.toLowerCase() !== 'inset' && COLOR_TOKEN.test(t) && !/^-?\d/.test(t));
      const lengths = tokens.filter((t) => !inset.includes(t) && !colors.includes(t));
      return [...inset, ...lengths, ...colors].join(' ');
    })
    .join(', ');
}

/** Normalize a font-family list for token matching: quotes removed, single spaces, lowercase. */
export function normalizeFontFamily(value: string): string {
  return value
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').toLowerCase())
    .filter((part) => part.length > 0)
    .join(', ');
}

/** Parse a `<number>px` value; `null` for anything else. */
export function parsePx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim());
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Read a property with the `STYLE_DEFAULTS` fallback. */
export function styleValue(style: StyleRecord, property: string): string | undefined {
  const value = style[property];
  if (value !== undefined) return value;
  return (STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[property];
}

/** Sanitize a token name into a Tailwind-safe identifier (`color-01`). */
export function tokenClassName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.length > 0 ? cleaned : 'token';
}

/** Map a style record to utility classes. Pure and deterministic; output is sorted. */
export function classesFor(style: StyleRecord, options: ClassOptions = {}): ClassMapping {
  const tokens = options.tokens ?? EMPTY_TOKEN_INDEX;
  const only = options.only;
  const prefix = options.prefix ?? '';
  const classes = new Set<string>();
  const skipped: SkippedProperty[] = [];

  const wants = (property: string): boolean => (only ? only.has(property) : style[property] !== undefined);
  const get = (property: string): string | undefined => styleValue(style, property);
  const add = (cls: string): void => {
    classes.add(prefix + cls);
  };
  const skip = (property: string, value: string, reason: string): void => {
    skipped.push({ property, value, reason });
  };
  /** Emit `<utility>-[value]` or the named class when a named value exists. */
  const lengthClass = (property: string, utility: string, named: Readonly<Record<string, string>> = {}): void => {
    if (!wants(property)) return;
    const value = get(property);
    if (value === undefined) return;
    const namedClass = named[value];
    if (namedClass !== undefined) {
      add(namedClass);
      return;
    }
    const arb = arbitraryValue(value);
    if (arb === null) {
      skip(property, value, 'value cannot be expressed as an arbitrary value');
      return;
    }
    add(`${utility}-[${arb}]`);
  };
  const colorClass = (property: string, utility: string): void => {
    if (!wants(property)) return;
    const value = get(property);
    if (value === undefined) return;
    const normalized = normalizeColor(value);
    if (normalized === 'transparent') {
      add(`${utility}-transparent`);
      return;
    }
    const token = tokens.colors.get(normalized);
    if (token !== undefined) {
      add(`${utility}-${token}`);
      return;
    }
    const arb = arbitraryValue(normalized);
    if (arb === null) {
      skip(property, value, 'color cannot be expressed as an arbitrary value');
      return;
    }
    add(`${utility}-[${arb}]`);
  };
  const keywordClass = (property: string, map: Readonly<Record<string, string>>): void => {
    if (!wants(property)) return;
    const value = get(property);
    if (value === undefined) return;
    const cls = map[value];
    if (cls !== undefined) add(cls);
    else {
      const arb = arbitraryValue(value);
      if (arb === null) skip(property, value, 'keyword cannot be expressed as an arbitrary property');
      else add(`[${property}:${arb}]`);
    }
  };
  /** `bg-[<type>:value]` for background size and position. */
  const typedClass = (property: string, type: string, named: Readonly<Record<string, string>>): void => {
    if (!wants(property)) return;
    const value = get(property);
    if (value === undefined) return;
    const namedClass = named[value];
    if (namedClass !== undefined) {
      add(namedClass);
      return;
    }
    const arb = arbitraryValue(value);
    if (arb === null) skip(property, value, 'value cannot be expressed as an arbitrary value');
    else add(`bg-[${type}:${arb}]`);
  };
  /** Four-side shorthand (`p-[x]`, `px-[x]`, `pt-[x]`), used for margin and padding. */
  const boxSides = (base: string, utility: string, allowAuto: boolean): void => {
    const values = SIDES.map((side) => ({ side, wanted: wants(`${base}-${side}`), value: get(`${base}-${side}`) }));
    const wanted = values.filter((v) => v.wanted && v.value !== undefined);
    if (wanted.length === 0) return;
    const toClass = (suffix: string, value: string): string | null => {
      if (value === '0px') return `${utility}${suffix}-0`;
      if (value === 'auto') return allowAuto ? `${utility}${suffix}-auto` : null;
      const arb = arbitraryValue(value);
      return arb === null ? null : `${utility}${suffix}-[${arb}]`;
    };
    const emit = (suffix: string, property: string, value: string): void => {
      const cls = toClass(suffix, value);
      if (cls === null) skip(property, value, 'value cannot be expressed as an arbitrary value');
      else add(cls);
    };
    const all = wanted.length === 4 && wanted.every((v) => v.value === wanted[0]?.value);
    if (all && wanted[0]?.value !== undefined) {
      emit('', `${base}-top`, wanted[0].value);
      return;
    }
    const bySide = new Map(wanted.map((v) => [v.side, v.value] as const));
    const top = bySide.get('top');
    const bottom = bySide.get('bottom');
    const left = bySide.get('left');
    const right = bySide.get('right');
    if (top !== undefined && bottom !== undefined && top === bottom) emit('y', `${base}-top`, top);
    else {
      if (top !== undefined) emit(SIDE_SUFFIX.top, `${base}-top`, top);
      if (bottom !== undefined) emit(SIDE_SUFFIX.bottom, `${base}-bottom`, bottom);
    }
    if (left !== undefined && right !== undefined && left === right) emit('x', `${base}-left`, left);
    else {
      if (left !== undefined) emit(SIDE_SUFFIX.left, `${base}-left`, left);
      if (right !== undefined) emit(SIDE_SUFFIX.right, `${base}-right`, right);
    }
  };

  /* ---- layout ---- */
  if (wants('display')) {
    const value = get('display');
    if (value !== undefined) {
      const cls = DISPLAY_CLASSES[value];
      if (cls !== undefined) add(cls);
      else {
        const arb = arbitraryValue(value);
        if (arb === null) skip('display', value, 'unsupported display value');
        else add(`[display:${arb}]`);
      }
    }
  }
  keywordClass('position', { static: 'static', relative: 'relative', absolute: 'absolute', fixed: 'fixed', sticky: 'sticky' });
  for (const side of SIDES) lengthClass(side, side, { auto: `${side}-auto`, '0px': `${side}-0` });
  lengthClass('z-index', 'z', { auto: 'z-auto' });
  keywordClass('box-sizing', { 'border-box': 'box-border', 'content-box': 'box-content' });
  lengthClass('width', 'w', { auto: 'w-auto', '100%': 'w-full' });
  lengthClass('height', 'h', { auto: 'h-auto', '100%': 'h-full' });
  lengthClass('min-width', 'min-w', { auto: 'min-w-auto', '0px': 'min-w-0', '100%': 'min-w-full' });
  lengthClass('max-width', 'max-w', { none: 'max-w-none', '100%': 'max-w-full' });
  lengthClass('min-height', 'min-h', { auto: 'min-h-auto', '0px': 'min-h-0', '100%': 'min-h-full' });
  lengthClass('max-height', 'max-h', { none: 'max-h-none', '100%': 'max-h-full' });
  boxSides('margin', 'm', true);
  boxSides('padding', 'p', false);
  if (wants('overflow-x') || wants('overflow-y')) {
    const x = get('overflow-x');
    const y = get('overflow-y');
    if (x !== undefined && y !== undefined && x === y && wants('overflow-x') && wants('overflow-y')) add(`overflow-${x}`);
    else {
      if (wants('overflow-x') && x !== undefined) add(`overflow-x-${x}`);
      if (wants('overflow-y') && y !== undefined) add(`overflow-y-${y}`);
    }
  }
  keywordClass('float', { none: 'float-none', left: 'float-left', right: 'float-right', 'inline-start': 'float-start', 'inline-end': 'float-end' });
  keywordClass('clear', { none: 'clear-none', left: 'clear-left', right: 'clear-right', both: 'clear-both', 'inline-start': 'clear-start', 'inline-end': 'clear-end' });
  lengthClass('vertical-align', 'align', {
    baseline: 'align-baseline',
    top: 'align-top',
    middle: 'align-middle',
    bottom: 'align-bottom',
    'text-top': 'align-text-top',
    'text-bottom': 'align-text-bottom',
    sub: 'align-sub',
    super: 'align-super',
  });
  if (wants('aspect-ratio')) {
    const value = get('aspect-ratio');
    if (value !== undefined) {
      if (value === 'auto') add('aspect-auto');
      else {
        const ratio = /^(?:auto\s+)?([\d.]+)\s*\/\s*([\d.]+)$/.exec(value);
        if (ratio) add(`aspect-[${ratio[1]}/${ratio[2]}]`);
        else {
          const arb = arbitraryValue(value);
          if (arb === null) skip('aspect-ratio', value, 'unsupported aspect-ratio value');
          else add(`aspect-[${arb}]`);
        }
      }
    }
  }
  keywordClass('object-fit', { fill: 'object-fill', contain: 'object-contain', cover: 'object-cover', none: 'object-none', 'scale-down': 'object-scale-down' });

  /* ---- flex and grid ---- */
  keywordClass('flex-direction', { row: 'flex-row', column: 'flex-col', 'row-reverse': 'flex-row-reverse', 'column-reverse': 'flex-col-reverse' });
  keywordClass('flex-wrap', { nowrap: 'flex-nowrap', wrap: 'flex-wrap', 'wrap-reverse': 'flex-wrap-reverse' });
  lengthClass('flex-grow', 'grow', { '0': 'grow-0', '1': 'grow' });
  lengthClass('flex-shrink', 'shrink', { '0': 'shrink-0', '1': 'shrink' });
  lengthClass('flex-basis', 'basis', { auto: 'basis-auto', '100%': 'basis-full' });
  keywordClass('justify-content', JUSTIFY);
  keywordClass('justify-items', JUSTIFY_ITEMS);
  keywordClass('justify-self', JUSTIFY_SELF);
  keywordClass('align-items', ALIGN_ITEMS);
  keywordClass('align-content', ALIGN_CONTENT);
  keywordClass('align-self', ALIGN_SELF);
  if (wants('gap')) {
    const value = get('gap');
    if (value !== undefined) {
      const parts = value.split(/\s+/);
      if (parts.length === 1) lengthClass('gap', 'gap', { '0px': 'gap-0', normal: '[gap:normal]' });
      else {
        const [row, column] = parts;
        if (row !== undefined && column !== undefined) {
          const rowArb = arbitraryValue(row);
          const colArb = arbitraryValue(column);
          if (rowArb === null || colArb === null) skip('gap', value, 'gap cannot be expressed as an arbitrary value');
          else {
            add(row === '0px' ? 'gap-y-0' : `gap-y-[${rowArb}]`);
            add(column === '0px' ? 'gap-x-0' : `gap-x-[${colArb}]`);
          }
        }
      }
    }
  }
  if (!wants('gap') || get('gap') === undefined) {
    lengthClass('row-gap', 'gap-y', { '0px': 'gap-y-0', normal: '[row-gap:normal]' });
    lengthClass('column-gap', 'gap-x', { '0px': 'gap-x-0', normal: '[column-gap:normal]' });
  }
  lengthClass('order', 'order', { '0': 'order-0' });
  for (const [property, utility] of [
    ['grid-template-columns', 'grid-cols'],
    ['grid-template-rows', 'grid-rows'],
  ] as const) {
    if (!wants(property)) continue;
    const value = get(property);
    if (value === undefined) continue;
    if (value === 'none') {
      add(`${utility}-none`);
      continue;
    }
    const tracks = value.split(/\s+/).filter((t) => t.length > 0);
    const px = tracks.map((t) => parsePx(t));
    const first = px[0];
    if (tracks.length >= 1 && first !== null && first !== undefined && px.every((p) => p !== null && Math.abs(p - first) <= 0.5)) {
      add(`${utility}-${tracks.length}`);
      continue;
    }
    const arb = arbitraryValue(value);
    if (arb === null) skip(property, value, 'track list cannot be expressed as an arbitrary value');
    else add(`${utility}-[${arb}]`);
  }
  keywordClass('grid-auto-flow', {
    row: 'grid-flow-row',
    column: 'grid-flow-col',
    dense: 'grid-flow-dense',
    'row dense': 'grid-flow-row-dense',
    'column dense': 'grid-flow-col-dense',
  });
  lengthClass('grid-auto-columns', 'auto-cols', { auto: 'auto-cols-auto', 'min-content': 'auto-cols-min', 'max-content': 'auto-cols-max' });
  lengthClass('grid-auto-rows', 'auto-rows', { auto: 'auto-rows-auto', 'min-content': 'auto-rows-min', 'max-content': 'auto-rows-max' });
  for (const [property, utility] of [
    ['grid-column-start', 'col-start'],
    ['grid-column-end', 'col-end'],
    ['grid-row-start', 'row-start'],
    ['grid-row-end', 'row-end'],
  ] as const) {
    if (!wants(property)) continue;
    const value = get(property);
    if (value === undefined) continue;
    if (value === 'auto') add(`${utility}-auto`);
    else if (/^-?\d+$/.test(value)) add(`${utility}-${value}`);
    else {
      const arb = arbitraryValue(value);
      if (arb === null) skip(property, value, 'grid line cannot be expressed as an arbitrary value');
      else add(`${utility}-[${arb}]`);
    }
  }

  /* ---- borders ---- */
  const widths = SIDES.map((side) => get(`border-${side}-width`) ?? '0px');
  const anyBorder = widths.some((w) => (parsePx(w) ?? 0) > 0);
  const widthWanted = SIDES.filter((side) => wants(`border-${side}-width`));
  if (widthWanted.length > 0) {
    const widthClass = (suffix: string, value: string, property: string): void => {
      const px = parsePx(value);
      if (px === 0) add(`border${suffix}-0`);
      else if (px === 1) add(`border${suffix}`);
      else {
        const arb = arbitraryValue(value);
        if (arb === null) skip(property, value, 'border width cannot be expressed as an arbitrary value');
        else add(`border${suffix}-[${arb}]`);
      }
    };
    const allSame = widthWanted.length === 4 && widths.every((w) => w === widths[0]);
    if (allSame && widths[0] !== undefined) widthClass('', widths[0], 'border-top-width');
    else {
      for (const side of widthWanted) {
        const value = get(`border-${side}-width`);
        if (value !== undefined) widthClass(`-${SIDE_SUFFIX[side]}`, value, `border-${side}-width`);
      }
    }
  }
  const styleWanted = SIDES.some((side) => wants(`border-${side}-style`));
  if (styleWanted) {
    const styles = SIDES.map((side) => get(`border-${side}-style`) ?? 'none').filter((s) => s !== 'none');
    const first = styles[0];
    if (first === undefined) {
      if (anyBorder) add('border-none');
    } else if (first !== 'solid') {
      if (['dashed', 'dotted', 'double', 'hidden'].includes(first)) add(`border-${first}`);
      else add(`[border-style:${first}]`);
    }
  }
  if (anyBorder) {
    const colorWanted = SIDES.filter((side) => wants(`border-${side}-color`));
    if (colorWanted.length > 0) {
      const colors = SIDES.map((side) => get(`border-${side}-color`) ?? 'currentcolor');
      const allSame = colorWanted.length === 4 && colors.every((c) => c === colors[0]);
      if (allSame) colorClass('border-top-color', 'border');
      else for (const side of colorWanted) colorClass(`border-${side}-color`, `border-${SIDE_SUFFIX[side]}`);
    }
  }
  const radiusWanted = CORNERS.filter((corner) => wants(`border-${corner}-radius`));
  if (radiusWanted.length > 0) {
    const radii = CORNERS.map((corner) => get(`border-${corner}-radius`) ?? '0px');
    const radiusClass = (suffix: string, value: string, property: string): void => {
      if (value === '0px') {
        add(`rounded${suffix}-none`);
        return;
      }
      const token = tokens.radii.get(value);
      if (token !== undefined) {
        add(`rounded${suffix}-${token}`);
        return;
      }
      const arb = arbitraryValue(value);
      if (arb === null) skip(property, value, 'radius cannot be expressed as an arbitrary value');
      else add(`rounded${suffix}-[${arb}]`);
    };
    const allSame = radiusWanted.length === 4 && radii.every((r) => r === radii[0]);
    if (allSame && radii[0] !== undefined) radiusClass('', radii[0], 'border-top-left-radius');
    else {
      for (const corner of radiusWanted) {
        const value = get(`border-${corner}-radius`);
        if (value !== undefined) radiusClass(`-${CORNER_SUFFIX[corner]}`, value, `border-${corner}-radius`);
      }
    }
  }
  const outlineStyle = get('outline-style') ?? 'none';
  if (wants('outline-style')) {
    if (outlineStyle === 'none') add('outline-none');
    else if (['solid', 'dashed', 'dotted', 'double'].includes(outlineStyle)) add(`outline-${outlineStyle}`);
    else add(`[outline-style:${outlineStyle}]`);
  }
  if (outlineStyle !== 'none') {
    lengthClass('outline-width', 'outline');
    colorClass('outline-color', 'outline');
    lengthClass('outline-offset', 'outline-offset');
  }
  if (wants('box-shadow')) {
    const value = get('box-shadow');
    if (value !== undefined) {
      if (value === 'none') add('shadow-none');
      else {
        const arb = arbitraryValue(normalizeBoxShadow(value));
        if (arb === null) skip('box-shadow', value, 'shadow cannot be expressed as an arbitrary value');
        else add(`shadow-[${arb}]`);
      }
    }
  }

  /* ---- background ---- */
  colorClass('background-color', 'bg');
  if (wants('background-image')) {
    const value = get('background-image');
    if (value !== undefined) {
      if (value === 'none') add('bg-none');
      else if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(value) && !value.includes('url(')) {
        const arb = arbitraryValue(value);
        if (arb === null) skip('background-image', value, 'gradient cannot be expressed as an arbitrary value');
        else add(`bg-[${arb}]`);
      } else skip('background-image', value, 'background images are assets and are not reproduced by the baseline');
    }
  }
  typedClass('background-size', 'length', { auto: 'bg-auto', cover: 'bg-cover', contain: 'bg-contain' });
  typedClass('background-position', 'position', {
    center: 'bg-center',
    '50% 50%': 'bg-center',
    '0% 0%': 'bg-top-left',
    top: 'bg-top',
    bottom: 'bg-bottom',
    left: 'bg-left',
    right: 'bg-right',
  });
  keywordClass('background-repeat', {
    repeat: 'bg-repeat',
    'no-repeat': 'bg-no-repeat',
    'repeat-x': 'bg-repeat-x',
    'repeat-y': 'bg-repeat-y',
    round: 'bg-repeat-round',
    space: 'bg-repeat-space',
  });
  keywordClass('background-clip', { 'border-box': 'bg-clip-border', 'padding-box': 'bg-clip-padding', 'content-box': 'bg-clip-content', text: 'bg-clip-text' });

  /* ---- text ---- */
  colorClass('color', 'text');
  if (wants('font-family')) {
    const value = get('font-family');
    if (value !== undefined) {
      const token = tokens.fontFamilies.get(normalizeFontFamily(value));
      if (token !== undefined) add(`font-${token}`);
      else {
        const families = value
          .split(',')
          .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
          .filter((part) => part.length > 0);
        if (families.length === 0 || families.some((f) => !/^[A-Za-z0-9 _-]+$/.test(f))) {
          skip('font-family', value, 'font family contains characters that cannot live in a class name');
        } else add(`font-[family-name:${families.map((f) => f.replace(/\s+/g, '_')).join(',')}]`);
      }
    }
  }
  if (wants('font-size')) {
    const value = get('font-size');
    if (value !== undefined) {
      const token = tokens.fontSizes.get(value);
      if (token !== undefined) add(`text-${token}`);
      else {
        const arb = arbitraryValue(value);
        if (arb === null) skip('font-size', value, 'font size cannot be expressed as an arbitrary value');
        else add(`text-[${arb}]`);
      }
    }
  }
  lengthClass('font-weight', 'font', FONT_WEIGHTS);
  keywordClass('font-style', { normal: 'not-italic', italic: 'italic' });
  lengthClass('line-height', 'leading', { normal: 'leading-[normal]' });
  lengthClass('letter-spacing', 'tracking', { normal: 'tracking-normal' });
  keywordClass('text-align', { start: 'text-start', end: 'text-end', left: 'text-left', right: 'text-right', center: 'text-center', justify: 'text-justify' });
  const decoration = get('text-decoration-line') ?? 'none';
  keywordClass('text-decoration-line', { none: 'no-underline', underline: 'underline', 'line-through': 'line-through', overline: 'overline' });
  if (decoration !== 'none') colorClass('text-decoration-color', 'decoration');
  keywordClass('text-transform', { none: 'normal-case', uppercase: 'uppercase', lowercase: 'lowercase', capitalize: 'capitalize' });
  keywordClass('text-overflow', { clip: 'text-clip', ellipsis: 'text-ellipsis' });
  keywordClass('white-space', {
    normal: 'whitespace-normal',
    nowrap: 'whitespace-nowrap',
    pre: 'whitespace-pre',
    'pre-line': 'whitespace-pre-line',
    'pre-wrap': 'whitespace-pre-wrap',
    'break-spaces': 'whitespace-break-spaces',
  });
  keywordClass('word-break', { normal: 'break-normal', 'break-all': 'break-all', 'keep-all': 'break-keep' });
  lengthClass('list-style-type', 'list', { none: 'list-none', disc: 'list-disc', decimal: 'list-decimal' });

  /* ---- visual effects ---- */
  lengthClass('opacity', 'opacity', { '1': 'opacity-100', '0': 'opacity-0' });
  keywordClass('visibility', { visible: 'visible', hidden: 'invisible', collapse: 'collapse' });
  if (wants('transform')) {
    const value = get('transform');
    if (value !== undefined) {
      if (value === 'none') add('transform-none');
      else {
        const arb = arbitraryValue(value);
        if (arb === null) skip('transform', value, 'transform cannot be expressed as an arbitrary value');
        else add(`[transform:${arb}]`);
      }
    }
  }
  if ((get('transform') ?? 'none') !== 'none') lengthClass('transform-origin', 'origin', { center: 'origin-center' });
  if (wants('filter')) {
    const value = get('filter');
    if (value !== undefined) {
      if (value === 'none') add('filter-none');
      else {
        const arb = arbitraryValue(value);
        if (arb === null) skip('filter', value, 'filter cannot be expressed as an arbitrary value');
        else add(`[filter:${arb}]`);
      }
    }
  }
  if (wants('mix-blend-mode')) {
    const value = get('mix-blend-mode');
    if (value !== undefined) {
      if (BLEND_MODES.has(value)) add(`mix-blend-${value}`);
      else skip('mix-blend-mode', value, 'unsupported blend mode');
    }
  }
  if (wants('cursor')) {
    const value = get('cursor');
    if (value !== undefined) {
      if (CURSORS.has(value)) add(`cursor-${value}`);
      else skip('cursor', value, 'custom cursors are not reproduced');
    }
  }
  keywordClass('pointer-events', { auto: 'pointer-events-auto', none: 'pointer-events-none' });
  keywordClass('user-select', { auto: 'select-auto', none: 'select-none', text: 'select-text', all: 'select-all' });

  /* ---- pseudo-element content (virtual property added by the generator) ---- */
  if (wants('content')) {
    const value = get('content');
    if (value !== undefined) {
      const content = pseudoContentClass(value);
      if (content === null) skip('content', value, 'generated content is not a plain string');
      else add(content);
    }
  }

  return { classes: [...classes].sort(compareClasses), skipped };
}

/**
 * Turn a computed `content` value (a quoted CSS string) into `content-['...']`.
 * Returns `null` for `none`, `normal`, counters, images and strings with
 * characters that cannot live inside a class name.
 */
export function pseudoContentClass(value: string): string | null {
  const v = value.trim();
  if (v === 'none' || v === 'normal') return null;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(v) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(v);
  if (!quoted) return null;
  const inner = quoted[1] ?? '';
  if (!/^[A-Za-z0-9 +\-−–—·•*:.,!?%&()#=~^|@]*$/.test(inner)) return null;
  return `content-['${inner.replace(/\s/g, '_')}']`;
}

/** Stable ordering of classes: plain code-point comparison. */
export function compareClasses(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tags that are rendered as placeholders because their content cannot be reproduced from the capture. */
export const PLACEHOLDER_TAGS = new Set(['svg', 'video', 'iframe', 'canvas', 'object', 'embed', 'audio', 'math']);

/**
 * Display value an element gets for free under Tailwind's preflight (which
 * resets the UA stylesheet). Unknown tags are rendered as `div`, so callers
 * pass the rendered tag.
 */
export function uaDefaultDisplay(renderedTag: string): string {
  switch (renderedTag) {
    case 'li':
    case 'summary':
      return 'list-item';
    case 'a':
    case 'span':
    case 'em':
    case 'strong':
    case 'b':
    case 'i':
    case 'small':
    case 'code':
    case 'label':
    case 'abbr':
    case 'cite':
    case 'q':
    case 'sub':
    case 'sup':
    case 'time':
    case 'mark':
    case 'kbd':
    case 's':
    case 'u':
    case 'del':
    case 'ins':
    case 'br':
    case 'wbr':
    case 'bdi':
    case 'bdo':
    case 'data':
    case 'dfn':
    case 'samp':
    case 'var':
      return 'inline';
    case 'button':
    case 'input':
    case 'select':
    case 'textarea':
    case 'meter':
    case 'progress':
      return 'inline-block';
    case 'table':
      return 'table';
    case 'tr':
      return 'table-row';
    case 'td':
    case 'th':
      return 'table-cell';
    case 'thead':
      return 'table-header-group';
    case 'tbody':
      return 'table-row-group';
    case 'tfoot':
      return 'table-footer-group';
    case 'caption':
      return 'table-caption';
    case 'col':
      return 'table-column';
    case 'colgroup':
      return 'table-column-group';
    default:
      return 'block';
  }
}

/** CSS properties (among the captured ones) that inherit from the parent. */
export const INHERITED_PROPERTIES: ReadonlySet<string> = new Set([
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'white-space',
  'word-break',
  'list-style-type',
  'visibility',
  'cursor',
  'pointer-events',
]);
