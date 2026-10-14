/**
 * Schema 0.3.0 is additive: a 0.2.0 document stays valid, and the new
 * `visual.responsive` and `collections` facets are cross-checked against the
 * pages, states and transitions they name.
 */
import { describe, expect, it } from 'vitest';
import { formatIssues, validateUiDna, type UiDnaDocument } from '../src/index.js';
import { minimalDocument } from './schema.test.js';

const AT = '2026-10-14T12:00:00.000Z';
const observed = { kind: 'observed' as const, source: 'interaction' as const, stateId: 'st_01', capturedAt: AT, confidence: 1 };

function withTransition(doc: UiDnaDocument): UiDnaDocument {
  const base = doc.states.items[0];
  if (base === undefined) throw new Error('minimal document has no state');
  doc.states.items.push({ ...base, id: 'st_02', kind: 'derived', parentStateId: 'st_01', provenance: { ...base.provenance, stateId: 'st_02' } });
  doc.app.pages[0]?.stateIds.push('st_02');
  doc.states.transitions.push({
    id: 'tr_01',
    from: 'st_01',
    to: 'st_02',
    action: { type: 'fill', target: { nodeId: 'n0', nodePath: '', role: 'searchbox', name: 'Search orders', tag: 'input', nth: 0 }, value: 'mar' },
    sideEffects: false,
    network: { requests: 0, nonGet: 0 },
    revert: { method: 'reload', succeeded: true },
    change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: [] },
    provenance: observed,
  });
  return doc;
}

function fullDocument(): UiDnaDocument {
  const doc = withTransition(minimalDocument());
  doc.visual.responsive = {
    breakpoints: [
      {
        id: 'bp_01',
        minWidth: 960,
        source: 'css',
        bracket: { lower: 959, upper: 960 },
        observed: true,
        conditionIds: ['mq_01'],
        pageIds: ['pg_01'],
        provenance: { kind: 'measured', source: 'stylesheet', capturedAt: AT, confidence: 1 },
      },
    ],
    conditions: [
      {
        id: 'mq_01',
        text: '(min-width: 960px)',
        kind: 'media',
        thresholds: [960],
        never: false,
        unsupported: [],
        stylesheet: { url: 'http://127.0.0.1:4173/styles.css', origin: 'same-origin' },
        ruleCount: 3,
        pageIds: ['pg_01'],
        observedEffect: true,
        provenance: { kind: 'measured', source: 'stylesheet', capturedAt: AT, confidence: 1 },
      },
    ],
    rules: [{ id: 'rr_001', breakpointId: 'bp_01', pageId: 'pg_01', nodePath: '0/1', property: 'display', below: 'none', above: 'block', provenance: { ...observed, source: 'computed-style' } }],
    probes: [{ pageId: 'pg_01', height: 800, widths: [390, 959, 960, 1280], maxProbes: 24, exhausted: false, blockedRequests: 0, evidenceId: 'ev_000000000002' }],
  };
  doc.collections = {
    definitions: [
      {
        id: 'col_01',
        pageId: 'pg_01',
        stateId: 'st_01',
        layout: 'table',
        container: { nodeId: 'n0', nodePath: '', tag: 'tbody', role: 'rowgroup', name: null },
        item: { tag: 'tr', role: 'row', fingerprint: 'fp_row' },
        identity: { basis: 'text', attribute: null },
        fields: [{ id: 'f01', name: 'Customer', generatedName: 'customer', relativePath: '1', valueKind: 'text', distinct: 2 }],
        items: [
          { key: 't:aaa', nodeId: 'n1', nodePath: '0', values: { f01: 'Mara Quinn' } },
          { key: 't:bbb', nodeId: 'n2', nodePath: '1', values: { f01: 'Theo Hart' } },
        ],
        provenance: { kind: 'measured', source: 'a11y-tree', stateId: 'st_01', capturedAt: AT, confidence: 1 },
      },
    ],
    rules: [
      {
        id: 'crl_01',
        kind: 'search',
        collectionId: 'col_01',
        transitionId: 'tr_01',
        control: { target: { nodeId: 'n0', nodePath: '', role: 'searchbox', name: 'Search orders', tag: 'input', nth: 0 }, kind: 'searchbox', label: 'Search orders' },
        event: { type: 'fill', value: 'mar' },
        before: { stateId: 'st_01', keys: ['t:aaa', 't:bbb'], emptyState: null },
        after: { stateId: 'st_02', keys: ['t:aaa'], emptyState: null },
        search: { query: 'mar', match: 'substring', fieldIds: ['f01'], explainsExcluded: true },
        provenance: observed,
      },
    ],
  };
  return doc;
}

const issuesOf = (doc: UiDnaDocument): string => formatIssues(validateUiDna(doc)).join('\n');

describe('schema 0.3.0', () => {
  it('still validates a 0.2.0 document', () => {
    const doc = minimalDocument();
    doc.dnaVersion = '0.2.0';
    expect(formatIssues(validateUiDna(doc))).toEqual([]);
  });

  it('validates a document with responsive breakpoints and collections', () => {
    expect(issuesOf(fullDocument())).toBe('');
  });

  it('checks breakpoint brackets and references', () => {
    const doc = fullDocument();
    const responsive = doc.visual.responsive;
    const bp = responsive?.breakpoints[0];
    const rule = responsive?.rules[0];
    if (responsive === undefined || bp === undefined || rule === undefined) throw new Error('no responsive facet');
    bp.bracket = { lower: 960, upper: 961 };
    bp.conditionIds = ['mq_99'];
    responsive.rules[0] = { ...rule, breakpointId: 'bp_99' };
    const issues = issuesOf(doc);
    expect(issues).toContain('lower < minWidth <= upper');
    expect(issues).toContain('unknown condition mq_99');
    expect(issues).toContain('unknown breakpoint bp_99');
  });

  it('accepts stylesheet, never agent, as the measured source of a condition', () => {
    const doc = fullDocument();
    const condition = doc.visual.responsive?.conditions[0];
    if (condition === undefined) throw new Error('no condition');
    (condition.provenance as { source: string }).source = 'agent';
    expect(validateUiDna(doc).success).toBe(false);
  });

  it('checks collection rules against transitions, kinds and fields', () => {
    const doc = fullDocument();
    const rules = doc.collections?.rules;
    const first = rules?.[0];
    if (rules === undefined || first === undefined) throw new Error('no rule');
    rules[0] = { ...first, after: { ...first.after, stateId: 'st_01' }, search: { query: 'mar', match: 'substring', fieldIds: ['f99'], explainsExcluded: true } };
    rules.push({ ...first, id: 'crl_02', kind: 'sort', transitionId: 'tr_99' });
    const issues = issuesOf(doc);
    expect(issues).toContain("after.stateId must be the transition's to-state");
    expect(issues).toContain('unknown field f99 of collection col_01');
    expect(issues).toContain('unknown transition tr_99');
    expect(issues).toContain('a sort rule needs its sort body');
    expect(issues).toContain('a sort rule carries no search body');
  });

  it('rejects duplicate item keys and values for unknown fields', () => {
    const doc = fullDocument();
    const collection = doc.collections?.definitions[0];
    const second = collection?.items[1];
    if (collection === undefined || second === undefined) throw new Error('no collection');
    collection.items[1] = { ...second, key: 't:aaa', values: { f02: 'x' } };
    const issues = issuesOf(doc);
    expect(issues).toContain('duplicate item keys');
    expect(issues).toContain('unknown field f02');
  });
});
