import { describe, expect, it } from 'vitest';
import { ComponentsSchema } from 'uidna-schema';
import type { CapturedState } from '../browser/types.js';
import { findComponents, VARIANT_IGNORED_PROPERTIES } from './components.js';
import { buildFixtureACaptures, findNodes } from './testing.js';

const captures = buildFixtureACaptures();
const components = findComponents(captures, { evidenceIdByState: { st_01: 'ev_000000000001', st_02: 'ev_000000000002' } });
const byTag = (tag: string) => components.definitions.filter((d) => d.structure.tag === tag);

describe('findComponents', () => {
  it('produces schema-valid components', () => {
    expect(ComponentsSchema.safeParse(components).success).toBe(true);
  });

  it('finds the three cards as one candidate with three instances per state', () => {
    const card = byTag('article')[0]!;
    expect(card.structure).toMatchObject({ tag: 'article', role: 'article', signature: 'article>div+h3+p', childCount: 3 });
    expect(card.matchesByState).toEqual({ st_01: 3, st_02: 3 });
    expect(card.instanceCount).toBe(6);
    expect(card.confidence).toBe(1);
    expect(card.provenance).toMatchObject({ kind: 'measured', source: 'a11y-tree', confidence: 1 });
    const instances = components.instances.filter((i) => i.definitionId === card.id);
    expect(instances).toHaveLength(6);
    const cardPaths = findNodes(captures.get('st_01')!, '.card').map((n) => n.path);
    expect(instances.filter((i) => i.stateId === 'st_01').map((i) => i.nodePath)).toEqual(cardPaths);
    expect(instances[0]!.box.provenance).toMatchObject({ kind: 'measured', source: 'bounding-box', stateId: 'st_01', evidenceId: 'ev_000000000001' });
  });

  it('detects text props where the card instances differ', () => {
    const card = byTag('article')[0]!;
    expect(card.props.map((p) => [p.name, p.kind, p.relativePath])).toEqual([
      ['h3-text', 'text', '1'],
      ['p-text', 'text', '2'],
    ]);
    expect(card.props[0]!.values).toEqual(['Capture quickly', 'Link naturally', 'Review calmly']);
    const first = components.instances.find((i) => i.definitionId === card.id)!;
    expect(first.props).toEqual({ 'h3-text': 'Capture quickly', 'p-text': expect.stringContaining('Jot down') });
  });

  it('groups the four nav links into one candidate', () => {
    const navLinks = findNodes(captures.get('st_01')!, '.nav-link');
    const candidate = components.definitions.find((d) => {
      const paths = components.instances.filter((i) => i.definitionId === d.id && i.stateId === 'st_01').map((i) => i.nodePath);
      return navLinks.every((n) => paths.includes(n.path)) && paths.length === 4;
    });
    expect(candidate).toBeDefined();
    expect(candidate!.structure.tag).toBe('a');
    expect(candidate!.props.map((p) => p.kind).sort()).toEqual(['link', 'text']);
    expect(candidate!.variants).toHaveLength(1);
  });

  it('makes the primary and secondary buttons two variants of one candidate', () => {
    const buttons = findNodes(captures.get('st_01')!, '.button');
    const candidate = components.definitions.find((d) =>
      components.instances.some((i) => i.definitionId === d.id && i.nodePath === buttons[0]!.path && i.stateId === 'st_01'),
    )!;
    expect(candidate.instanceCount).toBe(4);
    expect(candidate.variants).toHaveLength(2);
    const differing = candidate.variants[0]!.differences.map((d) => d.property);
    expect(differing).toEqual(expect.arrayContaining(['background-color', 'color', 'border-top-color']));
    expect(differing).not.toContain('width');
    const bg = candidate.variants[0]!.differences.find((d) => d.property === 'background-color')!;
    expect(bg.values).toEqual(['rgb(47, 91, 234)', 'rgb(255, 255, 255)']);
    // Confidence is the measured style agreement (structure agrees fully): share of design properties that do not differ.
    const styles = buttons.map((b) => captures.get('st_01')!.styles[b.styleId]!);
    const keys = new Set(styles.flatMap((s) => Object.keys(s)).filter((k) => !VARIANT_IGNORED_PROPERTIES.includes(k)));
    const differingCount = [...keys].filter((k) => new Set(styles.map((s) => s[k] ?? '(unset)')).size > 1).length;
    expect(candidate.confidence).toBeLessThan(1);
    expect(candidate.confidence).toBeCloseTo(1 - differingCount / keys.size, 3);
    const instances = components.instances.filter((i) => i.definitionId === candidate.id);
    expect(new Set(instances.map((i) => i.variantId)).size).toBe(2);
    expect(candidate.variants.flatMap((v) => v.instanceIds).sort()).toEqual(instances.map((i) => i.id).sort());
  });

  it('orders definitions by instance count and numbers ids and names', () => {
    const counts = components.definitions.map((d) => d.instanceCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(components.definitions.map((d) => d.id)).toEqual(components.definitions.map((_, i) => `cmp_${String(i + 1).padStart(2, '0')}`));
    expect(components.definitions[0]!.generatedName).toBe('Component01');
    expect(components.instances[0]!.id).toBe('inst_001');
  });

  it('never reports a leaf text container or a single path as a component', () => {
    for (const definition of components.definitions) {
      const paths = new Set(components.instances.filter((i) => i.definitionId === definition.id).map((i) => i.nodePath));
      expect(paths.size).toBeGreaterThanOrEqual(2);
      expect(['p', 'span', 'div'].includes(definition.structure.tag) && definition.structure.childCount === 0).toBe(false);
    }
  });

  it('honours minInstances', () => {
    const strict = findComponents(captures, { minInstances: 4 });
    for (const definition of strict.definitions) {
      const paths = new Set(strict.instances.filter((i) => i.definitionId === definition.id).map((i) => i.nodePath));
      expect(paths.size).toBeGreaterThanOrEqual(4);
    }
    expect(strict.definitions.length).toBeLessThan(components.definitions.length);
  });

  it('does not recurse forever on a capture whose childIds form a cycle', () => {
    const base = captures.get('st_01')!;
    const card = findNodes(base, '.card')[0]!;
    const icon = card.childIds[0]!;
    const cyclic: CapturedState = { ...base, nodes: base.nodes.map((n) => (n.id === icon ? { ...n, childIds: [...n.childIds, card.id] } : n)) };
    const result = findComponents(
      new Map([
        ['st_01', cyclic],
        ['st_02', captures.get('st_02')!],
      ]),
    );
    expect(ComponentsSchema.safeParse(result).success).toBe(true);
    expect(result.definitions.length).toBeGreaterThan(0);
  });
});
