import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCommand } from '../application/process.js';
import { unwrap } from '../domain/result.js';
import { buildProject, generateProject, installProject } from './index.js';
import { fixtureDocument } from './testing.js';

const SKIP = process.env.UIDNA_SKIP_BUILD_TEST === '1';
const ROOT = join(process.cwd(), 'tests', '.tmp', 'generate-build');

async function tail(path: string, lines = 40): Promise<string> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return `(no log at ${path})`;
  }
}

describe('generated project builds', () => {
  afterAll(async () => {
    if (!SKIP) await rm(ROOT, { recursive: true, force: true });
  });

  it(
    'installs, typechecks and builds with Vite (real npm install; set UIDNA_SKIP_BUILD_TEST=1 to skip)',
    async () => {
      if (SKIP) {
        console.warn('UIDNA_SKIP_BUILD_TEST=1: skipping the real npm install + vite build of the generated project');
        return;
      }
      await rm(ROOT, { recursive: true, force: true });
      const scanDir = join(ROOT, 'scan');
      const outDir = join(ROOT, 'project');
      await mkdir(scanDir, { recursive: true });
      const record = unwrap(await generateProject({ dna: fixtureDocument(), scanDir, outDir, install: false, build: false, evidenceId: 'ev_000000000020' }), 'generate');
      expect(record.files).toContain('package.json');

      const install = unwrap(await installProject(outDir), 'install');
      expect(install.ok, `npm install failed:\n${await tail(install.logPath)}`).toBe(true);

      const tsc = unwrap(
        await runCommand(process.execPath, [join(outDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], { cwd: outDir, timeoutMs: 120_000 }),
        'tsc',
      );
      expect(tsc.code, `tsc reported errors in the generated project:\n${tsc.stdout}\n${tsc.stderr}`).toBe(0);

      const build = unwrap(await buildProject(outDir), 'build');
      expect(build.ok, `vite build failed:\n${await tail(build.logPath)}`).toBe(true);
      expect(build.distDir).not.toBeNull();
      expect((await stat(join(outDir, 'dist', 'index.html'))).isFile()).toBe(true);
      const html = await readFile(join(outDir, 'dist', 'index.html'), 'utf8');
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain('data-uidna-path=""');
    },
    300_000,
  );
});
