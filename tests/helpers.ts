/**
 * Helpers for end-to-end tests: serve Fixture A, create isolated temp roots
 * under tests/.tmp, and run the CLI as a subprocess.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, type StaticServer } from '../src/application/static-server.js';
import { runCommand, type CommandOutcome } from '../src/application/process.js';
import type { Envelope } from '../src/domain/evidence.js';

/** Repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Fixture A directory. */
export const FIXTURE_A = join(REPO_ROOT, 'fixtures', 'a-marketing');

/** Serve Fixture A on a free port. */
export async function serveFixtureA(): Promise<StaticServer> {
  const server = await serveStatic(FIXTURE_A);
  if (!server.ok) throw new Error(server.error.message);
  return server.value;
}

/** Create an empty directory under tests/.tmp/<name> (removed first if present). */
export async function tempDir(name: string): Promise<string> {
  const dir = join(REPO_ROOT, 'tests', '.tmp', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Run the CLI from source with tsx and parse its JSON envelope. */
export async function runCli(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ outcome: CommandOutcome; envelope: Envelope<unknown> | null; error: { tag: string; message: string } | null }> {
  const cli = join(REPO_ROOT, 'src', 'cli.ts');
  const result = await runCommand(process.execPath, [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), cli, '--json', ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    timeoutMs: options.timeoutMs ?? 600_000,
    maxBufferBytes: 50 * 1024 * 1024,
  });
  if (!result.ok) throw new Error(result.error.message);
  const outcome = result.value;
  let envelope: Envelope<unknown> | null = null;
  let error: { tag: string; message: string } | null = null;
  const text = outcome.stdout.trim();
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as { error?: { tag: string; message: string } } & Partial<Envelope<unknown>>;
      if (parsed.error) error = parsed.error;
      else if (parsed.evidence_id) envelope = parsed as Envelope<unknown>;
    } catch {
      // Non-JSON output is reported through `outcome`.
    }
  }
  return { outcome, envelope, error };
}
