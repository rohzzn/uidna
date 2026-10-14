/**
 * Phase 2 acceptance, dashboard (Fixture B): search, filter and sort
 * inference and responsive-rule inference, end to end in a real Chromium.
 *
 * - Breakpoints at 600, 960 and 1100px (none of them a scanned width) are
 *   located to the pixel and explained by the stylesheet; the generated
 *   project declares exactly those.
 * - The orders table is a collection; the search box is tried with a query
 *   taken from the rows, the status chips filter, the column headers sort.
 *   Every expected row list is computed from api/orders.json with the
 *   fixture's own matching and ordering.
 * - The Archive row action is attempted once, its POST is blocked, and no
 *   non-GET request ever reaches the server.
 * - The generated project reproduces search, filter and sort; the verifier
 *   compares rows by identity and order, the generated Playwright suite
 *   passes, and a broken sort is caught and then resolved.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseUiDna, type Collection, type UiDnaDocument } from '@rohzzn/uidna-schema';
import type { DiffReport } from '../src/contracts/diff-report.js';
import { serveStatic, type StaticServer } from '../src/application/static-server.js';
import { REPO_ROOT, runCli, tempDir } from './helpers.js';

interface Order {
  readonly id: string;
  readonly customer: string;
  readonly status: string;
  readonly amount: number;
  readonly date: string;
}

interface ReconstructResult {
  scanId: string;
  projectPath: string | null;
  dnaPath: string | null;
  diffReport: DiffReport | null;
  steps: { name: string; ok: boolean; error: string | null }[];
}

const FIXTURE = join(REPO_ROOT, 'fixtures', 'b-dashboard');

describe('Phase 2 loop on Fixture B (dashboard: search, filter, sort, breakpoints)', () => {
  let server: StaticServer;
  const requests: { method: string; pathname: string }[] = [];
  let outRoot: string;
  let projectDir: string;
  let result: ReconstructResult;
  let dna: UiDnaDocument;
  let orders: Order[];
  let table: Collection;

  beforeAll(async () => {
    orders = (JSON.parse(await readFile(join(FIXTURE, 'api', 'orders.json'), 'utf8')) as { orders: Order[] }).orders;
    const served = await serveStatic(FIXTURE, { fixtureApi: true, onRequest: (request) => requests.push(request) });
    if (!served.ok) throw new Error(served.error.message);
    server = served.value;
    outRoot = await tempDir('dashboard-scans');
    projectDir = await tempDir('dashboard-project');
  });

  afterAll(async () => {
    await server.close();
  });

  /** Order ids of row keys, through the collection's Order column. */
  const idsOf = (keys: readonly string[]): string[] => {
    const order = table.fields.find((f) => f.name === 'Order');
    return keys.map((key) => table.items.find((item) => item.key === key)?.values[order?.id ?? ''] ?? key);
  };
  const widestRules = (): NonNullable<UiDnaDocument['collections']>['rules'] =>
    (dna.collections?.rules ?? []).filter((r) => r.collectionId === table.id && dna.states.items.find((s) => s.id === r.before.stateId)?.viewport.width === 1280);

  it('reconstructs the dashboard, locating the breakpoints and classifying search, filter and sort', async () => {
    const run = await runCli(['reconstruct', server.url, projectDir, '--out-root', outRoot, '--viewports', '1280,768,390', '--budget', '{"actions":400,"timeMs":1500000}'], { timeoutMs: 2_400_000 });
    expect(run.error, run.outcome.stderr.slice(-2000)).toBeNull();
    result = run.envelope?.result as ReconstructResult;
    expect(result.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.error ?? ''}`)).toEqual([]);
    dna = parseUiDna(JSON.parse(await readFile(result.dnaPath ?? '', 'utf8')));
    expect(dna.dnaVersion).toBe('0.3.0');

    // Breakpoints between the scanned widths, each confirmed one pixel apart and explained by its condition.
    const responsive = dna.visual.responsive;
    expect(responsive?.breakpoints.map((b) => [b.minWidth, b.source, b.bracket.lower, b.bracket.upper])).toEqual([
      [600, 'css', 599, 600],
      [960, 'css', 959, 960],
      [1100, 'css', 1099, 1100],
    ]);
    const conditionText = new Map((responsive?.conditions ?? []).map((c) => [c.id, c] as const));
    expect(responsive?.breakpoints.map((b) => b.conditionIds.map((id) => conditionText.get(id)?.text))).toEqual([['(max-width: 599px)'], ['(min-width: 960px)'], ['(max-width: 1099px)']]);
    expect([...conditionText.values()].find((c) => c.text === '(min-width: 1440px)')?.observedEffect).toBeNull();
    expect([...conditionText.values()].find((c) => c.text === 'print')?.never).toBe(true);
    expect(dna.limitations.some((l) => l.subject.startsWith('breakpoint 1440px'))).toBe(true);

    // The orders table: ten rows in base order (by order id), with its columns as fields.
    const found = dna.collections?.definitions.find((c) => c.container.tag === 'tbody');
    expect(found).toBeDefined();
    if (found === undefined) return;
    table = found;
    expect(table.layout).toBe('table');
    expect(table.fields.map((f) => [f.name, f.valueKind])).toEqual([
      ['Order', 'text'],
      ['Customer', 'text'],
      ['Status', 'text'],
      ['Amount', 'number'],
      ['Date', 'date'],
      ['Actions', 'text'],
    ]);
    expect(idsOf(table.items.map((i) => i.key))).toEqual(orders.map((o) => o.id));
  });

  it('records search, filter and sort with the rows the fixture itself shows', () => {
    const rules = widestRules();
    const ids = (filter: (o: Order) => boolean, sort?: (a: Order, b: Order) => number): string[] => {
      const kept = orders.filter(filter);
      return (sort === undefined ? kept : [...kept].sort(sort)).map((o) => o.id);
    };

    const searches = rules.filter((r) => r.kind === 'search');
    const query = searches.find((r) => r.after.keys.length > 0)?.event.value ?? '';
    expect(query).toMatch(/^[a-z]{3,6}$/);
    const matches = ids((o) => `${o.id} ${o.customer}`.toLowerCase().includes(query));
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.length).toBeLessThan(orders.length);
    const search = searches.find((r) => r.event.value === query);
    expect(idsOf(search?.after.keys ?? [])).toEqual(matches);
    expect(search?.search).toMatchObject({ match: 'substring', explainsExcluded: true });
    const noMatch = searches.find((r) => r.after.keys.length === 0);
    expect(noMatch?.after.emptyState?.text).toBe('No orders match your filters.');
    expect(rules.some((r) => r.kind === 'reset' && r.event.type === 'fill' && r.event.value === '')).toBe(true);

    const status = table.fields.find((f) => f.name === 'Status');
    for (const value of ['Paid', 'Pending', 'Refunded']) {
      const rule = rules.find((r) => r.kind === 'filter' && r.control.label === value);
      expect(rule?.filter?.predicate, value).toEqual({ op: 'equals', fieldId: status?.id, value });
      expect(idsOf(rule?.after.keys ?? []), value).toEqual(ids((o) => o.status === value));
    }
    const cancelled = rules.find((r) => r.kind === 'filter' && r.control.label === 'Cancelled');
    expect(cancelled?.after.keys).toEqual([]);
    expect(cancelled?.after.emptyState?.text).toBe('No orders match your filters.');

    const sortBy = (label: string): (typeof rules)[number] | undefined => rules.find((r) => r.kind === 'sort' && r.control.label?.toLowerCase() === label);
    const fieldNamed = (name: string): string | undefined => table.fields.find((f) => f.name === name)?.id;
    expect(sortBy('order')?.sort).toEqual({ fieldId: fieldNamed('Order'), direction: 'descending', comparator: 'text', ariaSort: 'descending' });
    expect(idsOf(sortBy('order')?.after.keys ?? [])).toEqual(orders.map((o) => o.id).reverse());
    expect(sortBy('customer')?.sort).toMatchObject({ fieldId: fieldNamed('Customer'), direction: 'ascending', ariaSort: 'ascending' });
    expect(idsOf(sortBy('customer')?.after.keys ?? [])).toEqual(ids(() => true, (a, b) => a.customer.localeCompare(b.customer)));
    expect(sortBy('amount')?.sort).toEqual({ fieldId: fieldNamed('Amount'), direction: 'ascending', comparator: 'number', ariaSort: 'ascending' });
    expect(idsOf(sortBy('amount')?.after.keys ?? [])).toEqual(ids(() => true, (a, b) => a.amount - b.amount));
    expect(sortBy('date')?.sort).toMatchObject({ fieldId: fieldNamed('Date'), direction: 'ascending', comparator: 'date' });
    expect(idsOf(sortBy('date')?.after.keys ?? [])).toEqual(ids(() => true, (a, b) => a.date.localeCompare(b.date)));
    // The Date column is hidden below 600px, so it is never sorted at 390.
    expect((dna.collections?.rules ?? []).filter((r) => r.kind === 'sort' && r.control.label?.toLowerCase() === 'date').length).toBe(2);
  });

  it('blocks the Archive row action once and never lets a non-GET request reach the server', () => {
    const archives = dna.states.transitions.filter((t) => (t.action.target?.name ?? '').startsWith('Archive'));
    expect(archives).toHaveLength(1);
    expect(archives[0]?.sideEffects).toBe(true);
    expect(requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([]);
  });

  it('generates a project that declares the located breakpoints and renders the orders from state', async () => {
    const tokens = await readFile(join(projectDir, 'src', 'styles', 'tokens.css'), 'utf8');
    const declared = [...tokens.matchAll(/--breakpoint-[a-z0-9]+: (\d+)px;/g)].map((m) => Number(m[1]));
    expect(declared).toEqual([600, 960, 1100]);
    const main = await readFile(join(projectDir, 'src', 'sections', 'Main.tsx'), 'utf8');
    expect(main).toContain('data-uidna-item=');
    expect(main).toContain('applyView(COLLECTION_01');
    expect(main).toContain('aria-pressed:');
    expect(main).not.toMatch(/fetch\(/);
    expect(main).toContain("useSharedState(");
    expect(await readFile(join(projectDir, 'src', 'sections', 'Header.tsx'), 'utf8')).toContain("useSharedState(");
    expect(await readFile(join(projectDir, 'src', 'lib', 'collection.ts'), 'utf8')).toContain('export function applyView');
  });

  it('replays every search, filter and sort with the same rows in the same order, and checks the breakpoints', () => {
    const report = result.diffReport;
    expect(report).not.toBeNull();
    if (report === null) return;
    const ruleTransitions = new Set((dna.collections?.rules ?? []).map((r) => r.transitionId));
    const replays = report.behavioral.filter((b) => ruleTransitions.has(b.transitionId));
    expect(replays.length).toBe(ruleTransitions.size);
    expect(replays.filter((b) => b.collection?.match !== true).map((b) => b.transitionId)).toEqual([]);
    expect(replays.filter((b) => b.roleTreeMatch !== true).map((b) => b.transitionId)).toEqual([]);
    const findings = [...report.visual.flatMap((v) => v.findings), ...report.behavioral.flatMap((b) => b.findings)];
    expect(findings.filter((f) => f.property.startsWith('collection:'))).toEqual([]);
    expect((report.responsive ?? []).map((r) => r.minWidth)).toEqual([600, 960, 1100]);
    for (const check of report.responsive ?? []) expect(check.findings, `breakpoint ${check.minWidth}`).toEqual([]);
    // The sidebar toggle in the header opens the drawer in the main section: one state shared across the two files.
    const toggles = report.behavioral.filter((b) => b.action.target?.name === 'Open navigation');
    expect(toggles.length).toBeGreaterThan(0);
    expect(toggles.filter((b) => b.roleTreeMatch !== true).map((b) => b.transitionId)).toEqual([]);
    expect(report.summary.transitionsMatched).toBe(report.summary.transitionsReplayed);
  });

  it('passes the generated Playwright suite, catches a broken sort and resolves it after the revert', async () => {
    const tested = await runCli(['verify', result.scanId, projectDir, '--out-root', outRoot, '--no-build', '--run-generated-tests', '--label', 'generated tests'], { timeoutMs: 1_800_000 });
    expect(tested.error, tested.outcome.stderr.slice(-2000)).toBeNull();
    const run = JSON.parse(await readFile(join(outRoot, result.scanId, 'verify', 'attempt-2', 'generated-tests.json'), 'utf8')) as { ran: boolean; stats: { passed: number; failed: number } };
    expect(run.ran).toBe(true);
    expect(run.stats.failed).toBe(0);
    expect(run.stats.passed).toBeGreaterThan(20);

    const lib = join(projectDir, 'src', 'lib', 'collection.ts');
    const original = await readFile(lib, 'utf8');
    const broken = original.replace('function compare(a: CollectionItem, b: CollectionItem, field: string, kind: \'number\' | \'date\' | \'text\'): number {', 'function compare(a: CollectionItem, b: CollectionItem, field: string, kind: \'number\' | \'date\' | \'text\'): number {\n  if (field !== \'\') return 0;');
    expect(broken).not.toBe(original);
    await writeFile(lib, broken, 'utf8');
    const regressed = await runCli(['verify', result.scanId, projectDir, '--out-root', outRoot, '--label', 'sort broken'], { timeoutMs: 1_800_000 });
    expect(regressed.error).toBeNull();
    const attempt3 = regressed.envelope?.result as DiffReport;
    const sortTransitions = new Set((dna.collections?.rules ?? []).filter((r) => r.kind === 'sort').map((r) => r.transitionId));
    const orderRegressions = attempt3.regressions.filter((f) => f.property === 'collection:order');
    // Sorting by a column whose base order is already ascending (Order) is unaffected; the others are caught.
    expect(orderRegressions.length).toBeGreaterThanOrEqual(sortTransitions.size - 3);
    expect(orderRegressions.every((f) => f.transitionId !== null && sortTransitions.has(f.transitionId))).toBe(true);

    await writeFile(lib, original, 'utf8');
    const fixed = await runCli(['verify', result.scanId, projectDir, '--out-root', outRoot, '--label', 'sort restored'], { timeoutMs: 1_800_000 });
    expect(fixed.error).toBeNull();
    const attempt4 = fixed.envelope?.result as DiffReport;
    expect(attempt4.resolved.filter((f) => f.property === 'collection:order').length).toBe(orderRegressions.length);
    expect(attempt4.regressions).toEqual([]);
  });
});
