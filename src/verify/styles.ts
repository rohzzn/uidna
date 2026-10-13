/**
 * Computed-style comparison over matched nodes. Colors are compared by RGB
 * distance, typography by normalized values, layout properties by pixel
 * difference against the box drift threshold. Properties the capture dropped
 * as UA defaults are read back through `STYLE_DEFAULTS`.
 */
import { styleValue } from '../analysis/common.js';
import { colorDistance, parseCssColor } from '../domain/color.js';
import { parsePx } from '../domain/clustering.js';

/** Properties compared as colors. */
export const COLOR_PROPERTIES: readonly string[] = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];

/** Properties compared as typography. */
export const TYPOGRAPHY_PROPERTIES: readonly string[] = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'];

/** Properties compared as layout. */
export const LAYOUT_PROPERTIES: readonly string[] = [
  'display',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'width',
  'height',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
];

/** Category of a compared property. */
export type StyleCategory = 'color' | 'typography' | 'layout';

/** One differing property. */
export interface StyleDifference {
  readonly property: string;
  readonly category: StyleCategory;
  readonly original: string;
  readonly generated: string;
  /** Numeric difference (color distance or pixels) when both values were numeric. */
  readonly delta: number | null;
}

/** Result of `compareStyles`. */
export interface StyleComparison {
  /** Properties present on both sides and compared. */
  readonly compared: number;
  readonly differences: readonly StyleDifference[];
}

/** Thresholds used by `compareStyles`. */
export interface StyleThresholds {
  readonly colorDistance: number;
  readonly boxDriftPx: number;
}

/** Numeric tolerance for typography px values (sub-pixel rounding between captures). */
const TYPOGRAPHY_PX_EPSILON = 0.05;

/** The first family of a `font-family` list, unquoted, lowercased. */
export function firstFontFamily(value: string): string {
  const first = value.split(',')[0] ?? '';
  return first.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

function compareColor(property: string, original: string, generated: string, threshold: number): StyleDifference | null {
  const a = parseCssColor(original);
  const b = parseCssColor(generated);
  if (a !== null && b !== null) {
    const distance = colorDistance(a, b);
    return distance > threshold ? { property, category: 'color', original, generated, delta: round(distance) } : null;
  }
  return original.trim() === generated.trim() ? null : { property, category: 'color', original, generated, delta: null };
}

function comparePxOrText(property: string, category: StyleCategory, original: string, generated: string, tolerance: number): StyleDifference | null {
  const a = parsePx(original);
  const b = parsePx(generated);
  if (a !== null && b !== null) {
    const delta = Math.abs(a - b);
    return delta > tolerance ? { property, category, original, generated, delta: round(delta) } : null;
  }
  return original.trim() === generated.trim() ? null : { property, category, original, generated, delta: null };
}

function compareTypography(property: string, original: string, generated: string): StyleDifference | null {
  if (property === 'font-family') {
    return firstFontFamily(original) === firstFontFamily(generated) ? null : { property, category: 'typography', original, generated, delta: null };
  }
  return comparePxOrText(property, 'typography', original, generated, TYPOGRAPHY_PX_EPSILON);
}

/**
 * Compare the rendering properties of two style objects. A property missing
 * on either side (and without a UA default) is not compared; nothing is
 * assumed about it.
 */
export function compareStyles(
  original: Readonly<Record<string, string>> | undefined,
  generated: Readonly<Record<string, string>> | undefined,
  thresholds: StyleThresholds,
): StyleComparison {
  const differences: StyleDifference[] = [];
  let compared = 0;
  const each = (properties: readonly string[], compare: (property: string, a: string, b: string) => StyleDifference | null): void => {
    for (const property of properties) {
      const a = styleValue(original, property);
      const b = styleValue(generated, property);
      if (a === undefined || b === undefined) continue;
      compared += 1;
      const difference = compare(property, a, b);
      if (difference !== null) differences.push(difference);
    }
  };
  each(COLOR_PROPERTIES, (property, a, b) => compareColor(property, a, b, thresholds.colorDistance));
  each(TYPOGRAPHY_PROPERTIES, compareTypography);
  each(LAYOUT_PROPERTIES, (property, a, b) => comparePxOrText(property, 'layout', a, b, thresholds.boxDriftPx));
  return { compared, differences };
}
