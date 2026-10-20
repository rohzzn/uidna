import { describe, expect, it } from 'vitest';
import { LayoutConstraintSchema } from 'uidna-schema';
import { computeLayout } from './layout.js';
import { buildFixtureACaptures, findNode } from './testing.js';

const captures = buildFixtureACaptures();
const layout = computeLayout(captures, { evidenceIdByState: { st_01: 'ev_000000000001', st_02: 'ev_000000000002' } });

describe('computeLayout', () => {
  it('produces schema-valid constraints for every visible container', () => {
    for (const constraint of layout) expect(LayoutConstraintSchema.safeParse(constraint).success).toBe(true);
    const containers = [...captures.entries()].flatMap(([, c]) => c.nodes.filter((n) => n.visible && n.childIds.length > 0));
    expect(layout).toHaveLength(containers.length);
  });

  it('reports the hero as a grid at 1280 with measured provenance', () => {
    const hero = findNode(captures.get('st_01')!, '.hero')!;
    const constraint = layout.find((c) => c.stateId === 'st_01' && c.nodeId === hero.id)!;
    expect(constraint.display.value).toBe('grid');
    expect(constraint.grid).toBeDefined();
    expect(constraint.grid!.templateColumns!.value).toBe('512px 512px');
    expect(constraint.grid!.gap!.value).toBe('48px');
    expect(constraint.flow).toBeUndefined();
    expect(constraint.display.provenance).toMatchObject({
      kind: 'measured',
      source: 'computed-style',
      stateId: 'st_01',
      viewport: { width: 1280, height: 800 },
      evidenceId: 'ev_000000000001',
    });
    expect(constraint.box.provenance).toMatchObject({ kind: 'measured', source: 'bounding-box' });
    expect(constraint.box.value).toEqual(hero.box);
    expect(constraint.spacing.padding.value).toBe('64px 24px 64px 24px');
    expect(constraint.spacing.margin.value).toBe('0px 80px 0px 80px');
    expect(constraint.sizing.maxWidth!.value).toBe('1120px');
    expect(constraint.sizing.minWidth).toBeUndefined();
    expect(constraint.position.value).toBe('static');
  });

  it('reports the navbar as flex with its flow values', () => {
    const nav = findNode(captures.get('st_01')!, '.navbar')!;
    const constraint = layout.find((c) => c.stateId === 'st_01' && c.nodeId === nav.id)!;
    expect(constraint.display.value).toBe('flex');
    expect(constraint.flow).toMatchObject({
      direction: { value: 'row' },
      wrap: { value: 'nowrap' },
      justify: { value: 'space-between' },
      align: { value: 'center' },
      gap: { value: '24px' },
    });
    expect(constraint.grid).toBeUndefined();
    expect(constraint.position.value).toBe('relative');
  });

  it('shows one column at 390 and never writes inferred provenance', () => {
    const grid = findNode(captures.get('st_02')!, '.card-grid')!;
    const constraint = layout.find((c) => c.stateId === 'st_02' && c.nodeId === grid.id)!;
    expect(constraint.grid!.templateColumns!.value).toBe('358px');
    const json = JSON.stringify(layout);
    expect(json).not.toContain('"inferred"');
  });
});
