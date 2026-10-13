import { describe, expect, it } from 'vitest';
import { REDACTED, redactPageUrl, redactQueryText, redactSrcset, redactUrl, SENSITIVE_PARAM_PATTERN } from './redact.js';

describe('redactUrl', () => {
  it('redacts values of secret-looking query parameters and keeps the others', () => {
    const out = redactUrl('https://example.com/api?token=abc123&page=2&api_key=zzz&Authorization=Bearer%20x&q=hello%20world');
    expect(out).toBe(`https://example.com/api?token=${REDACTED}&page=2&api_key=${REDACTED}&Authorization=${REDACTED}&q=hello%20world`);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('zzz');
  });

  it('matches every name in the sensitive pattern case-insensitively', () => {
    for (const name of ['token', 'KEY', 'secret', 'auth', 'session_id', 'password', 'signature', 'sig', 'code', 'id_token', 'X-Auth']) {
      expect(SENSITIVE_PARAM_PATTERN.test(name)).toBe(true);
      expect(redactUrl(`http://h/?${name}=v`)).toBe(`http://h/?${name}=${REDACTED}`);
    }
    expect(redactUrl('http://h/?page=1&sort=asc&id=42')).toBe('http://h/?page=1&sort=asc&id=42');
  });

  it('leaves URLs without a query untouched', () => {
    expect(redactUrl('http://127.0.0.1:4173/styles.css')).toBe('http://127.0.0.1:4173/styles.css');
  });

  it('strips userinfo and redacts fragment parameters', () => {
    expect(redactUrl('https://user:pw@example.com/#access_token=abc&state=1')).toBe(`https://example.com/#access_token=${REDACTED}&state=1`);
  });

  it('never throws on unparseable input', () => {
    expect(redactUrl('not a url?token=1&x=2')).toBe(`not a url?token=${REDACTED}&x=2`);
    expect(redactUrl('')).toBe('');
  });

  it('returns the input verbatim when nothing is redacted, so values are not re-serialized', () => {
    expect(redactUrl('HTTP://Example.com/A%20b?x=1#frag')).toBe('HTTP://Example.com/A%20b?x=1#frag');
  });
});

describe('redactPageUrl / redactSrcset', () => {
  it('redacts relative and absolute page URLs and leaves data, blob and javascript values alone', () => {
    expect(redactPageUrl('/docs?page=1&token=abc')).toBe(`/docs?page=1&token=${REDACTED}`);
    expect(redactPageUrl('#features')).toBe('#features');
    expect(redactPageUrl('page.html')).toBe('page.html');
    expect(redactPageUrl('https://cdn.example.com/a.png?X-Amz-Signature=zzz')).toBe(`https://cdn.example.com/a.png?X-Amz-Signature=${REDACTED}`);
    expect(redactPageUrl('data:text/plain,token=abc')).toBe('data:text/plain,token=abc');
    expect(redactPageUrl('blob:https://x/uuid')).toBe('blob:https://x/uuid');
    expect(redactPageUrl('javascript:void(0)')).toBe('javascript:void(0)');
  });

  it('redacts each srcset candidate and keeps the text verbatim when nothing changes', () => {
    expect(redactSrcset('a.png?sig=1 1x, b.png 2x')).toBe(`a.png?sig=${REDACTED} 1x, b.png 2x`);
    expect(redactSrcset('a.png 1x,  b.png 2x')).toBe('a.png 1x,  b.png 2x');
  });
});

describe('redactQueryText', () => {
  it('redacts raw name=value pairs and decodes names before matching', () => {
    expect(redactQueryText('a=1&se%63ret=2')).toBe(`a=1&se%63ret=${REDACTED}`);
    expect(redactQueryText('plain')).toBe('plain');
  });
});
