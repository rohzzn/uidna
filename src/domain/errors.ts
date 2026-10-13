/**
 * Tagged errors. Every error in UI DNA is a plain object with a `_tag`
 * discriminant, a human-readable message and optional structured details.
 * Errors never carry secrets; details are meant for local diagnostics.
 */

/** The closed set of error categories. */
export type ErrorTag =
  | 'browser'
  | 'navigation'
  | 'capture'
  | 'policy'
  | 'validation'
  | 'io'
  | 'budget'
  | 'timeout'
  | 'not-found'
  | 'generate'
  | 'verify'
  | 'cancelled'
  | 'config'
  | 'unsupported'
  | 'internal';

/** A tagged UI DNA error. */
export interface UidnaError {
  readonly _tag: ErrorTag;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** True when retrying the same operation may succeed (timeouts, transient browser errors). */
  readonly retryable?: boolean;
}

/** Create a tagged error. */
export function uidnaError(
  tag: ErrorTag,
  message: string,
  extra: { details?: Record<string, unknown>; cause?: unknown; retryable?: boolean } = {},
): UidnaError {
  const error: { -readonly [K in keyof UidnaError]: UidnaError[K] } = { _tag: tag, message };
  if (extra.details) error.details = extra.details;
  if (extra.cause !== undefined) error.cause = extra.cause;
  if (extra.retryable !== undefined) error.retryable = extra.retryable;
  return error;
}

/** Type guard for `UidnaError`. */
export function isUidnaError(value: unknown): value is UidnaError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_tag' in value &&
    typeof (value)._tag === 'string' &&
    'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
  );
}

/** Convert an arbitrary thrown value into a tagged error without losing the cause. */
export function toError(cause: unknown, tag: ErrorTag = 'internal', prefix?: string): UidnaError {
  if (isUidnaError(cause)) return prefix ? uidnaError(cause._tag, `${prefix}: ${cause.message}`, { cause }) : cause;
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : safeStringify(cause);
  const name = cause instanceof Error ? cause.name : undefined;
  let inferredTag: ErrorTag = tag;
  if (tag === 'internal' && name === 'TimeoutError') inferredTag = 'timeout';
  if (tag === 'internal' && name === 'AbortError') inferredTag = 'cancelled';
  if (tag === 'internal' && /timeout/i.test(message)) inferredTag = 'timeout';
  return uidnaError(inferredTag, prefix ? `${prefix}: ${message}` : message, {
    cause,
    retryable: inferredTag === 'timeout',
  });
}

/** One-line description of any error for logs and tool results. */
export function describeError(error: unknown): string {
  if (isUidnaError(error)) return `[${error._tag}] ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return safeStringify(error);
}

/** JSON-safe representation of an error for envelopes and diagnostics files (no `cause` chain beyond its message). */
export function serializeError(error: UidnaError): { tag: ErrorTag; message: string; details?: Record<string, unknown>; cause?: string } {
  const out: { tag: ErrorTag; message: string; details?: Record<string, unknown>; cause?: string } = {
    tag: error._tag,
    message: error.message,
  };
  if (error.details) out.details = { ...error.details };
  if (error.cause !== undefined) out.cause = describeError(error.cause);
  return out;
}

function safeStringify(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}
