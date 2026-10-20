/**
 * Form verification against the real pipeline: Fixture C scanned with JSON
 * body capture, then the transitions the forms policy would record are
 * recorded here by driving the original page (no explorer): an empty submit
 * (validation messages), a chain of fills (name, email) followed by a submit
 * that still fails validation, and the chain continued (password, terms) up
 * to the submission the session blocks (a non-GET request: a side effect).
 * The project is generated, installed and built, then verified: the submit
 * replays match the validation states, no request is attempted, the derived
 * from-states are reached through their fill chains, the blocked submission
 * is never replayed, and the generated Playwright suite runs against the
 * served build.
 */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action, Transition, UiDnaDocument, UiNode } from 'uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { captureState, openSession, reassembleDna, scanInterface } from '../application/scan.js';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/index.js';
import { DESKTOP, FIXTURE_C_DIR } from '../browser/test-helpers.js';
import type { CapturedState, UiAction } from '../browser/types.js';
import { DEFAULT_THRESHOLDS, DiffReportSchema, type DiffReport } from '../contracts/diff-report.js';
import { BudgetTracker } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { isSideEffect } from '../domain/safe-policy.js';
import { generateProject } from '../generate/index.js';
import { GeneratedTestRunSchema } from './generated-tests.js';
import { renderReport, verifyReconstruction } from './index.js';

const REPO_ROOT = process.cwd();
const SCANS = join(REPO_ROOT, 'tests', '.tmp', 'verify-forms-scans');
const PROJECT = join(REPO_ROOT, 'tests', '.tmp', 'verify-forms-project');

let fixture: StaticServer;
let ctx: WorkflowContext;
let scanId: string;
let scan: ScanRecord;
let dna: UiDnaDocument;
let report: DiffReport;

async function tail(path: string | null, lines = 30): Promise<string> {
  if (path === null) return '(no log)';
  try {
    return (await readFile(path, 'utf8')).split('\n').slice(-lines).join('\n');
  } catch {
    return `(no log at ${path})`;
  }
}

/** Ids of `to` nodes whose path has no counterpart in `from` or whose attributes, text, box or visibility differ (what the explorer records). */
function changedNodeIds(from: CapturedState, to: CapturedState): string[] {
  const before = new Map(from.nodes.map((n) => [n.path, n] as const));
  return to.nodes
    .filter((n) => {
      const b = before.get(n.path);
      return b === undefined || JSON.stringify([b.tag, b.attrs, b.text, b.box, b.visible]) !== JSON.stringify([n.tag, n.attrs, n.text, n.box, n.visible]);
    })
    .map((n) => n.id);
}

function targetOf(node: UiNode): NonNullable<Action['target']> {
  return { nodeId: node.id, nodePath: node.path, role: node.role, name: node.name, tag: node.tag, nth: node.a11y.nth ?? 0 };
}

function toUiAction(action: Action): UiAction {
  const target = action.target;
  if (target === null) throw new Error('actions recorded here always have a target');
  const locator = { nodePath: target.nodePath };
  if (action.type === 'fill') return { kind: 'fill', target: locator, value: action.value ?? '' };
  if (action.type === 'submit') return { kind: 'submit', target: locator };
  if (action.type === 'click') return { kind: 'click', target: locator };
  throw new Error(`unexpected action ${action.type}`);
}

