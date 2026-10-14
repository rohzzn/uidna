/**
 * A form without client-side validation sends its request on the empty
 * submit too. That request is blocked, so it never reaches the server: the
 * same chain still fills the form and submits it filled (blocked again), and
 * only then is the submit control remembered, so no other chain, at another
 * viewport, submits through it.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { scanInterface } from '../application/scan.js';
import { createPlaywrightProvider } from '../browser/index.js';
import { BudgetTracker, resolveBudget } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { exploreInteractions, type ExploreOutcome } from './explorer.js';
import { SUBMIT_SKIPPED_EARLIER } from './forms.js';
import { effectKey } from './run.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Newsletter</title>
<style>body{font-family:sans-serif;margin:24px}label,button{display:block;margin:8px 0}</style></head>
<body>
<h1>Newsletter</h1>
<form id="newsletter" aria-label="Newsletter">
  <label>Email <input id="email" name="email" type="text"></label>
  <button type="submit">Subscribe</button>
</form>
<p id="status">idle</p>
<script>
let sent = 0;
document.getElementById('newsletter').addEventListener('submit', (e) => {
  e.preventDefault();
  sent += 1;
  fetch('/api/subscribe', { method: 'POST', body: document.getElementById('email').value })
    .then(() => { document.getElementById('status').textContent = 'subscribed'; })
    .catch(() => { document.getElementById('status').textContent = 'unreachable ' + sent; });
});
</script></body></html>`;

describe('forms policy: an empty submit that sent a blocked request does not hide the filled submit', () => {
  let server: Server;
  let posts = 0;
  let root = '';
  let ctx: WorkflowContext;
  let scan: ScanRecord;
  let outcome: ExploreOutcome;
  let submitPath = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST') {
        posts += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
    root = await mkdtemp(join(tmpdir(), 'uidna-forms-resubmit-'));
    ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.2.0', cwd: root, outRoot: root });
    const scanned = unwrap(await scanInterface(ctx, { url, viewports: [390, 1280] }), 'scan');
    scan = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
    const captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
    submitPath = captures.get(scan.states[0]?.stateId ?? '')?.nodes.find((node) => node.tag === 'button')?.path ?? '';
    const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId, policy: 'forms' }, scanId: scan.scanId });
    outcome = unwrap(
      await exploreInteractions({ ctx, scan, captures, budget: new BudgetTracker(resolveBudget({ actions: 200 }), ctx.clock), evidenceId: evidence.id, policy: 'forms' }),
      'explore forms',
    );
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('submits empty and filled in the first chain, both blocked, and never submits again', () => {
    expect(posts).toBe(0);
    expect(submitPath).not.toBe('');
    const submits = outcome.record.attempted.filter((a) => a.action.type === 'submit' && a.action.target?.nodePath === submitPath);
    expect(submits.map((a) => a.outcome)).toEqual(['side-effect', 'side-effect']);
    const transitions = submits.map((a) => outcome.transitions.find((t) => t.id === a.transitionId));
    expect(transitions.every((t) => t?.sideEffects === true)).toBe(true);
    // The second submit starts from the state the fill produced: the form was submitted filled.
    const fill = outcome.record.attempted.find((a) => a.action.type === 'fill');
    expect(fill?.action.value).toBeTruthy();
    const filledFrom = transitions[1]?.from;
    expect(filledFrom).toBeDefined();
    // From the fill's state when the fill changed the page, else from the state the empty submit produced.
    const fillTo = outcome.transitions.find((t) => t.id === fill?.transitionId)?.to;
    expect(filledFrom).toBe(fillTo ?? transitions[0]?.to);
    expect(filledFrom).not.toBe(transitions[0]?.from);
    expect(outcome.record.unknowns.filter((u) => u.includes('/api/subscribe') && u.includes('blocked'))).toHaveLength(2);

    // The other viewport's chain skips both submits with the reason; the persisted keys name the control on its page.
    const skippedSubmits = outcome.record.skipped.filter((s) => s.nodePath === submitPath && s.reason.startsWith('submit:'));
    expect(skippedSubmits.map((s) => s.reason)).toEqual([`submit: ${SUBMIT_SKIPPED_EARLIER}`, `submit: ${SUBMIT_SKIPPED_EARLIER}`]);
    expect(outcome.record.sideEffectKeys).toContain(effectKey(scan.pageId, submitPath));
    for (const t of outcome.transitions.filter((x) => x.action.type === 'fill' || x.action.type === 'submit')) expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
    expect(outcome.record.partial).toBe(false);
  });
});
