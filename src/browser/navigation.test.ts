import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { unwrap } from '../domain/result.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { BLOCKED_NAVIGATION_FAILURE, ROBOTS_BLOCKED_NAVIGATION_FAILURE } from './session.js';
import { DESKTOP, makeTempDir, serveCounting, serveCountingDir, serveFixtureD, writeSite, type CountingDirServer, type CountingServer, type TempDir } from './test-helpers.js';
import type { BrowserSession } from './types.js';

let fixture: StaticServer;
let other: CountingServer;
let siteRobots: CountingDirServer;
let temp: TempDir;
let session: BrowserSession;

beforeAll(async () => {
  fixture = await serveFixtureD();
  other = await serveCounting('<!doctype html><html><head><title>Elsewhere</title></head><body><h1>Elsewhere</h1></body></html>');
  temp = await makeTempDir('uidna-navigation-');
  await writeSite(temp.path, {
    'robots.txt': 'User-agent: uidna\nDisallow: /private/\n',
    'index.html': `<!doctype html><html><head><title>Robots site</title></head><body>
      <a id="public" href="/public.html">Public page</a>
      <a id="private" href="/private/index.html">Private page</a>
      <a id="away" href="${other.url}">Away</a>
      <form id="postform" method="post" action="/api/post"><button id="post-submit" type="submit">Post</button></form>
      <form id="getform" method="get" action="/public.html"><input name="q" value="1"><button id="get-submit" type="submit">Search</button></form>
    </body></html>`,
    'public.html': '<!doctype html><html><head><title>Public</title></head><body><h1>Public</h1></body></html>',
    'private/index.html': '<!doctype html><html><head><title>Private</title></head><body><h1>Private</h1></body></html>',
  });
  siteRobots = await serveCountingDir(temp.path);
  session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
});

afterAll(async () => {
  await session.close();
  await siteRobots.close();
  await other.close();
  await fixture.close();
  await temp.cleanup();
});

describe('click with allowNavigation on Fixture D', () => {
  it('follows the Features link, loads the new document and invalidates old node ids', async () => {
    unwrap(await session.navigate(fixture.url));
    const home = unwrap(await session.capture());
    expect(home.title).toBe('Lumen — Home');
    const navLink = home.nodes.find((node) => node.role === 'link' && node.name === 'Features' && node.a11y.nth === 0);
    if (!navLink) throw new Error('Features link not found');
    const marker = session.markNetwork();
    const outcome = unwrap(await session.act({ kind: 'click', target: { nodeId: navLink.id }, allowNavigation: 'same-origin' }));
    expect(outcome.performed).toBe(true);
    expect(outcome.navigated).toBe(true);
    expect(outcome.url).toBe(`${fixture.url}features.html`);
    expect(outcome.blockedNavigation).toBeUndefined();
    expect(outcome.blockedRequests).toBeUndefined();
    expect(session.currentUrl()).toBe(`${fixture.url}features.html`);
    const document = session.networkSince(marker).find((entry) => entry.url === `${fixture.url}features.html`);
    expect(document).toMatchObject({ method: 'GET', status: 200, resourceType: 'document' });
    // Node ids of the home capture belong to the previous document until the new one is captured.
    const stale = unwrap(await session.act({ kind: 'hover', target: { nodeId: navLink.id } }));
    expect(stale.performed).toBe(false);
    expect(stale.reason).toContain('previous document');
    const features = unwrap(await session.capture());
    expect(features.title).toBe('Lumen — Features');
    expect(features.network.map((entry) => entry.url)).toContain(`${fixture.url}features.html`);
    expect(features.network.map((entry) => entry.url)).not.toContain(fixture.url);
    expect(features.roleTree.filter((entry) => entry.role === 'tab').map((entry) => entry.name)).toEqual(['Write', 'Link', 'Review']);
    // The page works: the tabs respond.
    const tab = unwrap(await session.act({ kind: 'click', target: { role: 'tab', name: 'Link' } }));
    expect(tab).toMatchObject({ performed: true, navigated: false });
    expect(unwrap(await session.capture()).nodes.find((node) => node.attrs.id === 'tab-link')?.a11y.selected).toBe(true);
  });

  it('still blocks the cross-origin footer link, and same-origin links without allowNavigation', async () => {
    unwrap(await session.navigate(`${fixture.url}features.html`));
    const marker = session.markNetwork();
    const crossOrigin = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Status page' }, allowNavigation: 'same-origin' }));
    expect(crossOrigin.performed).toBe(false);
    expect(crossOrigin.navigated).toBe(false);
    expect(crossOrigin.blockedNavigation).toBe('https://example.com/');
    expect(crossOrigin.reason).toContain('blocked');
    expect(session.currentUrl()).toBe(`${fixture.url}features.html`);
    expect(session.networkSince(marker).find((entry) => entry.url === 'https://example.com/')).toMatchObject({ status: null, failure: BLOCKED_NAVIGATION_FAILURE });

    const pricing = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Pricing', nth: 0 } }));
    expect(pricing.performed).toBe(false);
    expect(pricing.navigated).toBe(false);
    expect(pricing.blockedNavigation).toBe(`${fixture.url}pricing.html`);
    expect(session.currentUrl()).toBe(`${fixture.url}features.html`);
    expect(unwrap(await session.capture()).title).toBe('Lumen — Features');
  });

  it('follows a same-origin link to the pricing page and reads the billing toggle state', async () => {
    unwrap(await session.navigate(`${fixture.url}features.html`));
    const outcome = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Compare plans' }, allowNavigation: 'same-origin' }));
    expect(outcome).toMatchObject({ performed: true, navigated: true, url: `${fixture.url}pricing.html` });
    const pricing = unwrap(await session.capture());
    expect(pricing.title).toBe('Lumen — Pricing');
    const toggle = pricing.nodes.find((node) => node.attrs.id === 'billing');
    expect(toggle?.a11y.pressed).toBe(false);
    expect(toggle?.form).toEqual({ valid: null, validationMessage: null, required: false, type: 'button', hasValue: false });
  });
});

