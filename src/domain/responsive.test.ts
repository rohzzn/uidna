import { describe, expect, it } from 'vitest';
import { ok, type Result } from './result.js';
import { diffSignatures, locateChanges, reconcileBreakpoints, type LayoutSignature } from './responsive.js';

/** A synthetic page: sidebar shown from 960px, stat grid 1/2/4 columns with steps at 600 and 1100. */
function dashboard(width: number): LayoutSignature {
  return new Map([
    ['0/1|display', width >= 960 ? 'block' : 'none'],
    ['0/1|rendered', width >= 960 ? 'true' : 'false'],
    ['0/2/0|grid-columns', width >= 1100 ? '4' : width >= 600 ? '2' : '1'],
    ['0/2/0|display', 'grid'],
  ]);
}

function measurer(page: (width: number) => LayoutSignature): { measure: (width: number) => Promise<Result<LayoutSignature>>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    measure: (width) => {
      calls.push(width);
      return Promise.resolve(ok(page(width)));
    },
  };
}

describe('diffSignatures', () => {
  it('lists changed keys with the values on either side, in document order', () => {
    expect(diffSignatures(dashboard(959), dashboard(960))).toEqual([
      { path: '0/1', property: 'display', below: 'none', above: 'block' },
      { path: '0/1', property: 'rendered', below: 'false', above: 'true' },
    ]);
    expect(diffSignatures(dashboard(700), dashboard(900))).toEqual([]);
  });
});

describe('locateChanges', () => {
  it('confirms each stylesheet threshold with one probe on either side', async () => {
    const { measure, calls } = measurer(dashboard);
    const outcome = await locateChanges({ scannedWidths: [1280, 768, 390], cssThresholds: [600, 960, 1100, 1440], tolerancePx: 8, maxProbes: 32, measure });
    expect(outcome.changePoints.map((p) => [p.lower, p.upper])).toEqual([
      [599, 600],
      [959, 960],
      [1099, 1100],
    ]);
    expect([...calls].sort((a, b) => a - b)).toEqual([390, 599, 600, 768, 959, 960, 1099, 1100, 1280]);
    expect(outcome.exhausted).toBe(false);
    expect(outcome.failures).toEqual([]);
  });

  it('finds the same changes to the pixel by bisection when no stylesheet explains them', async () => {
    const { measure, calls } = measurer(dashboard);
    const outcome = await locateChanges({ scannedWidths: [390, 768, 1280], cssThresholds: [], tolerancePx: 8, maxProbes: 64, measure });
    expect(outcome.changePoints.map((p) => [p.lower, p.upper])).toEqual([
      [599, 600],
      [959, 960],
      [1099, 1100],
    ]);
    expect(calls.length).toBeLessThanOrEqual(40);
    expect(new Set(calls).size).toBe(calls.length);
  });

  it('stops at its budget and reports the bracket it reached', async () => {
    const { measure, calls } = measurer(dashboard);
    const outcome = await locateChanges({ scannedWidths: [390, 768, 1280], cssThresholds: [], tolerancePx: 8, maxProbes: 6, measure });
    expect(calls).toHaveLength(6);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.changePoints.some((p) => p.upper - p.lower > 1)).toBe(true);
  });

  it('never probes outside the scanned range or a pair whose layouts agree', async () => {
    const constant = measurer(() => new Map([['0|display', 'block']]));
    const outcome = await locateChanges({ scannedWidths: [390, 1280], cssThresholds: [600, 1440], tolerancePx: 8, maxProbes: 32, measure: constant.measure });
    expect(constant.calls).toEqual([390, 1280]);
    expect(outcome.changePoints).toEqual([]);
  });
});

describe('reconcileBreakpoints', () => {
  it('attributes change points to stylesheet thresholds, or to the probe, and records each condition\'s effect', async () => {
    const { measure } = measurer((width) => new Map([...dashboard(width), ['0/3|position', width >= 720 ? 'static' : 'absolute']]));
    const outcome = await locateChanges({ scannedWidths: [390, 768, 1280], cssThresholds: [600, 960, 1100, 1440, 500], tolerancePx: 8, maxProbes: 64, measure });
    const reconciled = reconcileBreakpoints(
      outcome.changePoints,
      [
        { id: 'mq_01', thresholds: [600], never: false },
        { id: 'mq_02', thresholds: [960], never: false },
        { id: 'mq_03', thresholds: [1100], never: false },
        { id: 'mq_04', thresholds: [1440], never: false },
        { id: 'mq_05', thresholds: [500], never: false },
        { id: 'mq_06', thresholds: [], never: true },
      ],
      outcome.widths,
    );
    expect(reconciled.breakpoints.map((b) => [b.minWidth, b.source, b.bracket.lower, b.conditionIds.join(',')])).toEqual([
      [600, 'css', 599, 'mq_01'],
      [720, 'probe', 719, ''],
      [960, 'css', 959, 'mq_02'],
      [1100, 'css', 1099, 'mq_03'],
    ]);
    expect(Object.fromEntries(reconciled.observedEffect)).toEqual({ mq_01: true, mq_02: true, mq_03: true, mq_04: null, mq_05: false, mq_06: null });
    expect(reconciled.unprobed).toEqual([1440]);
  });
});
