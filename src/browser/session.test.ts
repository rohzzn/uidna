import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { unwrap } from '../domain/result.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { BLOCKED_NAVIGATION_FAILURE, NETWORK_INCOMPLETE_LIMITATION } from './session.js';
import { MAX_TEXT_LENGTH } from './style-properties.js';
import { makeTempDir, PHONE, serveCounting, serveDir, serveFixtureA, writeSite, type CountingServer, type TempDir } from './test-helpers.js';
import type { BrowserSession, CapturedState, UiNode } from './types.js';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PIC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#2f5bea"/></svg>';

let fixture: StaticServer;
let siteA: StaticServer;
let siteB: CountingServer;
let temp: TempDir;
let session: BrowserSession;

beforeAll(async () => {
  fixture = await serveFixtureA();
  temp = await makeTempDir('uidna-session-');
  siteB = await serveCounting('<!doctype html><html><head><title>Other</title></head><body><h1>Other origin</h1></body></html>');
  await writeSite(temp.path, {
    'a/robots.txt': 'User-agent: uidna\nDisallow: /private/\n',
    'a/private/index.html': '<!doctype html><html><head><title>Private</title></head><body><p>private</p></body></html>',
    'a/b.html': '<!doctype html><html><head><title>Page B</title></head><body><h1>Page B</h1><a id="back" href="index.html">Back</a></body></html>',
    'a/pic.svg': PIC_SVG,
    'a/index.html': `<!doctype html><html><head><title>Site A</title></head><body>
      <h1>Site A</h1>
      <a href="${siteB.url}">Other site</a>
      <a href="${siteB.url}" target="_blank">Popup site</a>
      <a href="b.html" target="_blank">Popup B</a>
      <a href="#local">Local anchor</a>
      <a id="tob" href="b.html">Page B</a>
      <a id="docs" href="/docs?page=1&token=abc">Docs</a>
      <button type="button" onclick="alert('hello from A')">Alert</button>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-label="dot" role="img"><circle cx="6" cy="6" r="5"></circle></svg>
      <div id="bg" style="width:20px;height:20px;background-image:url('${TINY_PNG}')"></div>
      <img src="pic.svg?signature=zzz" alt="Signed picture" width="10" height="10">
      <form action="/submit"><input name="q" placeholder="Search"><input type="password" name="pw" value="s3cret"><input type="hidden" name="csrf" value="tok123"></form>
      <p id="long">${'x'.repeat(MAX_TEXT_LENGTH + 500)}</p>
      <iframe title="Embedded" srcdoc="&lt;p id=inner&gt;inside the frame&lt;/p&gt;"></iframe>
    </body></html>`,
  });
  siteA = await serveDir(`${temp.path}/a`);
  session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...PHONE } }), 'launch');
});

afterAll(async () => {
  await session.close();
  await siteA.close();
  await siteB.close();
  await fixture.close();
  await temp.cleanup();
});

function findNode(state: CapturedState, predicate: (node: UiNode) => boolean): UiNode {
  const node = state.nodes.find(predicate);
  if (!node) throw new Error('node not found');
  return node;
}

