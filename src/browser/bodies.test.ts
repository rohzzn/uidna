import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Frame, Page, Response } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { sha256 } from '../domain/digest.js';
import { unwrap } from '../domain/result.js';
import { DEFAULT_MAX_BODY_BYTES, hasNoBody, isJsonMime, JsonBodyRecorder, MAX_RECORDED_BODIES, redactJson } from './bodies.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { DESKTOP, FIXTURE_C_DIR, makeTempDir, serveFixtureC, writeSite, type TempDir } from './test-helpers.js';
import type { BrowserSession, CapturedAsset } from './types.js';

const SECRET_TOKEN = 'tok_9f8e7d6c';
const SECRET_KEY = 'ak_1234567890';
const SECRET_PASSWORD = 'hunter2hunter2';

let fixture: StaticServer;
let siteSecrets: StaticServer;
let temp: TempDir;
let session: BrowserSession;

beforeAll(async () => {
  fixture = await serveFixtureC();
  temp = await makeTempDir('uidna-bodies-');
  await writeSite(join(temp.path, 'site'), {
    'index.html': `<!doctype html><html><head><title>Secrets</title></head><body><h1>Secrets</h1><p id="out"></p><script src="app.js"></script></body></html>`,
    'app.js': `fetch('/secret.json').then(r => r.json()).then(d => { document.getElementById('out').textContent = d.name; });
fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }).then(r => r.json()).then(() => {});
fetch('/big.json').then(r => r.json()).then(() => {});
fetch('/broken.json').then(r => r.text()).then(() => {});
fetch('/plain.txt').then(r => r.text()).then(() => {});`,
    'secret.json': JSON.stringify({ name: 'ok', token: SECRET_TOKEN, nested: { api_key: SECRET_KEY, list: [{ password: SECRET_PASSWORD, id: 7 }] }, count: 2 }),
    'big.json': JSON.stringify({ filler: 'x'.repeat(DEFAULT_MAX_BODY_BYTES) }),
    'broken.json': '{"unterminated": ',
    'plain.txt': '{"looks":"like json"}',
    'second.html': `<!doctype html><html><head><title>Second</title></head><body><h1>Second</h1></body></html>`,
  });
  siteSecrets = unwrap(await serveStatic(join(temp.path, 'site'), { fixtureApi: true }), 'serve secrets site');
  session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
});

afterAll(async () => {
  await session.close();
  await siteSecrets.close();
  await fixture.close();
  await temp.cleanup();
});

function dataAssets(assets: readonly CapturedAsset[]): CapturedAsset[] {
  return assets.filter((asset) => asset.kind === 'data');
}

describe('redaction helpers', () => {
  it('redacts secret-looking keys at any depth and leaves everything else', () => {
    const redacted = redactJson({ token: 'a', nested: { api_key: 'b', list: [{ password: 'c', id: 1 }, 'text', null] }, name: 'n', count: 2 });
    expect(redacted).toEqual({ token: '[redacted]', nested: { api_key: '[redacted]', list: [{ password: '[redacted]', id: 1 }, 'text', null] }, name: 'n', count: 2 });
    expect(redactJson([{ Authorization: 'x' }])).toEqual([{ Authorization: '[redacted]' }]);
    expect(redactJson('plain')).toBe('plain');
    expect(redactJson(null)).toBeNull();
  });

  it('recognizes JSON media types with parameters and +json suffixes', () => {
    expect(isJsonMime('application/json')).toBe(true);
    expect(isJsonMime('application/json; charset=utf-8')).toBe(true);
    expect(isJsonMime('Application/JSON')).toBe(true);
    expect(isJsonMime('application/problem+json')).toBe(true);
    expect(isJsonMime('text/html')).toBe(false);
    expect(isJsonMime('text/javascript')).toBe(false);
    expect(isJsonMime(undefined)).toBe(false);
  });

  it('knows which statuses carry no body', () => {
    expect([301, 302, 304, 307, 204, 205].every(hasNoBody)).toBe(true);
    expect([200, 201, 400, 404, 500].some(hasNoBody)).toBe(false);
  });
});

