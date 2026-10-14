/**
 * Token extraction. Every token is backed by a cluster of measured values with
 * sample counts; values are only merged when the clustering evidence allows
 * it (colors within a small RGB distance, numeric values that parse equal).
 * Nothing here infers: the provenance of every token is `measured` from
 * computed styles, except breakpoints which are `observed` from bounding boxes.
 */
import type { ProvenanceContext, Token, Tokens, TypographyStyle, UiNode } from '@rohzzn/uidna-schema';
import { measured, observed } from '@rohzzn/uidna-schema';
import type { CapturedState } from '../browser/types.js';
import { clusterSamples, compareValues, parsePx, type Cluster, type Sample } from '../domain/clustering.js';
import { colorDistance, formatCssColor, isTransparent, parseCssColor, type RgbaColor } from '../domain/color.js';
import { tokenId } from '../domain/ids.js';
import { distinct, normalizeFontFamily, styleValue, type CaptureMap, type EvidenceIndex } from './common.js';

/** Context for token extraction. */
export interface TokenContext {
  /** Timestamp recorded on aggregate (cross-state) provenance. */
  readonly capturedAt: string;
  readonly evidenceIdByState: EvidenceIndex;
  /** Base state ids used for breakpoint detection; defaults to the first capture per viewport width. */
  readonly baseStateIds?: readonly string[];
}

/** RGB distance under which two measured colors are one token. */
export const COLOR_DISTANCE_THRESHOLD = 6;
/** Font sizes are only merged when they parse to the same pixel value. */
export const FONT_SIZE_THRESHOLD = 0.5;

const COLOR_SIDES = ['top', 'right', 'bottom', 'left'] as const;
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'g', 'polygon', 'line', 'ellipse', 'polyline', 'use', 'text', 'tspan']);
const SPACING_PROPERTIES = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'] as const;
const RADIUS_PROPERTIES = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'] as const;

/** Accumulated occurrences of one raw CSS value. */
interface Tally {
  count: number;
  readonly properties: Set<string>;
  readonly stateIds: Set<string>;
}

class TallyMap {
  readonly byValue = new Map<string, Tally>();

  add(value: string, property: string, stateId: string): void {
    const tally = this.byValue.get(value) ?? { count: 0, properties: new Set<string>(), stateIds: new Set<string>() };
    tally.count += 1;
    tally.properties.add(property);
    tally.stateIds.add(stateId);
    this.byValue.set(value, tally);
  }

  samples(): Sample<string>[] {
    return [...this.byValue.entries()].map(([value, tally]) => ({ value, count: tally.count }));
  }
}

/** A styled thing to sample: a node's own style or one of its pseudo-element styles. */
interface StyledSurface {
  readonly node: UiNode;
  readonly style: Readonly<Record<string, string>>;
  /** True for a node's own style; false for `::before`/`::after`. */
  readonly own: boolean;
  /** Pseudo content, when a pseudo element. */
  readonly content?: string;
}

function* surfaces(capture: CapturedState): Generator<StyledSurface> {
  for (const node of capture.nodes) {
    if (!node.visible) continue;
    const style = capture.styles[node.styleId];
    if (style) yield { node, style, own: true };
    for (const pseudo of [node.pseudo?.before, node.pseudo?.after]) {
      if (!pseudo) continue;
      const pseudoStyle = capture.styles[pseudo.styleId];
      if (pseudoStyle) yield { node, style: pseudoStyle, own: false, content: pseudo.content };
    }
  }
}

function hasText(surface: StyledSurface): boolean {
  if (surface.own) return surface.node.text !== null && surface.node.text.trim().length > 0;
  const content = (surface.content ?? '').trim();
  return content.length > 0 && content !== 'none' && content !== 'normal' && content !== '""' && content !== "''";
}

function isRendered(value: string | undefined): boolean {
  return value !== undefined && value !== 'none' && value !== 'hidden';
}

