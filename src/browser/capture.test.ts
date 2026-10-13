import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { fixedClock } from '../domain/clock.js';
import { sha256 } from '../domain/digest.js';
import { unwrap } from '../domain/result.js';
import { capturePage, collectAx } from './capture.js';
import { attachBackendIds, collectViaEvaluate, collectViaSnapshot } from './dom-tree.js';
import { buildState } from './nodes.js';
import { CapturedStateSchema } from './schemas.js';
import { PlaywrightSession } from './session.js';
import { RENDERING_STYLE_PROPERTIES } from './style-properties.js';
import { DESKTOP, makeTempDir, PHONE, serveFixtureA, type TempDir } from './test-helpers.js';
import type { CapturedState, UiNode } from './types.js';

const CAPTURED_AT = '2026-10-13T17:29:00.000Z';

let server: StaticServer;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let session: PlaywrightSession;
let temp: TempDir;
let desktop: CapturedState;
let phone: CapturedState;

beforeAll(async () => {
  server = await serveFixtureA();
  temp = await makeTempDir('uidna-capture-');
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { ...DESKTOP }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page = await context.newPage();
  session = new PlaywrightSession({ browser, page, mode: 'launch', clock: fixedClock(CAPTURED_AT), viewport: { ...DESKTOP }, honorRobots: true, ownsBrowser: true });
  unwrap(await session.navigate(server.url));
  desktop = unwrap(
    await session.capture({ screenshotPath: join(temp.path, 'desktop.png'), assetDir: join(temp.path, 'scan_x', 'assets') }),
    'desktop capture',
  );
  unwrap(await session.setViewport({ ...PHONE }));
  phone = unwrap(await session.capture({ screenshotPath: join(temp.path, 'phone.png') }), 'phone capture');
});

afterAll(async () => {
  await session.close();
  await server.close();
  await temp.cleanup();
});

function nodeByTag(state: CapturedState, tag: string): UiNode {
  const node = state.nodes.find((candidate) => candidate.tag === tag);
  if (!node) throw new Error(`no <${tag}> node`);
  return node;
}

