import { describe, expect, it } from 'vitest';
import { clusterSamples, countSamples, parsePx } from './clustering.js';
import { colorDistance, parseCssColor } from './color.js';

const numeric = (a: number, b: number): number => Math.abs(a - b);

describe('clusterSamples', () => {
  it('keeps 16 and 17 apart at threshold 0.5 and merges equal values', () => {
    const clusters = clusterSamples(
      [
        { value: 16, count: 3 },
        { value: 17, count: 2 },
        { value: 16, count: 1 },
      ],
      numeric,
      0.5,
    );
    expect(clusters.map((c) => [c.representative, c.sampleCount, c.spread])).toEqual([
      [16, 4, 0],
      [17, 2, 0],
    ]);
  });

  it('merges colors within distance 6 and lists every member with its count', () => {
    const parse = (v: string) => parseCssColor(v) ?? { r: 0, g: 0, b: 0, a: 0 };
    const clusters = clusterSamples(
      [
        { value: 'rgb(47, 91, 234)', count: 8 },
        { value: 'rgb(48, 92, 236)', count: 2 },
        { value: 'rgb(255, 255, 255)', count: 5 },
      ],
      (a, b) => colorDistance(parse(a), parse(b)),
      6,
    );
    expect(clusters).toHaveLength(2);
    const blue = clusters[0]!;
    expect(blue.representative).toBe('rgb(47, 91, 234)');
    expect(blue.sampleCount).toBe(10);
    expect(blue.members).toEqual([
      { value: 'rgb(47, 91, 234)', count: 8 },
      { value: 'rgb(48, 92, 236)', count: 2 },
    ]);
    expect(blue.spread).toBeGreaterThan(0);
    expect(blue.spread).toBeLessThanOrEqual(6);
    expect(clusters[1]!.representative).toBe('rgb(255, 255, 255)');
  });

  it('never lets a cluster spread past the threshold through chaining', () => {
    // 0, 5, 10, 15: each neighbour is within 5 but the extremes are 15 apart.
    const clusters = clusterSamples(
      [0, 5, 10, 15].map((value) => ({ value, count: 1 })),
      numeric,
      5,
    );
    for (const cluster of clusters) expect(cluster.spread).toBeLessThanOrEqual(5);
    expect(clusters.reduce((sum, c) => sum + c.sampleCount, 0)).toBe(4);
  });

  it('is deterministic regardless of input order and breaks ties by sort order', () => {
    const a = clusterSamples(
      [
        { value: 'b', count: 2 },
        { value: 'a', count: 2 },
        { value: 'c', count: 1 },
      ],
      () => 10,
      1,
    );
    const b = clusterSamples(
      [
        { value: 'c', count: 1 },
        { value: 'a', count: 2 },
        { value: 'b', count: 2 },
      ],
      () => 10,
      1,
    );
    expect(a).toEqual(b);
    expect(a.map((c) => c.representative)).toEqual(['a', 'b', 'c']);
  });

  it('picks the member with the highest count as representative', () => {
    const clusters = clusterSamples(
      [
        { value: 10, count: 1 },
        { value: 10.2, count: 5 },
      ],
      numeric,
      0.5,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.representative).toBe(10.2);
    expect(clusters[0]!.members[0]).toEqual({ value: 10.2, count: 5 });
  });

  it('returns nothing for no samples and drops zero counts', () => {
    expect(clusterSamples([], numeric, 1)).toEqual([]);
    expect(clusterSamples([{ value: 1, count: 0 }], numeric, 1)).toEqual([]);
  });
});

describe('parsePx', () => {
  it('parses pixel lengths and rejects other units', () => {
    expect(parsePx('16px')).toBe(16);
    expect(parsePx('0')).toBe(0);
    expect(parsePx('-8px')).toBe(-8);
    expect(parsePx('341.333px')).toBeCloseTo(341.333, 3);
    expect(parsePx('1.5em')).toBeNull();
    expect(parsePx('auto')).toBeNull();
    expect(parsePx(undefined)).toBeNull();
  });
});

describe('countSamples', () => {
  it('counts distinct values', () => {
    expect(countSamples(['a', 'b', 'a'])).toEqual([
      { value: 'a', count: 2 },
      { value: 'b', count: 1 },
    ]);
  });
});
