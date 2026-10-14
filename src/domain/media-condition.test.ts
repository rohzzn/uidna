import { describe, expect, it } from 'vitest';
import { parseMediaCondition } from './media-condition.js';

const thresholds = (text: string, emPx = 16): readonly number[] => parseMediaCondition(text, { emPx }).thresholds;

describe('parseMediaCondition', () => {
  it('writes min-width and max-width thresholds mobile-first', () => {
    expect(thresholds('(min-width: 960px)')).toEqual([960]);
    expect(thresholds('(max-width: 959px)')).toEqual([960]);
    expect(thresholds('(max-width: 959.98px)')).toEqual([960]);
    expect(thresholds('(max-width: 599px)')).toEqual([600]);
    expect(thresholds('screen and (min-width: 768px)')).toEqual([768]);
  });

  it('converts em and rem with the initial font size', () => {
    expect(thresholds('(min-width: 60em)')).toEqual([960]);
    expect(thresholds('(max-width: 37.5rem)', 16)).toEqual([601]);
    expect(thresholds('(min-width: 60em)', 20)).toEqual([1200]);
  });

  it('reads range syntax in both directions and two-sided ranges', () => {
    expect(thresholds('(width >= 960px)')).toEqual([960]);
    expect(thresholds('(width > 959px)')).toEqual([960]);
    expect(thresholds('(width < 1100px)')).toEqual([1100]);
    expect(thresholds('(width <= 1099px)')).toEqual([1100]);
    expect(thresholds('(960px <= width)')).toEqual([960]);
    expect(thresholds('(600px <= width < 1100px)')).toEqual([600, 1100]);
  });

  it('unions comma-separated branches and keeps negations at the same flip', () => {
    expect(thresholds('(max-width: 599px), (min-width: 1100px)')).toEqual([600, 1100]);
    expect(thresholds('not all and (min-width: 768px)')).toEqual([768]);
    expect(thresholds('screen and (min-width: 768px), print and (min-width: 1px)')).toEqual([768]);
  });

  it('marks print-only conditions as never matching a screen', () => {
    expect(parseMediaCondition('print')).toEqual({ never: true, thresholds: [], unsupported: [] });
    expect(parseMediaCondition('print and (min-width: 600px)').never).toBe(true);
    expect(parseMediaCondition('not print').never).toBe(false);
  });

  it('ignores features that are not width rules', () => {
    expect(parseMediaCondition('(prefers-reduced-motion: reduce)')).toEqual({ never: false, thresholds: [], unsupported: [] });
    expect(thresholds('(min-width: 768px) and (hover: hover)')).toEqual([768]);
    expect(thresholds('(orientation: portrait)')).toEqual([]);
    expect(thresholds('(min-height: 600px)')).toEqual([]);
  });

  it('lists width values it cannot convert instead of guessing', () => {
    const parsed = parseMediaCondition('(min-width: calc(1px + 2em))');
    expect(parsed.thresholds).toEqual([]);
    expect(parsed.unsupported).toEqual(['(min-width: calc(1px + 2em))']);
    expect(parseMediaCondition('(min-width: 50vw)').unsupported).toHaveLength(1);
  });
});