describe('click with allowNavigation and robots.txt', () => {
  it('follows allowed pages, blocks disallowed ones with the rule, and never contacts another origin', async () => {
    unwrap(await session.navigate(siteRobots.url));
    const marker = session.markNetwork();
    const denied = unwrap(await session.act({ kind: 'click', target: { selector: '#private' }, allowNavigation: 'same-origin' }));
    expect(denied.performed).toBe(false);
    expect(denied.navigated).toBe(false);
    expect(denied.blockedNavigation).toBe(`${siteRobots.url}private/index.html`);
    expect(denied.reason).toContain('robots.txt');
    expect(denied.reason).toContain('Disallow: /private/');
    expect(session.currentUrl()).toBe(siteRobots.url);
    const entry = session.networkSince(marker).find((candidate) => candidate.url === `${siteRobots.url}private/index.html`);
    expect(entry?.failure).toContain(ROBOTS_BLOCKED_NAVIGATION_FAILURE);
    expect(entry?.status).toBeNull();

    const away = unwrap(await session.act({ kind: 'click', target: { selector: '#away' }, allowNavigation: 'same-origin' }));
    expect(away.performed).toBe(false);
    expect(away.blockedNavigation).toBe(other.url);
    expect(other.hits()).toBe(0);

    const allowed = unwrap(await session.act({ kind: 'click', target: { selector: '#public' }, allowNavigation: 'same-origin' }));
    expect(allowed).toMatchObject({ performed: true, navigated: true, url: `${siteRobots.url}public.html` });
    expect(unwrap(await session.capture()).title).toBe('Public');
  });

  it('never follows a same-origin POST form submission, but follows a GET form like a link', async () => {
    unwrap(await session.navigate(siteRobots.url));
    const postsBefore = siteRobots.hits('POST');
    const marker = session.markNetwork();
    const post = unwrap(await session.act({ kind: 'click', target: { selector: '#post-submit' }, allowNavigation: 'same-origin' }));
    expect(post.performed).toBe(false);
    expect(post.navigated).toBe(false);
    expect(post.blockedNavigation).toBe(`${siteRobots.url}api/post`);
    expect(post.reason).toContain('blocked');
    expect(session.currentUrl()).toBe(siteRobots.url);
    expect(siteRobots.hits('POST')).toBe(postsBefore);
    expect(session.networkSince(marker).find((entry) => entry.url === `${siteRobots.url}api/post`)).toMatchObject({ method: 'POST', status: null, failure: BLOCKED_NAVIGATION_FAILURE });
    expect(unwrap(await session.capture()).title).toBe('Robots site');

    const get = unwrap(await session.act({ kind: 'click', target: { selector: '#get-submit' }, allowNavigation: 'same-origin' }));
    expect(get).toMatchObject({ performed: true, navigated: true, url: `${siteRobots.url}public.html?q=1` });
    expect(get.blockedNavigation).toBeUndefined();
    expect(unwrap(await session.capture()).title).toBe('Public');
    expect(siteRobots.hits('POST')).toBe(postsBefore);
  });
});
