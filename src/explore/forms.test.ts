/**
 * The forms policy against the real instrument: Fixture C (a signup form with
 * client-side validation) served by a counting server, scanned by the real
 * `scan_interface` workflow, then explored with `policy: 'forms'`: the empty
 * submit shows the validation messages, every control is filled with a
 * synthetic value that never lands in a capture, the filled submit is blocked
 * and recorded as a side effect, and the server receives no POST. The safe
 * policy on the same scan records no fill or submit at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type Transition } from 'uidna-schema';
import { createContext, type WorkflowContext } from '../application/context.js';
import type { ScanRecord, StateRecord } from '../application/records.js';
import { reassembleDna, scanInterface } from '../application/scan.js';
import { createPlaywrightProvider } from '../browser/index.js';
import { FIXTURE_C_DIR, serveCountingDir, type CountingDirServer } from '../browser/test-helpers.js';
import type { CapturedState, UiNode } from '../browser/types.js';
import { BudgetTracker, resolveBudget, type ProgressEvent } from '../domain/budget.js';
import { unwrap } from '../domain/result.js';
import { SYNTHETIC_VALUES } from '../domain/safe-policy.js';
import { tempDir } from '../../tests/helpers.js';
import { exploreInteractions, type ExploreOutcome } from './explorer.js';

const RUN_TIMEOUT = 300_000;

const MESSAGES: Readonly<Record<string, string>> = {
  name: 'Enter your full name.',
  email: 'Enter a valid email address.',
  password: 'Use at least 8 characters.',
  terms: 'You must agree to the terms.',
};

let server: CountingDirServer;
let ctx: WorkflowContext;
let scan: ScanRecord;
let base: StateRecord;
let baseCapture: CapturedState;
let forms: ExploreOutcome;
let safe: ExploreOutcome;
const progress: ProgressEvent[] = [];

function byAttrId(capture: CapturedState | undefined, id: string): UiNode {
  const node = capture?.nodes.find((candidate) => candidate.attrs.id === id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node;
}

function transitionsOfType(outcome: ExploreOutcome, type: Transition['action']['type']): Transition[] {
  return outcome.transitions.filter((t) => t.action.type === type);
}

beforeAll(async () => {
  server = await serveCountingDir(FIXTURE_C_DIR);
  const outRoot = await tempDir('explore-forms');
  ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.1.0', cwd: outRoot, outRoot, progress: { report: (event) => progress.push(event) } });
  const scanned = unwrap(await scanInterface(ctx, { url: server.url, viewports: [1280] }), 'scan');
  scan = unwrap(await ctx.store.loadScan(scanned.result.scanId), 'load scan');
  const captures = unwrap(await ctx.store.loadAllCaptures(scan.scanId, scan), 'load captures');
  base = scan.states.find((s) => s.kind === 'base')!;
  baseCapture = captures.get(base.stateId)!;
  const evidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId, policy: 'forms' }, scanId: scan.scanId });
  forms = unwrap(
    await exploreInteractions({ ctx, scan, captures, budget: new BudgetTracker(resolveBudget({ actions: 120 }), ctx.clock), evidenceId: evidence.id, policy: 'forms' }),
    'explore forms',
  );
  // The safe run continues from the saved scan so its derived state ids follow the forms run's.
  const saved = unwrap(await ctx.store.loadScan(scan.scanId), 'reload scan');
  const allCaptures = unwrap(await ctx.store.loadAllCaptures(saved.scanId, saved), 'reload captures');
  const safeEvidence = await ctx.ledger.record({ kind: 'explore', inputs: { scanId: scan.scanId, policy: 'safe' }, scanId: scan.scanId });
  safe = unwrap(
    await exploreInteractions({ ctx, scan: saved, captures: allCaptures, budget: new BudgetTracker(resolveBudget({ actions: 120 }), ctx.clock), evidenceId: safeEvidence.id, policy: 'safe' }),
    'explore safe',
  );
}, RUN_TIMEOUT);

afterAll(async () => {
  await server.close();
});

describe('forms policy on Fixture C (real Chromium, real scan)', () => {
  it('submits the empty form from the base state and records the validation state with its messages', () => {
    const submits = transitionsOfType(forms, 'submit');
    const emptySubmit = submits.find((t) => t.from === base.stateId);
    expect(emptySubmit).toBeDefined();
    if (!emptySubmit) return;
    expect(emptySubmit.action.target).toMatchObject({ role: 'button', name: 'Create account', tag: 'button' });
    expect(emptySubmit.sideEffects).toBe(false);
    expect(emptySubmit.network.nonGet).toBe(0);
    expect(emptySubmit.change.domChanged).toBe(true);
    const invalid = forms.captures.get(emptySubmit.to);
    expect(invalid).toBeDefined();
    for (const [id, message] of Object.entries(MESSAGES)) {
      const control = byAttrId(invalid, id);
      expect(control.a11y.invalid, id).toBe(true);
      expect(control.a11y.errorMessage, id).toBe(message);
      expect(control.attrs['aria-invalid'], id).toBe('true');
      const error = byAttrId(invalid, `${id}-error`);
      expect(error.visible, id).toBe(true);
      expect(error.role, id).toBe('alert');
      expect(error.text, id).toBe(message);
    }
    const record = forms.scan.states.find((s) => s.stateId === emptySubmit.to);
    expect(record).toMatchObject({ kind: 'derived', pageId: scan.pageId, parentStateId: base.stateId, viaTransitionId: emptySubmit.id });
    const attempted = forms.record.attempted.find((a) => a.transitionId === emptySubmit.id);
    expect(attempted).toMatchObject({ stateId: base.stateId, outcome: 'changed', action: { type: 'submit' } });
  });

  it('fills name, email, password and terms with synthetic values that never appear in a capture as attrs.value', () => {
    const fills = transitionsOfType(forms, 'fill');
    const expected: Readonly<Record<string, string>> = { name: SYNTHETIC_VALUES.name, email: SYNTHETIC_VALUES.email, password: SYNTHETIC_VALUES.password, terms: SYNTHETIC_VALUES.checked };
    const emptySubmit = transitionsOfType(forms, 'submit').find((t) => t.from === base.stateId)!;
    // The chain: every fill or submit starts from the state the previous step produced, beginning with the empty submit.
    const chain = forms.transitions.filter((t) => t.action.type === 'fill' || t.action.type === 'submit');
    expect(chain[0]?.id).toBe(emptySubmit.id);
    for (let i = 1; i < chain.length; i += 1) expect(chain[i]?.from, chain[i]?.id).toBe(chain[i - 1]?.to);
    for (const [id, value] of Object.entries(expected)) {
      const path = byAttrId(baseCapture, id).path;
      const fill = fills.find((t) => t.action.target?.nodePath === path);
      expect(fill, id).toBeDefined();
      if (!fill) continue;
      expect(fill.action.value, id).toBe(value);
      expect((fill.action.value ?? '').length, id).toBeGreaterThan(0);
      expect(fill.sideEffects, id).toBe(false);
      expect(fill.change.domChanged, id).toBe(true);
      const after = forms.captures.get(fill.to);
      expect(byAttrId(after, id).a11y.invalid, id).not.toBe(true);
      expect(byAttrId(after, id).form?.hasValue, id).toBe(true);
      expect(byAttrId(after, `${id}-error`).visible, id).toBe(false);
      expect(forms.scan.states.find((s) => s.stateId === fill.to)).toMatchObject({ kind: 'derived', pageId: scan.pageId, parentStateId: fill.from, viaTransitionId: fill.id });
    }
    for (const capture of forms.captures.values()) {
      for (const node of capture.nodes) {
        for (const value of Object.values(expected)) expect(node.attrs.value, `${node.id} in a capture`).not.toBe(value);
      }
      expect(JSON.stringify(capture)).not.toContain(SYNTHETIC_VALUES.password);
    }
    // The select already shows its first option: filling it is attempted with that option and recorded as observed (at most the focus moves).
    const planPath = byAttrId(baseCapture, 'plan').path;
    const planAttempt = forms.record.attempted.find((a) => a.action.type === 'fill' && a.action.target?.nodePath === planPath);
    expect(planAttempt).toMatchObject({ action: { value: 'free' } });
    expect(['changed', 'unchanged']).toContain(planAttempt?.outcome);
    const planFill = fills.find((t) => t.action.target?.nodePath === planPath);
    if (planFill) expect(planFill.change.domChanged).toBe(false);
  });

  it('submits the filled form as a side effect: the POST is blocked and never reaches the server', () => {
    const submits = transitionsOfType(forms, 'submit');
    const filledSubmit = submits.find((t) => t.sideEffects);
    expect(filledSubmit).toBeDefined();
    if (!filledSubmit) return;
    expect(server.hits('POST')).toBe(0);
    expect(server.hits('GET')).toBeGreaterThan(0);
    expect(filledSubmit.network.nonGet).toBeGreaterThan(0);
    expect(filledSubmit.action.target).toMatchObject({ role: 'button', name: 'Create account' });
    const lastFill = transitionsOfType(forms, 'fill').at(-1)!;
    expect(filledSubmit.from).toBe(lastFill.to);
    const after = forms.captures.get(filledSubmit.to);
    const status = byAttrId(after, 'status');
    expect(status.text ?? '').not.toContain('Welcome');
    expect(status.text).toBe('Could not reach the server.');
    const attempted = forms.record.attempted.find((a) => a.transitionId === filledSubmit.id);
    expect(attempted?.outcome).toBe('side-effect');
    expect(forms.record.unknowns.some((u) => u.includes('non-GET request(s) blocked') && u.includes('/api/signup'))).toBe(true);
    // The whole chain was reverted by one fresh load that restored the base.
    for (const t of [...submits, ...transitionsOfType(forms, 'fill')]) expect(t.revert, t.id).toEqual({ method: 'reload', succeeded: true });
    expect(submits).toHaveLength(2);
    // The submit control is never submitted again, and no other action touches it afterwards.
    const submitPath = filledSubmit.action.target?.nodePath;
    const later = forms.record.skipped.filter((s) => s.nodePath === submitPath);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((s) => s.reason.includes('side effect observed earlier') || s.reason.includes('inside a form'))).toBe(true);
  });

  it('reports the policy, per-page coverage, every exclusion with a reason, and restored the base state', () => {
    expect(forms.record.policy).toBe('forms');
    expect(forms.record.partial).toBe(false);
    expect(forms.record.coverageByPage).toBeDefined();
    const page = forms.record.coverageByPage?.[scan.pageId];
    expect(page).toBeDefined();
    expect(page).toEqual(forms.record.coverage);
    expect(page?.discovered).toBeGreaterThan(0);
    expect(page?.explored).toBe(forms.record.attempted.length);
    expect(page?.changed).toBe(forms.newStateIds.length);
    expect(page?.skipped).toBe(forms.record.skipped.length);
    expect(forms.record.attempted.filter((a) => a.outcome === 'failed')).toEqual([]);
    expect(forms.record.limitations.filter((l) => /could not restore|could not verify|cleanup_incomplete|ended early/.test(l))).toEqual([]);
    for (const t of forms.transitions) expect(t.revert.succeeded, t.id).toBe(true);
    // Buttons inside the form are still not clicked; nothing is reported as not filled on this form.
    const fillExample = forms.record.skipped.filter((s) => s.name === 'Fill example');
    expect(fillExample.some((s) => s.reason === 'click: inside a form')).toBe(true);
    expect(forms.record.skipped.filter((s) => s.reason.startsWith('fill:'))).toEqual([]);
    expect(forms.record.skipped.filter((s) => s.reason.startsWith('submit:'))).toEqual([]);
    expect(progress.some((e) => e.message.startsWith('submit ') && e.message.includes('(empty)'))).toBe(true);
    expect(progress.some((e) => e.message.startsWith('fill ') && e.message.includes('Email'))).toBe(true);
  });

  it('re-assembles a valid document whose behavior rules carry the fill and submit events', async () => {
    unwrap(await reassembleDna(ctx, forms.scan, forms.transitions), 'reassemble');
    const dna = unwrap(await ctx.store.loadDna(scan.scanId), 'load dna');
    expect(formatIssues(validateUiDna(dna))).toEqual([]);
    expect(dna.behavior.filter((rule) => rule.event.type === 'fill').length).toBeGreaterThanOrEqual(4);
    expect(dna.behavior.filter((rule) => rule.event.type === 'submit')).toHaveLength(2);
    // Page coverage comes from the explore record on disk, which the later safe run wrote.
    const stored = unwrap(await ctx.store.loadExplore(scan.scanId), 'load explore');
    expect(stored?.policy).toBe('safe');
    expect(dna.app.pages[0]?.coverage).toEqual(stored?.coverageByPage?.[scan.pageId]);
    expect(dna.app.pages[0]?.coverage).toEqual(safe.record.coverage);
    // The synthetic value lives on the fill transitions and their rules (by design), never in a captured state.
    expect(JSON.stringify(dna.states.items).includes(SYNTHETIC_VALUES.password)).toBe(false);
    expect(dna.states.transitions.filter((t) => t.action.value === SYNTHETIC_VALUES.password)).toHaveLength(1);
    expect(JSON.stringify(dna).includes('"inferred"')).toBe(false);
  });
});

describe('safe policy on the same scan', () => {
  it('records no fill and no submit, and still sends no POST', () => {
    expect(safe.record.policy).toBe('safe');
    expect(transitionsOfType(safe, 'fill')).toEqual([]);
    expect(transitionsOfType(safe, 'submit')).toEqual([]);
    expect(safe.record.attempted.filter((a) => a.action.type === 'fill' || a.action.type === 'submit')).toEqual([]);
    expect(server.hits('POST')).toBe(0);
    expect(safe.record.skipped.filter((s) => s.reason.startsWith('fill:') || s.reason.startsWith('submit:'))).toEqual([]);
    for (const id of ['name', 'email', 'password', 'plan', 'terms']) {
      const path = byAttrId(baseCapture, id).path;
      expect(safe.record.skipped.filter((s) => s.nodePath === path).map((s) => s.reason)).toEqual(['click: inside a form']);
    }
    expect(safe.record.coverageByPage?.[scan.pageId]).toEqual(safe.record.coverage);
    // Ids continue after the forms run's derived states.
    expect(new Set(safe.newStateIds).size).toBe(safe.newStateIds.length);
    for (const id of safe.newStateIds) expect(forms.newStateIds).not.toContain(id);
  });
});
