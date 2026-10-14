/**
 * Media-condition parsing: the viewport widths at which a condition's result
 * flips. Thresholds are written mobile-first, as the smallest width of the
 * wider side: `(min-width: 960px)` and `(max-width: 959px)` both flip at
 * 960, `(max-width: 959.98px)` too. Only width features yield thresholds;
 * other features (`hover`, `prefers-reduced-motion`, `orientation`, height)
 * are not width rules and are ignored. Values the parser cannot convert to
 * pixels (`calc()`, `vw`) are listed as unsupported instead of guessed.
 */

/** What a condition means for viewport widths. */
export interface ParsedCondition {
  /** True when the condition can never match a screen viewport (e.g. `print`). */
  readonly never: boolean;
  /** Widths at which the result flips, ascending and unique. */
  readonly thresholds: readonly number[];
  /** Feature texts that mention a width but could not be converted to pixels. */
  readonly unsupported: readonly string[];
}

/** Environment the condition is evaluated in. */
export interface ConditionEnv {
  /** Pixels per `em`/`rem` in media queries: the initial font size (16 in a default browser). */
  readonly emPx: number;
}

const DEFAULT_ENV: ConditionEnv = { emPx: 16 };

/** Media types that never match a screen viewport. */
const NON_SCREEN_TYPES: ReadonlySet<string> = new Set(['print', 'speech', 'aural', 'braille', 'embossed', 'handheld', 'projection', 'tty', 'tv']);

type Comparison = '<' | '<=' | '>' | '>=' | '=';

/** Split a list on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Pixels of a length like `960px`, `60em`, `37.5rem`; null for anything else. */
function toPixels(value: string, env: ConditionEnv): number | null {
  const match = /^(-?\d*\.?\d+)\s*(px|em|rem)?$/i.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '' && amount !== 0) return null;
  return unit === 'em' || unit === 'rem' ? amount * env.emPx : amount;
}

/** The flip width of `width <op> px`, as the smallest width of the wider side. */
function thresholdOf(op: Comparison, px: number): number[] {
  switch (op) {
    case '>=':
      return [Math.ceil(px)];
    case '>':
      return [Math.floor(px) + 1];
    case '<':
      return [Math.ceil(px)];
    case '<=':
      return [Math.floor(px) + 1];
    case '=':
      return [Math.ceil(px), Math.floor(px) + 1];
    default:
      return [];
  }
}

/** Mirror a comparison written as `value <op> width` into `width <op'> value`. */
function mirror(op: Comparison): Comparison {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op;
  }
}

const COMPARISON = '(<=|>=|<|>|=)';

/** Thresholds of one parenthesized feature; `null` when it is not a width feature. */
function featureThresholds(feature: string, env: ConditionEnv): { thresholds: number[]; unsupported: boolean } | null {
  const text = feature.trim().toLowerCase();
  const plain = /^(min-|max-)?width\s*:\s*(.+)$/.exec(text);
  if (plain !== null) {
    const px = toPixels(plain[2] ?? '', env);
    if (px === null) return { thresholds: [], unsupported: true };
    const prefix = plain[1];
    return { thresholds: thresholdOf(prefix === 'min-' ? '>=' : prefix === 'max-' ? '<=' : '=', px), unsupported: false };
  }
  if (!/(^|[^-a-z])width([^-a-z]|$)/.test(text) || /device-width|inline-size/.test(text)) {
    return text.includes('device-width') ? { thresholds: [], unsupported: true } : null;
  }
  // Range syntax: `width >= 600px`, `600px <= width`, `600px <= width < 1100px`.
  const range = new RegExp(`^(?:(.+?)\\s*${COMPARISON}\\s*)?width(?:\\s*${COMPARISON}\\s*(.+))?$`).exec(text);
  if (range === null) return { thresholds: [], unsupported: true };
  const [, leftValue, leftOp, rightOp, rightValue] = range;
  const thresholds: number[] = [];
  let unsupported = false;
  if (leftValue !== undefined && leftOp !== undefined) {
    const px = toPixels(leftValue, env);
    if (px === null) unsupported = true;
    else thresholds.push(...thresholdOf(mirror(leftOp as Comparison), px));
  }
  if (rightValue !== undefined && rightOp !== undefined) {
    const px = toPixels(rightValue, env);
    if (px === null) unsupported = true;
    else thresholds.push(...thresholdOf(rightOp as Comparison, px));
  }
  if (leftValue === undefined && rightValue === undefined) return null;
  return { thresholds, unsupported };
}

/** Top-level parenthesized groups of `text`, without their outer parentheses. */
function groupsOf(text: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === ')' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) groups.push(text.slice(start, i));
    }
  }
  return groups;
}

/**
 * The features of a branch: `(a) and ((b) or (c))` gives a, b, c. A group
 * that itself starts with a group is a nested condition and is flattened; any
 * other group is one feature, parentheses inside it (`calc()`) included.
 */
function featuresOf(branch: string): string[] {
  const features: string[] = [];
  for (const group of groupsOf(branch)) {
    if (group.trimStart().startsWith('(') || /^\s*not\s*\(/.test(group)) features.push(...featuresOf(group));
    else features.push(group);
  }
  return features;
}

/** Parse a media condition (an `@media` prelude, an `@import` media list or a `media` attribute). */
export function parseMediaCondition(text: string, env: ConditionEnv = DEFAULT_ENV): ParsedCondition {
  const thresholds = new Set<number>();
  const unsupported: string[] = [];
  let anyScreen = false;
  const branches = splitTopLevel(text);
  for (const raw of branches) {
    const branch = raw.toLowerCase();
    const head = branch.split('(')[0]?.trim() ?? '';
    const words = head.split(/\s+/).filter((word) => word.length > 0 && word !== 'and');
    const negated = words[0] === 'not';
    const type = words.find((word) => word !== 'not' && word !== 'only');
    const nonScreen = type !== undefined && NON_SCREEN_TYPES.has(type);
    // `print and (min-width: 600px)` never applies on screen; `not print` always does.
    if (nonScreen && !negated) continue;
    anyScreen = true;
    for (const feature of featuresOf(branch)) {
      const parsed = featureThresholds(feature, env);
      if (parsed === null) continue;
      for (const threshold of parsed.thresholds) if (threshold > 0) thresholds.add(threshold);
      if (parsed.unsupported) unsupported.push(`(${feature.trim()})`);
    }
  }
  return {
    never: branches.length > 0 && !anyScreen,
    thresholds: [...thresholds].sort((a, b) => a - b),
    unsupported,
  };
}
