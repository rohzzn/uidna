/**
 * A request of a document the browser replaces is cancelled without
 * `requestfinished` or `requestfailed`; the ledger settles it when the new
 * main-frame document arrives, so a later stability wait does not count it
 * as in flight until its timeout.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unwrap } from '../domain/result.js';
import { ABANDONED_BY_NAVIGATION } from './network.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { DESKTOP } from './test-helpers.js';
import type { BrowserSession } from './types.js';

const PENDING = `<!doctype html><html><head><meta charset="utf-8"><title>Pending</title></head><body>
<p>Waiting</p>
<script>fetch('/slow', { method: 'POST', body: 'x' }).catch(() => {}); fetch('/slow-get').catch(() => {});</script>
</body></html>`;
const NEXT = `<!doctype html><html><head><meta charset="utf-8"><title>Next</title></head><body><p>Next</p></body></html>`;

describe('network ledger: requests abandoned by a navigation', () => {
  let server: Server;
  let base = '';
  let session: BrowserSession;
  const held: ServerResponse[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/slow' || req.url === '/slow-get') {
        // Never answered: only the navigation ends these requests.
        held.push(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.url === '/next' ? NEXT : PENDING);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
  }, 60_000);

  afterAll(async () => {
    await session.close();
    for (const res of held) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('settles the old document\'s pending requests when the next document arrives', async () => {
    unwrap(await session.navigate(`${base}/`), 'navigate');
    // The page's two requests are pending on a server that never answers them.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const marker = session.markNetwork();
    unwrap(await session.navigate(`${base}/next`), 'navigate away');
    const stability = unwrap(await session.waitForStability({ timeoutMs: 5000, quietMs: 300 }), 'stability');
    expect(stability.stable).toBe(true);
    expect(stability.pendingRequests).toBe(0);
    expect(stability.waitedMs).toBeLessThan(3000);
    const all = session.networkSince('net:0');
    const abandoned = all.filter((entry) => entry.url.endsWith('/slow') || entry.url.endsWith('/slow-get'));
    expect(abandoned.map((entry) => entry.method).sort()).toEqual(['GET', 'POST']);
    expect(abandoned.every((entry) => entry.failure === ABANDONED_BY_NAVIGATION)).toBe(true);
    // The new document's own request is unaffected.
    const next = session.networkSince(marker).find((entry) => entry.url.endsWith('/next'));
    expect(next?.status).toBe(200);
    expect(next?.failure).toBeUndefined();
  }, 60_000);
});
