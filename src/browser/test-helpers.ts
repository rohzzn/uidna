/**
 * Shared helpers for the browser-layer tests: Fixture A served by the real
 * static server, temporary directories and small generated test sites.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
