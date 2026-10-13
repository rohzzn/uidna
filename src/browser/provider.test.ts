import { createServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { unwrap } from '../domain/result.js';
import { cdpVersionUrl, createPlaywrightProvider, USER_AGENT_SUFFIX } from './playwright-provider.js';
import { NETWORK_INCOMPLETE_LIMITATION } from './session.js';
import { makeTempDir, PHONE, serveDir, serveFixtureA, writeSite } from './test-helpers.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

let fixture: StaticServer;
let debugPort: number;
let userBrowser: Browser;
let userPage: Page;

beforeAll(async () => {
  fixture = await serveFixtureA();
  debugPort = await freePort();
  userBrowser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] });
  const context = await userBrowser.newContext({ viewport: { ...PHONE } });
  userPage = await context.newPage();
  await userPage.goto(fixture.url);
});

afterAll(async () => {
  await userBrowser.close();
  await fixture.close();
});

describe('probe', () => {
  it('reports Playwright, Chromium and CDP reachability', async () => {
    const provider = createPlaywrightProvider();
    const report = await provider.probe(`http://localhost:${debugPort}`);
    expect(report.playwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.chromium.available).toBe(true);
    expect(report.chromium.executablePath).toContain('chrom');
    expect(report.cdp?.reachable).toBe(true);
    expect(report.cdp?.browser).toContain('Chrome');

    const unreachable = await provider.probe(`http://127.0.0.1:${await freePort()}`);
    expect(unreachable.cdp?.reachable).toBe(false);
    expect(unreachable.cdp?.detail).toContain('unreachable');
    expect((await provider.probe()).cdp).toBeNull();
  });

  it('derives the version URL from http and ws endpoints', () => {
    expect(cdpVersionUrl('http://localhost:9222')).toBe('http://localhost:9222/json/version');
    expect(cdpVersionUrl('ws://localhost:9222/devtools/browser/abc')).toBe('http://localhost:9222/json/version');
    expect(cdpVersionUrl('ftp://x')).toBeNull();
  });
});

describe('attach mode', () => {
  it('attaches to the running browser, captures, and close() only detaches', async () => {
    const provider = createPlaywrightProvider();
    const session = unwrap(await provider.attach({ cdpEndpoint: `http://localhost:${debugPort}` }), 'attach');
    expect(session.mode).toBe('cdp');
    const nav = unwrap(await session.navigate(`${fixture.url}#features`));
    expect(nav.url).toBe(`${fixture.url}#features`);
    const state = unwrap(await session.capture());
    expect(state.nodes.length).toBeGreaterThan(50);
    expect(state.nodes.find((node) => node.tag === 'button')?.role).toBe('button');
    expect(state.viewport).toEqual(PHONE);
    // The page was loaded before the session attached (the hash navigation did not reload it): said, not guessed.
    expect(state.limitations).toEqual([NETWORK_INCOMPLETE_LIMITATION]);
    unwrap(await session.reload());
    const reloaded = unwrap(await session.capture());
    expect(reloaded.limitations).toEqual([]);
    expect(reloaded.network.map((entry) => entry.url)).toContain(fixture.url);
    await session.close();
    expect(userBrowser.isConnected()).toBe(true);
    expect(userPage.isClosed()).toBe(false);
    expect(userPage.url()).toBe(`${fixture.url}#features`);
  });

  it('selects a page by target id and rejects unknown ids', async () => {
    const cdp = await userPage.context().newCDPSession(userPage);
    const info = (await cdp.send('Target.getTargetInfo')).targetInfo;
    await cdp.detach();
    const provider = createPlaywrightProvider();
    const session = unwrap(await provider.attach({ cdpEndpoint: `http://localhost:${debugPort}`, targetId: info.targetId }));
    expect(session.currentUrl()).toBe(userPage.url());
    await session.close();
    const missing = await provider.attach({ cdpEndpoint: `http://localhost:${debugPort}`, targetId: 'nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error._tag).toBe('not-found');
    expect(userBrowser.isConnected()).toBe(true);
  });

  it('fails cleanly when nothing listens on the endpoint', async () => {
    const result = await createPlaywrightProvider().attach({ cdpEndpoint: `http://127.0.0.1:${await freePort()}` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe('browser');
    const invalid = await createPlaywrightProvider().attach({ cdpEndpoint: 'localhost:9222' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error._tag).toBe('validation');
  });
});

describe('launch mode', () => {
  it('applies the user agent suffix and context options', async () => {
    const temp = await makeTempDir('uidna-provider-');
    await writeSite(temp.path, {
      'index.html':
        '<!doctype html><html><head><title>UA</title></head><body><p id="ua"></p><p id="lang"></p><p id="scheme"></p>' +
        '<script>document.getElementById("ua").textContent = navigator.userAgent;' +
        'document.getElementById("lang").textContent = navigator.language;' +
        'document.getElementById("scheme").textContent = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";</script></body></html>',
    });
    const site = await serveDir(temp.path);
    const session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...PHONE }, locale: 'de-DE', colorScheme: 'dark' }));
    try {
      unwrap(await session.navigate(site.url));
      const state = unwrap(await session.capture());
      expect(state.viewport).toEqual(PHONE);
      const text = (id: string): string | null => state.nodes.find((node) => node.attrs.id === id)?.text ?? null;
      expect(text('ua')).toContain(USER_AGENT_SUFFIX);
      expect(text('ua')).toContain('Chrome');
      expect(text('lang')).toBe('de-DE');
      expect(text('scheme')).toBe('dark');
      expect(state.network.find((candidate) => candidate.url === site.url)?.status).toBe(200);
    } finally {
      await session.close();
      await site.close();
      await temp.cleanup();
    }
    expect(USER_AGENT_SUFFIX).toBe('uidna/0.1.0');
  });
});
