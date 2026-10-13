import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateUiDna } from '@uidna/schema';
import { annotateDna } from './annotate.js';
import { exportEvidence } from './export.js';
import { extractTokens, inspectDna, inspectElement, searchComponents } from './inspect.js';
import { getAtPath, locatePath, parsePath, toPointer } from './json-path.js';
import { createSampleContext, sampleDocument, SAMPLE_SCAN_ID } from './testing.js';
import type { WorkflowContext } from './context.js';

describe('json-path', () => {
  it('parses dot paths and JSON pointers', () => {
    expect(parsePath('a.b.0')).toEqual({ ok: true, value: ['a', 'b', '0'] });
    expect(parsePath('/a/b/0')).toEqual({ ok: true, value: ['a', 'b', '0'] });
    expect(parsePath('/a~1b/c~0d')).toEqual({ ok: true, value: ['a/b', 'c~d'] });
    expect(parsePath('a..b').ok).toBe(false);
  });

  it('reads and locates values', () => {
    const doc = { a: { list: [{ v: 1 }, { v: 2 }] } };
    expect(getAtPath(doc, 'a.list.1.v')).toEqual({ ok: true, value: 2 });
    expect(getAtPath(doc, 'a.list.5.v').ok).toBe(false);
    const loc = locatePath(doc, '/a/list/0');
    expect(loc.ok && loc.value.key).toBe(0);
    expect(toPointer(['states', 'items', 0])).toBe('/states/items/0');
  });
});

