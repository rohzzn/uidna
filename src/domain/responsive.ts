/**
 * Responsive-rule inference, the pure part: compare layout signatures,
 * decide which widths to probe, and reconcile located changes with the
 * thresholds read from the page's stylesheets.
 *
 * A layout signature maps `<node path>|<property>` to a value for the few
 * properties that describe layout structure (rendered or not, display,
 * position, flex direction, float, grid track count). Sizes and font sizes
 * are left out on purpose: they vary continuously with the width (fluid
 * type, percentage widths, wrapping rows) and would make every width look
 * like a breakpoint.
 *
 * Probing never acts on the page: the caller's `measure` only resizes the
 * viewport and reads the signature.
 */
import type { Result } from './result.js';

/** `<node path>|<property>` → value. */
export type LayoutSignature = ReadonlyMap<string, string>;

/** Properties a layout signature records. */
export const SIGNATURE_PROPERTIES = ['rendered', 'display', 'position', 'flex-direction', 'float', 'grid-columns'] as const;

/** One key whose value differs between a narrower and a wider width. */
export interface SignatureChange {
  readonly path: string;
  readonly property: string;
  /** Value at the narrower width; null when the key is absent there. */
  readonly below: string | null;
  /** Value at the wider width; null when the key is absent there. */
  readonly above: string | null;
}

/** Split a signature key into its node path and property. */
export function splitKey(key: string): { path: string; property: string } {
  const at = key.lastIndexOf('|');
  return at < 0 ? { path: key, property: '' } : { path: key.slice(0, at), property: key.slice(at + 1) };
}

/** Keys whose values differ between `narrow` and `wide`, sorted by path then property. */
export function diffSignatures(narrow: LayoutSignature, wide: LayoutSignature): SignatureChange[] {
  const keys = new Set<string>([...narrow.keys(), ...wide.keys()]);
  const changes: SignatureChange[] = [];
  for (const key of keys) {
    const below = narrow.get(key) ?? null;
    const above = wide.get(key) ?? null;
    if (below === above) continue;
    // A node that is absent on one side and not rendered on the other did not change visibly.
    const { path, property } = splitKey(key);
    changes.push({ path, property, below, above });
  }
  return changes.sort((a, b) => (a.path === b.path ? a.property.localeCompare(b.property, 'en') : comparePaths(a.path, b.path)));
}

/** Document order of two node paths. */
export function comparePaths(a: string, b: string): number {
  const pa = a === '' ? [] : a.split('/').map(Number);
  const pb = b === '' ? [] : b.split('/').map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return pa.length - pb.length;
}

/** A width interval in which the layout changed: the narrower layout at `lower`, the wider at `upper`. */
export interface ChangePoint {
  readonly lower: number;
  readonly upper: number;
  readonly changes: readonly SignatureChange[];
}

export interface LocateInput {
  /** Scanned viewport widths; probing stays within their range. */
  readonly scannedWidths: readonly number[];
  /** Stylesheet thresholds to confirm first, each with one probe on either side. */
  readonly cssThresholds: readonly number[];
  /** Bisection stops once a change is located within this many pixels; leftover budget refines to 1px. */
  readonly tolerancePx: number;
  /** Measurements allowed in total, scanned widths included. */
  readonly maxProbes: number;
  /** Resize to `width` and read the signature. Must never act on the page. */
  readonly measure: (width: number) => Promise<Result<LayoutSignature>>;
}

export interface LocateOutcome {
  readonly changePoints: readonly ChangePoint[];
  /** Every measured width, ascending. */
  readonly widths: readonly number[];
  readonly signatures: ReadonlyMap<number, LayoutSignature>;
  /** True when the budget ran out before every change was located to 1px. */
  readonly exhausted: boolean;
  /** Measurements that failed, with their reason. */
  readonly failures: readonly string[];
}

/**
 * Locate where the layout changes between the scanned widths: measure the
 * scanned widths, confirm each stylesheet threshold inside a changing pair
 * with probes at T-1 and T, bisect what is still unexplained down to
 * `tolerancePx`, then refine to 1px while the budget lasts.
 */
