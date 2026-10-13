import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { evaluateRobots, fetchRobots, matchesRobotsPath, parseRobots, RobotsCache, selectGroup } from './robots.js';
import { makeTempDir, serveDir, writeSite, type TempDir } from './test-helpers.js';

const SAMPLE = `
# comment
User-agent: *
Disallow: /private/
Allow: /private/public-file.html

User-agent: uidna
Disallow: /uidna-only/
Allow: /uidna-only/ok

User-agent: other
Disallow: /
`;

describe('parseRobots / selectGroup', () => {
  it('parses groups, ignores comments and unknown directives', () => {
    const groups = parseRobots(`${SAMPLE}\nSitemap: https://x/sitemap.xml\nCrawl-delay: 5`);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.agents).toEqual(['*']);
    expect(groups[0]?.rules).toEqual([
      { type: 'disallow', path: '/private/' },
      { type: 'allow', path: '/private/public-file.html' },
    ]);
    expect(groups[1]?.agents).toEqual(['uidna']);
  });

  it('prefers the uidna group over * and merges split groups', () => {
    const groups = parseRobots(`${SAMPLE}\nUser-agent: uidna\nDisallow: /extra/`);
    const selected = selectGroup(groups);
    expect(selected?.agent).toBe('uidna');
    expect(selected?.group.rules.map((rule) => rule.path)).toEqual(['/uidna-only/', '/uidna-only/ok', '/extra/']);
    expect(selectGroup(parseRobots('User-agent: other\nDisallow: /'))).toBeNull();
  });
});

describe('evaluateRobots', () => {
  const groups = parseRobots(SAMPLE);

  it('allows paths that no rule matches', () => {
    expect(evaluateRobots(groups, 'https://example.com/public/page').allowed).toBe(true);
  });

  it('disallows by the uidna group and names the rule', () => {
    const decision = evaluateRobots(groups, 'https://example.com/uidna-only/secret');
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toEqual({ type: 'disallow', path: '/uidna-only/' });
    expect(decision.agent).toBe('uidna');
    expect(decision.reason).toContain('Disallow: /uidna-only/');
  });

  it('applies longest match so a more specific Allow wins', () => {
    expect(evaluateRobots(groups, 'https://example.com/uidna-only/ok/page').allowed).toBe(true);
    // The uidna group, not *, applies: /private/ is not disallowed for uidna.
    expect(evaluateRobots(groups, 'https://example.com/private/x').allowed).toBe(true);
    const star = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public-file.html');
    expect(evaluateRobots(star, 'https://example.com/private/x').allowed).toBe(false);
    expect(evaluateRobots(star, 'https://example.com/private/public-file.html').allowed).toBe(true);
  });

  it('treats an empty Disallow as allow-all and supports wildcards and anchors', () => {
    expect(evaluateRobots(parseRobots('User-agent: *\nDisallow:'), 'https://e.com/anything').allowed).toBe(true);
    expect(matchesRobotsPath('/*.json$', '/data/file.json')).toBe(true);
    expect(matchesRobotsPath('/*.json$', '/data/file.json?x=1')).toBe(false);
    expect(matchesRobotsPath('/a/*/c', '/a/b/c/d')).toBe(true);
    expect(matchesRobotsPath('/a/', '/b/')).toBe(false);
  });
});

describe('fetchRobots', () => {
  it('treats unreachable and 404 as allowed, 200 as parsed', async () => {
    const unreachable = await fetchRobots('http://127.0.0.1:9', { timeoutMs: 500 });
    expect(unreachable.status).toBe('unreachable');
    expect(unreachable.groups).toEqual([]);

    const missing = await fetchRobots('http://h', { fetchImpl: () => Promise.resolve({ status: 404, text: () => Promise.resolve('') }) });
    expect(missing.status).toBe('missing');

    const okFile = await fetchRobots('http://h', { fetchImpl: () => Promise.resolve({ status: 200, text: () => Promise.resolve(SAMPLE) }) });
    expect(okFile.status).toBe('ok');
    expect(okFile.groups).toHaveLength(3);
  });
});

describe('RobotsCache against a real static server', () => {
  let server: StaticServer;
  let temp: TempDir;

  beforeAll(async () => {
    temp = await makeTempDir('uidna-robots-');
    await writeSite(temp.path, {
      'robots.txt': 'User-agent: uidna\nDisallow: /private/\n',
      'index.html': '<!doctype html><title>ok</title><body>ok</body>',
      'private/index.html': '<!doctype html><title>private</title><body>private</body>',
    });
    server = await serveDir(temp.path);
  });

  afterAll(async () => {
    await server.close();
    await temp.cleanup();
  });

  it('fetches once per origin and returns a policy error for disallowed URLs', async () => {
    const cache = new RobotsCache();
    const allowed = await cache.check(`${server.url}index.html`);
    expect(allowed.ok).toBe(true);
    const denied = await cache.check(`${server.url}private/`);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error._tag).toBe('policy');
      expect(denied.error.message).toContain('Disallow: /private/');
      expect(denied.error.details?.rule).toEqual({ type: 'disallow', path: '/private/' });
    }
    expect(await cache.file(new URL(server.url).origin)).toBe(await cache.file(new URL(server.url).origin));
  });

  it('does not apply to non-http URLs', async () => {
    const cache = new RobotsCache();
    const result = await cache.check('file:///C:/tmp/page.html');
    expect(result.ok && result.value.allowed).toBe(true);
  });
});
