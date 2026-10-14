/**
 * Role tree deltas. A transition is compared by what it changed: the role
 * tree entries added and removed between its from and to states, in the
 * original and in the generated app. Entries are `role|name|expanded=…`
 * strings with normalized names, compared as multisets.
 */
import type { RoleTreeNode } from '@rohzzn/uidna-schema';
import { normalizeName } from './match.js';

/** Entries added and removed between two role trees. */
export interface RoleTreeDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** How two deltas differ. Prefixed `+` for added entries and `-` for removed ones. */
export interface DeltaComparison {
  readonly match: boolean;
  /** Entries of the original delta the generated delta lacks. */
  readonly missing: readonly string[];
  /** Entries of the generated delta the original delta lacks. */
  readonly extra: readonly string[];
}

/** One comparable entry per role tree node: `role|normalized name` plus `|expanded=<bool>` when the node exposes it. */
export function roleTreeEntry(node: RoleTreeNode): string {
  const expanded = node.states.expanded;
  const suffix = expanded === undefined ? '' : `|expanded=${String(expanded)}`;
  return `${node.role}|${normalizeName(node.name)}${suffix}`;
}

/** Entries of a role tree in document order. */
export function roleTreeEntries(tree: readonly RoleTreeNode[]): string[] {
  return tree.map(roleTreeEntry);
}

function countEntries(entries: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  return counts;
}

/** Multiset difference `a − b`, each entry repeated by its surplus, sorted. */
function surplus(a: readonly string[], b: readonly string[]): string[] {
  const countsA = countEntries(a);
  const countsB = countEntries(b);
  const out: string[] = [];
  for (const [entry, count] of countsA) {
    const extra = count - (countsB.get(entry) ?? 0);
    for (let i = 0; i < extra; i += 1) out.push(entry);
  }
  return out.sort();
}

/** Entries added and removed between `from` and `to`, as multisets. */
export function diffRoleTrees(from: readonly RoleTreeNode[], to: readonly RoleTreeNode[]): RoleTreeDelta {
  const before = roleTreeEntries(from);
  const after = roleTreeEntries(to);
  return { added: surplus(after, before), removed: surplus(before, after) };
}

/** Compare the original delta with the generated one. */
export function compareDeltas(original: RoleTreeDelta, generated: RoleTreeDelta): DeltaComparison {
  const missing = [...surplus(original.added, generated.added).map((e) => `+${e}`), ...surplus(original.removed, generated.removed).map((e) => `-${e}`)];
  const extra = [...surplus(generated.added, original.added).map((e) => `+${e}`), ...surplus(generated.removed, original.removed).map((e) => `-${e}`)];
  return { match: missing.length === 0 && extra.length === 0, missing, extra };
}