/** Color samples from the properties where a color renders. */
function collectColors(captures: CaptureMap): TallyMap {
  const tallies = new TallyMap();
  const add = (value: string | undefined, property: string, stateId: string): void => {
    if (value === undefined) return;
    const parsed = parseCssColor(value);
    if (parsed === null || isTransparent(parsed)) return;
    tallies.add(value, property, stateId);
  };
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      const { style } = surface;
      if (hasText(surface)) add(style.color, 'color', stateId);
      add(styleValue(style, 'background-color'), 'background-color', stateId);
      for (const side of COLOR_SIDES) {
        const width = parsePx(styleValue(style, `border-${side}-width`));
        if (isRendered(styleValue(style, `border-${side}-style`)) && width !== null && width > 0) {
          add(style[`border-${side}-color`], `border-${side}-color`, stateId);
        }
      }
      const outlineWidth = parsePx(styleValue(style, 'outline-width'));
      if (isRendered(styleValue(style, 'outline-style')) && outlineWidth !== null && outlineWidth > 0) {
        add(style['outline-color'], 'outline-color', stateId);
      }
      if (surface.own && SVG_TAGS.has(surface.node.tag.toLowerCase())) {
        add(style.fill, 'fill', stateId);
        add(style.stroke, 'stroke', stateId);
      }
    }
  }
  return tallies;
}

function collectFontFamilies(captures: CaptureMap): TallyMap {
  const tallies = new TallyMap();
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      if (!hasText(surface)) continue;
      const family = surface.style['font-family'];
      if (family === undefined) continue;
      const normalized = normalizeFontFamily(family);
      if (normalized.length > 0) tallies.add(normalized, 'font-family', stateId);
    }
  }
  return tallies;
}

function collectFontSizes(captures: CaptureMap): TallyMap {
  const tallies = new TallyMap();
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      if (!hasText(surface)) continue;
      const size = surface.style['font-size'];
      if (size !== undefined && parsePx(size) !== null) tallies.add(size, 'font-size', stateId);
    }
  }
  return tallies;
}

function pxTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(/\s+/)
    .filter((token) => {
      const px = parsePx(token);
      return px !== null && px !== 0;
    });
}

function collectSpacing(captures: CaptureMap): TallyMap {
  const tallies = new TallyMap();
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      const { style } = surface;
      for (const property of SPACING_PROPERTIES) {
        for (const token of pxTokens(style[property])) tallies.add(token, property, stateId);
      }
      // `gap` is a shorthand of `row-gap`/`column-gap`; count the longhands when present so one gap is not counted three times.
      const rowGap = style['row-gap'];
      const columnGap = style['column-gap'];
      if (rowGap !== undefined || columnGap !== undefined) {
        for (const token of pxTokens(rowGap)) tallies.add(token, 'row-gap', stateId);
        for (const token of pxTokens(columnGap)) tallies.add(token, 'column-gap', stateId);
      } else {
        for (const token of pxTokens(style.gap)) tallies.add(token, 'gap', stateId);
      }
    }
  }
  return tallies;
}

/**
 * Radius values are kept in pixels or percentages (computed styles leave
 * `50%` as a percentage); zero radii are not tokens.
 */
function radiusTokens(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(/\s+/).filter((token) => {
    const px = parsePx(token);
    if (px !== null) return px !== 0;
    const pct = /^(\d*\.?\d+)%$/.exec(token);
    return pct !== null && Number(pct[1]) !== 0;
  });
}

function collectRadii(captures: CaptureMap): TallyMap {
  const tallies = new TallyMap();
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      for (const property of RADIUS_PROPERTIES) {
        for (const token of radiusTokens(surface.style[property])) tallies.add(token, property, stateId);
      }
    }
  }
  return tallies;
}

function collectShadows(captures: CaptureMap): TallyMap {
  const tallies = new TallyMap();
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      const shadow = surface.style['box-shadow'];
      if (shadow !== undefined && shadow !== 'none') tallies.add(shadow.trim(), 'box-shadow', stateId);
    }
  }
  return tallies;
}

