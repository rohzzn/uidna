/**
 * A tagged result type. Every fallible operation in UI DNA returns a `Result`
 * instead of throwing, so callers must handle failure explicitly and errors
 * carry a discriminant tag (see `errors.ts`).
 */
import type { UidnaError } from './errors.js';

/** Successful result carrying a value. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** Failed result carrying an error. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Union of success and failure. */
export type Result<T, E = UidnaError> = Ok<T> | Err<E>;

/** Wrap a value as a successful result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Wrap an error as a failed result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard for `Ok`. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard for `Err`. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Transform the value of a successful result. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Chain a result-returning function on a successful result. */
export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Transform the error of a failed result. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Extract the value or throw. Only for places where failure is a programming
 * error (tests, top-level CLI after errors have been reported).
 */
export function unwrap<T, E>(result: Result<T, E>, context?: string): T {
  if (result.ok) return result.value;
  const detail = describeUnknown(result.error);
  throw new Error(context ? `${context}: ${detail}` : detail);
}

/** Extract the value or return a fallback. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Collect an array of results into a result of an array, failing on the first error. */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Run a function that may throw and convert the outcome into a `Result`.
 * `onError` turns the thrown value into a typed error.
 */
export function tryCatch<T, E>(fn: () => T, onError: (cause: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (cause) {
    return err(onError(cause));
  }
}

/** Async variant of `tryCatch`. */
export async function tryCatchAsync<T, E>(
  fn: () => Promise<T>,
  onError: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onError(cause));
  }
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message: unknown = (value).message;
    if (typeof message === 'string') return message;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