describe('capture of Fixture A', () => {
  it('starts with <body>, has more than 50 nodes and validates against the schema', () => {
    for (const state of [desktop, phone]) {
      expect(state.nodes[0]?.tag).toBe('body');
      expect(state.nodes[0]?.id).toBe('n0');
      expect(state.nodes[0]?.path).toBe('');
      expect(state.nodes.length).toBeGreaterThan(50);
      expect(CapturedStateSchema.safeParse(state).success).toBe(true);
      expect(state.capturedAt).toBe(CAPTURED_AT);
      expect(state.limitations).toEqual([]);
    }
    expect(desktop.viewport).toEqual(DESKTOP);
    expect(phone.viewport).toEqual(PHONE);
    expect(desktop.title).toBe('Lumen — Notes that think with you');
    expect(desktop.nodes.map((node) => node.id)).toEqual(desktop.nodes.map((_, i) => `n${i}`));
  });

  it('describes the hamburger button: visible and expanded=false at 390, display:none at 1280', () => {
    const phoneButton = nodeByTag(phone, 'button');
    expect(phoneButton.role).toBe('button');
    expect(phoneButton.name).toBe('Open menu');
    expect(phoneButton.a11y.expanded).toBe(false);
    expect(phoneButton.a11y.nth).toBe(0);
    expect(phoneButton.interactive).toBe(true);
    expect(phoneButton.visible).toBe(true);
    expect(phoneButton.box?.width).toBe(40);
    expect(phoneButton.attrs).toMatchObject({ 'aria-expanded': 'false', 'aria-controls': 'primary-menu', class: 'nav-toggle' });

    const desktopButton = nodeByTag(desktop, 'button');
    expect(desktopButton.box).toBeNull();
    expect(desktopButton.visible).toBe(false);
    expect(desktopButton.interactive).toBe(true);
    // Not rendered: Chrome's AX tree omits it, so role/name are unknown rather than guessed.
    expect(desktopButton.role).toBeNull();
    expect(desktop.styles[desktopButton.styleId]?.display).toBe('none');
    expect(phone.styles[phoneButton.styleId]?.display).toBe('flex');
  });

  it('gives <summary> no role (Playwright assigns none) but keeps its name, expanded state and interactivity', async () => {
    const summaries = phone.nodes.filter((node) => node.tag === 'summary');
    expect(summaries).toHaveLength(3);
    const first = summaries[0];
    if (!first) throw new Error('unreachable');
    expect(first.role).toBeNull();
    expect(first.name).toBe('Is there a free plan? +');
    expect(first.text).toBe('Is there a free plan?');
    expect(first.a11y.expanded).toBe(false);
    expect(first.interactive).toBe(true);
    expect(first.pseudo?.after).toEqual({ content: '+', styleId: expect.any(String) });
    expect(phone.styles[first.pseudo?.after?.styleId ?? '']).toBeDefined();
    const details = phone.nodes.find((node) => node.id === first.parentId);
    expect(details?.tag).toBe('details');
    expect(details?.role).toBe('group');
    // Verified rather than guessed: Playwright 1.64 cannot locate a <summary> by role under any role.
    expect(await page.getByRole('button', { name: 'Is there a free plan? +', exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Is there a free plan?' }).count()).toBe(0);
    expect(await page.getByRole('group').count()).toBe(3);
    expect(await page.locator('summary').first().evaluate((el) => el.textContent?.trim())).toBe('Is there a free plan?');
  });

  it('deduplicates styles and every style id resolves', () => {
    for (const state of [desktop, phone]) {
      expect(Object.keys(state.styles).length).toBeLessThan(state.nodes.length);
      for (const node of state.nodes) {
        expect(state.styles[node.styleId]).toBeDefined();
        if (node.pseudo?.before) expect(state.styles[node.pseudo.before.styleId]).toBeDefined();
        if (node.pseudo?.after) expect(state.styles[node.pseudo.after.styleId]).toBeDefined();
      }
      // Defaults are dropped: no stored style carries the UA default for position.
      for (const style of Object.values(state.styles)) expect(style.position).not.toBe('static');
    }
  });

  it('resolves every node path back to the same element', async () => {
    const tags = await page.evaluate((paths: string[]) =>
      paths.map((path) => {
        let el: Element | null = document.body;
        if (path !== '') {
          for (const part of path.split('/')) {
            if (el === null) return null;
            el = el.children[Number(part)] ?? null;
          }
        }
        return el?.tagName.toLowerCase() ?? null;
      }),
      phone.nodes.map((node) => node.path),
    );
    expect(tags).toEqual(phone.nodes.map((node) => node.tag));
    for (const node of phone.nodes) {
      for (const childId of node.childIds) expect(phone.nodes.find((child) => child.id === childId)?.parentId).toBe(node.id);
    }
  });

  it('writes a full-page screenshot with real dimensions and digest', async () => {
    for (const [state, width] of [
      [desktop, DESKTOP.width],
      [phone, PHONE.width],
    ] as const) {
      const shot = state.screenshot;
      if (!shot) throw new Error('no screenshot');
      const bytes = await readFile(shot.path);
      expect(shot.width).toBe(width);
      expect(shot.height).toBe(state.document.height);
      expect(shot.digest).toBe(sha256(bytes));
      expect(shot.truncated).toBe(false);
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    }
  });

  it('drops unrendered subtrees when includeHiddenNodes is false', async () => {
    unwrap(await session.setViewport({ ...DESKTOP }));
    try {
      const visibleOnly = unwrap(await session.capture({ includeHiddenNodes: false }));
      expect(visibleOnly.nodes.length).toBeLessThan(desktop.nodes.length);
      expect(visibleOnly.nodes.find((node) => node.tag === 'button')).toBeUndefined();
      expect(visibleOnly.nodes.every((node) => node.box !== null)).toBe(true);
      expect(visibleOnly.nodes.map((node) => node.id)).toEqual(visibleOnly.nodes.map((_, i) => `n${i}`));
    } finally {
      unwrap(await session.setViewport({ ...PHONE }));
    }
  });

  it('truncates the screenshot at maxHeight and says so', async () => {
    const truncated = unwrap(await session.capture({ screenshotPath: join(temp.path, 'short.png'), maxHeight: 600 }));
    expect(truncated.screenshot?.truncated).toBe(true);
    expect(truncated.screenshot?.height).toBe(600);
    expect(truncated.limitations.some((text) => text.includes('Content below 600px was not captured'))).toBe(true);
  });

  it('lists the illustration as a same-origin svg asset and stores a local copy when assetDir is given', async () => {
    const asset = desktop.assets.find((candidate) => candidate.url.endsWith('/assets/illustration.svg'));
    if (!asset) throw new Error('illustration.svg not found in assets');
    expect(asset.origin).toBe('same-origin');
    expect(asset.kind).toBe('svg');
    expect(asset.mime).toBe('image/svg+xml');
    expect(asset.usedBy).toEqual([nodeByTag(desktop, 'img').id]);
    expect(asset.localPath).toMatch(/^assets\/[0-9a-f]{12}\.svg$/);
    const stored = join(temp.path, 'scan_x', ...(asset.localPath ?? '').split('/'));
    const bytes = await readFile(stored);
    expect((await stat(stored)).size).toBe(asset.bytes);
    expect(sha256(bytes)).toBe(asset.digest);
    expect(asset.width).toBeGreaterThan(0);
    expect(asset.height).toBeGreaterThan(0);
    // Without assetDir nothing is stored.
    expect(phone.assets.find((candidate) => candidate.url.endsWith('illustration.svg'))?.localPath).toBeUndefined();
  });

  it('reports the fonts that rendered text', () => {
    expect(desktop.fonts.length).toBeGreaterThan(0);
    for (const font of desktop.fonts) {
      expect(font.family).not.toBe('');
      expect(font.status).toBe('loaded');
      expect(['local', 'url', 'data']).toContain(font.source);
    }
  });

  it('records the network ledger with status 200 entries and no secrets', () => {
    const urls = desktop.network.map((entry) => entry.url);
    for (const suffix of ['/', '/styles.css', '/app.js', '/assets/illustration.svg']) {
      const entry = desktop.network.find((candidate) => candidate.url === `${server.url.replace(/\/$/, '')}${suffix}`);
      expect(entry, suffix).toBeDefined();
      expect(entry?.status).toBe(200);
      expect(entry?.method).toBe('GET');
      expect(entry?.bytes).toBeGreaterThan(0);
      expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry?.failure).toBeUndefined();
    }
    expect(urls.some((url) => /[?&](token|key|secret)=/.test(url))).toBe(false);
    for (const entry of desktop.network) expect(Object.keys(entry)).not.toContain('headers');
  });

  it('builds a role tree with the landmarks Chrome exposes and stable digests', () => {
    const roles = desktop.roleTree.map((entry) => entry.role);
    // Observed on Chromium 156 for Fixture A: header -> banner, nav -> navigation, main, labelled sections -> region, footer -> contentinfo.
    for (const landmark of ['banner', 'navigation', 'main', 'region', 'contentinfo']) expect(roles).toContain(landmark);
    expect(roles.filter((role) => role === 'region')).toHaveLength(3);
    expect(desktop.roleTree.find((entry) => entry.role === 'navigation')?.name).toBe('Primary');
    expect(desktop.roleTree.find((entry) => entry.role === 'heading')?.states).toEqual({ level: 1 });
    expect(desktop.roleTree.find((entry) => entry.role === 'img')?.name).toBe('Abstract illustration of connected notes');
    expect(desktop.roleTree.every((entry) => entry.nodeId !== null)).toBe(true);
    expect(desktop.roleTreeDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(desktop.domDigest).toMatch(/^[0-9a-f]{12}$/);
    // The hidden phone menu changes the role tree but not the DOM.
    expect(desktop.domDigest).toBe(phone.domDigest);
    expect(desktop.roleTreeDigest).not.toBe(phone.roleTreeDigest);
    // nth: the nav "Features" link precedes the footer "Features" link at 1280.
    const features = desktop.nodes.filter((node) => node.role === 'link' && node.name === 'Features');
    expect(features.map((node) => node.a11y.nth)).toEqual([0, 1]);
  });

  it('marks interactive and in-form nodes and keeps text/attrs normalized', () => {
    const links = desktop.nodes.filter((node) => node.tag === 'a');
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect(link.interactive).toBe(true);
    expect(desktop.nodes.every((node) => !node.inForm)).toBe(true);
    const heading = nodeByTag(desktop, 'h1');
    expect(heading.text).toBe('Notes that think with you');
    expect(heading.role).toBe('heading');
    expect(heading.a11y.level).toBe(1);
    const hidden = desktop.nodes.find((node) => node.attrs['aria-hidden'] === 'true');
    expect(hidden?.role).toBeNull();
    expect(desktop.document.height).toBeGreaterThan(DESKTOP.height);
    expect(desktop.document.width).toBe(DESKTOP.width);
  });
});

describe('fallback in-page walk', () => {
  let cdp: CDPSession;

  beforeAll(async () => {
    cdp = await context.newCDPSession(page);
  });

  afterAll(async () => {
    await cdp.detach();
  });

  it('produces the same nodes and digests as DOMSnapshot', async () => {
    const limitations: string[] = [];
    const viaSnapshot = unwrap(await collectViaSnapshot(cdp, { styleProperties: RENDERING_STYLE_PROPERTIES }));
    const walked = unwrap(await collectViaEvaluate(page, { styleProperties: RENDERING_STYLE_PROPERTIES }));
    expect(walked.limitations[0]).toContain('DOMSnapshot was unavailable');
    const viaEvaluate = await attachBackendIds(cdp, walked);
    expect(viaEvaluate.elements.every((element) => element.backendNodeId !== null)).toBe(true);
    const ax = await collectAx(cdp, limitations);
    expect(limitations).toEqual([]);
    const a = buildState(viaSnapshot, ax);
    const b = buildState(viaEvaluate, ax);
    expect(b.nodes.map((node) => [node.id, node.path, node.tag, node.text, node.role, node.name])).toEqual(
      a.nodes.map((node) => [node.id, node.path, node.tag, node.text, node.role, node.name]),
    );
    expect(b.domDigest).toBe(a.domDigest);
    expect(b.roleTreeDigest).toBe(a.roleTreeDigest);
    for (let i = 0; i < a.nodes.length; i += 1) {
      const boxA = a.nodes[i]?.box;
      const boxB = b.nodes[i]?.box;
      if (boxA === null || boxA === undefined || boxB === null || boxB === undefined) {
        expect(boxB ?? null).toEqual(boxA ?? null);
        continue;
      }
      expect(Math.abs(boxA.x - boxB.x)).toBeLessThan(1);
      expect(Math.abs(boxA.y - boxB.y)).toBeLessThan(1);
      expect(Math.abs(boxA.width - boxB.width)).toBeLessThan(1);
      expect(Math.abs(boxA.height - boxB.height)).toBeLessThan(1);
      expect(b.styles[b.nodes[i]?.styleId ?? '']?.display).toBe(a.styles[a.nodes[i]?.styleId ?? '']?.display);
    }
  });

  it('keeps accessibility roles when DOMSnapshot fails and the CDP session is replaced mid-capture', async () => {
    // Failure injected at the CDP boundary of a real session: the first `DOMSnapshot.captureSnapshot` rejects.
    let failures = 0;
    const flaky = (session: CDPSession): CDPSession =>
      new Proxy(session, {
        get(target, property, receiver) {
          if (property === 'send') {
            return (method: string, params?: unknown): Promise<unknown> => {
              if (method === 'DOMSnapshot.captureSnapshot') {
                failures += 1;
                return Promise.reject(new Error('injected DOMSnapshot failure'));
              }
              return target.send(method as never, params as never);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    const holder: { current: CDPSession | null } = { current: null };
    const cdpFactory = async (reset?: boolean): Promise<CDPSession | null> => {
      if (reset && holder.current) {
        await holder.current.detach();
        holder.current = null;
      }
      if (!holder.current) {
        const fresh = await context.newCDPSession(page);
        holder.current = failures === 0 ? flaky(fresh) : fresh;
      }
      return holder.current;
    };
    try {
      const state = unwrap(await capturePage({ page, cdp: cdpFactory, clock: fixedClock(CAPTURED_AT), viewport: { ...PHONE }, network: [] }));
      expect(failures).toBe(1);
      expect(state.limitations).toContainEqual(expect.stringContaining('falling back to the in-page walk'));
      expect(state.limitations.some((text) => text.includes('Accessibility tree unavailable'))).toBe(false);
      expect(state.nodes.find((node) => node.tag === 'button')?.role).toBe('button');
      expect(state.roleTree.length).toBeGreaterThan(5);
      expect(state.fonts.length).toBeGreaterThan(0);
      expect(state.domDigest).toBe(phone.domDigest);
      expect(state.roleTreeDigest).toBe(phone.roleTreeDigest);
    } finally {
      await holder.current?.detach().catch(() => undefined);
    }
  });
});
