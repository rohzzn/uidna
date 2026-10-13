#!/usr/bin/env node
// Minimal static file server for fixtures. No dependencies.
// Usage: node fixtures/serve.mjs <dir> [--port 4173]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Start a static server for `dir`. Resolves with { url, port, close }.
 * Port 0 picks a free port.
 */
export function serveStatic(dir, port = 0) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const target = normalize(join(root, pathname));
      if (!target.startsWith(root + sep) && target !== root) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      let filePath = target;
      try {
        const s = await stat(filePath);
        if (s.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': body.length,
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error && error.message ? error.message : error));
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolvePromise({
        url: `http://127.0.0.1:${actualPort}/`,
        port: actualPort,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) ?? 'fixtures/a-marketing';
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4173;
  const { url } = await serveStatic(dir, port);
  console.log(`serving ${resolve(dir)} at ${url}`);
}
