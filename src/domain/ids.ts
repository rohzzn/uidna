/**
 * Identifier helpers. IDs are short, prefixed and sortable where it matters
 * (scan ids embed the date so `.uidna/` lists chronologically).
 */
import { randomBytes } from 'node:crypto';

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** New scan id, e.g. `scan_20261013_3f9a1c`. */
export function newScanId(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  return `scan_${y}${m}${d}_${hex(3)}`;
}

/** New evidence id, e.g. `ev_3f9a1c7b2d4e`. */
export function newEvidenceId(): string {
  return `ev_${hex(6)}`;
}

/** Sequential, zero-padded id with a prefix: `sequentialId('st', 1)` is `st_01`. */
export function sequentialId(prefix: string, index: number, width = 2): string {
  return `${prefix}_${index.toString().padStart(width, '0')}`;
}

/** State id for the n-th state of a scan (1-based). */
export function stateId(index: number): string {
  return sequentialId('st', index);
}

/** Transition id (1-based). */
export function transitionId(index: number): string {
  return sequentialId('tr', index);
}

/** Component definition id (1-based). */
export function componentId(index: number): string {
  return sequentialId('cmp', index);
}

/** Component instance id (1-based). */
export function instanceId(index: number): string {
  return sequentialId('inst', index, 3);
}

/** Token id, e.g. `tok_color_01`. */
export function tokenId(kind: string, index: number): string {
  return sequentialId(`tok_${kind}`, index);
}

/** Pattern of a scan id (checked at boundaries before touching the filesystem). */
export const SCAN_ID_PATTERN = /^scan_\d{8}_[0-9a-f]{6}$/;

/** True when `value` is a scan id. */
export function isScanId(value: string): boolean {
  return SCAN_ID_PATTERN.test(value);
}

/** Pattern of a state id. */
export const STATE_ID_PATTERN = /^st_\d{2,}$/;

/** Pattern of an evidence id. */
export const EVIDENCE_ID_PATTERN = /^ev_[0-9a-f]{12}$/;
