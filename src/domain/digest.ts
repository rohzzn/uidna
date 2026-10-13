/**
 * Content digests. Used for deduplication (style objects, screenshots), for
 * state identity (DOM and role-tree digests) and for evidence integrity.
 */
import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a buffer or string. */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Short (12 hex chars by default) SHA-256 digest. The full digest is available via `sha256`. */
export function shortDigest(data: Buffer | string, length = 12): string {
  return sha256(data).slice(0, length);
}

/**
 * Deterministic JSON serialization: object keys sorted recursively, so that
 * structurally equal values produce equal digests.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Digest of a JSON value using `stableStringify`. */
export function digestValue(value: unknown, length = 12): string {
  return shortDigest(stableStringify(value), length);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const inner = record[key];
      if (inner !== undefined) sorted[key] = sortKeys(inner);
    }
    return sorted;
  }
  return value;
}
