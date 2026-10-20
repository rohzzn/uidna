/**
 * Side effects the safe policy observes are attributed to the action that
 * caused them and never repeated at the other viewport, even when the action
 * is not recorded as a transition:
 *
 * - a click that POSTs, then opens a popup UI DNA closes (not performed);
 * - a click on a disclosure trigger whose Escape revert POSTs;
 * - a focus whose blur revert POSTs;
 * - the page-level Tab key, whose keydown handler POSTs (no target node);
 * - a link to a crawled page that has no base state capture at the width,
 *   whose click POSTs on the way.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UiNode } from 'uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { scanInterface } from '../application/scan.js';
import { createPlaywrightProvider } from '../browser/index.js';
import type { CapturedState } from '../browser/types.js';
import { BudgetTracker, resolveBudget } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { exploreInteractions, type ExploreOutcome } from './explorer.js';
import { NAVIGATION_SKIPPED_EARLIER } from './navigation.js';
import { effectKey, keyPressEffectKey } from './run.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Attribution</title>
<style>body{font-family:sans-serif;margin:24px}button,a,input,p{display:block;margin:8px 0}[hidden]{display:none}</style></head>
<body>
<h1>Attribution</h1>
<button type="button" id="report">Open report</button>
<button type="button" id="menu" aria-expanded="false" aria-controls="menu-panel">Menu</button>
<div id="menu-panel" hidden><p>Menu content</p></div>
<input id="note" type="text" aria-label="Note">
<a id="other" href="/other.html">Other page</a>
<p id="status">idle</p>
<script>
const post = (path) => { fetch(path, { method: 'POST', body: 'x' }).catch(() => {}); };
const menu = document.getElementById('menu');
const panel = document.getElementById('menu-panel');
document.getElementById('report').addEventListener('click', () => { post('/api/report'); window.open('/report.html', '_blank'); });
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') === 'true';
  menu.setAttribute('aria-expanded', open ? 'false' : 'true');
  panel.hidden = open;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    menu.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    post('/api/menu-closed');
  }
  if (e.key === 'Tab') post('/api/tab');
});
document.getElementById('note').addEventListener('blur', () => post('/api/note'));
document.getElementById('other').addEventListener('click', () => post('/api/link'));
</script></body></html>`;

const OTHER = '<!doctype html><html><head><meta charset="utf-8"><title>Other</title></head><body><h1>Other page</h1></body></html>';

describe('safe policy: side effects are attributed to their action and never repeated', () => {
  let server: Server;
  let origin = '';
  const posts = new Map<string, number>();
  let root = '';
  let ctx: WorkflowContext;
  let scan: ScanRecord;
  let base: CapturedState;
  let outcome: ExploreOutcome;
  let first = '';
  let second = '';

  const pathOf = (id: string): string => {
    const node: UiNode | undefined = base.nodes.find((candidate) => candidate.attrs.id === id);
    if (!node) throw new Error(`no node with id ${id}`);
    return node.path;
  };
  const attemptsOn = (stateId: string, path: string) => outcome.record.attempted.filter((a) => a.stateId === stateId && a.action.target?.nodePath === path);
  const skippedOn = (stateId: string, path: string) => outcome.record.skipped.filter((s) => s.stateId === stateId && s.nodePath === path).map((s) => s.reason);

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== 'GET') {
        const path = req.url ?? '';
        posts.set(path, (posts.get(path) ?? 0) + 1);
        res.writeHead(204);
        res.end();
        return;
      }
      const send = (): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.url === '/other.html' || req.url === '/report.html' ? OTHER : PAGE);
      };
      // The link's POST completes before its navigation commits: a request the navigation cancels never settles in
      // the ledger, which would hold every later stability wait to its timeout.
      if (req.url === '/other.html') setTimeout(send, 300);
      else send();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    root = await mkdtemp(join(tmpdir(), 'uidna-attribution-'));
    ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.2.0', cwd: root, outRoot: root });
    const scanned = unwrap(await scanInterface(ctx, { url: `${origin}/`, viewports: [390, 1280] }), 'scan');
    const saved = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
    // The other page counts as crawled, but the crawl captured it at no width: its link is followed, and has no destination state.
    const seed = saved.pages?.[0] ?? { pageId: saved.pageId, url: `${origin}/`, depth: 0, discoveredVia: null, title: 'Attribution' };
    scan = { ...saved, pages: [seed, { pageId: 'pg_02', url: `${origin}/other.html`, depth: 1, discoveredVia: null, title: 'Other' }] };
    const captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
    const bases = scan.states.filter((state) => state.kind === 'base');
    first = bases[0]?.stateId ?? '';
    second = bases[1]?.stateId ?? '';
    const firstCapture = captures.get(first);
    if (!firstCapture) throw new Error('no base capture');
    base = firstCapture;
    const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId }, scanId: scan.scanId });
    outcome = unwrap(await exploreInteractions({ ctx, scan, captures, budget: new BudgetTracker(resolveBudget({ actions: 200 }), ctx.clock), evidenceId: evidence.id }), 'explore');
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('records the click that POSTs and opens a popup as a side effect, though it was not performed', () => {
    const report = pathOf('report');
    const attempts = attemptsOn(first, report).filter((a) => a.action.type === 'click');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('side-effect');
    expect(attempts[0]?.reason).toContain('new page');
    expect(attempts[0]?.reason).toContain('1 non-GET request(s)');
    expect(skippedOn(second, report)).toContain('click: side effect observed earlier');
    // Exploration holds the non-GET guard for the whole run: the request was attempted, blocked, and never reached the server.
    expect(posts.get('/api/report')).toBeUndefined();
  });

  it('attributes the POST of an Escape revert to the disclosure trigger it reverted', () => {
    const menu = pathOf('menu');
    const click = attemptsOn(first, menu).find((a) => a.action.type === 'click');
    expect(click?.outcome).toBe('changed');
    expect(outcome.record.limitations).toContainEqual('reverting click on button "Menu" with Escape caused 1 non-GET request(s); the element will not be acted on again');
    const back = outcome.transitions.find((t) => t.from !== first && t.to === first && t.action.type === 'key' && t.action.target?.nodePath === menu);
    expect(back?.sideEffects).toBe(true);
    expect(attemptsOn(second, menu)).toEqual([]);
    expect(skippedOn(second, menu)).toContain('click: side effect observed earlier');
    // Exploration holds the non-GET guard for the whole run: the request was attempted, blocked, and never reached the server.
    expect(posts.get('/api/menu-closed')).toBeUndefined();
  });

  it('attributes the POST of a blur revert to the focus it reverted', () => {
    const note = pathOf('note');
    expect(attemptsOn(first, note).filter((a) => a.action.type === 'focus')).toHaveLength(1);
    expect(outcome.record.limitations.some((l) => l.startsWith('reverting focus on textbox "Note" with a blur caused 1 non-GET request(s)'))).toBe(true);
    expect(attemptsOn(second, note).filter((a) => a.action.type === 'focus')).toEqual([]);
    expect(skippedOn(second, note)).toContain('focus: side effect observed earlier');
    // Exploration holds the non-GET guard for the whole run: the request was attempted, blocked, and never reached the server.
    expect(posts.get('/api/note')).toBeUndefined();
  });

  it('remembers the page-level Tab key that POSTed, and never presses it again on that page', () => {
    const tabs = outcome.record.attempted.filter((a) => a.action.type === 'key' && a.action.key === 'Tab');
    expect(tabs.map((a) => [a.stateId, a.outcome])).toEqual([[first, 'side-effect']]);
    expect(outcome.record.skipped.filter((s) => s.stateId === second && s.reason.startsWith('key Tab:')).map((s) => s.reason)).toEqual(['key Tab: side effect observed earlier']);
    // Escape caused nothing at the base state and runs at both viewports.
    expect(outcome.record.attempted.filter((a) => a.action.type === 'key' && a.action.key === 'Escape').map((a) => a.stateId)).toEqual([first, second]);
    expect(outcome.record.sideEffectKeys).toContain(keyPressEffectKey(scan.pageId, 'Tab'));
    expect(outcome.record.sideEffectKeys).not.toContain(keyPressEffectKey(scan.pageId, 'Escape'));
    // Exploration holds the non-GET guard for the whole run: the request was attempted, blocked, and never reached the server.
    expect(posts.get('/api/tab')).toBeUndefined();
  });

  it('records a link that POSTs on its way to a crawled page without a base state at the width as a side effect', () => {
    const link = pathOf('other');
    const clicks = attemptsOn(first, link).filter((a) => a.action.type === 'click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.outcome).toBe('side-effect');
    expect(clicks[0]?.reason).toContain('no base state capture');
    expect(clicks[0]?.reason).toContain('1 non-GET request(s)');
    expect(skippedOn(second, link)).toContain(`click: ${NAVIGATION_SKIPPED_EARLIER}`);
    expect(outcome.transitions.some((t) => t.navigation !== undefined && t.navigation !== null)).toBe(false);
  });

  it('persists every key, and reverted the base state after every action', () => {
    expect(outcome.record.sideEffectKeys).toEqual(
      expect.arrayContaining(['report', 'menu', 'note', 'other'].map((id) => effectKey(scan.pageId, pathOf(id))).concat([keyPressEffectKey(scan.pageId, 'Tab')])),
    );
    expect(outcome.record.limitations.filter((l) => /could not restore|could not verify|cleanup_incomplete|ended early/.test(l))).toEqual([]);
    for (const t of outcome.transitions) expect(t.revert.succeeded, t.id).toBe(true);
    expect(outcome.record.partial).toBe(false);
  });
});
