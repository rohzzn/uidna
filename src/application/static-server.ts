/**
 * Dependency-free static file server. Serves fixtures in tests and the built
 * output of generated projects during verification. Binds to 127.0.0.1 only.
 */
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { toError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** A running static server. */
export interface StaticServer {
  readonly url: string;
  readonly port: number;
  readonly root: string;
  close(): Promise<void>;
}

/** Options for `serveStatic`. */
export interface StaticServerOptions {
  /** Port to bind; 0 (default) picks a free one. */
  readonly port?: number;
  /** Serve index.html for unknown paths without an extension (single-page apps). */
  readonly spaFallback?: boolean;
  /** Answer `POST /api/*` with a JSON acknowledgement, as the fixture server does. */
  readonly fixtureApi?: boolean;
}

/** Start serving `dir`. */
export async function serveStatic(dir: string, options: StaticServerOptions = {}): Promise<Result<StaticServer>> {
  const root = resolve(dir);
  try {
    const s = await stat(root);
    if (!s.isDirectory()) return err(toError(new Error(`${root} is not a directory`), 'io'));
  } catch (cause) {
    return err(toError(cause, 'io', `serve ${root}`));
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (options.fixtureApi && req.method === 'POST' && url.pathname.startsWith('/api/')) {
          let size = 0;
          req.on('data', (chunk: Buffer) => {
            size += chunk.length;
          });
          req.on('end', () => {
            const body = JSON.stringify({ ok: true, received: size });
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
            res.end(body);
          });
          return;
        }
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        let target = normalize(join(root, pathname));
        if (target !== root && !target.startsWith(root + sep)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        let exists = false;
        try {
          const st = await stat(target);
          if (st.isDirectory()) target = join(target, 'index.html');
          exists = true;
        } catch {
          exists = false;
        }
        // Single-page apps serve every route (including crawled `*.html` paths) from index.html.
        if (!exists && options.spaFallback && (extname(pathname) === '' || extname(pathname).toLowerCase() === '.html')) {
          target = join(root, 'index.html');
          exists = true;
        }
        if (!exists) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        const body = await readFile(target);
        res.writeHead(200, {
          'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
          'content-length': body.length,
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'error');
      }
    })();
  });

  return new Promise((resolvePromise) => {
    server.once('error', (cause) => resolvePromise(err(toError(cause, 'io', 'static server'))));
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
      resolvePromise(
        ok({
          url: `http://127.0.0.1:${port}/`,
          port,
          root,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        }),
      );
    });
  });
}
