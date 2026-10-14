/**
 * `runGeneratedTests` against a real npm run of a synthetic project whose
 * `test:behavior` script stands in for Playwright: it writes a JSON report
 * to `PLAYWRIGHT_JSON_OUTPUT_NAME` or not at all, as `mode.txt` says. Attempt
 * numbers can be reused, so a report an earlier run left in the attempt
 * directory must be removed first and never read as this run's.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GENERATED_TESTS_RAW_FILE, runGeneratedTests } from './generated-tests.js';

const ROOT = join(process.cwd(), 'tests', '.tmp', 'verify-generated-tests-run');
const PROJECT = join(ROOT, 'project');
const ATTEMPT = join(ROOT, 'attempt-1');
const RAW = join(ATTEMPT, GENERATED_TESTS_RAW_FILE);

/** A Playwright JSON report with one test per title. */
function report(title: string, status: 'expected' | 'unexpected'): string {
  return JSON.stringify({ suites: [{ title: 'behavior.spec.ts', specs: [{ title, tests: [{ status, projectName: '', results: [{ status: status === 'expected' ? 'passed' : 'failed', duration: 12 }] }] }] }], errors: [] });
}

const RUNNER = `const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(__dirname, 'ran.txt'), 'ran');
const mode = fs.readFileSync(path.join(__dirname, 'mode.txt'), 'utf8').trim();
if (mode === 'fresh') fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, ${JSON.stringify(report('tr_02: fresh test', 'expected'))});
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function setMode(mode: 'none' | 'fresh'): Promise<void> {
  await writeFile(join(PROJECT, 'mode.txt'), mode, 'utf8');
}

describe('runGeneratedTests with a report left by an earlier run', () => {
  beforeEach(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(join(PROJECT, 'tests'), { recursive: true });
    await mkdir(join(PROJECT, 'node_modules', '@playwright', 'test'), { recursive: true });
    await mkdir(ATTEMPT, { recursive: true });
    await writeFile(join(PROJECT, 'package.json'), JSON.stringify({ name: 'uidna-fake-generated', private: true, scripts: { 'test:behavior': 'node runner.cjs' } }), 'utf8');
    await writeFile(join(PROJECT, 'runner.cjs'), RUNNER, 'utf8');
    await writeFile(join(PROJECT, 'playwright.config.ts'), '// stand-in: the runner never reads it\n', 'utf8');
    await writeFile(join(PROJECT, 'tests', 'behavior.spec.ts'), '// stand-in: the runner never reads it\n', 'utf8');
    await writeFile(join(PROJECT, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({ name: '@playwright/test', version: '0.0.0' }), 'utf8');
  });

  it('removes the stale report first, so a run that writes none reports that instead of the old results', async () => {
    await writeFile(RAW, report('tr_01: stale test', 'unexpected'), 'utf8');
    await setMode('none');
    const outcome = await runGeneratedTests({ outDir: PROJECT, serverUrl: 'http://127.0.0.1:9/', port: 9, artifactDir: ATTEMPT, timeoutMs: 60_000 });
    expect(outcome.reason).toBeNull();
    expect(outcome.ran).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.tests).toEqual([]);
    expect(outcome.reportPath).toBeNull();
    expect(outcome.parseError).toContain(`no JSON report was written to ${GENERATED_TESTS_RAW_FILE}`);
    expect(await exists(RAW)).toBe(false);
  }, 120_000);

  it('reads only the report this run wrote', async () => {
    await writeFile(RAW, report('tr_01: stale test', 'unexpected'), 'utf8');
    await setMode('fresh');
    const outcome = await runGeneratedTests({ outDir: PROJECT, serverUrl: 'http://127.0.0.1:9/', port: 9, artifactDir: ATTEMPT, timeoutMs: 60_000 });
    expect(outcome.ran).toBe(true);
    expect(outcome.parseError).toBeNull();
    expect(outcome.reportPath).toBe(RAW);
    expect(outcome.tests.map((t) => [t.transitionId, t.status])).toEqual([['tr_02', 'passed']]);
    expect(outcome.stats).toEqual({ passed: 1, failed: 0, skipped: 0, flaky: 0 });
    expect(await readFile(RAW, 'utf8')).toContain('tr_02: fresh test');
  }, 120_000);

  it('does not start when the stale report cannot be removed, and says why', async () => {
    // A directory in the report's place: removing it without recursion fails with something other than ENOENT.
    await mkdir(join(RAW, 'nested'), { recursive: true });
    await writeFile(join(RAW, 'nested', 'report.json'), report('tr_01: stale test', 'unexpected'), 'utf8');
    await setMode('fresh');
    const outcome = await runGeneratedTests({ outDir: PROJECT, serverUrl: 'http://127.0.0.1:9/', port: 9, artifactDir: ATTEMPT, timeoutMs: 60_000 });
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toContain(`the previous ${GENERATED_TESTS_RAW_FILE} at ${RAW} could not be removed`);
    expect(outcome.reason).toContain("its results would be read as this run's");
    expect(outcome.tests).toEqual([]);
    expect(await exists(join(PROJECT, 'ran.txt'))).toBe(false);
    expect(await exists(join(RAW, 'nested', 'report.json'))).toBe(true);
  }, 120_000);
});