/* ------------------------------------------------------------ token build */

interface TokenKindSpec {
  readonly kind: Token['kind'];
  readonly idKind: string;
  readonly namePrefix: string;
}

const KIND_SPECS = {
  color: { kind: 'color', idKind: 'color', namePrefix: 'color' },
  fontFamily: { kind: 'font-family', idKind: 'font', namePrefix: 'font' },
  fontSize: { kind: 'font-size', idKind: 'text', namePrefix: 'text' },
  spacing: { kind: 'spacing', idKind: 'space', namePrefix: 'space' },
  radius: { kind: 'radius', idKind: 'radius', namePrefix: 'radius' },
  shadow: { kind: 'shadow', idKind: 'shadow', namePrefix: 'shadow' },
  breakpoint: { kind: 'breakpoint', idKind: 'bp', namePrefix: 'bp' },
} as const satisfies Record<string, TokenKindSpec>;

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** Provenance context for a value aggregated over states: state-specific fields only when exactly one state contributed. */
function aggregateContext(ctx: TokenContext, captures: CaptureMap, stateIds: readonly string[]): ProvenanceContext {
  const base: ProvenanceContext = { capturedAt: ctx.capturedAt };
  const only = stateIds.length === 1 ? stateIds[0] : undefined;
  if (only === undefined) return base;
  const capture = captures.get(only);
  const evidenceId = ctx.evidenceIdByState[only];
  return {
    ...base,
    stateId: only,
    ...(capture ? { viewport: capture.viewport } : {}),
    ...(evidenceId === undefined ? {} : { evidenceId }),
  };
}

function stateOrder(captures: CaptureMap): (ids: Iterable<string>) => string[] {
  const order = [...captures.keys()];
  return (ids) => {
    const set = new Set(ids);
    return order.filter((id) => set.has(id));
  };
}

interface BuiltToken {
  readonly value: string;
  readonly cluster: Cluster<string>;
  readonly stateIds: string[];
  readonly properties: string[];
  readonly confidence: number;
}

/**
 * One cluster per distinct value. Exact token kinds never merge values, so the
 * pairwise distance matrix of `clusterSamples` is not needed for them.
 */
function singletonClusters(samples: readonly Sample<string>[]): Cluster<string>[] {
  return samples
    .filter((sample) => sample.count > 0)
    .map((sample) => ({ representative: sample.value, members: [sample], sampleCount: sample.count, spread: 0 }))
    .sort((a, b) => b.sampleCount - a.sampleCount || compareValues(a.representative, b.representative));
}

function buildExact(tallies: TallyMap, captures: CaptureMap, cluster: (samples: readonly Sample<string>[]) => Cluster<string>[], format: (rep: string) => string): BuiltToken[] {
  const clusters = cluster(tallies.samples());
  const order = stateOrder(captures);
  return clusters.map((cluster) => {
    const stateIds = new Set<string>();
    const properties = new Set<string>();
    for (const member of cluster.members) {
      const tally = tallies.byValue.get(member.value);
      if (!tally) continue;
      for (const id of tally.stateIds) stateIds.add(id);
      for (const prop of tally.properties) properties.add(prop);
    }
    const repCount = cluster.members[0]?.count ?? cluster.sampleCount;
    return {
      value: format(cluster.representative),
      cluster,
      stateIds: order(stateIds),
      properties: [...properties].sort(),
      confidence: Math.round((repCount / cluster.sampleCount) * 1000) / 1000,
    };
  });
}

