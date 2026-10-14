/**
 * Responsive measurement of one page during `scan_interface`: read the
 * page's stylesheet width conditions, then probe by resizing between the
 * scanned widths to locate where the layout actually changes.
 *
 * Probing only resizes the viewport and reads the layout signature: no
 * clicks, focus, keys or scrolling. The non-GET guard is held for the whole
 * probe, so a resize handler that posts or sends a beacon never reaches its
 * server; such requests are counted and reported.
 */
import { blockedByUiDna } from '../browser/session.js';
import type { BrowserSession } from '../browser/types.js';
import type { BudgetTracker } from '../domain/budget.js';
import { describeError, uidnaError } from '../domain/errors.js';
import { parseMediaCondition } from '../domain/media-condition.js';
import { err, ok, type Result } from '../domain/result.js';
import { locateChanges, type LayoutSignature } from '../domain/responsive.js';
import type { PageResponsiveRecord, ResponsiveConditionRecord, ResponsiveRecord } from './records.js';

/** Responsive measurement options (the `responsive` input of `scan_interface`). */
export interface ResponsiveOptions {
  /** Read `@media` conditions from the page's stylesheets. */
  readonly css: boolean;
  /** Resize between the scanned widths to locate layout changes. */
  readonly probe: boolean;
  /** Measurements per page, scanned widths included. */
  readonly maxProbes: number;
  /** Bisection stops at this precision; leftover budget refines to 1px. Stylesheet thresholds are confirmed to 1px. */
  readonly tolerancePx: number;
  /** Viewport height held constant while probing. */
  readonly height: number;
  /** DOM quiet time after each resize. */
  readonly settleMs: number;
}

export const DEFAULT_RESPONSIVE_OPTIONS: ResponsiveOptions = { css: true, probe: true, maxProbes: 32, tolerancePx: 8, height: 800, settleMs: 300 };

/** Resolve user input against the defaults. */
export function resolveResponsiveOptions(input: { readonly [K in keyof ResponsiveOptions]?: ResponsiveOptions[K] | undefined } | undefined): ResponsiveOptions {
  const d = DEFAULT_RESPONSIVE_OPTIONS;
  return {
    css: input?.css ?? d.css,
    probe: input?.probe ?? d.probe,
    maxProbes: input?.maxProbes ?? d.maxProbes,
    tolerancePx: input?.tolerancePx ?? d.tolerancePx,
    height: input?.height ?? d.height,
    settleMs: input?.settleMs ?? d.settleMs,
  };
}

/** Measure one page. Never throws; failures become limitations of the record. */
export async function measureResponsive(
  session: BrowserSession,
  args: { readonly pageId: string; readonly scannedWidths: readonly number[]; readonly options: ResponsiveOptions; readonly budget: BudgetTracker },
): Promise<PageResponsiveRecord> {
  const { pageId, options, budget } = args;
  const limitations: string[] = [];
  let conditions: ResponsiveConditionRecord[] = [];
  let unreadable: string[] = [];
  let containerRules = 0;
  let emPx = 16;
  if (options.css) {
    const reading = await session.readStyleConditions();
    if (!reading.ok) {
      limitations.push(`stylesheet conditions not read: ${describeError(reading.error)}`);
    } else {
      emPx = reading.value.emPx;
      unreadable = reading.value.unreadable;
      containerRules = reading.value.containerRules;
      if (reading.value.truncated) limitations.push('some conditioned style rules matched more nodes than are recorded; their node lists are truncated');
      conditions = reading.value.conditions.map((condition) => {
        const parsed = parseMediaCondition(condition.text, { emPx });
        return { ...condition, thresholds: [...parsed.thresholds], never: parsed.never, unsupported: [...parsed.unsupported] };
      });
    }
    if (unreadable.length > 0) limitations.push(`${unreadable.length} stylesheet(s) could not be read (cross-origin): ${unreadable.join(', ')}; their width conditions are only located by probing`);
    if (containerRules > 0) limitations.push(`${containerRules} @container rule(s) were not read: container queries are not viewport breakpoints`);
  }

  const scanned = [...new Set(args.scannedWidths)].sort((a, b) => a - b);
  // With one scanned width there is nothing to probe between; that is the scan's scope, not a limitation.
  if (!options.probe || scanned.length < 2) return { pageId, conditions, unreadable, containerRules, emPx, probe: null, limitations };

  const guard = await session.holdNonGetGuard();
  if (!guard.ok) {
    limitations.push(`layout changes were not probed: the request guard could not be held (${describeError(guard.error)})`);
    return { pageId, conditions, unreadable, containerRules, emPx, probe: null, limitations };
  }
  const marker = session.markNetwork();
  const stopped: { reason: string | null } = { reason: null };
  const measure = async (width: number): Promise<Result<LayoutSignature>> => {
    const stop = budget.check();
    if (stop !== null) {
      stopped.reason ??= stop.message;
      return err(uidnaError('budget', stop.message));
    }
    const resized = await session.setViewport({ width, height: options.height });
    if (!resized.ok) return resized;
    const stable = await session.waitForStability({ quietMs: options.settleMs, timeoutMs: 3000 });
    if (!stable.ok) return stable;
    const signature = await session.layoutSignature();
    if (!signature.ok) return signature;
    if (signature.value.truncated) limitations.push(`layout signature at ${width}px covers only the first ${signature.value.nodes} elements`);
    return ok(new Map(Object.entries(signature.value.entries)));
  };
  const thresholds = conditions.filter((c) => !c.never).flatMap((c) => c.thresholds);
  let outcome;
  try {
    outcome = await locateChanges({ scannedWidths: scanned, cssThresholds: thresholds, tolerancePx: options.tolerancePx, maxProbes: options.maxProbes, measure });
  } finally {
    await guard.value.release();
  }
  const blocked = session.networkSince(marker).filter(blockedByUiDna);
  if (blocked.length > 0) {
    limitations.push(`resizing made the page send ${blocked.length} non-GET request(s) (${[...new Set(blocked.map((entry) => `${entry.method} ${entry.url}`))].slice(0, 5).join(', ')}); all were blocked`);
  }
  if (stopped.reason !== null) limitations.push(`probing stopped early: ${stopped.reason}`);
  if (outcome.exhausted) limitations.push(`the probe budget (${options.maxProbes} widths) ran out; some changes are located only within a wider bracket`);
  for (const failure of outcome.failures) limitations.push(`probe at ${failure}`);
  const signatureWidths = new Set(outcome.changePoints.flatMap((point) => [point.lower, point.upper]));
  const signatures: Record<string, Record<string, string>> = {};
  for (const width of [...signatureWidths].sort((a, b) => a - b)) {
    const signature = outcome.signatures.get(width);
    if (signature !== undefined) signatures[String(width)] = Object.fromEntries(signature);
  }
  return {
    pageId,
    conditions,
    unreadable,
    containerRules,
    emPx,
    probe: {
      height: options.height,
      maxProbes: options.maxProbes,
      widths: [...outcome.widths],
      exhausted: outcome.exhausted,
      blockedRequests: blocked.length,
      failures: [...outcome.failures],
      changePoints: outcome.changePoints.map((point) => ({ lower: point.lower, upper: point.upper, changes: point.changes.map((change) => ({ ...change })) })),
      signatures,
    },
    limitations,
  };
}

/** An empty record for a scan, filled page by page. */
export function emptyResponsiveRecord(scanId: string, evidenceId: string, options: ResponsiveOptions): ResponsiveRecord {
  return { scanId, evidenceId, options: { ...options }, pages: {} };
}
