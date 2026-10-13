/**
 * URL redaction for everything the capture stores. Query parameters whose
 * name looks like a credential are replaced with `[redacted]` and userinfo
 * (`user:password@`) is removed before a URL is written: network entries,
 * URL-bearing attributes (`href`, `src`, `srcset`, `action`), asset URLs and
 * `@font-face` sources all pass through here. Headers and bodies are never
 * stored at all.
 */

/** Parameter names that are treated as secrets (matched case-insensitively). */
export const SENSITIVE_PARAM_PATTERN = /token|key|secret|auth|session|sess|sid\b|password|passwd|pwd|pass\b|signature|sig\b|code|jwt|bearer|credential|otp|csrf|xsrf|nonce|ticket|hash\b/i;

/** The replacement value. */
export const REDACTED = '[redacted]';

/**
 * Redact secret-looking query (and fragment) parameters and strip userinfo.
 * The input is returned unchanged (not re-serialized) when nothing needs
 * redacting. Unparseable input is redacted with a best-effort textual pass
 * and returned as a string; the function never throws.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactQueryText(url);
  }
  let changed = false;
  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
    changed = true;
  }
  if (parsed.search.length > 1) {
    // Work on the raw query text so the original encoding of other values is kept.
    const redacted = redactQueryText(parsed.search.slice(1));
    if (redacted !== parsed.search.slice(1)) {
      parsed.search = redacted;
      changed = true;
    }
  }
  if (parsed.hash.length > 1 && parsed.hash.includes('=')) {
    const redacted = redactQueryText(parsed.hash.slice(1));
    if (redacted !== parsed.hash.slice(1)) {
      parsed.hash = redacted;
      changed = true;
    }
  }
  return changed ? parsed.href : url;
}

/**
 * Redact a URL found in page content (an attribute value, a stylesheet
 * source). `data:`, `blob:`, `about:` and `javascript:` values are returned
 * unchanged: their payload is not a query string and rewriting it would
 * corrupt the value. Relative URLs get the textual pass.
 */
export function redactPageUrl(value: string): string {
  if (/^\s*(data|blob|about|javascript):/i.test(value)) return value;
  return redactUrl(value);
}

/** Redact every candidate URL of a `srcset` attribute; the text is left as is when no candidate changes. */
export function redactSrcset(srcset: string): string {
  let changed = false;
  const candidates = srcset.split(',').map((candidate) => {
    const trimmed = candidate.trim();
    const [url, ...descriptors] = trimmed.split(/\s+/);
    if (url === undefined || url === '') return candidate;
    const redacted = redactPageUrl(url);
    if (redacted === url) return candidate;
    changed = true;
    const lead = candidate.slice(0, candidate.length - candidate.trimStart().length);
    return `${lead}${[redacted, ...descriptors].join(' ')}`;
  });
  return changed ? candidates.join(',') : srcset;
}

/** Redact `name=value` pairs in a raw query-like string (`a=1&token=x`). */
export function redactQueryText(text: string): string {
  const [head, query] = splitQuery(text);
  if (query === null) return text;
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      return SENSITIVE_PARAM_PATTERN.test(safeDecode(name)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');
  return head === null ? redacted : `${head}?${redacted}`;
}

function splitQuery(text: string): [string | null, string | null] {
  const q = text.indexOf('?');
  if (q >= 0) return [text.slice(0, q), text.slice(q + 1)];
  if (text.includes('=')) return [null, text];
  return [text, null];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
