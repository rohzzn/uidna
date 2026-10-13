import { describe, expect, it } from 'vitest';
import { colorDistance, formatCssColor, isTransparent, parseCssColor, toHex } from './color.js';

describe('parseCssColor', () => {
  it('parses computed-style rgb() and rgba()', () => {
    expect(parseCssColor('rgb(47, 91, 234)')).toEqual({ r: 47, g: 91, b: 234, a: 1 });
    expect(parseCssColor('rgba(27, 31, 42, 0.08)')).toEqual({ r: 27, g: 31, b: 42, a: 0.08 });
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('parses modern space syntax and percentages', () => {
    expect(parseCssColor('rgb(47 91 234 / 50%)')).toEqual({ r: 47, g: 91, b: 234, a: 0.5 });
    expect(parseCssColor('rgb(100% 0% 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses hex in all four lengths', () => {
    expect(parseCssColor('#2f5bea')).toEqual({ r: 47, g: 91, b: 234, a: 1 });
    expect(parseCssColor('#FFF')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#0008')?.a).toBeCloseTo(136 / 255, 5);
    expect(parseCssColor('#2f5bea80')?.a).toBeCloseTo(128 / 255, 5);
  });

  it('parses transparent and basic named colors', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor('White')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('navy')).toEqual({ r: 0, g: 0, b: 128, a: 1 });
  });

  it('returns null for non-colors', () => {
    expect(parseCssColor('currentcolor')).toBeNull();
    expect(parseCssColor('linear-gradient(red, blue)')).toBeNull();
    expect(parseCssColor('#12')).toBeNull();
    expect(parseCssColor('rgb(1, 2)')).toBeNull();
    expect(parseCssColor('')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats opaque colors as lowercase hex and translucent ones as rgba()', () => {
    expect(toHex({ r: 47, g: 91, b: 234, a: 1 })).toBe('#2f5bea');
    expect(toHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
    expect(formatCssColor({ r: 47, g: 91, b: 234, a: 1 })).toBe('#2f5bea');
    expect(formatCssColor({ r: 27, g: 31, b: 42, a: 0.08 })).toBe('rgba(27, 31, 42, 0.08)');
  });
});

describe('colorDistance', () => {
  it('is zero for identical colors and about 441.67 for black vs white', () => {
    const blue = { r: 47, g: 91, b: 234, a: 1 };
    expect(colorDistance(blue, blue)).toBe(0);
    expect(colorDistance({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(441.673, 2);
  });

  it('counts alpha differences', () => {
    const opaque = { r: 10, g: 10, b: 10, a: 1 };
    expect(colorDistance(opaque, { ...opaque, a: 0 })).toBe(255);
    expect(colorDistance(opaque, { ...opaque, a: 0.5 })).toBeCloseTo(127.5, 5);
  });

  it('keeps near colors within the token threshold and distinct ones outside it', () => {
    const a = { r: 47, g: 91, b: 234, a: 1 };
    const b = { r: 48, g: 92, b: 236, a: 1 };
    expect(colorDistance(a, b)).toBeLessThan(6);
    expect(colorDistance(a, { r: 36, g: 72, b: 191, a: 1 })).toBeGreaterThan(6);
  });
});

describe('isTransparent', () => {
  it('is true only for zero alpha', () => {
    expect(isTransparent({ r: 0, g: 0, b: 0, a: 0 })).toBe(true);
    expect(isTransparent({ r: 0, g: 0, b: 0, a: 0.01 })).toBe(false);
  });
});
