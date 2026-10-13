/**
 * Dot-path and JSON-pointer resolution over plain JSON values. Used by
 * `inspect_dna` (read one value) and `annotate_dna` (annotate one value).
 */
import { uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** Split `a.b.0.c` or `/a/b/0/c` into segments. */
export function parsePath(path: string): Result<string[]> {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/' || trimmed === '.') return ok([]);
  if (trimmed.startsWith('/')) {
    return ok(
      trimmed
        .slice(1)
        .split('/')
        .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')),
    );
  }
  const segments = trimmed.split('.');
  if (segments.some((s) => s === '')) return err(uidnaError('validation', `invalid path "${path}": empty segment`));
  return ok(segments);
}

/** Resolve a path to its value. Missing locations are a `not-found` error naming the first missing segment. */
export function getAtPath(root: unknown, path: string): Result<unknown> {
  const parsed = parsePath(path);
  if (!parsed.ok) return parsed;
  let current: unknown = root;
  for (const segment of parsed.value) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return err(uidnaError('not-found', `path "${path}": index ${segment} out of range`));
      }
      current = current[index];
    } else if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        return err(uidnaError('not-found', `path "${path}": no key "${segment}"`));
      }
      current = record[segment];
    } else {
      return err(uidnaError('not-found', `path "${path}": cannot descend into ${typeof current} at "${segment}"`));
    }
  }
  return ok(current);
}

/** The container and key a path points at, so callers can mutate in place. */
export interface PathLocation {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string | number;
  readonly value: unknown;
  readonly segments: readonly string[];
}

/** Resolve a path to its container. The root itself cannot be located. */
export function locatePath(root: unknown, path: string): Result<PathLocation> {
  const parsed = parsePath(path);
  if (!parsed.ok) return parsed;
  const segments = parsed.value;
  if (segments.length === 0) return err(uidnaError('validation', 'path must point below the document root'));
  const parentPath = segments.slice(0, -1);
  const last = segments[segments.length - 1] ?? '';
  const parent: Result<unknown> = parentPath.length === 0 ? ok(root) : getAtPath(root, '/' + parentPath.map(escapePointer).join('/'));
  if (!parent.ok) return parent;
  const container = parent.value;
  if (Array.isArray(container)) {
    const list = container as unknown[];
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) {
      return err(uidnaError('not-found', `path "${path}": index ${last} out of range`));
    }
    return ok({ parent: list, key: index, value: list[index], segments });
  }
  if (container !== null && typeof container === 'object') {
    const record = container as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, last)) {
      return err(uidnaError('not-found', `path "${path}": no key "${last}"`));
    }
    return ok({ parent: record, key: last, value: record[last], segments });
  }
  return err(uidnaError('not-found', `path "${path}": parent is not a container`));
}

/** Render segments as a JSON pointer. */
export function toPointer(segments: readonly (string | number)[]): string {
  return '/' + segments.map((s) => escapePointer(String(s))).join('/');
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
