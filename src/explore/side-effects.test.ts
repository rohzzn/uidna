/**
 * Side effects are remembered across explore runs: an action that fired a
 * non-GET request (or asked to navigate) in one run is never performed again
 * by a later run of the same scan, and the earlier run's transitions are kept.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContext, type WorkflowContext } from '../application/context.js';
import { exploreInteractions } from '../application/explore-workflow.js';
import { scanInterface } from '../application/scan.js';
import { createPlaywrightProvider } from '../browser/index.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Side effects</title>
<style>body{font-family:sans-serif;margin:24px}button{display:block;margin:8px 0;padding:8px 12px}.hidden{display:none}</style></head>
<body>
<h1>Side effects</h1>
<button type="button" id="post" aria-label="Save draft">Save draft</button>
<button type="button" id="go">Open other page</button>
<button type="button" id="toggle" aria-expanded="false" aria-controls="panel">Toggle panel</button>
<div id="panel" class="hidden">Panel content</div>
<p id="status">idle</p>
<script>
document.getElementById('post').addEventListener('click', () => {
  fetch('/submit', { method: 'POST', body: 'x' }).then(() => { document.getElementById('status').textContent = 'saved'; });
});
document.getElementById('go').addEventListener('click', () => { location.href = '/other.html'; });
document.getElementById('toggle').addEventListener('click', (e) => {
  const open = e.currentTarget.getAttribute('aria-expanded') === 'true';
  e.currentTarget.setAttribute('aria-expanded', open ? 'false' : 'true');
  document.getElementById('panel').classList.toggle('hidden', open);
});
</script></body></html>`;

describe('side effects across explore runs', () => {
  let server: Server;
  let url = '';
  let posts = 0;
  let otherPageHits = 0;
  let root = '';
  let ctx: WorkflowContext;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/submit') {
        posts += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/other.html') {
        otherPageHits += 1;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Other</title><h1>Other page</h1>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
    root = await mkdtemp(join(tmpdir(), 'uidna-side-effects-'));
    ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: root, outRoot: root });
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('never repeats a POST-firing click or a navigating click in a second run, and keeps the first run\'s transitions', async () => {
    const scanned = await scanInterface(ctx, { url, viewports: [1280] });
    expect(scanned.ok, scanned.ok ? '' : scanned.error.message).toBe(true);
    if (!scanned.ok) return;
    const scanId = scanned.value.result.scanId;

    const first = await exploreInteractions(ctx, { scanId, policy: 'safe' });
    expect(first.ok, first.ok ? '' : first.error.message).toBe(true);
    if (!first.ok) return;
    const postsAfterFirst = posts;
    expect(postsAfterFirst).toBe(1);
    expect(otherPageHits).toBe(0);
    const firstTransitions = first.value.result.transitions;
    const saveTransition = firstTransitions.find((t) => t.action.target?.name === 'Save draft');
    expect(saveTransition?.sideEffects).toBe(true);
    expect(firstTransitions.some((t) => t.action.target?.name === 'Toggle panel' && !t.sideEffects)).toBe(true);
    expect(first.value.unknowns.some((u) => u.includes('Open other page') && u.includes('navigates'))).toBe(true);

    const second = await exploreInteractions(ctx, { scanId, policy: 'safe' });
    expect(second.ok, second.ok ? '' : second.error.message).toBe(true);
    if (!second.ok) return;
    expect(posts).toBe(postsAfterFirst);
    expect(otherPageHits).toBe(0);
    const skippedSave = second.value.result.skipped.filter((s) => s.name === 'Save draft');
    expect(skippedSave.length).toBeGreaterThan(0);
    expect(skippedSave.every((s) => s.reason.includes('side effect observed earlier'))).toBe(true);
    expect(second.value.result.skipped.some((s) => s.name === 'Open other page' && s.reason.includes('side effect observed earlier'))).toBe(true);
    // The first run's transitions survive the second run's re-assembly.
    const dna = await ctx.store.loadDna(scanId);
    expect(dna.ok).toBe(true);
    if (!dna.ok) return;
    for (const transition of firstTransitions) expect(dna.value.states.transitions.some((t) => t.id === transition.id)).toBe(true);
  }, 240_000);
});