export async function locateChanges(input: LocateInput): Promise<LocateOutcome> {
  const measured = new Map<number, LayoutSignature>();
  const failures: string[] = [];
  let probes = 0;
  let exhausted = false;

  const measureAt = async (width: number): Promise<LayoutSignature | null> => {
    const known = measured.get(width);
    if (known !== undefined) return known;
    if (probes >= input.maxProbes) {
      exhausted = true;
      return null;
    }
    probes += 1;
    const result = await input.measure(width);
    if (!result.ok) {
      failures.push(`${width}px: ${result.error.message}`);
      return null;
    }
    measured.set(width, result.value);
    return result.value;
  };

  const scanned = [...new Set(input.scannedWidths)].sort((a, b) => a - b);
  for (const width of scanned) await measureAt(width);

  const differs = (a: number, b: number): boolean => {
    const sa = measured.get(a);
    const sb = measured.get(b);
    return sa !== undefined && sb !== undefined && diffSignatures(sa, sb).length > 0;
  };

  // 1. Confirm stylesheet thresholds inside every scanned pair whose layouts differ.
  for (let i = 1; i < scanned.length; i += 1) {
    const lo = scanned[i - 1];
    const hi = scanned[i];
    if (lo === undefined || hi === undefined || !differs(lo, hi)) continue;
    for (const threshold of [...new Set(input.cssThresholds)].sort((a, b) => a - b)) {
      if (threshold <= lo || threshold > hi) continue;
      if (threshold - 1 > lo) await measureAt(threshold - 1);
      await measureAt(threshold);
    }
  }

  // 2. Bisect intervals that still change between neighbouring measurements.
  const sortedWidths = (): number[] => [...measured.keys()].sort((a, b) => a - b);
  const bisect = async (lo: number, hi: number, stopAt: number): Promise<void> => {
    if (hi - lo <= stopAt || !differs(lo, hi)) return;
    const mid = Math.floor((lo + hi) / 2);
    if ((await measureAt(mid)) === null) return;
    await bisect(lo, mid, stopAt);
    await bisect(mid, hi, stopAt);
  };
  const pass = async (stopAt: number): Promise<void> => {
    const widths = sortedWidths();
    for (let i = 1; i < widths.length; i += 1) {
      const lo = widths[i - 1];
      const hi = widths[i];
      if (lo !== undefined && hi !== undefined) await bisect(lo, hi, stopAt);
    }
  };
  await pass(Math.max(1, input.tolerancePx));
  await pass(1);

  const widths = sortedWidths();
  const changePoints: ChangePoint[] = [];
  for (let i = 1; i < widths.length; i += 1) {
    const lo = widths[i - 1];
    const hi = widths[i];
    if (lo === undefined || hi === undefined) continue;
    const a = measured.get(lo);
    const b = measured.get(hi);
    if (a === undefined || b === undefined) continue;
    const changes = diffSignatures(a, b);
    if (changes.length > 0) changePoints.push({ lower: lo, upper: hi, changes });
  }
  if (changePoints.some((point) => point.upper - point.lower > 1)) exhausted = exhausted || probes >= input.maxProbes;
  return { changePoints, widths, signatures: measured, exhausted, failures };
}

/** A stylesheet condition as reconciliation needs it. */
export interface ConditionThresholds {
  readonly id: string;
  readonly thresholds: readonly number[];
  readonly never: boolean;
}

/** A located breakpoint, before ids and provenance are attached. */
export interface ReconciledBreakpoint {
  readonly minWidth: number;
  readonly source: 'css' | 'probe';
  readonly bracket: { readonly lower: number; readonly upper: number };
  readonly conditionIds: readonly string[];
  readonly changes: readonly SignatureChange[];
}

export interface Reconciliation {
  readonly breakpoints: readonly ReconciledBreakpoint[];
  /** Per condition id: true when a located change matches a threshold, false when every threshold lies where probing saw no change, null when no probe reached it. */
  readonly observedEffect: ReadonlyMap<string, boolean | null>;
  /** Thresholds outside the probed range, which only the stylesheet shows. */
  readonly unprobed: readonly number[];
}

/**
 * Turn change points into breakpoints. A stylesheet threshold `T` explains a
 * change point when `lower < T <= upper`; the breakpoint is then `T` (source
 * `css`). Otherwise it is the narrowest width seen with the wider layout
 * (source `probe`).
 */
export function reconcileBreakpoints(changePoints: readonly ChangePoint[], conditions: readonly ConditionThresholds[], probedWidths: readonly number[]): Reconciliation {
  const live = conditions.filter((condition) => !condition.never);
  const breakpoints: ReconciledBreakpoint[] = [];
  const matched = new Set<string>();
  for (const point of changePoints) {
    const explaining = live.filter((condition) => condition.thresholds.some((t) => point.lower < t && t <= point.upper));
    const candidates = explaining.flatMap((condition) => condition.thresholds.filter((t) => point.lower < t && t <= point.upper));
    if (candidates.length > 0) {
      const minWidth = Math.max(...candidates);
      const ids = explaining.filter((condition) => condition.thresholds.includes(minWidth)).map((condition) => condition.id);
      for (const id of ids) matched.add(id);
      breakpoints.push({ minWidth, source: 'css', bracket: { lower: point.lower, upper: point.upper }, conditionIds: ids, changes: point.changes });
    } else {
      breakpoints.push({ minWidth: point.upper, source: 'probe', bracket: { lower: point.lower, upper: point.upper }, conditionIds: [], changes: point.changes });
    }
  }
  const widths = [...probedWidths].sort((a, b) => a - b);
  const min = widths[0];
  const max = widths[widths.length - 1];
  const inRange = (t: number): boolean => min !== undefined && max !== undefined && min < t && t <= max;
  const observedEffect = new Map<string, boolean | null>();
  const unprobed = new Set<number>();
  for (const condition of conditions) {
    if (matched.has(condition.id)) {
      observedEffect.set(condition.id, true);
      continue;
    }
    const reachable = condition.thresholds.filter(inRange);
    for (const t of condition.thresholds) if (!inRange(t) && !condition.never) unprobed.add(t);
    observedEffect.set(condition.id, condition.never || reachable.length === 0 ? null : false);
  }
  return { breakpoints, observedEffect, unprobed: [...unprobed].sort((a, b) => a - b) };
}
