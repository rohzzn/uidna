/**
 * Phase 2 acceptance, forms (Fixture C): the forms policy fills the signup
 * form with synthetic values and submits; validation states are captured
 * with their messages; the submission request is blocked and marked as a side
 * effect; a JSON response becomes a data asset and a typed mock; the generated
 * form reproduces the observed validation messages and the verifier replays
 * the empty-submit transition.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUiDna, type UiDnaDocument } from '@rohzzn/uidna-schema';
import type { DiffReport } from '../src/contracts/diff-report.js';
import { serveStatic, type StaticServer } from '../src/application/static-server.js';
import { REPO_ROOT, runCli, tempDir } from './helpers.js';

interface ReconstructResult {
  scanId: string;
  projectPath: string | null;
  dnaPath: string | null;
  diffReport: DiffReport | null;
  steps: { name: string; ok: boolean; error: string | null }[];
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('Phase 2 loop on Fixture C (forms and data)', () => {
  let server: StaticServer;
  let outRoot: string;
  let projectDir: string;
  let result: ReconstructResult;
  let dna: UiDnaDocument;

  beforeAll(async () => {
    const served = await serveStatic(join(REPO_ROOT, 'fixtures', 'c-form'), { fixtureApi: true });
    if (!served.ok) throw new Error(served.error.message);
    server = served.value;
    outRoot = await tempDir('forms-scans');
    projectDir = await tempDir('forms-project');
  });

  afterAll(async () => {
    await server.close();
  });

  it('captures validation states, blocks the submission, records a data asset and generates a mock', async () => {
    const run = await runCli(['reconstruct', server.url, projectDir, '--out-root', outRoot, '--viewports', '1280', '--policy', 'forms', '--capture-bodies', 'json']);
    expect(run.error, run.outcome.stderr.slice(-2000)).toBeNull();
    result = run.envelope?.result as ReconstructResult;
    expect(result.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error ?? ''}`)).toEqual([]);
    dna = parseUiDna(JSON.parse(await readFile(result.dnaPath ?? '', 'utf8')));

    // Form facts on the base state
    const base = dna.states.items.find((s) => s.kind === 'base');
    const email = base?.nodes.find((n) => n.attrs.id === 'email');
    expect(email?.form).toMatchObject({ required: true, type: 'email', hasValue: false });

    // Empty submit shows the observed validation messages
    const submits = dna.states.transitions.filter((t) => t.action.type === 'submit');
    expect(submits.length).toBeGreaterThanOrEqual(1);
    const emptySubmit = submits.find((t) => t.from === base?.id);
    expect(emptySubmit, 'a submit transition from the base state').toBeDefined();
    const invalidState = dna.states.items.find((s) => s.id === emptySubmit?.to);
    const emailAfter = invalidState?.nodes.find((n) => n.attrs.id === 'email');
    expect(emailAfter?.a11y.invalid).toBe(true);
    expect(emailAfter?.a11y.errorMessage).toBe('Enter a valid email address.');
    expect(invalidState?.nodes.some((n) => n.attrs.id === 'name-error' && n.visible && n.text === 'Enter your full name.')).toBe(true);

    // Filled submit is blocked and marked as a side effect; synthetic values never include real credentials
    const fills = dna.states.transitions.filter((t) => t.action.type === 'fill');
    expect(fills.length).toBeGreaterThanOrEqual(3);
    expect(fills.every((t) => (t.action.value ?? '').length > 0)).toBe(true);
    const filledSubmit = submits.find((t) => t.sideEffects);
    expect(filledSubmit, 'a blocked submission recorded as a side effect').toBeDefined();
    expect(dna.states.items.find((s) => s.id === filledSubmit?.to)?.nodes.some((n) => n.attrs.id === 'status' && n.visible)).toBe(false);

    // Data asset from the JSON endpoint and a typed mock in the project
    const data = dna.assets.find((a) => a.kind === 'data' && a.url.endsWith('/api/items.json'));
    expect(data?.request?.status).toBe(200);
    expect(data?.localPath).toBeDefined();
    const stored = JSON.parse(await readFile(join(outRoot, result.scanId, data?.localPath ?? ''), 'utf8')) as { items: unknown[] };
    expect(stored.items).toHaveLength(3);
    const mock = await readFile(join(projectDir, 'src', 'mocks', 'itemsJson.ts'), 'utf8');
    expect(mock).toContain('export interface');
    expect(mock).toContain('Reading list for the weekend');
    expect(mock).not.toContain('"token"');

    // Generated form reproduces the messages and performs no request
    const sources = await Promise.all(['src/sections/Main.tsx', 'src/App.tsx'].map(async (f) => ((await exists(join(projectDir, f))) ? readFile(join(projectDir, f), 'utf8') : '')));
    const joined = sources.join('\n');
    expect(joined).toContain('noValidate');
    expect(joined).toContain('Enter a valid email address.');
    expect(joined).not.toMatch(/fetch\(/);
    expect(await exists(join(projectDir, 'dist', 'index.html'))).toBe(true);

    // Verifier replays the empty submit and matches the validation state
    const report = result.diffReport!;
    const replay = report.behavioral.find((b) => b.transitionId === emptySubmit?.id);
    expect(replay?.replayed, replay?.reason ?? '').toBe(true);
    expect(replay?.roleTreeMatch, JSON.stringify(replay?.roleTreeDiff)).toBe(true);
    expect(report.behavioral.filter((b) => b.transitionId === filledSubmit?.id)).toHaveLength(0);
  });
});