describe('session on Fixture A at 390px', () => {
  it('reports launch mode, viewport and navigation outcome', async () => {
    expect(session.mode).toBe('launch');
    expect(session.id).toMatch(/^sess_[0-9a-f]{8}$/);
    const nav = unwrap(await session.navigate(fixture.url));
    expect(nav).toEqual({ url: fixture.url, status: 200, redirected: false });
    expect(session.currentUrl()).toBe(fixture.url);
    expect(session.viewport()).toEqual(PHONE);
  });

  it('snapshot digests equal capture digests on an unchanged page', async () => {
    const capture = unwrap(await session.capture());
    const snapshot = unwrap(await session.snapshot());
    expect(snapshot.domDigest).toBe(capture.domDigest);
    expect(snapshot.roleTreeDigest).toBe(capture.roleTreeDigest);
    expect(snapshot.nodeCount).toBe(capture.nodes.length);
    expect(snapshot.url).toBe(capture.url);
  });

  it('is stable on a static page well within the timeout', async () => {
    const outcome = unwrap(await session.waitForStability({ timeoutMs: 5000, quietMs: 300 }));
    expect(outcome.stable).toBe(true);
    expect(outcome.waitedMs).toBeLessThan(5000);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(300);
    expect(outcome.pendingRequests).toBe(0);
  });

  it('clicks the hamburger by node id, exposes the menu, and Escape restores the digests', async () => {
    const base = unwrap(await session.capture());
    const button = findNode(base, (node) => node.tag === 'button');
    expect(button.a11y.expanded).toBe(false);
    const menu = findNode(base, (node) => node.attrs.id === 'primary-menu');
    expect(menu.visible).toBe(false);

    const click = unwrap(await session.act({ kind: 'click', target: { nodeId: button.id } }));
    expect(click).toMatchObject({ performed: true, navigated: false, url: fixture.url, dialogs: [] });
    expect(click.durationMs).toBeGreaterThanOrEqual(0);
    const after = unwrap(await session.snapshot());
    expect(after.roleTreeDigest).not.toBe(base.roleTreeDigest);
    expect(after.domDigest).not.toBe(base.domDigest);

    const opened = unwrap(await session.capture());
    const openedButton = findNode(opened, (node) => node.id === button.id);
    expect(openedButton.attrs['aria-expanded']).toBe('true');
    expect(openedButton.a11y.expanded).toBe(true);
    expect(openedButton.name).toBe('Close menu');
    const openedMenu = findNode(opened, (node) => node.id === menu.id);
    expect(openedMenu.visible).toBe(true);
    expect(openedMenu.box?.height).toBeGreaterThan(0);
    expect(opened.roleTree.filter((entry) => entry.role === 'link').map((entry) => entry.name)).toContain('Pricing');

    const escape = unwrap(await session.act({ kind: 'key', key: 'Escape' }));
    expect(escape.performed).toBe(true);
    const restored = unwrap(await session.snapshot());
    expect(restored.roleTreeDigest).toBe(base.roleTreeDigest);
    expect(restored.domDigest).toBe(base.domDigest);
  });

  it('hovers and focuses by node path and by role+name, and acts by selector', async () => {
    const state = unwrap(await session.capture());
    const hiddenNavLink = findNode(state, (node) => node.tag === 'a' && node.attrs.class === 'nav-link' && node.attrs.href === '#features');
    expect(hiddenNavLink.visible).toBe(false);
    const hidden = unwrap(await session.act({ kind: 'hover', target: { nodePath: hiddenNavLink.path } }));
    expect(hidden.performed).toBe(false); // display:none at 390: Playwright refuses to hover it
    expect(hidden.reason).toBeTruthy();
    const footerLink = findNode(state, (node) => node.role === 'link' && node.name === 'Features');
    expect(unwrap(await session.act({ kind: 'hover', target: { nodeId: footerLink.id } })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'hover', target: { role: 'link', name: 'Start writing' } })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'focus', target: { role: 'link', name: 'See how it works', nth: 0 } })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'blur' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'reset-pointer' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'scroll', y: 400 })).performed).toBe(true);
    const missing = unwrap(await session.act({ kind: 'click', target: { role: 'button', name: 'Does not exist' } }));
    expect(missing.performed).toBe(false);
    expect(missing.reason).toContain('Does not exist');
    const unknownId = unwrap(await session.act({ kind: 'click', target: { nodeId: 'n99999' } }));
    expect(unknownId.performed).toBe(false);
    expect(unknownId.reason).toContain('n99999');
    expect(unwrap(await session.act({ kind: 'focus', target: { selector: 'summary' } })).performed).toBe(true);
    const badSelector = unwrap(await session.act({ kind: 'focus', target: { selector: 'css=[' } }));
    expect(badSelector.performed).toBe(false);
    expect(badSelector.reason).toContain('invalid');
  });

  it('reports same-origin hash navigation and keeps the page', async () => {
    const outcome = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Start writing' } }));
    expect(outcome.performed).toBe(true);
    expect(outcome.navigated).toBe(true);
    expect(outcome.url).toBe(`${fixture.url}#start`);
  });

  it('stabilize does not change the captured DOM', async () => {
    const before = unwrap(await session.snapshot());
    unwrap(await session.stabilize());
    const after = unwrap(await session.snapshot());
    expect(after.domDigest).toBe(before.domDigest);
  });

  it('slices the network ledger with markers', async () => {
    const marker = session.markNetwork();
    expect(session.networkSince(marker)).toEqual([]);
    unwrap(await session.reload());
    const since = session.networkSince(marker);
    expect(since.length).toBeGreaterThanOrEqual(3);
    expect(since.every((entry) => entry.status === 200)).toBe(true);
    expect(session.networkSince().length).toBeGreaterThan(since.length);
  });
});

