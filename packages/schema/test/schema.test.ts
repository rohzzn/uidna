import { describe, expect, it } from 'vitest';
import {
  attributed,
  formatIssues,
  inferred,
  isCompatibleVersion,
  isKnown,
  measured,
  parseUiDna,
  ProvenanceSchema,
  UI_DNA_VERSION,
  unknown,
  validateUiDna,
  type UiDnaDocument,
} from '../src/index.js';
import { z } from 'zod';

const AT = '2026-10-13T17:29:00.000Z';
const ctx = { stateId: 'st_01', viewport: { width: 1280, height: 800 }, evidenceId: 'ev_000000000001', capturedAt: AT };

/** Smallest valid document: one page, one base state with a body node. */
export function minimalDocument(): UiDnaDocument {
  return {
    dnaVersion: UI_DNA_VERSION,
    target: {
      kind: 'url',
      url: 'http://127.0.0.1:4173/',
      scanId: 'scan_20261013_abcdef',
      scannedAt: AT,
      viewports: [{ width: 1280, height: 800 }],
      budget: {
        limits: { timeMs: 120000, pages: 1, actions: 60, resources: 400 },
        used: { timeMs: 1200, pages: 1, actions: 0, resources: 3 },
      },
      tool: { name: 'uidna', version: '0.1.0' },
    },
    app: {
      pages: [{ id: 'pg_01', url: 'http://127.0.0.1:4173/', title: measured('Lumen', 'a11y-tree', ctx), stateIds: ['st_01'] }],
      routes: [],
      layouts: [],
      navigation: [],
    },
    states: {
      items: [
        {
          id: 'st_01',
          pageId: 'pg_01',
          kind: 'base',
          parentStateId: null,
          url: 'http://127.0.0.1:4173/',
          title: 'Lumen',
          viewport: { width: 1280, height: 800 },
          capturedAt: AT,
          evidenceId: 'ev_000000000001',
          screenshot: { path: 'states/st_01/screenshot.png', width: 1280, height: 1600, digest: 'abc', truncated: false },
          roleTreeDigest: 'r1',
          domDigest: 'd1',
          document: { width: 1280, height: 1600, scrollHeight: 1600 },
          nodeCount: 1,
          nodes: [
            {
              id: 'n0',
              parentId: null,
              path: '',
              depth: 0,
              tag: 'body',
              role: null,
              name: null,
              attrs: {},
              text: null,
              box: { x: 0, y: 0, width: 1280, height: 1600 },
              styleId: 's0',
              a11y: {},
              visible: true,
              interactive: false,
              inForm: false,
              childIds: [],
            },
          ],
          styles: { s0: { display: 'block' } },
          roleTree: [],
          provenance: { kind: 'measured', source: 'computed-style', stateId: 'st_01', capturedAt: AT, confidence: 1 },
        },
      ],
      transitions: [],
    },
    components: { definitions: [], instances: [] },
    visual: {
      tokens: { colors: [], typography: [], fontFamilies: [], fontSizes: [], spacing: [], radii: [], shadows: [], breakpoints: [] },
      layout: [],
    },
    behavior: [],
    assets: [],
    limitations: [],
    evidence: [],
    annotations: [],
  };
}

describe('provenance', () => {
  it('accepts measured values from instrument sources', () => {
    const value = measured('248px', 'computed-style', ctx, 0.98);
    expect(isKnown(value)).toBe(true);
    expect(ProvenanceSchema.safeParse(value.provenance).success).toBe(true);
  });

  it('rejects inferred values from non-agent sources', () => {
    const result = ProvenanceSchema.safeParse({ kind: 'inferred', source: 'computed-style', capturedAt: AT, confidence: 0.5 });
    expect(result.success).toBe(false);
  });

  it('rejects agent as a measured source', () => {
    const result = ProvenanceSchema.safeParse({ kind: 'measured', source: 'agent', capturedAt: AT, confidence: 1 });
    expect(result.success).toBe(false);
  });

  it('requires a reason for unknown values and forbids a value', () => {
    const schema = attributed(z.string());
    expect(schema.safeParse(unknown('not rendered')).success).toBe(true);
    expect(schema.safeParse({ value: null, provenance: { kind: 'unknown' } }).success).toBe(false);
    expect(schema.safeParse({ value: 'x', provenance: { kind: 'unknown', reason: 'r' } }).success).toBe(false);
  });

  it('keeps the measured value when an annotation is added', () => {
    const schema = attributed(z.string());
    const base = measured('#2f5bea', 'computed-style', ctx);
    const annotated = { ...base, annotation: inferred('brand-primary', { capturedAt: AT, rationale: 'matches the logo' }, 0.8) };
    const parsed = schema.parse(annotated);
    expect(parsed.value).toBe('#2f5bea');
    expect(parsed.annotation?.provenance.source).toBe('agent');
  });
});

describe('document', () => {
  it('validates the minimal document', () => {
    const result = validateUiDna(minimalDocument());
    expect(formatIssues(result)).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('rejects dangling state references', () => {
    const doc = minimalDocument();
    doc.states.transitions.push({
      id: 'tr_01',
      from: 'st_01',
      to: 'st_99',
      action: { type: 'click', target: null },
      sideEffects: false,
      network: { requests: 0, nonGet: 0 },
      revert: { method: 'none', succeeded: true },
      change: { domChanged: true, roleTreeChanged: false, screenshotChanged: true, changedNodeIds: [] },
      provenance: { kind: 'observed', source: 'interaction', capturedAt: AT, confidence: 1 },
    });
    const result = validateUiDna(doc);
    expect(result.success).toBe(false);
    expect(formatIssues(result).join('\n')).toContain('unknown state st_99');
  });

  it('rejects unknown style ids and wrong node counts', () => {
    const doc = minimalDocument();
    const state = doc.states.items[0]!;
    state.nodes[0]!.styleId = 'missing';
    state.nodeCount = 5;
    const issues = formatIssues(validateUiDna(doc)).join('\n');
    expect(issues).toContain('unknown style missing');
    expect(issues).toContain('nodeCount');
  });

  it('rejects unknown top-level keys', () => {
    const doc = { ...minimalDocument(), react: true } as unknown;
    expect(validateUiDna(doc).success).toBe(false);
  });

  it('parseUiDna throws on invalid input', () => {
    expect(() => parseUiDna({})).toThrow();
  });

  it('checks major-version compatibility', () => {
    expect(isCompatibleVersion(UI_DNA_VERSION)).toBe(true);
    expect(isCompatibleVersion('99.0.0')).toBe(false);
  });

  it('contains no output-framework terms', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    for (const file of ['schema.ts', 'provenance.ts', 'index.ts']) {
      const source = await readFile(dir + file, 'utf8');
      for (const term of ['React', 'Tailwind', 'Vue', 'Svelte', 'JSX', 'className']) {
        expect(source.includes(term), `${file} mentions ${term}`).toBe(false);
      }
    }
  });
});
