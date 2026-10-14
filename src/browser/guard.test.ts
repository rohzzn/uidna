/**
 * The held non-GET guard against the real instrument: while it is held no
 * non-GET request reaches the server, between actions too (a debounced
 * autosave), for actions that are neither fills nor submits (a click), and
 * for the beacon and keepalive request of a document being unloaded, which
 * Playwright neither reports nor routes. Each blocked request is in the
 * ledger with UI DNA's failure. GET navigations proceed; once released,
 * requests flow again.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unwrap } from '../domain/result.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { BLOCKED_REQUEST_FAILURE, blockedByUiDna } from './session.js';
import { DESKTOP } from './test-helpers.js';
import type { BrowserSession } from './types.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Guarded</title></head><body>
<button id="post" type="button">Post</button>
<input id="field" aria-label="Field">
<script>
let dirty = false;
document.getElementById('post').addEventListener('click', () => { fetch('/api/click', { method: 'POST', body: 'c' }).catch(() => {}); });
document.getElementById('field').addEventListener('input', () => {
  dirty = true;
  setTimeout(() => { fetch('/api/autosave', { method: 'PUT', body: 'a' }).catch(() => {}); }, 300);
});
addEventListener('pagehide', () => {
  if (!dirty) return;
  navigator.sendBeacon('/api/beacon', 'b');
  fetch('/api/keepalive', { method: 'POST', body: 'k', keepalive: true }).catch(() => {});
});
</script></body></html>`;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('holdNonGetGuard', () => {
  let server: Server;
  let url = '';
  const received: string[] = [];
  let session: BrowserSession;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method !== 'GET') {
        received.push(`${req.method ?? ''} ${req.url ?? ''}`);
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
    session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
  });

  afterAll(async () => {
    await session.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('blocks every non-GET request while held, unload beacons included, records each in the ledger, and lets requests through once released', async () => {
    unwrap(await session.navigate(url));
    const hold = unwrap(await session.holdNonGetGuard(), 'hold');
    const marker = session.markNetwork();

    // A fill starts a debounced autosave that fires after the action returned.
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#field' }, value: 'draft' })).performed).toBe(true);
    await pause(700);
    // A click is not a fill or a submit, yet while the guard is held its request is blocked too, and reported.
    const clicked = unwrap(await session.act({ kind: 'click', target: { selector: '#post' } }));
    expect(clicked.performed).toBe(true);
    expect(clicked.blockedRequests).toEqual([`${url}api/click`]);
    // A GET navigation proceeds; the unloading document's beacon and keepalive request do not.
    const navigated = unwrap(await session.navigate(url));
    expect(navigated.status).toBe(200);
    await pause(500);
    await hold.release();
    await hold.release();

    expect(received).toEqual([]);
    const nonGet = session.networkSince(marker).filter((entry) => entry.method !== 'GET');
    const byPath = new Map(nonGet.map((entry) => [new URL(entry.url).pathname, entry] as const));
    expect([...byPath.keys()].sort()).toEqual(['/api/autosave', '/api/beacon', '/api/click', '/api/keepalive']);
    for (const entry of nonGet) {
      expect(entry.failure, entry.url).toBe(BLOCKED_REQUEST_FAILURE);
      expect(blockedByUiDna(entry), entry.url).toBe(true);
      expect(entry.status, entry.url).toBeNull();
    }
    expect(byPath.get('/api/autosave')?.method).toBe('PUT');
    expect(byPath.get('/api/beacon')).toMatchObject({ method: 'POST', resourceType: 'ping' });

    // Released: the same click reaches the server.
    const after = unwrap(await session.act({ kind: 'click', target: { selector: '#post' } }));
    expect(after.blockedRequests).toBeUndefined();
    await pause(300);
    expect(received).toEqual(['POST /api/click']);
  }, 60_000);
});
