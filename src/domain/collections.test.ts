/**
 * Collections on a real capture of Fixture B (the orders table, the stat
 * grid, the status chips; the sidebar navigation is a menu, not a
 * collection), plus classification of changes on key lists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from '../browser/playwright-provider.js';
import { DESKTOP, serveFixtureB } from '../browser/test-helpers.js';
import type { CapturedState } from '../browser/types.js';
import {
  chooseIdentity,
  chooseNoMatchQuery,
  chooseSearchQuery,
  classifyCollectionChange,
  CollectionIndex,
  detectCollections,
  detectFields,
  itemKeys,
  parseDate,
  parseNumber,
  type DetectedField,
} from './collections.js';
import { unwrap } from './result.js';

describe('collections on Fixture B', () => {
  let server: StaticServer;
  let capture: CapturedState;

  beforeAll(async () => {
    server = await serveFixtureB();
    const session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
    try {
      unwrap(await session.navigate(server.url), 'navigate');
      unwrap(await session.waitForStability({ timeoutMs: 5000 }), 'stable');
      capture = unwrap(await session.capture(), 'capture');
    } finally {
      await session.close();
    }
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  const orders = (): { index: CollectionIndex; collection: ReturnType<typeof detectCollections>[number] } => {
    const index = new CollectionIndex(capture.nodes);
    const collection = detectCollections(capture.nodes).find((c) => c.container.tag === 'tbody');
    if (collection === undefined) throw new Error('no orders collection');
    return { index, collection };
  };

  it('finds the orders rows, the stat cards and the chips, and never the navigation', () => {
    const found = detectCollections(capture.nodes).map((c) => [c.container.tag, c.layout, c.items.length]);
    expect(found).toEqual(expect.arrayContaining([['tbody', 'table', 10]]));
    expect(found.some(([tag, layout, n]) => tag === 'div' && layout === 'grid' && n === 4)).toBe(true);
    expect(found.some(([tag]) => tag === 'ul')).toBe(false);
  });

  it('reads the columns as fields with their headers and value kinds', () => {
    const { index, collection } = orders();
    const { fields, values } = detectFields(index, collection);
    expect(fields.map((f) => [f.name, f.generatedName, f.valueKind])).toEqual([
      ['Order', 'order', 'text'],
      ['Customer', 'customer', 'text'],
      ['Status', 'status', 'text'],
      ['Amount', 'amount', 'number'],
      ['Date', 'date', 'date'],
      ['Actions', 'actions', 'text'],
    ]);
    const firstItem = collection.items[0];
    if (firstItem === undefined) throw new Error('no rows');
    const first = values.get(firstItem);
    expect(first).toMatchObject({ f01: 'ORD-1001', f02: 'Mara Quinn', f03: 'Paid', f04: '$120.00', f05: '2026-09-14' });
    expect(fields.find((f) => f.name === 'Status')?.distinct).toBe(3);
  });

  it('identifies rows by text, stably and uniquely', () => {
    const { index, collection } = orders();
    const identity = chooseIdentity(collection.items);
    expect(identity).toEqual({ basis: 'text', attribute: null });
    const keys = itemKeys(index, collection.items, identity);
    expect(new Set(keys).size).toBe(10);
    expect(keys.every((k) => k.startsWith('t:'))).toBe(true);
  });

  it('chooses a search query from the customer and order text that selects about a third of the rows', () => {
    const { index, collection } = orders();
    const { fields, values } = detectFields(index, collection);
    const chosen = chooseSearchQuery(collection.items.map((item) => values.get(item) ?? {}), fields);
    expect(chosen).not.toBeNull();
    expect(chosen?.matches).toBe(3);
    expect(chosen?.query).toMatch(/^[a-z]{3,6}$/);
    const noMatch = chooseNoMatchQuery(capture.nodes.map((n) => n.text ?? ''));
    expect(noMatch).toBe('zqxj');
  });
});

describe('parsing displayed values', () => {
  it('reads currency, grouping, percent and negatives', () => {
    expect(parseNumber('$1,240.00')).toBe(1240);
    expect(parseNumber('15.75')).toBe(15.75);
    expect(parseNumber('12%')).toBe(12);
    expect(parseNumber('(75.25)')).toBe(-75.25);
    expect(parseNumber('ORD-1001')).toBeNull();
  });

  it('reads ISO dates and dates with month names', () => {
    expect(parseDate('2026-09-14')).toBe(Date.UTC(2026, 8, 14));
    expect(parseDate('Oct 2, 2026')).not.toBeNull();
    expect(parseDate('03/04')).toBeNull();
  });
});

describe('classifyCollectionChange', () => {
  const fields: DetectedField[] = [
    { id: 'f01', name: 'Customer', generatedName: 'customer', relativePath: '1', valueKind: 'text', distinct: 5 },
    { id: 'f02', name: 'Status', generatedName: 'status', relativePath: '2', valueKind: 'text', distinct: 2 },
    { id: 'f03', name: 'Amount', generatedName: 'amount', relativePath: '3', valueKind: 'number', distinct: 5 },
    { id: 'f04', name: 'Actions', generatedName: 'actions', relativePath: '4', valueKind: 'text', distinct: 1 },
  ];
  const rows: [string, string, string, string][] = [
    ['k1', 'Mara Quinn', 'Paid', '$120.00'],
    ['k2', 'Theo Hart', 'Pending', '$89.50'],
    ['k3', 'Omar Haddad', 'Paid', '$1,240.00'],
    ['k4', 'Lina Okafor', 'Pending', '$15.75'],
    ['k5', 'Elena Marsh', 'Paid', '$240.00'],
  ];
  const values = new Map(rows.map(([k, customer, status, amount]) => [k, { f01: customer, f02: status, f03: amount, f04: 'Archive' }] as const));
  const baseKeys = rows.map(([k]) => k);
  const classify = (after: string[], action: { type: string; value?: string; label: string | null }, before = baseKeys, columnFieldId: string | null = null): ReturnType<typeof classifyCollectionChange> =>
    classifyCollectionChange({ baseKeys, before, after, values, fields, action, columnFieldId });

  it('explains a search by the narrowest field that predicts kept and removed rows', () => {
    expect(classify(['k1', 'k3', 'k5'], { type: 'fill', value: 'mar', label: 'Search orders' })).toEqual({
      kind: 'search',
      search: { match: 'substring', fieldIds: ['f01'], explainsExcluded: true },
    });
  });

  it('explains a filter by the categorical field equal to the control label, an empty one included', () => {
    expect(classify(['k1', 'k3', 'k5'], { type: 'click', label: 'Paid' })).toEqual({ kind: 'filter', filter: { predicate: { op: 'equals', fieldId: 'f02', value: 'Paid' } } });
    expect(classify([], { type: 'click', label: 'Cancelled' })).toEqual({ kind: 'filter', filter: { predicate: { op: 'equals', fieldId: 'f02', value: 'Cancelled' } } });
    expect(classify(['k3'], { type: 'click', label: 'High value' })).toEqual({ kind: 'filter', filter: { predicate: { op: 'in-keys', keys: ['k3'] } } });
  });

  it('explains a sort by the column of the control, with direction and comparator', () => {
    const byAmount = ['k4', 'k2', 'k1', 'k5', 'k3'];
    expect(classify(byAmount, { type: 'click', label: 'Amount' }, baseKeys, 'f03')).toEqual({ kind: 'sort', sort: { fieldId: 'f03', direction: 'ascending', comparator: 'number' } });
    expect(classify([...byAmount].reverse(), { type: 'click', label: 'Amount' }, byAmount, 'f03')).toEqual({ kind: 'sort', sort: { fieldId: 'f03', direction: 'descending', comparator: 'number' } });
  });

  it('calls a return to the base view a reset, and ignores no-ops and replaced items', () => {
    expect(classify(baseKeys, { type: 'fill', value: '', label: 'Search' }, ['k1'])).toEqual({ kind: 'reset' });
    expect(classify(baseKeys, { type: 'click', label: 'All' })).toBeNull();
    expect(classify(['x1', 'x2'], { type: 'click', label: 'Next' })).toBeNull();
  });
});