beforeAll(async () => {
  await rm(SCANS, { recursive: true, force: true });
  await rm(join(PROJECT, 'dist'), { recursive: true, force: true });
  fixture = unwrap(await serveStatic(FIXTURE_C_DIR, { fixtureApi: true }), 'serve fixture C');
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: REPO_ROOT, outRoot: SCANS });
  const scanned = unwrap(await scanInterface(ctx, { url: fixture.url, viewports: [1280], captureBodies: 'json' }), 'scan');
  scanId = scanned.result.scanId;
  scan = unwrap(await ctx.store.loadScan(scanId), 'load scan');
  dna = unwrap(await ctx.store.loadDna(scanId), 'load dna');
  const base = dna.states.items.find((s) => s.kind === 'base');
  if (base === undefined) throw new Error('no base state');
  expect(base.id).toBe('st_01');
  expect(dna.assets.some((a) => a.kind === 'data' && a.url.endsWith('/api/items.json'))).toBe(true);
  const byId = (id: string): UiNode => {
    const node = base.nodes.find((n) => n.attrs.id === id);
    if (node === undefined) throw new Error(`#${id} not captured in st_01`);
    return node;
  };
  const name = byId('name');
  const email = byId('email');
  const password = byId('password');
  const terms = byId('terms');
  const submit = base.nodes.find((n) => n.tag === 'button' && n.attrs.type === 'submit');
  if (submit === undefined) throw new Error('submit button not captured in st_01');
  expect(email.form).toMatchObject({ required: true, type: 'email', hasValue: false, valid: false });

  const baseCapture = unwrap(await ctx.store.loadCapture(scanId, base.id), 'load base capture');
  const captures = new Map<string, CapturedState>([[base.id, baseCapture]]);
  const transitions: Transition[] = [];
  const budget = new BudgetTracker();
  const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId, note: 'forms.test.ts records fill and submit transitions by driving the signup form' }, scanId });
  const session = unwrap(await openSession(ctx, { url: fixture.url }, { ...DESKTOP }), 'open session');
  try {
    const load = async (): Promise<void> => {
      unwrap(await session.navigate(base.url), 'load');
      unwrap(await session.stabilize());
      unwrap(await session.waitForStability({ timeoutMs: 5_000 }));
    };
    /** Perform `action` from `fromId`, store the result as a derived state and record the transition; returns what the session reported. */
    const record = async (transitionId: string, fromId: string, stateId: string, action: Action): Promise<{ blockedRequests: readonly string[]; nonGet: number }> => {
      const from = captures.get(fromId);
      if (from === undefined) throw new Error(`capture of ${fromId} missing`);
      const marker = session.markNetwork();
      const outcome = unwrap(await session.act(toUiAction(action)), transitionId);
      expect(outcome.performed, `${transitionId}: ${outcome.reason ?? ''}`).toBe(true);
      expect(outcome.navigated, `${transitionId} navigated`).toBe(false);
      unwrap(await session.waitForStability({ timeoutMs: 5_000 }));
      const network = isSideEffect(session.networkSince(marker));
      const captured = unwrap(
        await captureState(ctx, session, scan, { stateId, kind: 'derived', parentStateId: fromId, viaTransitionId: transitionId, evidenceId: evidence.id, budget, captureBodies: 'json' }),
        `capture ${stateId}`,
      );
      scan.states.push(captured.record);
      captures.set(stateId, captured.capture);
      transitions.push({
        id: transitionId,
        from: fromId,
        to: stateId,
        action,
        sideEffects: network.nonGet > 0 || outcome.navigated,
        network: { requests: network.total, nonGet: network.nonGet },
        revert: { method: 'none', succeeded: false },
        change: {
          domChanged: captured.capture.domDigest !== from.domDigest,
          roleTreeChanged: captured.capture.roleTreeDigest !== from.roleTreeDigest,
          screenshotChanged: (captured.capture.screenshot?.digest ?? null) !== (from.screenshot?.digest ?? null),
          changedNodeIds: changedNodeIds(from, captured.capture),
        },
        provenance: { kind: 'observed', source: 'interaction', stateId: fromId, viewport: { ...DESKTOP }, evidenceId: evidence.id, capturedAt: captured.capture.capturedAt, confidence: 1 },
      });
      return { blockedRequests: outcome.blockedRequests ?? [], nonGet: network.nonGet };
    };
    const fill = (node: UiNode, value: string): Action => ({ type: 'fill', target: targetOf(node), value });
    const submitAction: Action = { type: 'submit', target: targetOf(submit) };

    // tr_01: the empty submit shows every validation message and sends nothing.
    await load();
    const empty = await record('tr_01', 'st_01', 'st_02', submitAction);
    expect(empty).toEqual({ blockedRequests: [], nonGet: 0 });

    // tr_02 → tr_03 → tr_04: name and email filled, then a submit that still fails on password and terms.
    await load();
    await record('tr_02', 'st_01', 'st_03', fill(name, 'Ada Lovelace'));
    await record('tr_03', 'st_03', 'st_04', fill(email, 'ada@example.com'));
    const partial = await record('tr_04', 'st_04', 'st_05', submitAction);
    expect(partial).toEqual({ blockedRequests: [], nonGet: 0 });

    // tr_05 → tr_06 → tr_07: the chain continued from st_04 (re-established on a fresh load) up to the blocked submission.
    await load();
    for (const action of [fill(name, 'Ada Lovelace'), fill(email, 'ada@example.com')]) expect(unwrap(await session.act(toUiAction(action))).performed).toBe(true);
    await record('tr_05', 'st_04', 'st_06', fill(password, 'correct-horse-battery'));
    await record('tr_06', 'st_06', 'st_07', fill(terms, 'true'));
    const blocked = await record('tr_07', 'st_07', 'st_08', submitAction);
    expect(blocked.nonGet).toBe(1);
    expect(blocked.blockedRequests).toHaveLength(1);
  } finally {
    await session.close();
  }
  unwrap(await ctx.store.saveScan(scan), 'save scan');
  unwrap(await reassembleDna(ctx, scan, transitions), 'reassemble');
  dna = unwrap(await ctx.store.loadDna(scanId), 'reload dna');
  expect(dna.states.transitions.map((t) => [t.id, t.action.type, t.sideEffects])).toEqual([
    ['tr_01', 'submit', false],
    ['tr_02', 'fill', false],
    ['tr_03', 'fill', false],
    ['tr_04', 'submit', false],
    ['tr_05', 'fill', false],
    ['tr_06', 'fill', false],
    ['tr_07', 'submit', true],
  ]);
  const invalid = dna.states.items.find((s) => s.id === 'st_02');
  expect(invalid?.nodes.find((n) => n.attrs.id === 'email')?.a11y.errorMessage).toBe('Enter a valid email address.');

  const generated = unwrap(await generateProject({ dna, scanDir: ctx.store.scanDir(scanId), outDir: PROJECT, install: true, build: true, evidenceId: 'ev_verify_forms_generate' }), 'generate');
  expect(generated.files).toContain('src/mocks/itemsJson.ts');
  expect(generated.files).toContain('tests/behavior.spec.ts');
  expect(generated.install.ok, `npm install failed:\n${await tail(generated.install.logPath)}`).toBe(true);
  expect(generated.build.ok, `vite build failed:\n${await tail(generated.build.logPath)}`).toBe(true);
}, 900_000);

