import { describe, expect, it } from 'vitest';
import type { UiNode } from '@rohzzn/uidna-schema';
import { compareItemKeys, generatedItemKeys } from './collections.js';

function node(id: string, parentId: string | null, attrs: Record<string, string>, childIds: string[] = [], visible = true): UiNode {
  return {
    id,
    parentId,
    path: id,
    depth: 0,
    tag: 'tr',
    role: null,
    name: null,
    attrs,
    text: null,
    box: visible ? { x: 0, y: 0, width: 100, height: 20 } : null,
    styleId: 's0',
    a11y: {},
    visible,
    interactive: false,
    inForm: false,
    childIds,
  };
}

describe('generatedItemKeys', () => {
  const nodes = [
    node('n0', null, { 'data-uidna-path': '1/2' }, ['n1', 'n2', 'n3', 'n4']),
    node('n1', 'n0', { 'data-uidna-item': 'k2' }),
    node('n2', 'n0', { 'data-uidna-item': 'k1' }),
    node('n3', 'n0', { 'data-uidna-item': 'k3' }, [], false),
    node('n4', 'n0', {}),
  ];

  it('lists the rendered items of the container in document order', () => {
    expect(generatedItemKeys(nodes, '1/2')).toEqual(['k2', 'k1']);
  });

  it('returns null when the container is absent', () => {
    expect(generatedItemKeys(nodes, '9')).toBeNull();
  });
});

describe('compareItemKeys', () => {
  it('tells a different order apart from different items', () => {
    expect(compareItemKeys(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ membership: true, order: true, missing: [], extra: [] });
    expect(compareItemKeys(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual({ membership: true, order: false, missing: [], extra: [] });
    expect(compareItemKeys(['a', 'b'], ['a', 'x'])).toEqual({ membership: false, order: false, missing: ['b'], extra: ['x'] });
  });
});