describe('workflows over the sample scan', () => {
  let ctx: WorkflowContext;
  let root: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const sample = await createSampleContext();
    ctx = sample.ctx;
    root = sample.root;
    cleanup = sample.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  it('the sample document validates', () => {
    expect(validateUiDna(sampleDocument()).success).toBe(true);
  });

  it('inspect_dna summarizes and reads paths', async () => {
    const summary = await inspectDna(ctx, { scanId: SAMPLE_SCAN_ID });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.result.summary.states).toBe(3);
    expect(summary.value.result.summary.transitions).toBe(1);
    expect(summary.value.result.summary.tokens.colors).toBe(1);
    expect(summary.value.result.facets.behavior).toEqual({ available: true, count: 1 });
    expect(summary.value.result.document).toBeUndefined();
    expect(summary.value.evidence_id).toMatch(/^ev_[0-9a-f]{12}$/);
    expect(summary.value.limitations.join(' ')).toContain('summary only');

    const path = await inspectDna(ctx, { scanId: SAMPLE_SCAN_ID, path: 'visual.tokens.colors.0.value.value' });
    expect(path.ok && path.value.result.value).toBe('#1b1f2a');

    const facet = await inspectDna(ctx, { scanId: SAMPLE_SCAN_ID, facet: 'states' });
    expect(facet.ok && Array.isArray(facet.value.result.value) && facet.value.result.value.length).toBe(3);

    const full = await inspectDna(ctx, { scanId: SAMPLE_SCAN_ID, full: true });
    expect(full.ok && full.value.result.document?.dnaVersion).toBe(sampleDocument().dnaVersion);

    const missing = await inspectDna(ctx, { scanId: 'scan_20260101_000000' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error._tag).toBe('not-found');
  });

  it('inspect_element locates by id, role+name and selector', async () => {
    const byId = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_02', nodeId: 'n2' });
    expect(byId.ok).toBe(true);
    if (!byId.ok) return;
    expect(byId.value.result.node.tag).toBe('button');
    expect(byId.value.result.style['background-color']).toBe('rgb(255, 255, 255)');
    expect(byId.value.result.ancestors.map((a) => a.tag)).toEqual(['body', 'header']);
    expect(byId.value.result.evidence[0]).toBe('ev_st_0200000000');

    const byRole = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_01', role: 'heading', name: 'capture quickly' });
    expect(byRole.ok && byRole.value.result.node.id).toBe('n9');
    expect(byRole.ok && byRole.value.result.componentInstance).toBeNull();

    const card = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_01', selector: 'article', nth: 1 });
    expect(card.ok && card.value.result.componentInstance?.instanceId).toBe('inst_002');
    expect(card.ok && card.value.result.matches).toBe(2);

    const byClass = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_01', selector: 'a.nav-link' });
    expect(byClass.ok && byClass.value.result.node.id).toBe('n4');
    expect(byClass.ok && byClass.value.result.tokens.some((t) => t.tokenId === 'tok_color_01')).toBe(false);

    const h1 = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_01', selector: 'h1' });
    expect(h1.ok && h1.value.result.tokens.map((t) => t.tokenId)).toEqual(['tok_color_01']);

    const hidden = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_01', nodeId: 'n2' });
    expect(hidden.ok && hidden.value.limitations[0]).toContain('not rendered');

    const none = await inspectElement(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_01', selector: '#nope' });
    expect(none.ok).toBe(false);
  });

  it('search_components returns candidates in stable order', async () => {
    const result = await searchComponents(ctx, { scanId: SAMPLE_SCAN_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.total).toBe(1);
    expect(result.value.result.candidates[0]?.instanceCount).toBe(4);
    expect(result.value.result.candidates[0]?.name).toBeNull();
    const filtered = await searchComponents(ctx, { scanId: SAMPLE_SCAN_ID, stateId: 'st_02', minInstances: 3 });
    expect(filtered.ok && filtered.value.result.total).toBe(0);
  });

  it('extract_tokens filters by kind', async () => {
    const all = await extractTokens(ctx, { scanId: SAMPLE_SCAN_ID });
    expect(all.ok && all.value.result.counts.colors).toBe(1);
    const colors = await extractTokens(ctx, { scanId: SAMPLE_SCAN_ID, kinds: ['color'] });
    expect(colors.ok && colors.value.result.tokens.fontSizes).toEqual([]);
    expect(colors.ok && colors.value.result.tokens.colors.length).toBe(1);
  });

  it('annotate_dna applies patches with agent provenance and keeps measured values', async () => {
    const result = await annotateDna(ctx, {
      scanId: SAMPLE_SCAN_ID,
      patches: [
        { op: 'name', target: 'component', id: 'cmp_01', value: 'FeatureCard', rationale: 'three feature cards', confidence: 0.9 },
        { op: 'name', target: 'token', id: 'tok_color_01', value: 'ink', confidence: 0.8 },
        { op: 'annotate', path: 'visual.tokens.colors.0.value', value: '#1b1f2b', rationale: 'brand palette says 2b', confidence: 0.6 },
        { op: 'authorize', assetId: 'as_01', authorization: 'authorized', rationale: 'own fixture', confidence: 1 },
        { op: 'limitation', limitation: { kind: 'not-reconstructable', subject: 'parallax', reason: 'not observed' }, confidence: 1 },
        { op: 'behavior', event: { type: 'key', nodeId: 'n2', stateId: 'st_03', key: 'Escape' }, effects: [{ kind: 'hide', targetNodeId: 'n3' }], transitionId: 'tr_01', confidence: 0.7 },
        { op: 'name', target: 'token', id: 'tok_missing', value: 'x', confidence: 0.5 },
        { op: 'annotate', path: 'visual.tokens.colors.0.value', value: 42, confidence: 0.5 },
        { op: 'annotate', path: 'states.items.0.nodes.0', value: 'nope', confidence: 0.5 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.applied.map((a) => a.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.value.result.rejected.map((r) => r.index)).toEqual([6, 7, 8]);
    expect(result.value.result.annotations).toBe(6);

    const dna = await ctx.store.loadDna(SAMPLE_SCAN_ID);
    expect(dna.ok).toBe(true);
    if (!dna.ok) return;
    const definition = dna.value.components.definitions[0];
    expect(definition?.name?.value).toBe('FeatureCard');
    expect(definition?.name?.provenance.kind).toBe('inferred');
    expect(definition?.name?.provenance.source).toBe('agent');
    const color = dna.value.visual.tokens.colors[0];
    expect(color?.value.value).toBe('#1b1f2a');
    expect(color?.value.annotation?.value).toBe('#1b1f2b');
    expect(color?.name?.value).toBe('ink');
    expect(dna.value.assets[0]?.authorization).toBe('authorized');
    expect(dna.value.assets[0]?.provenance.kind).toBe('measured');
    expect(dna.value.behavior.at(-1)?.provenance.source).toBe('agent');
    expect(dna.value.behavior.at(-1)?.event.target.nodeId).toBe('n2');
    expect(dna.value.annotations.length).toBe(6);
    expect(dna.value.annotations[0]?.path).toBe('component:cmp_01/name');
  });

  it('export_evidence writes a bundle with a manifest', async () => {
    const ledgerBefore = await ctx.ledger.record({ kind: 'inspect', inputs: { scanId: SAMPLE_SCAN_ID, apiKey: 'secret' }, scanId: SAMPLE_SCAN_ID });
    expect(ledgerBefore.inputs.apiKey).toBe('[redacted]');
    const result = await exportEvidence(ctx, { scanId: SAMPLE_SCAN_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = JSON.parse(await readFile(result.value.result.manifestPath, 'utf8')) as { files: { path: string; sha256: string }[]; ledgerRecords: number };
    expect(manifest.files.map((f) => f.path)).toContain('dna.json');
    expect(manifest.files.map((f) => f.path)).toContain('evidence/ledger.jsonl');
    expect(manifest.ledgerRecords).toBe(1);
    expect(result.value.result.bundlePath).toBe(join(root, SAMPLE_SCAN_ID, 'export'));
    await expect(stat(join(result.value.result.bundlePath, 'dna.json'))).resolves.toBeTruthy();
    const second = await exportEvidence(ctx, { scanId: SAMPLE_SCAN_ID });
    expect(second.ok && second.value.result.files).toBe(result.value.result.files);
  });
});
