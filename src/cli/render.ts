/**
 * Human-readable rendering of evidence envelopes for the CLI. `--json`
 * bypasses this and prints the envelope verbatim.
 */
import type { Envelope } from '../domain/evidence.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function renderValue(value: unknown, indent: string, depth: number, lines: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${indent}(none)`);
      return;
    }
    const limit = depth === 0 ? 50 : 12;
    value.slice(0, limit).forEach((item) => {
      if (isRecord(item)) {
        const summary = summarizeRecord(item);
        lines.push(`${indent}- ${summary}`);
      } else {
        lines.push(`${indent}- ${scalar(item)}`);
      }
    });
    if (value.length > limit) lines.push(`${indent}… ${value.length - limit} more (use --json for everything)`);
    return;
  }
  if (isRecord(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (Array.isArray(inner)) {
        lines.push(`${indent}${key}: ${inner.length} item${inner.length === 1 ? '' : 's'}`);
        if (depth < 2) renderValue(inner, indent + '  ', depth + 1, lines);
      } else if (isRecord(inner)) {
        const entries = Object.entries(inner);
        if (entries.length > 0 && entries.every(([, v]) => !isRecord(v) && !Array.isArray(v))) {
          lines.push(`${indent}${key}: ${entries.map(([k, v]) => `${k}=${scalar(v)}`).join(' ')}`);
        } else {
          lines.push(`${indent}${key}:`);
          if (depth < 3) renderValue(inner, indent + '  ', depth + 1, lines);
        }
      } else {
        lines.push(`${indent}${key}: ${scalar(inner)}`);
      }
    }
    return;
  }
  lines.push(`${indent}${scalar(value)}`);
}

const SUMMARY_KEYS = ['id', 'stateId', 'name', 'generatedName', 'kind', 'category', 'severity', 'role', 'viewport', 'message', 'reason', 'path', 'file', 'instanceCount', 'confidence', 'ok', 'error'];

function summarizeRecord(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null || Array.isArray(value)) continue;
    if (isRecord(value)) {
      if (key === 'viewport') parts.push(`${scalar(value.width)}x${scalar(value.height)}`);
      continue;
    }
    parts.push(`${key}=${scalar(value)}`);
  }
  if (parts.length === 0) return JSON.stringify(record).slice(0, 160);
  return parts.join(' ');
}

/** Render an envelope as indented text. */
export function renderEnvelope(toolName: string, envelope: Envelope<unknown>): string {
  const lines: string[] = [`${toolName} (evidence ${envelope.evidence_id}, ${envelope.evidence.capturedAt})`];
  renderValue(envelope.result, '  ', 0, lines);
  if (envelope.evidence.artifacts.length > 0) {
    lines.push('artifacts:');
    envelope.evidence.artifacts.slice(0, 20).forEach((a) => lines.push(`  ${a}`));
    if (envelope.evidence.artifacts.length > 20) lines.push(`  … ${envelope.evidence.artifacts.length - 20} more`);
  }
  if (envelope.limitations.length > 0) {
    lines.push('limitations:');
    envelope.limitations.forEach((l) => lines.push(`  - ${l}`));
  }
  if (envelope.unknowns.length > 0) {
    lines.push('unknowns:');
    envelope.unknowns.forEach((u) => lines.push(`  - ${u}`));
  }
  return lines.join('\n');
}
