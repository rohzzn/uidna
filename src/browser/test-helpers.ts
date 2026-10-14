/**
 * Shared helpers for the browser-layer tests: Fixture A served by the real
 * static server, temporary directories and small generated test sites.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { unwrap } from '../domain/result.js';

/** Absolute path of Fixture A. */
export const FIXTURE_A_DIR = fileURLToPath(new URL('../../fixtures/a-marketing/', import.meta.url));

/** Serve a directory on 127.0.0.1 with a free port; throws on failure (test setup). */
export async function serveDir(dir: string): Promise<StaticServer> {
  return unwrap(await serveStatic(dir), `serve ${dir}`);
}

/** Serve Fixture A. */
export function serveFixtureA(): Promise<StaticServer> {
  return serveDir(FIXTURE_A_DIR);
}

/** A temporary directory removed by `cleanup`. */
export interface TempDir {
  readonly path: string;
  cleanup(): Promise<void>;
}

/** Create a temporary directory under the OS temp dir. */
export async function makeTempDir(prefix = 'uidna-test-'): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Write files (relative paths with forward slashes) under `root`. */
export async function writeSite(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, ...relativePath.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** A one-page HTTP server that counts the requests it receives, to prove that a request never left the browser. */
export interface CountingServer {
  readonly url: string;
  hits(): number;
  close(): Promise<void>;
}

/** Serve `html` for every path on 127.0.0.1 and count hits. */
export async function serveCounting(html: string): Promise<CountingServer> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Desktop viewport used across the tests. */
export const DESKTOP = { width: 1280, height: 800 } as const;

/** Phone viewport used across the tests (the hamburger breakpoint is 768px). */
export const PHONE = { width: 390, height: 844 } as const;

/** Absolute path of Fixture C (signup form with client-side validation and a JSON-fed list). */
export const FIXTURE_C_DIR = fileURLToPath(new URL('../../fixtures/c-form/', import.meta.url));

/** Absolute path of Fixture D (three linked pages with a shared header and footer). */
export const FIXTURE_D_DIR = fileURLToPath(new URL('../../fixtures/d-multipage/', import.meta.url));

/** Serve Fixture C with the fixture API (`POST /api/*` answered with JSON). */
export async function serveFixtureC(): Promise<StaticServer> {
  return unwrap(await serveStatic(FIXTURE_C_DIR, { fixtureApi: true }), 'serve Fixture C');
}

/** Fixture B: an orders dashboard with search, status chips, sortable columns and breakpoints at 600, 960 and 1100px. */
export const FIXTURE_B_DIR = fileURLToPath(new URL('../../fixtures/b-dashboard/', import.meta.url));

/** Serve Fixture B. */
export function serveFixtureB(): Promise<StaticServer> {
  return serveDir(FIXTURE_B_DIR);
}

/** Serve Fixture D. */
export function serveFixtureD(): Promise<StaticServer> {
  return serveDir(FIXTURE_D_DIR);
}

/** A static directory server that counts the requests it receives by method, to prove that a request never left the browser. */
export interface CountingDirServer {
  readonly url: string;
  /** Number of requests received with `method` (upper case), e.g. `hits('POST')`. */
  hits(method: string): number;
  close(): Promise<void>;
}

const COUNTING_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serve the files of `dir` on 127.0.0.1, answer `POST /api/*` with JSON like the fixture API, and count requests per method. */
export async function serveCountingDir(dir: string): Promise<CountingDirServer> {
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    counts.set(method, (counts.get(method) ?? 0) + 1);
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = JSON.stringify({ ok: true });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
        return;
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      try {
        const body = await readFile(join(dir, ...pathname.split('/').filter((part) => part !== '' && part !== '..')));
        const dot = pathname.lastIndexOf('.');
        res.writeHead(200, { 'content-type': COUNTING_TYPES[dot < 0 ? '' : pathname.slice(dot).toLowerCase()] ?? 'application/octet-stream', 'content-length': body.length });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: (method) => counts.get(method.toUpperCase()) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