function toTokens(built: BuiltToken[], spec: TokenKindSpec, ctx: TokenContext, captures: CaptureMap): Token[] {
  const sorted = [...built].sort((a, b) => b.cluster.sampleCount - a.cluster.sampleCount || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return sorted.map((item, i) => ({
    id: tokenId(spec.idKind, i + 1),
    kind: spec.kind,
    generatedName: `${spec.namePrefix}-${pad2(i + 1)}`,
    value: measured(item.value, 'computed-style', aggregateContext(ctx, captures, item.stateIds), item.confidence),
    cluster: {
      sampleCount: item.cluster.sampleCount,
      members: item.cluster.members.map((m) => ({ value: m.value, count: m.count })),
      properties: item.properties,
      ...(item.cluster.members.length > 1 ? { spread: Math.round(item.cluster.spread * 1000) / 1000 } : {}),
    },
    usage: { count: item.cluster.sampleCount, stateIds: item.stateIds },
  }));
}

function colorTokens(captures: CaptureMap, ctx: TokenContext): Token[] {
  const tallies = collectColors(captures);
  const cache = new Map<string, RgbaColor>();
  const parsed = (value: string): RgbaColor => {
    const hit = cache.get(value);
    if (hit) return hit;
    const color = parseCssColor(value) ?? { r: 0, g: 0, b: 0, a: 0 };
    cache.set(value, color);
    return color;
  };
  const built = buildExact(
    tallies,
    captures,
    (samples) => clusterSamples(samples, (a, b) => colorDistance(parsed(a), parsed(b)), COLOR_DISTANCE_THRESHOLD),
    (rep) => formatCssColor(parsed(rep)),
  );
  return toTokens(built, KIND_SPECS.color, ctx, captures);
}

function fontSizeTokens(captures: CaptureMap, ctx: TokenContext): Token[] {
  const built = buildExact(
    collectFontSizes(captures),
    captures,
    (samples) => clusterSamples(samples, (a, b) => Math.abs((parsePx(a) ?? 0) - (parsePx(b) ?? 0)), FONT_SIZE_THRESHOLD),
    (rep) => rep,
  );
  return toTokens(built, KIND_SPECS.fontSize, ctx, captures);
}

function exactTokens(tallies: TallyMap, spec: TokenKindSpec, captures: CaptureMap, ctx: TokenContext): Token[] {
  return toTokens(buildExact(tallies, captures, singletonClusters, (rep) => rep), spec, ctx, captures);
}

/* -------------------------------------------------------------- typography */

interface TypographyKey {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly textTransform: string;
}

function typographyStyles(captures: CaptureMap, ctx: TokenContext): TypographyStyle[] {
  const groups = new Map<string, { key: TypographyKey; count: number; stateIds: Set<string> }>();
  for (const [stateId, capture] of captures) {
    for (const surface of surfaces(capture)) {
      if (!surface.own || !hasText(surface)) continue;
      const { style } = surface;
      const fontFamily = style['font-family'];
      const fontSize = style['font-size'];
      const fontWeight = style['font-weight'];
      const lineHeight = style['line-height'];
      if (fontFamily === undefined || fontSize === undefined || fontWeight === undefined || lineHeight === undefined) continue;
      const key: TypographyKey = {
        fontFamily: normalizeFontFamily(fontFamily),
        fontSize,
        fontWeight,
        lineHeight,
        letterSpacing: styleValue(style, 'letter-spacing') ?? 'normal',
        textTransform: styleValue(style, 'text-transform') ?? 'none',
      };
      const id = [key.fontFamily, key.fontSize, key.fontWeight, key.lineHeight, key.letterSpacing, key.textTransform].join('|');
      const group = groups.get(id) ?? { key, count: 0, stateIds: new Set<string>() };
      group.count += 1;
      group.stateIds.add(stateId);
      groups.set(id, group);
    }
  }
  const order = stateOrder(captures);
  const sorted = [...groups.entries()].sort(([ka, a], [kb, b]) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0));
  return sorted.map(([, group], i) => {
    const stateIds = order(group.stateIds);
    const context = aggregateContext(ctx, captures, stateIds);
    const m = (value: string) => measured(value, 'computed-style', context, 1);
    return {
      id: tokenId('type', i + 1),
      generatedName: `type-${pad2(i + 1)}`,
      fontFamily: m(group.key.fontFamily),
      fontSize: m(group.key.fontSize),
      fontWeight: m(group.key.fontWeight),
      lineHeight: m(group.key.lineHeight),
      letterSpacing: m(group.key.letterSpacing),
      textTransform: m(group.key.textTransform),
      sampleCount: group.count,
      stateIds,
    };
  });
}