afterAll(async () => {
  await fixture.close();
});

describe('verifyReconstruction on Fixture C (forms)', () => {
  it(
    'replays the submits and fills without a request, reaches chained from-states, and never replays the blocked submission',
    async () => {
      report = unwrap(
        await verifyReconstruction({ ctx, scan, dna, outDir: PROJECT, attempt: 1, previous: null, thresholds: DEFAULT_THRESHOLDS, build: false, label: 'forms', evidenceId: 'ev_verify_forms_1', runGeneratedTests: true }),
        'attempt 1',
      );
      console.log(
        '[verify forms attempt 1]',
        JSON.stringify({
          summary: report.summary,
          visual: report.visual.map((v) => ({ stateId: v.stateId, diffRatio: v.pixels?.diffRatio ?? null, geometry: v.geometry, findings: v.findings.length })),
          behavioral: report.behavioral.map((b) => ({ id: b.transitionId, type: b.action.type, replayed: b.replayed, reason: b.reason, roleTreeMatch: b.roleTreeMatch, diff: b.roleTreeDiff, diffRatio: b.pixels?.diffRatio ?? null, findings: b.findings.map((f) => f.message) })),
          limitations: report.limitations,
          unknowns: report.unknowns,
        }),
      );
      expect(DiffReportSchema.safeParse(report).success).toBe(true);
      expect(report.visual.map((v) => v.stateId)).toEqual(['st_01']);
      expect(report.visual[0]?.geometry.missingNodes).toBe(0);

      const byId = new Map(report.behavioral.map((b) => [b.transitionId, b] as const));
      // The empty submit: replayed from the base state, the validation state's role tree change reproduced, nothing sent.
      const empty = byId.get('tr_01');
      expect(empty?.replayed, empty?.reason ?? '').toBe(true);
      expect(empty?.roleTreeMatch, JSON.stringify({ diff: empty?.roleTreeDiff, findings: empty?.findings.map((f) => f.message) })).toBe(true);
      expect(empty?.findings).toEqual([]);
      expect(empty?.pixels).not.toBeNull();
      // Fills type the recorded synthetic value; the chained submit is reached by replaying tr_02 and tr_03 first.
      for (const id of ['tr_02', 'tr_03', 'tr_05', 'tr_06']) {
        const fill = byId.get(id);
        expect(fill?.action.type).toBe('fill');
        expect(fill?.replayed, `${id}: ${fill?.reason ?? ''}`).toBe(true);
        expect(fill?.roleTreeMatch, `${id}: ${JSON.stringify(fill?.roleTreeDiff)}`).toBe(true);
      }
      const chained = byId.get('tr_04');
      expect(chained?.replayed, chained?.reason ?? '').toBe(true);
      expect(chained?.roleTreeMatch, JSON.stringify({ diff: chained?.roleTreeDiff, findings: chained?.findings.map((f) => f.message) })).toBe(true);
      // No generated form ever tried to send a request.
      expect(report.behavioral.flatMap((b) => b.findings).filter((f) => f.property === 'request')).toEqual([]);
      // The blocked submission is a side effect: listed in the unknowns, absent from the replays.
      expect(byId.has('tr_07')).toBe(false);
      expect(report.unknowns.some((u) => u.startsWith('transition tr_07:') && u.includes('side effects'))).toBe(true);
      expect(report.summary).toMatchObject({ states: 1, transitions: 6, transitionsReplayed: 6, transitionsMatched: 6 });
      expect(report.summary.byCategory.behavior, JSON.stringify(report.behavioral.flatMap((b) => b.findings).map((f) => f.message))).toBe(0);

      // The generated suite ran against the served build (no second preview server).
      expect(report.limitations.join('\n')).not.toContain('generated tests were not run');
      const stored = unwrap(await ctx.store.readJson(scanId, 'verify/attempt-1/generated-tests.json', GeneratedTestRunSchema), 'generated-tests.json');
      console.log('[verify forms generated tests]', JSON.stringify({ ran: stored.ran, exitCode: stored.exitCode, stats: stored.stats, parseError: stored.parseError, tests: stored.tests.map((t) => [t.title, t.status, t.error]) }));
      expect(stored.ran).toBe(true);
      expect(stored.parseError).toBeNull();
      expect(stored.tests.length).toBeGreaterThanOrEqual(1);
      expect(stored.stats.failed, JSON.stringify(stored.tests.filter((t) => t.status === 'failed'))).toBe(0);
    },
    400_000,
  );

  it(
    'renders the HTML report with the submit replays and the transition that was never replayed',
    async () => {
      const outPath = ctx.store.resolvePath(scanId, 'report.html');
      const rendered = unwrap(await renderReport({ ctx, scan, dna, attempts: [report], outPath }), 'render');
      expect(rendered.states).toBe(1);
      const html = await readFile(outPath, 'utf8');
      expect(html).toContain('id="page-pg_01"');
      expect(html).toContain('1 transition not replayed');
      expect(html).toContain('tr_07');
      expect(html).toContain('fill &quot;Ada Lovelace&quot;');
      expect(html).toContain('Generated behavior tests (attempt 1)');
      expect(html).not.toContain('<script');
    },
    60_000,
  );
});