/**
 * The recorder's event seam with a scripted page: Playwright's `response` /
 * `framenavigated` events arrive in a chosen order and `text()` resolves
 * when the test says so, which a real browser cannot be made to do on cue.
 */
describe('JsonBodyRecorder document scoping', () => {
  const MAIN = { name: 'main' } as unknown as Frame;

  function fakePage(): { page: Page; events: EventEmitter } {
    const events = new EventEmitter();
    const page = {
      on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener),
      off: (event: string, listener: (...args: unknown[]) => void) => events.off(event, listener),
      mainFrame: () => MAIN,
    } as unknown as Page;
    return { page, events };
  }

  function jsonResponse(url: string, body: () => Promise<string>, status = 200, method = 'GET'): Response {
    return {
      request: () => ({ isNavigationRequest: () => false, resourceType: () => 'fetch', method: () => method, frame: () => MAIN, redirectedFrom: () => null }),
      status: () => status,
      headers: () => ({ 'content-type': 'application/json' }),
      url: () => url,
      text: body,
    } as unknown as Response;
  }

  function documentResponse(url: string): Response {
    return {
      request: () => ({ isNavigationRequest: () => true, resourceType: () => 'document', method: () => 'GET', frame: () => MAIN, redirectedFrom: () => null }),
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html' }),
      url: () => url,
      text: () => Promise.resolve('<html></html>'),
    } as unknown as Response;
  }

  it('discards a body whose read was still pending when the document changed, and the read outcome either way', async () => {
    const { page, events } = fakePage();
    const recorder = new JsonBodyRecorder();
    recorder.attach(page);
    await recorder.collect(); // arms: bodies are read as responses arrive
    let finishSlow: (text: string) => void = () => undefined;
    events.emit(
      'response',
      jsonResponse(
        'http://a.test/slow.json',
        () =>
          new Promise<string>((resolve) => {
            finishSlow = resolve;
          }),
      ),
    );
    events.emit(
      'response',
      jsonResponse(
        'http://a.test/aborted.json',
        () =>
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error('aborted')), 0);
          }),
      ),
    );
    // A new document commits while both reads are pending.
    events.emit('response', documentResponse('http://a.test/second.html'));
    events.emit('framenavigated', MAIN);
    finishSlow('{"from":"the previous document"}');
    events.emit('response', jsonResponse('http://a.test/own.json', () => Promise.resolve('{"own":true}')));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const collected = await recorder.collect();
    expect(collected.bodies.map((body) => body.url)).toEqual(['http://a.test/own.json']);
    expect(collected.limitations).toEqual([]);
    recorder.detach();
  });

  it('keeps one copy of a repeated identical body, skips bodiless statuses and caps distinct bodies with a limitation', async () => {
    const { page, events } = fakePage();
    const recorder = new JsonBodyRecorder();
    recorder.attach(page);
    await recorder.collect();
    for (let i = 0; i < 3; i += 1) events.emit('response', jsonResponse('http://a.test/poll.json', () => Promise.resolve('{"tick":1}')));
    events.emit('response', jsonResponse('http://a.test/poll.json', () => Promise.resolve('{"tick":2}')));
    events.emit('response', jsonResponse('http://a.test/moved.json', () => Promise.reject(new Error('Response body is unavailable for redirect responses')), 302));
    events.emit('response', jsonResponse('http://a.test/empty.json', () => Promise.resolve(''), 204));
    for (let i = 0; i < MAX_RECORDED_BODIES + 2; i += 1) events.emit('response', jsonResponse(`http://a.test/item-${i}.json`, () => Promise.resolve(`{"i":${i}}`)));
    const collected = await recorder.collect();
    expect(collected.bodies.filter((body) => body.url === 'http://a.test/poll.json')).toHaveLength(2);
    expect(collected.bodies.some((body) => body.url.endsWith('moved.json') || body.url.endsWith('empty.json'))).toBe(false);
    expect(collected.bodies).toHaveLength(MAX_RECORDED_BODIES);
    expect(collected.limitations).toEqual([`4 distinct JSON response(s) were not kept: this document already had ${MAX_RECORDED_BODIES} recorded bodies.`]);
    // A new document starts from zero.
    events.emit('response', documentResponse('http://a.test/next.html'));
    events.emit('framenavigated', MAIN);
    expect(await recorder.collect()).toEqual({ bodies: [], limitations: [] });
    recorder.detach();
  });
});

