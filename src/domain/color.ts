/**
 * CSS color parsing and comparison. Computed styles report colors as
 * `rgb(r, g, b)` / `rgba(r, g, b, a)`; stylesheets and hand-written captures
 * may use hex or basic named colors. Anything else (gradients, `currentcolor`,
 * `inherit`) is not a color value and parses to `null`.
 */

/** A color as red, green, blue (0..255) and alpha (0..1). */
export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Basic CSS named colors (the 16 HTML colors plus a few that appear in computed styles). */
const NAMED_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  white: [255, 255, 255],
  maroon: [128, 0, 0],
  red: [255, 0, 0],
  purple: [128, 0, 128],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  olive: [128, 128, 0],
  yellow: [255, 255, 0],
  navy: [0, 0, 128],
  blue: [0, 0, 255],
  teal: [0, 128, 128],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  orange: [255, 165, 0],
};

const clampChannel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
const clampAlpha = (value: number): number => Math.min(1, Math.max(0, value));

function parseChannel(token: string): number | null {
  if (token.endsWith('%')) {
    const pct = Number(token.slice(0, -1));
    return Number.isFinite(pct) ? clampChannel((pct / 100) * 255) : null;
  }
  const n = Number(token);
  return Number.isFinite(n) ? clampChannel(n) : null;
}

function parseAlpha(token: string): number | null {
  if (token.endsWith('%')) {
    const pct = Number(token.slice(0, -1));
    return Number.isFinite(pct) ? clampAlpha(pct / 100) : null;
  }
  const n = Number(token);
  return Number.isFinite(n) ? clampAlpha(n) : null;
}

function parseHex(hex: string): RgbaColor | null {
  const body = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(body)) return null;
  const pair = (s: string): number => parseInt(s, 16);
  // `charAt` always returns a string, so short forms need no index assertions.
  const twice = (i: number): number => pair(body.charAt(i) + body.charAt(i));
  switch (body.length) {
    case 3:
      return { r: twice(0), g: twice(1), b: twice(2), a: 1 };
    case 4:
      return { r: twice(0), g: twice(1), b: twice(2), a: twice(3) / 255 };
    case 6:
      return { r: pair(body.slice(0, 2)), g: pair(body.slice(2, 4)), b: pair(body.slice(4, 6)), a: 1 };
    case 8:
      return { r: pair(body.slice(0, 2)), g: pair(body.slice(2, 4)), b: pair(body.slice(4, 6)), a: pair(body.slice(6, 8)) / 255 };
    default:
      return null;
  }
}

function parseFunctional(input: string): RgbaColor | null {
  const match = /^rgba?\(\s*([^)]*)\)$/i.exec(input);
  if (!match) return null;
  const inner = match[1] ?? '';
  // Legacy syntax uses commas; modern syntax uses spaces and `/` before alpha.
  let parts: string[];
  if (inner.includes(',')) {
    parts = inner.split(',').map((p) => p.trim());
  } else {
    const [rgbPart, alphaPart] = inner.split('/').map((p) => p.trim());
    parts = (rgbPart ?? '').split(/\s+/).filter((p) => p.length > 0);
    if (alphaPart !== undefined && alphaPart.length > 0) parts.push(alphaPart);
  }
  if (parts.length !== 3 && parts.length !== 4) return null;
  const r = parseChannel(parts[0] ?? '');
  const g = parseChannel(parts[1] ?? '');
  const b = parseChannel(parts[2] ?? '');
  if (r === null || g === null || b === null) return null;
  const a = parts.length === 4 ? parseAlpha(parts[3] ?? '') : 1;
  if (a === null) return null;
  return { r, g, b, a };
}

/**
 * Parse a CSS color string. Supports `rgb()`/`rgba()` in legacy and modern
 * syntax, `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `transparent` and the basic
 * named colors. Returns `null` for anything else.
 */
export function parseCssColor(input: string): RgbaColor | null {
  const text = input.trim().toLowerCase();
  if (text.length === 0) return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (text.startsWith('#')) return parseHex(text);
  if (text.startsWith('rgb')) return parseFunctional(text);
  const named = NAMED_COLORS[text];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };
  return null;
}

const hex2 = (n: number): string => clampChannel(n).toString(16).padStart(2, '0');

/**
 * Lowercase hex form. Opaque colors become `#rrggbb`; translucent colors
 * become `#rrggbbaa` so no information is lost.
 */
export function toHex(color: RgbaColor): string {
  const base = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  return color.a >= 1 ? base : `${base}${hex2(color.a * 255)}`;
}

/**
 * Canonical token form: `#rrggbb` for opaque colors, `rgba(r, g, b, a)`
 * (alpha rounded to three decimals) for translucent ones.
 */
export function formatCssColor(color: RgbaColor): string {
  if (color.a >= 1) return toHex(color);
  const alpha = Math.round(color.a * 1000) / 1000;
  return `rgba(${clampChannel(color.r)}, ${clampChannel(color.g)}, ${clampChannel(color.b)}, ${alpha})`;
}

/**
 * Euclidean distance in RGB space (0 for identical colors, about 441.67 for
 * black vs white). An alpha difference counts as a fourth channel scaled to
 * 0..255, so a fully opaque and a fully transparent version of the same color
 * are 255 apart.
 */
export function colorDistance(a: RgbaColor, b: RgbaColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const da = (a.a - b.a) * 255;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

/** True when the color has zero alpha (it does not render). */
export function isTransparent(color: RgbaColor): boolean {
  return color.a <= 0;
}
