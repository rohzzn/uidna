/**
 * Form chains under the forms policy, against the real instrument:
 *
 * - The non-GET guard is held for the whole chain, revert included: a
 *   debounced autosave a fill starts after the fill returned, and the
 *   beacon the page sends when it is unloaded by the revert's fresh load,
 *   never reach the server. The autosave makes the fill a side effect.
 * - A step acts on its control as found in the state the earlier steps
 *   produced: when the empty submit inserts an error summary before the
 *   controls, the fill and the filled submit still hit their own controls,
 *   never the deny-listed submit button the old node paths now point at.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UiNode } from '@rohzzn/uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { scanInterface } from '../application/scan.js';
import { createPlaywrightProvider } from '../browser/index.js';
import type { CapturedState } from '../browser/types.js';
import { BudgetTracker, resolveBudget } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { exploreInteractions, type ExploreOutcome } from './explorer.js';
import { resolveMoved, TARGET_MOVED } from './forms.js';
import { effectKey } from './run.js';

const AUTOSAVE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Profile</title>
<style>body{font-family:sans-serif;margin:24px}label,button,p{display:block;margin:8px 0}</style></head>
<body>
<h1>Profile</h1>
<form id="profile" aria-label="Profile" novalidate>
  <label>Display name <input id="display" name="display" type="text"></label>
  <button type="submit">Save profile</button>
</form>
<p id="status">idle</p>
<script>
let dirty = false;
let timer = null;
const input = document.getElementById('display');
const status = document.getElementById('status');
input.addEventListener('input', () => {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    fetch('/api/autosave', { method: 'PUT', body: input.value })
      .then(() => { status.textContent = 'draft saved'; })
      .catch(() => { status.textContent = 'draft not saved'; });
  }, 500);
});
document.getElementById('profile').addEventListener('submit', (e) => {
  e.preventDefault();
  if (input.value === '') { status.textContent = 'Enter a display name.'; return; }
  fetch('/api/profile', { method: 'POST', body: input.value })
    .then(() => { status.textContent = 'saved'; dirty = false; })
    .catch(() => { status.textContent = 'not saved'; });
});
addEventListener('pagehide', () => { if (dirty) navigator.sendBeacon('/api/draft', input.value); });
</script></body></html>`;

const MOVED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Account</title>
<style>body{font-family:sans-serif;margin:24px}label,button,p,div{display:block;margin:8px 0}</style></head>
<body>
<h1>Account</h1>
<form id="account" aria-label="Account" novalidate>
  <label>Email <input id="email" name="email" type="email"></label>
  <button type="submit" id="delete">Delete account</button>
  <button type="submit" id="save">Save changes</button>
</form>
<p id="status">idle</p>
<script>
const form = document.getElementById('account');
const email = document.getElementById('email');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (email.value === '') {
    if (!document.getElementById('errors')) {
      const errors = document.createElement('div');
      errors.id = 'errors';
      errors.setAttribute('role', 'alert');
      errors.textContent = 'Fix the errors below.';
      form.insertBefore(errors, form.firstElementChild);
    }
    return;
  }
  const via = e.submitter ? e.submitter.id : 'none';
  fetch('/api/' + via, { method: 'POST', body: email.value }).catch(() => { document.getElementById('status').textContent = 'offline via ' + via; });
});
</script></body></html>`;

let server: Server;
let origin = '';
const nonGetReceived: string[] = [];
let root = '';
let ctx: WorkflowContext;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'GET') {
      nonGetReceived.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url?.startsWith('/moved') === true ? MOVED_PAGE : AUTOSAVE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  root = await mkdtemp(join(tmpdir(), 'uidna-forms-guard-'));
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.2.0', cwd: root, outRoot: root });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Scan `path` at 1280 and explore it with the forms policy. */
async function scanAndExplore(path: string): Promise<{ scan: ScanRecord; base: CapturedState; outcome: ExploreOutcome }> {
  const scanned = unwrap(await scanInterface(ctx, { url: `${origin}${path}`, viewports: [1280] }), 'scan');
  const scan = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
  const captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
  const base = captures.get(scan.states[0]?.stateId ?? '');
  if (!base) throw new Error('no base capture');
  const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId, policy: 'forms' }, scanId: scan.scanId });
  const outcome = unwrap(
    await exploreInteractions({ ctx, scan, captures, budget: new BudgetTracker(resolveBudget({ actions: 120 }), ctx.clock), evidenceId: evidence.id, policy: 'forms' }),
    'explore forms',
  );
  return { scan, base, outcome };
}