describe('captureBodies on Fixture C', () => {
  it('captures nothing by default or with "none"', async () => {
    unwrap(await session.navigate(fixture.url));
    const byDefault = unwrap(await session.capture());
    expect(dataAssets(byDefault.assets)).toEqual([]);
    const none = unwrap(await session.capture({ captureBodies: 'none', assetDir: join(temp.path, 'scan_none', 'assets') }));
    expect(dataAssets(none.assets)).toEqual([]);
    // The asset directory exists for the page's image assets; no JSON copy was written to it.
    expect((await readdir(join(temp.path, 'scan_none', 'assets'))).filter((file) => file.endsWith('.json'))).toEqual([]);
  });

  it('yields a data asset for /api/items.json with a local redacted copy equal to the fixture JSON', async () => {
    unwrap(await session.navigate(fixture.url));
    unwrap(await session.waitForStability({ timeoutMs: 5000 }));
    const state = unwrap(await session.capture({ captureBodies: 'json', assetDir: join(temp.path, 'scan_c', 'assets') }));
    const data = dataAssets(state.assets);
    expect(data).toHaveLength(1);
    const asset = data[0];
    if (!asset) throw new Error('unreachable');
    const fixtureJson = await readFile(join(FIXTURE_C_DIR, 'api', 'items.json'), 'utf8');
    expect(asset).toMatchObject({
      kind: 'data',
      url: `${fixture.url}api/items.json`,
      origin: 'same-origin',
      mime: 'application/json',
      bytes: Buffer.byteLength(fixtureJson),
      usedBy: [],
      request: { method: 'GET', status: 200, mime: 'application/json' },
    });
    expect(asset.localPath).toMatch(/^assets\/[0-9a-f]{12}\.json$/);
    const stored = await readFile(join(temp.path, 'scan_c', ...(asset.localPath ?? '').split('/')), 'utf8');
    expect(JSON.parse(stored)).toEqual(JSON.parse(fixtureJson));
    expect(sha256(stored)).toBe(asset.digest);
    expect(asset.id).toBe(`a${state.assets.length - 1}`);
    // Ids continue after the page's other assets and stay unique.
    expect(new Set(state.assets.map((candidate) => candidate.id)).size).toBe(state.assets.length);
    expect(state.limitations).toEqual([]);
    // Never the document, the stylesheet or the script.
    expect(state.assets.some((candidate) => candidate.kind === 'data' && /\.(html|css|js)$|\/$/.test(candidate.url))).toBe(false);
  });

  it('keeps recording after the first request so a later response is captured, and deduplicates identical bodies', async () => {
    unwrap(await session.navigate(fixture.url));
    unwrap(await session.waitForStability({ timeoutMs: 5000 }));
    unwrap(await session.capture({ captureBodies: 'json' }));
    const marker = session.markNetwork();
    expect(unwrap(await session.act({ kind: 'click', target: { role: 'button', name: 'Reload notes' } })).performed).toBe(true);
    unwrap(await session.waitForStability({ timeoutMs: 5000 }));
    expect(session.networkSince(marker).filter((entry) => entry.url.endsWith('/api/items.json'))).toHaveLength(1);
    const state = unwrap(await session.capture({ captureBodies: 'json' }));
    // Two responses with the same URL and content are one asset; no asset directory means no local copy but still a digest.
    expect(dataAssets(state.assets)).toHaveLength(1);
    expect(dataAssets(state.assets)[0]?.localPath).toBeUndefined();
    expect(dataAssets(state.assets)[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
    const withoutBodies = unwrap(await session.capture());
    expect(dataAssets(withoutBodies.assets)).toEqual([]);
  });
});

describe('captureBodies on a generated site', () => {
  it('redacts secret keys, captures POST responses, skips oversized, broken and non-JSON bodies, and says why', async () => {
    unwrap(await session.navigate(siteSecrets.url));
    unwrap(await session.waitForStability({ timeoutMs: 5000 }));
    const state = unwrap(await session.capture({ captureBodies: 'json', assetDir: join(temp.path, 'scan_s', 'assets') }));
    const data = dataAssets(state.assets);
    expect(data.map((asset) => asset.url).sort()).toEqual([`${siteSecrets.url}api/echo`, `${siteSecrets.url}secret.json`]);
    const secret = data.find((asset) => asset.url.endsWith('secret.json'));
    const echo = data.find((asset) => asset.url.endsWith('api/echo'));
    if (!secret || !echo) throw new Error('unreachable');
    expect(echo.request).toEqual({ method: 'POST', status: 200, mime: 'application/json' });
    expect(secret.request).toEqual({ method: 'GET', status: 200, mime: 'application/json' });
    const stored = JSON.parse(await readFile(join(temp.path, 'scan_s', ...(secret.localPath ?? '').split('/')), 'utf8')) as unknown;
    expect(stored).toEqual({ name: 'ok', token: '[redacted]', nested: { api_key: '[redacted]', list: [{ password: '[redacted]', id: 7 }] }, count: 2 });
    const everything = JSON.stringify(state) + (await readFile(join(temp.path, 'scan_s', ...(echo.localPath ?? '').split('/')), 'utf8'));
    for (const value of [SECRET_TOKEN, SECRET_KEY, SECRET_PASSWORD]) expect(everything).not.toContain(value);
    expect(state.limitations).toContainEqual(expect.stringMatching(/JSON body of .*big\.json not captured: \d+ bytes exceeds the 262144 byte limit\./));
    expect(state.limitations).toContainEqual(expect.stringContaining('broken.json not captured: the response is not valid JSON.'));
    expect(state.limitations.some((text) => text.includes('plain.txt'))).toBe(false);
    expect(data.some((asset) => asset.url.endsWith('plain.txt') || asset.url.endsWith('big.json') || asset.url.endsWith('broken.json'))).toBe(false);
    // The stored files are exactly the data assets with a local path.
    const files = await readdir(join(temp.path, 'scan_s', 'assets'));
    expect(files.filter((file) => file.endsWith('.json')).sort()).toEqual(
      data
        .map((asset) => (asset.localPath ?? '').split('/').pop() ?? '')
        .filter((name) => name !== '')
        .sort(),
    );
  });

  it('honors maxBodyBytes and scopes bodies to the current document', async () => {
    unwrap(await session.navigate(siteSecrets.url));
    unwrap(await session.waitForStability({ timeoutMs: 5000 }));
    const small = unwrap(await session.capture({ captureBodies: 'json', maxBodyBytes: 10 }));
    expect(dataAssets(small.assets)).toEqual([]);
    expect(small.limitations.filter((text) => text.includes('exceeds the 10 byte limit')).length).toBeGreaterThanOrEqual(2);
    unwrap(await session.navigate(`${siteSecrets.url}second.html`));
    const second = unwrap(await session.capture({ captureBodies: 'json' }));
    expect(second.title).toBe('Second');
    expect(dataAssets(second.assets)).toEqual([]);
    expect(second.limitations).toEqual([]);
  });
});
