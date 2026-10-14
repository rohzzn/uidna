/**
 * A form control whose fill or submit caused a side effect is never acted on
 * again: not at another viewport of the same page in the same run, and not in
 * a later run that names it in `knownSideEffectPaths`. The other controls of
 * the form are still filled, every skip carries its reason, and no POST ever
 * reaches the server.
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
import type { CapturedState } from '../browser/types.js';
import { BudgetTracker, resolveBudget } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { exploreInteractions, type ExploreOutcome } from './explorer.js';
import { SUBMIT_SKIPPED_EARLIER } from './forms.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Tracked form</title>
<style>body{font-family:sans-serif;margin:24px}label,button{display:block;margin:8px 0}</style></head>
<body>
<h1>Tracked form</h1>
<form id="signup" aria-label="Sign up">
  <label>Name <input id="name" name="name" type="text" required></label>
  <label>Email <input id="email" name="email" type="email" required></label>
  <button type="submit">Create account</button>
</form>
<p id="status">idle</p>
<script>
document.getElementById('email').addEventListener('input', () => {
  fetch('/track', { method: 'POST', body: 'typing' }).catch(() => {});
});
document.getElementById('signup').addEventListener('submit', (e) => {
  e.preventDefault();
  fetch('/api/signup', { method: 'POST', body: 'x' })
    .then(() => { document.getElementById('status').textContent = 'created'; })
    .catch(() => { document.getElementById('status').textContent = 'unreachable'; });
});
</script></body></html>`;

describe('forms policy: side-effecting controls are never acted on again', () => {
  let server: Server;
  let url = '';
  let posts = 0;
  let root = '';
  let ctx: WorkflowContext;
  let scan: ScanRecord;
  let captures: Map<string, CapturedState>;
  let outcome: ExploreOutcome;
  let emailPath = '';
  let namePath = '';
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
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
    root = await mkdtemp(join(tmpdir(), 'uidna-forms-side-effects-'));
    ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: root, outRoot: root });
    const scanned = unwrap(await scanInterface(ctx, { url, viewports: [390, 1280] }), 'scan');
    scan = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
    captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
    const first = captures.get(scan.states[0]?.stateId ?? '');
    const pathOf = (id: string): string => first?.nodes.find((node) => node.attrs.id === id)?.path ?? '';
    emailPath = pathOf('email');
    namePath = pathOf('name');
    submitPath = first?.nodes.find((node) => node.tag === 'button')?.path ?? '';
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

  it('blocks every POST, fills the tracked control once, and skips it with a reason at the second viewport', () => {
    expect(posts).toBe(0);
    expect(emailPath).not.toBe('');
    expect(namePath).not.toBe('');
    expect(submitPath).not.toBe('');
    const [first, second] = scan.states.filter((state) => state.kind === 'base');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    const attemptsAt = (stateIds: ReadonlySet<string>, type: 'fill' | 'submit', path: string) =>
      outcome.record.attempted.filter((a) => stateIds.has(a.stateId) && a.action.type === type && a.action.target?.nodePath === path);
    // Chain steps start from derived states; attribute every attempt to the base state its page was loaded for via the parent chain.
    const baseOf = new Map<string, string>();
    for (const state of outcome.scan.states) {
      if (state.kind === 'base') baseOf.set(state.stateId, state.stateId);
    }
    for (const state of outcome.scan.states) {
      if (state.kind !== 'derived' || state.parentStateId === null) continue;
      baseOf.set(state.stateId, baseOf.get(state.parentStateId) ?? state.parentStateId);
    }
    const ofBase = (base: string): ReadonlySet<string> => new Set([...baseOf.entries()].filter(([, b]) => b === base).map(([id]) => id));

    // First base state: the email fill fired a (blocked) POST and is a side effect; the filled submit too.
    const emailFirst = attemptsAt(ofBase(first.stateId), 'fill', emailPath);
    expect(emailFirst).toHaveLength(1);
    expect(emailFirst[0]?.outcome).toBe('side-effect');
    const emailTransition = outcome.transitions.find((t) => t.id === emailFirst[0]?.transitionId);
    expect(emailTransition?.sideEffects).toBe(true);
    expect(emailTransition?.action.value).toBe('ada@example.com');
    const submitsFirst = attemptsAt(ofBase(first.stateId), 'submit', submitPath);
    expect(submitsFirst.map((a) => a.outcome)).toEqual([expect.stringMatching(/changed|unchanged/), 'side-effect']);
    expect(outcome.record.unknowns.some((u) => u.includes('/track') && u.includes('blocked'))).toBe(true);
    expect(outcome.record.unknowns.some((u) => u.includes('/api/signup') && u.includes('blocked'))).toBe(true);

    // Second base state (same page, other viewport): the email fill and both submits are skipped with the reason; the name fill still runs.
    expect(attemptsAt(ofBase(second.stateId), 'fill', emailPath)).toEqual([]);
    expect(attemptsAt(ofBase(second.stateId), 'submit', submitPath)).toEqual([]);
    const nameSecond = attemptsAt(ofBase(second.stateId), 'fill', namePath);
    expect(nameSecond).toHaveLength(1);
    expect(['changed', 'unchanged']).toContain(nameSecond[0]?.outcome);
    const skippedSecond = outcome.record.skipped.filter((s) => s.stateId === second.stateId);
    expect(skippedSecond.filter((s) => s.nodePath === emailPath).map((s) => s.reason)).toContain(`fill: ${SUBMIT_SKIPPED_EARLIER}`);
    expect(skippedSecond.filter((s) => s.nodePath === submitPath && s.reason.startsWith('submit:')).map((s) => s.reason)).toEqual([`submit: ${SUBMIT_SKIPPED_EARLIER}`, `submit: ${SUBMIT_SKIPPED_EARLIER}`]);
    expect(skippedSecond.some((s) => s.nodePath === namePath && s.reason.startsWith('fill:'))).toBe(false);

    // Every chain was reverted with a fresh load that restored its base; the browser and its temp files are gone.
    for (const t of outcome.transitions.filter((x) => x.action.type === 'fill' || x.action.type === 'submit')) expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
    expect(outcome.record.limitations.filter((l) => /could not restore|could not verify|cleanup_incomplete|ended early/.test(l))).toEqual([]);
    expect(outcome.record.partial).toBe(false);
    expect(outcome.record.coverage.explored).toBe(outcome.record.attempted.length);
  });

  it('never fills a control a later run is told about through knownSideEffectPaths, and never submits through it', async () => {
    const saved = unwrap(await ctx.store.loadScan(scan.scanId), 'reload scan');
    const allCaptures = unwrap(await ctx.store.loadAllCaptures(saved.scanId, saved), 'reload captures');
    const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId, policy: 'forms' }, scanId: scan.scanId });
    const postsBefore = posts;
    const again = unwrap(
      await exploreInteractions({
        ctx,
        scan: saved,
        captures: allCaptures,
        budget: new BudgetTracker(resolveBudget({ actions: 200 }), ctx.clock),
        evidenceId: evidence.id,
        policy: 'forms',
        viewportWidths: [1280],
        knownSideEffectPaths: new Set([emailPath, submitPath]),
      }),
      'explore again',
    );
    expect(posts).toBe(postsBefore);
    expect(again.record.attempted.filter((a) => a.action.target?.nodePath === emailPath || a.action.target?.nodePath === submitPath)).toEqual([]);
    expect(again.record.attempted.filter((a) => a.action.type === 'fill').map((a) => a.action.target?.nodePath)).toEqual([namePath]);
    const reasons = again.record.skipped.filter((s) => s.nodePath === emailPath || s.nodePath === submitPath).map((s) => s.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((r) => r.endsWith(SUBMIT_SKIPPED_EARLIER) || r === 'click: inside a form')).toBe(true);
    expect(reasons).toContain(`fill: ${SUBMIT_SKIPPED_EARLIER}`);
    expect(reasons).toContain(`submit: ${SUBMIT_SKIPPED_EARLIER}`);
    for (const t of again.transitions.filter((x) => x.action.type === 'fill')) expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
  }, 120_000);
});