function byAttrId(capture: CapturedState | undefined, id: string): UiNode {
  const node = capture?.nodes.find((candidate) => candidate.attrs.id === id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node;
}

describe('forms policy: the non-GET guard is held for the whole chain', () => {
  let scan: ScanRecord;
  let base: CapturedState;
  let outcome: ExploreOutcome;

  beforeAll(async () => {
    ({ scan, base, outcome } = await scanAndExplore('/autosave/'));
  }, 240_000);

  it('never lets the debounced autosave or the unload beacon reach the server, and records the fill as a side effect', () => {
    expect(nonGetReceived).toEqual([]);
    const displayPath = byAttrId(base, 'display').path;
    const fills = outcome.record.attempted.filter((a) => a.action.type === 'fill');
    expect(fills).toHaveLength(1);
    const fill = fills[0];
    expect(fill?.action.target?.nodePath).toBe(displayPath);
    expect(fill?.outcome).toBe('side-effect');
    if (fill?.transitionId !== null) {
      const transition = outcome.transitions.find((t) => t.id === fill?.transitionId);
      expect(transition?.sideEffects).toBe(true);
      expect(transition?.network.nonGet).toBeGreaterThanOrEqual(1);
    }
    expect(outcome.record.sideEffectKeys).toContain(effectKey(scan.pageId, displayPath));
    // Every request was blocked and is reported: the autosave, the filled submission and the beacon of the revert.
    expect(outcome.record.unknowns.some((u) => u.includes('/api/autosave') && u.includes('blocked'))).toBe(true);
    expect(outcome.record.unknowns.some((u) => u.includes('/api/profile') && u.includes('blocked'))).toBe(true);
    expect(outcome.record.unknowns.some((u) => u.includes('/api/draft') && u.includes('reverted') && u.includes('blocked'))).toBe(true);
    const submits = outcome.record.attempted.filter((a) => a.action.type === 'submit');
    expect(submits.map((a) => a.outcome)).toEqual(['changed', 'side-effect']);
    // The revert's beacon is attributed to the chain's last step: its transition counts the submission and the beacon.
    const filled = outcome.transitions.find((t) => t.id === submits[1]?.transitionId);
    expect(filled?.sideEffects).toBe(true);
    expect(filled?.network.nonGet).toBeGreaterThanOrEqual(2);
    for (const t of outcome.transitions.filter((x) => x.action.type === 'fill' || x.action.type === 'submit')) expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
    expect(outcome.record.limitations.filter((l) => /could not restore|could not verify|cleanup_incomplete|ended early|guard/.test(l))).toEqual([]);
    expect(outcome.record.partial).toBe(false);
  });
});

describe('forms policy: a chain step acts on its control where an earlier step moved it', () => {
  let scan: ScanRecord;
  let base: CapturedState;
  let outcome: ExploreOutcome;

  beforeAll(async () => {
    ({ scan, base, outcome } = await scanAndExplore('/moved/'));
  }, 240_000);

  it('fills the moved field and submits through the moved button, never through the deny-listed one now at the old path', () => {
    expect(nonGetReceived).toEqual([]);
    const chain = outcome.record.attempted.filter((a) => a.action.type === 'fill' || a.action.type === 'submit');
    expect(chain.map((a) => a.action.type)).toEqual(['submit', 'fill', 'submit']);
    const [empty, fill, filled] = chain;
    expect(empty?.outcome).toBe('changed');
    expect(chain.some((a) => a.action.target?.name === 'Delete account')).toBe(false);
    expect(outcome.record.unknowns.some((u) => u.includes('/api/delete'))).toBe(false);
    expect(outcome.record.unknowns.some((u) => u.includes('/api/save') && u.includes('blocked'))).toBe(true);
    expect(outcome.record.skipped.filter((s) => s.reason.endsWith(TARGET_MOVED))).toEqual([]);

    // The empty submit inserted the error summary before the controls: every path under the form moved by one.
    const invalid = outcome.captures.get(fill?.stateId ?? '');
    expect(byAttrId(invalid, 'errors').role).toBe('alert');
    const baseEmail = byAttrId(base, 'email');
    const movedEmail = byAttrId(invalid, 'email');
    expect(movedEmail.path).not.toBe(baseEmail.path);
    expect(fill?.outcome).toBe('changed');
    expect(fill?.action.target).toMatchObject({ nodePath: movedEmail.path, nodeId: movedEmail.id, name: 'Email' });
    expect(fill?.action.value).toBe('ada@example.com');

    // The filled submit started from the fill's state, on the save button found there.
    const filledFrom = outcome.captures.get(filled?.stateId ?? '');
    const movedSave = byAttrId(filledFrom, 'save');
    expect(movedSave.path).not.toBe(byAttrId(base, 'save').path);
    expect(byAttrId(filledFrom, 'delete').path).toBe(byAttrId(base, 'save').path);
    expect(filled?.outcome).toBe('side-effect');
    expect(filled?.action.target).toMatchObject({ nodePath: movedSave.path, name: 'Save changes' });
    // Both the control acted on and the planned one are remembered, so no later chain submits through it.
    expect(outcome.record.sideEffectKeys).toEqual(expect.arrayContaining([effectKey(scan.pageId, movedSave.path), effectKey(scan.pageId, byAttrId(base, 'save').path)]));
    expect(outcome.record.sideEffectKeys).not.toContain(effectKey(scan.pageId, byAttrId(base, 'delete').path));
    for (const t of outcome.transitions.filter((x) => x.action.type === 'fill' || x.action.type === 'submit')) expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
    expect(outcome.record.partial).toBe(false);
  });
});

describe('resolveMoved', () => {
  const node = (id: string, path: string, init: Partial<UiNode> & Pick<UiNode, 'tag'>): UiNode => ({
    id,
    parentId: null,
    path,
    depth: path === '' ? 0 : path.split('/').length,
    role: null,
    name: null,
    attrs: {},
    text: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
    styleId: 's1',
    a11y: {},
    visible: true,
    interactive: true,
    inForm: true,
    childIds: [],
    ...init,
  });
  const capture = (nodes: UiNode[]): CapturedState => ({
    url: 'http://127.0.0.1/',
    title: 't',
    viewport: { width: 1280, height: 800 },
    capturedAt: '2026-01-01T00:00:00.000Z',
    document: { width: 1280, height: 800, scrollHeight: 800 },
    nodes,
    styles: {},
    roleTree: [],
    roleTreeDigest: 'r',
    domDigest: 'd',
    screenshot: null,
    fonts: [],
    assets: [],
    network: [],
    limitations: [],
  });
  const field = (id: string, path: string, name: string): UiNode => node(id, path, { tag: 'input', role: 'textbox', name, attrs: { type: 'text', name: name.toLowerCase() } });
  const body = node('b', '', { tag: 'body', inForm: false });
  const planned = capture([body, field('n1', '0/0', 'First'), field('n2', '0/1', 'Second'), node('n3', '0/2', { tag: 'button', name: 'Go', attrs: { type: 'submit' } })]);

  it('returns the node itself when the step starts from the capture it was planned from', () => {
    const first = planned.nodes[1];
    if (!first) throw new Error('builder');
    expect(resolveMoved(planned, planned, first)).toBe(first);
  });

  it('finds a control by identity after an earlier step shifted the paths', () => {
    const current = capture([body, node('x', '0/0', { tag: 'div', role: 'alert' }), field('m1', '0/1', 'First'), field('m2', '0/2', 'Second'), node('m3', '0/3', { tag: 'button', name: 'Go', attrs: { type: 'submit' } })]);
    const [, first, second, go] = planned.nodes;
    if (!first || !second || !go) throw new Error('builder');
    expect(resolveMoved(planned, current, first)?.path).toBe('0/1');
    expect(resolveMoved(planned, current, second)?.path).toBe('0/2');
    expect(resolveMoved(planned, current, go)?.id).toBe('m3');
  });

  it('refuses when the control is gone, renamed, or when another control with the same identity appeared', () => {
    const [, first] = planned.nodes;
    if (!first) throw new Error('builder');
    expect(resolveMoved(planned, capture([body, field('m2', '0/1', 'Second')]), first)).toBeNull();
    expect(resolveMoved(planned, capture([body, field('m1', '0/0', 'First name')]), first)).toBeNull();
    expect(resolveMoved(planned, capture([body, field('m0', '0/0', 'First'), field('m1', '0/1', 'First'), field('m2', '0/2', 'Second')]), first)).toBeNull();
  });
});