describe('session on generated sites', () => {
  it('blocks a cross-origin click before any request reaches the other origin', async () => {
    unwrap(await session.navigate(siteA.url));
    const marker = session.markNetwork();
    const outcome = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Other site' } }));
    expect(outcome.performed).toBe(false);
    expect(outcome.navigated).toBe(false);
    expect(outcome.reason).toContain(siteB.url);
    expect(outcome.reason).toContain('blocked');
    expect(outcome.url).toBe(siteA.url);
    expect(session.currentUrl()).toBe(siteA.url);
    expect(siteB.hits()).toBe(0);
    // The ledger records the attempt as a failure, never as a response from the other origin.
    const entry = session.networkSince(marker).find((candidate) => candidate.url === siteB.url);
    expect(entry).toMatchObject({ status: null, failure: BLOCKED_NAVIGATION_FAILURE });
    // The page is intact: the same link is still there and usable.
    expect(unwrap(await session.act({ kind: 'hover', target: { role: 'link', name: 'Other site' } })).performed).toBe(true);
  });

  it('stops a cross-origin popup before its origin is contacted, and closes same-origin popups', async () => {
    unwrap(await session.navigate(siteA.url));
    const crossOrigin = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Popup site' } }));
    expect(crossOrigin.performed).toBe(false);
    expect(crossOrigin.navigated).toBe(false);
    expect(crossOrigin.reason).toContain(siteB.url);
    expect(crossOrigin.reason).toContain('blocked');
    expect(session.currentUrl()).toBe(siteA.url);
    expect(siteB.hits()).toBe(0);

    const sameOrigin = unwrap(await session.act({ kind: 'click', target: { role: 'link', name: 'Popup B' } }));
    expect(sameOrigin.performed).toBe(false);
    expect(sameOrigin.navigated).toBe(false);
    expect(sameOrigin.reason).toContain('new page');
    expect(session.currentUrl()).toBe(siteA.url);
    // The session page still works afterwards.
    expect(unwrap(await session.snapshot()).nodeCount).toBeGreaterThan(5);
  });

  it('blocks a same-origin link click, scopes the capture network to a navigated document, and refuses stale node ids', async () => {
    unwrap(await session.navigate(siteA.url));
    const before = unwrap(await session.capture());
    const link = findNode(before, (node) => node.attrs.id === 'tob');
    expect(before.network.map((entry) => entry.url)).toContain(siteA.url);

    // Phase 1 never leaves the document through an action: same-origin navigations are blocked too.
    const outcome = unwrap(await session.act({ kind: 'click', target: { nodeId: link.id } }));
    expect(outcome.performed).toBe(false);
    expect(outcome.navigated).toBe(false);
    expect(outcome.blockedNavigation).toBe(`${siteA.url}b.html`);
    expect(session.currentUrl()).toBe(siteA.url);

    unwrap(await session.navigate(`${siteA.url}b.html`));
    const stale = unwrap(await session.act({ kind: 'click', target: { nodeId: link.id } }));
    expect(stale.performed).toBe(false);
    expect(stale.reason).toContain('previous document');

    const after = unwrap(await session.capture());
    expect(after.title).toBe('Page B');
    expect(after.network.map((entry) => entry.url)).toEqual([`${siteA.url}b.html`]);
    expect(after.limitations).not.toContain(NETWORK_INCOMPLETE_LIMITATION);
    expect(session.networkSince().some((entry) => entry.url === siteA.url)).toBe(true);
    // Node ids of the fresh capture work again.
    expect(unwrap(await session.act({ kind: 'hover', target: { nodeId: findNode(after, (node) => node.attrs.id === 'back').id } })).performed).toBe(true);

    unwrap(await session.navigate(siteA.url));
    const navigated = unwrap(await session.capture());
    expect(navigated.network.map((entry) => entry.url)).not.toContain(`${siteA.url}b.html`);
  });

  it('auto-dismisses dialogs and reports them', async () => {
    unwrap(await session.navigate(siteA.url));
    const outcome = unwrap(await session.act({ kind: 'click', target: { role: 'button', name: 'Alert' } }));
    expect(outcome.performed).toBe(true);
    expect(outcome.dialogs).toEqual(['alert: hello from A']);
    expect(outcome.navigated).toBe(false);
  });

  it('captures inline svg, data-URL backgrounds, forms and never stores password values', async () => {
    unwrap(await session.navigate(siteA.url));
    const state = unwrap(await session.capture());
    const svg = findNode(state, (node) => node.tag === 'svg');
    expect(state.assets).toContainEqual(expect.objectContaining({ kind: 'svg', origin: 'inline', url: `inline:${svg.id}`, usedBy: [svg.id] }));
    expect(state.assets).toContainEqual(expect.objectContaining({ kind: 'image', origin: 'data', url: TINY_PNG }));
    expect(state.assets.find((asset) => asset.url === siteB.url)).toBeUndefined();
    const query = findNode(state, (node) => node.attrs.name === 'q');
    expect(query.inForm).toBe(true);
    expect(query.interactive).toBe(true);
    expect(query.role).toBe('textbox');
    const password = findNode(state, (node) => node.attrs.name === 'pw');
    expect(password.attrs.value).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('s3cret');
    expect(findNode(state, (node) => node.tag === 'form').inForm).toBe(false);
    // The iframe element is captured; its document is not entered and that is said in plain words.
    expect(findNode(state, (node) => node.tag === 'iframe').attrs.title).toBe('Embedded');
    expect(state.nodes.find((node) => node.attrs.id === 'inner')).toBeUndefined();
    expect(state.limitations).toContainEqual(expect.stringContaining('1 iframe(s) were not entered'));
  });

  it('never stores hidden-input values, redacts URL attributes and asset URLs, and reports clipped text', async () => {
    unwrap(await session.navigate(siteA.url));
    const state = unwrap(await session.capture({ assetDir: join(temp.path, 'scan_a', 'assets') }));
    expect(findNode(state, (node) => node.attrs.name === 'csrf').attrs.value).toBeUndefined();
    expect(findNode(state, (node) => node.attrs.id === 'docs').attrs.href).toBe('/docs?page=1&token=[redacted]');
    const pic = state.assets.find((asset) => asset.url.includes('pic.svg'));
    expect(pic?.url).toBe(`${siteA.url}pic.svg?signature=[redacted]`);
    expect(pic?.kind).toBe('svg');
    expect(pic?.mime).toBe('image/svg+xml');
    // Fetched and stored with the real URL, reported with the redacted one.
    expect(pic?.localPath).toMatch(/^assets\/[0-9a-f]{12}\.svg$/);
    expect(pic?.bytes).toBe(Buffer.byteLength(PIC_SVG));
    const json = JSON.stringify(state);
    for (const secret of ['tok123', 'token=abc', 'signature=zzz']) expect(json).not.toContain(secret);
    expect(findNode(state, (node) => node.attrs.id === 'long').text?.length).toBe(MAX_TEXT_LENGTH);
    expect(state.limitations).toContain(`1 text node(s) were clipped to ${MAX_TEXT_LENGTH} characters.`);
  });

  it('honors robots.txt in launch mode and reports the matched rule', async () => {
    const denied = await session.navigate(`${siteA.url}private/`);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error._tag).toBe('policy');
      expect(denied.error.message).toContain('Disallow: /private/');
    }
    expect(session.currentUrl()).toBe(siteA.url);
    const permissive = unwrap(await createPlaywrightProvider().launch({ honorRobots: false, viewport: { ...PHONE } }));
    try {
      const allowed = unwrap(await permissive.navigate(`${siteA.url}private/`));
      expect(allowed.status).toBe(200);
    } finally {
      await permissive.close();
    }
  });

  it('rejects unsupported schemes and invalid URLs without throwing', async () => {
    const bad = await session.navigate('javascript:alert(1)');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error._tag).toBe('validation');
    const invalid = await session.navigate('not a url');
    expect(invalid.ok).toBe(false);
  });
});
