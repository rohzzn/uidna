import { describe, expect, it } from 'vitest';
import { compareBreakpointSides, signatureValue } from './responsive.js';

describe('compareBreakpointSides', () => {
  const original = {
    lower: { '1/0|display': 'none', '1/0|rendered': 'false', '1/1|grid-columns': '2' },
    upper: { '1/0|display': 'block', '1/0|rendered': 'true', '1/1|grid-columns': '2' },
  };
  const rules = [
    { nodePath: '1/0', property: 'display' },
    { nodePath: '1/0', property: 'rendered' },
    { nodePath: '1', property: 'grid-template-columns' },
  ];

  it('checks only signature properties, on both sides', () => {
    const result = compareBreakpointSides({ rules, widths: { lower: 959, upper: 960 }, original, generated: original });
    expect(result).toEqual({ checked: 4, mismatches: [] });
  });

  it('reports each side whose generated value differs', () => {
    const generated = { lower: { '1/0|display': 'block', '1/0|rendered': 'true' }, upper: { '1/0|display': 'block', '1/0|rendered': 'true' } };
    const result = compareBreakpointSides({ rules, widths: { lower: 959, upper: 960 }, original, generated });
    expect(result.mismatches).toEqual([
      { side: 'lower', width: 959, path: '1/0', property: 'display', original: 'none', generated: 'block' },
      { side: 'lower', width: 959, path: '1/0', property: 'rendered', original: 'false', generated: 'true' },
    ]);
  });

  it('reads absent keys as the defaults the document uses', () => {
    expect(signatureValue({}, '1', 'position')).toBe('static');
    expect(signatureValue({}, '1', 'grid-columns')).toBe('0');
    expect(signatureValue({}, '1', 'rendered')).toBe('false');
  });
});
