/**
 * The analysis layer resolves link targets to crawled pages with the same
 * page identity the crawler uses. The function is repeated in `common.ts`
 * (importing the scan workflow from the analysis layer would be a cycle),
 * so this test pins the two implementations to each other.
 */
import { describe, expect, it } from 'vitest';
import { pageKey as crawlerPageKey } from '../application/scan.js';
import { pageKey } from './common.js';

const URLS = [
  'http://127.0.0.1:4173/',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:4173/#top',
  'http://127.0.0.1:4173/features.html',
  'http://127.0.0.1:4173/features.html#tabs',
  'http://127.0.0.1:4173/docs/',
  'http://127.0.0.1:4173/docs',
  'https://example.com/pricing?plan=pro#yearly',
  'https://example.com/a/b/?x=1&y=2',
  'not a url',
  '',
];

describe('pageKey', () => {
  it('agrees with the crawler on every URL shape', () => {
    for (const url of URLS) expect(pageKey(url), url).toBe(crawlerPageKey(url));
  });

  it('drops fragments and trailing slashes but keeps the query', () => {
    expect(pageKey('http://127.0.0.1:4173/#top')).toBe('http://127.0.0.1:4173/');
    expect(pageKey('http://127.0.0.1:4173/docs/')).toBe('http://127.0.0.1:4173/docs');
    expect(pageKey('https://example.com/pricing?plan=pro#yearly')).toBe('https://example.com/pricing?plan=pro');
    expect(pageKey('not a url')).toBe('not a url');
  });
});
