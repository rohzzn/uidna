/**
 * Collection checks, the pure part: read the visible items of a collection in
 * the generated app (children of the container carrying `data-uidna-item`, in
 * document order) and compare them with the items the original showed after
 * the same action. A role-tree comparison cannot tell a sort apart from no
 * change (same rows, other order); this compares identity and order.
 */
import type { UiNode } from 'uidna-schema';

/** Keys of the rendered items under the generated container at `containerPath`, or null when the container is absent. */
export function generatedItemKeys(nodes: readonly UiNode[], containerPath: string): string[] | null {
  const container = nodes.find((node) => node.attrs['data-uidna-path'] === containerPath);
  if (container === undefined) return null;
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const keys: string[] = [];
  for (const id of container.childIds) {
    const child = byId.get(id);
    const key = child?.attrs['data-uidna-item'];
    if (child === undefined || key === undefined || !child.visible || child.box === null) continue;
    keys.push(key);
  }
  return keys;
}

export interface CollectionComparison {
  /** Same items, whatever the order. */
  readonly membership: boolean;
  /** Same items in the same order. */
  readonly order: boolean;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/** Compare the expected item keys with the generated ones. */
export function compareItemKeys(expected: readonly string[], generated: readonly string[]): CollectionComparison {
  const want = new Set(expected);
  const got = new Set(generated);
  const missing = expected.filter((key) => !got.has(key));
  const extra = generated.filter((key) => !want.has(key));
  const membership = missing.length === 0 && extra.length === 0;
  return { membership, order: membership && expected.length === generated.length && expected.every((key, i) => generated[i] === key), missing, extra };
}