/* ------------------------------------------------------------- breakpoints */

/** Base states per viewport width, narrowest first. */
function baseStatesByWidth(captures: CaptureMap, ctx: TokenContext): { width: number; stateId: string; capture: CapturedState }[] {
  const chosen = new Map<number, { width: number; stateId: string; capture: CapturedState }>();
  const allowed = ctx.baseStateIds === undefined ? null : new Set(ctx.baseStateIds);
  for (const [stateId, capture] of captures) {
    if (allowed !== null && !allowed.has(stateId)) continue;
    const width = capture.viewport.width;
    if (!chosen.has(width)) chosen.set(width, { width, stateId, capture });
  }
  return [...chosen.values()].sort((a, b) => a.width - b.width);
}

function boxesDiffer(a: UiNode['box'], b: UiNode['box']): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5;
}

function breakpointTokens(captures: CaptureMap, ctx: TokenContext): Token[] {
  const bases = baseStatesByWidth(captures, ctx);
  const tokens: Token[] = [];
  for (let i = 0; i + 1 < bases.length; i += 1) {
    const narrow = bases[i];
    const wide = bases[i + 1];
    if (!narrow || !wide) continue;
    const wideByPath = new Map(wide.capture.nodes.map((node) => [node.path, node]));
    const properties = new Set<string>();
    let differing = 0;
    const seen = new Set<string>();
    for (const node of narrow.capture.nodes) {
      seen.add(node.path);
      const other = wideByPath.get(node.path);
      if (!other) {
        differing += 1;
        properties.add('structure');
        continue;
      }
      let changed = false;
      if (node.visible !== other.visible) {
        properties.add('visible');
        changed = true;
      }
      if (boxesDiffer(node.box, other.box)) {
        properties.add('box');
        changed = true;
      }
      if (changed) differing += 1;
    }
    for (const node of wide.capture.nodes) {
      if (!seen.has(node.path)) {
        differing += 1;
        properties.add('structure');
      }
    }
    if (differing === 0) continue;
    const index = tokens.length + 1;
    tokens.push({
      id: tokenId(KIND_SPECS.breakpoint.idKind, index),
      kind: 'breakpoint',
      generatedName: `bp-${pad2(index)}`,
      value: observed(`${narrow.width}px`, 'bounding-box', { capturedAt: ctx.capturedAt }, 1),
      cluster: {
        sampleCount: differing,
        members: [
          { value: `${narrow.width}px`, count: 1 },
          { value: `${wide.width}px`, count: 1 },
        ],
        properties: [...properties].sort(),
      },
      usage: { count: differing, stateIds: distinct([narrow.stateId, wide.stateId]) },
    });
  }
  return tokens;
}

/** Extract every token kind from the captures. */
export function extractTokens(captures: CaptureMap, ctx: TokenContext): Tokens {
  return {
    colors: colorTokens(captures, ctx),
    typography: typographyStyles(captures, ctx),
    fontFamilies: exactTokens(collectFontFamilies(captures), KIND_SPECS.fontFamily, captures, ctx),
    fontSizes: fontSizeTokens(captures, ctx),
    spacing: exactTokens(collectSpacing(captures), KIND_SPECS.spacing, captures, ctx),
    radii: exactTokens(collectRadii(captures), KIND_SPECS.radius, captures, ctx),
    shadows: exactTokens(collectShadows(captures), KIND_SPECS.shadow, captures, ctx),
    breakpoints: breakpointTokens(captures, ctx),
  };
}
