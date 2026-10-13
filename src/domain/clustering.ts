/**
 * Deterministic agglomerative clustering for token extraction. Samples are
 * distinct values with occurrence counts; clusters list every member so a
 * merged token can always be traced back to the measured values behind it.
 *
 * Merges proceed in single-linkage order (closest pair of clusters first,
 * measured by the smallest distance between any two members) but a merge is
 * only accepted while the merged cluster's spread (largest pairwise distance)
 * stays within the threshold. Pure single linkage chains values that are each
 * close to their neighbour into one cluster whose extremes are far apart; that
 * would merge measured values without evidence, so it is bounded here.
 */

/** A distinct value and how often it occurred. */
export interface Sample<T> {
  readonly value: T;
  readonly count: number;
}

/** A group of samples that are within `threshold` of each other. */
export interface Cluster<T> {
  /** The member with the highest count; ties go to the earliest in sort order. */
  readonly representative: T;
  /** Members sorted by count descending, then by value. */
  readonly members: readonly Sample<T>[];
  /** Sum of member counts. */
  readonly sampleCount: number;
  /** Largest pairwise distance inside the cluster; 0 for a single member. */
  readonly spread: number;
}

/** Total order used to break ties deterministically. Numbers compare numerically, everything else as strings. */
export function compareValues<T>(a: T, b: T): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareSamples<T>(compare: (a: T, b: T) => number): (a: Sample<T>, b: Sample<T>) => number {
  return (a, b) => b.count - a.count || compare(a.value, b.value);
}

/** Square matrix of numbers with a safe accessor (a missing cell reads as `fallback`). */
class Matrix {
  private readonly cells: Float64Array;

  constructor(
    private readonly n: number,
    private readonly fallback: number,
  ) {
    this.cells = new Float64Array(n * n).fill(fallback);
  }

  get(i: number, j: number): number {
    return this.cells[i * this.n + j] ?? this.fallback;
  }

  set(i: number, j: number, value: number): void {
    this.cells[i * this.n + j] = value;
    this.cells[j * this.n + i] = value;
  }
}

/**
 * Cluster samples whose values lie within `threshold` of each other under
 * `distance`. Equal values are merged into one sample first (counts added).
 * Output order: clusters by `sampleCount` descending, then by representative.
 */
export function clusterSamples<T>(
  samples: readonly Sample<T>[],
  distance: (a: T, b: T) => number,
  threshold: number,
  compare: (a: T, b: T) => number = compareValues,
): Cluster<T>[] {
  const merged = mergeEqual(samples, compare).sort(compareSamples(compare));
  const n = merged.length;
  if (n === 0) return [];

  // Cluster-to-cluster distances: `linkMin` is the single-linkage distance,
  // `linkMax` the largest member-to-member distance (what the spread becomes).
  const linkMin = new Matrix(n, Number.POSITIVE_INFINITY);
  const linkMax = new Matrix(n, Number.POSITIVE_INFINITY);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = merged[i];
      const b = merged[j];
      if (!a || !b) continue;
      const value = distance(a.value, b.value);
      linkMin.set(i, j, value);
      linkMax.set(i, j, value);
    }
  }

  const members: number[][] = merged.map((_, i) => [i]);
  const alive: boolean[] = merged.map(() => true);
  const spreads: number[] = merged.map(() => 0);
  const spreadOf = (i: number): number => spreads[i] ?? 0;

  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (!alive[j]) continue;
        const link = linkMin.get(i, j);
        if (link > threshold) continue;
        if (Math.max(spreadOf(i), spreadOf(j), linkMax.get(i, j)) > threshold) continue;
        if (link < best) {
          best = link;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;
    // Merge cluster j into cluster i.
    members[bestI] = [...(members[bestI] ?? []), ...(members[bestJ] ?? [])];
    spreads[bestI] = Math.max(spreadOf(bestI), spreadOf(bestJ), linkMax.get(bestI, bestJ));
    alive[bestJ] = false;
    for (let k = 0; k < n; k += 1) {
      if (!alive[k] || k === bestI) continue;
      linkMin.set(bestI, k, Math.min(linkMin.get(bestI, k), linkMin.get(bestJ, k)));
      linkMax.set(bestI, k, Math.max(linkMax.get(bestI, k), linkMax.get(bestJ, k)));
    }
  }

  const clusters: Cluster<T>[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!alive[i]) continue;
    const clusterMembers: Sample<T>[] = [];
    for (const index of members[i] ?? []) {
      const sample = merged[index];
      if (sample) clusterMembers.push(sample);
    }
    clusterMembers.sort(compareSamples(compare));
    const first = clusterMembers[0];
    if (!first) continue;
    clusters.push({
      representative: first.value,
      members: clusterMembers,
      sampleCount: clusterMembers.reduce((sum, m) => sum + m.count, 0),
      spread: spreadOf(i),
    });
  }
  return clusters.sort((a, b) => b.sampleCount - a.sampleCount || compare(a.representative, b.representative));
}

/** Merge samples with equal values (by `compare`), summing their counts. Samples with a zero count are dropped. */
function mergeEqual<T>(samples: readonly Sample<T>[], compare: (a: T, b: T) => number): Sample<T>[] {
  const sorted = [...samples].sort((a, b) => compare(a.value, b.value));
  const out: Sample<T>[] = [];
  for (const sample of sorted) {
    if (sample.count <= 0) continue;
    const last = out[out.length - 1];
    if (last && compare(last.value, sample.value) === 0) {
      out[out.length - 1] = { value: last.value, count: last.count + sample.count };
    } else {
      out.push({ value: sample.value, count: sample.count });
    }
  }
  return out;
}

/** Parse a CSS pixel length such as `16px` (or `0`) into a number; anything else is `null`. */
export function parsePx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text === '0') return 0;
  const match = /^(-?\d*\.?\d+)px$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Count occurrences of values into samples (one sample per distinct value, sorted by value). */
export function countSamples<T>(values: readonly T[], compare: (a: T, b: T) => number = compareValues): Sample<T>[] {
  return mergeEqual(
    values.map((value) => ({ value, count: 1 })),
    compare,
  );
}
