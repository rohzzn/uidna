/**
 * Assemble the `collections` facet: repeated items measured in each page's
 * widest base state, and one rule per observed transition that searched,
 * filtered, sorted or reset a collection, classified by item identity
 * against the base items (see `classifyCollectionChange`).
 */
import type { Collection, CollectionRule, Collections, CollectionView, Transition, UiNode, UiState } from '@rohzzn/uidna-schema';
import {
  chooseIdentity,
  classifyCollectionChange,
  CollectionIndex,
  detectCollections,
  detectFields,
  itemKeys,
  subtreeText,
  type DetectedCollection,
  type DetectedField,
  type Identity,
} from '../domain/collections.js';
import { digestValue } from '../domain/digest.js';

interface Measured {
  readonly definition: Collection;
  readonly identity: Identity;
  readonly fields: readonly DetectedField[];
  readonly itemTag: string;
  readonly baseKeys: readonly string[];
  readonly values: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const isRendered = (node: UiNode): boolean => node.visible && node.box !== null && node.box.width > 0 && node.box.height > 0;

/** The collection as `state` shows it: keys of its rendered items in order, or null when the container is not rendered there. */
function viewOf(state: UiState, measured: Measured): { keys: string[]; index: CollectionIndex; container: UiNode } | null {
  const index = new CollectionIndex(state.nodes);
  const container = index.byPath.get(measured.definition.container.nodePath);
  if (container?.tag !== measured.definition.container.tag) return null;
  // An emptied container (a tbody without rows) has no box: it still shows the collection, with no items, while its parent is rendered.
  const parent = index.parent(container);
  if (state.styles[container.styleId]?.display === 'none') return null;
  if (!isRendered(container) && (parent === null || !isRendered(parent))) return null;
  const items = index.children(container).filter((child) => isRendered(child) && child.tag === measured.itemTag);
  return { keys: itemKeys(index, items, measured.identity), index, container };
}

/** A message shown only once no item is visible: a node near the container rendered in `after` and not in `before`. */
function emptyStateOf(before: UiState, after: { index: CollectionIndex; container: UiNode }): CollectionView['emptyState'] {
  const beforeIndex = new CollectionIndex(before.nodes);
  const region = after.index.ancestors(after.container).find((a) => a.tag === 'section' || a.tag === 'article' || a.tag === 'main' || a.role === 'region' || a.role === 'main');
  if (region === undefined) return null;
  const inside = `${after.container.path}/`;
  for (const node of after.index.subtree(region)) {
    if (!isRendered(node) || (node.text ?? '').trim() === '' || node.path === after.container.path || node.path.startsWith(inside)) continue;
    const earlier = beforeIndex.byPath.get(node.path);
    if (earlier !== undefined && isRendered(earlier)) continue;
    return { nodeId: node.id, nodePath: node.path, text: subtreeText(after.index, node) || null };
  }
  return null;
}

/** Measure the collections of one page in its widest base state. */
function measurePage(pageId: string, base: UiState, capturedAt: string, firstId: number): Measured[] {
  const index = new CollectionIndex(base.nodes);
  return detectCollections(base.nodes).map((detected: DetectedCollection, i) => {
    const identity = chooseIdentity(detected.items);
    const keys = itemKeys(index, detected.items, identity);
    const { fields, values } = detectFields(index, detected);
    const byKey = new Map<string, Readonly<Record<string, string>>>(detected.items.map((item, j) => [keys[j] ?? '', values.get(item) ?? {}] as const));
    const definition: Collection = {
      id: `col_${pad(firstId + i)}`,
      pageId,
      stateId: base.id,
      layout: detected.layout,
      container: { nodeId: detected.container.id, nodePath: detected.container.path, tag: detected.container.tag, role: detected.container.role, name: detected.container.name },
      item: { tag: detected.items[0]?.tag ?? 'div', role: detected.items[0]?.role ?? null, fingerprint: `fp_${digestValue(detected.signature, 12)}` },
      identity: { basis: identity.basis, attribute: identity.attribute },
      fields: fields.map((f) => ({ id: f.id, name: f.name, generatedName: f.generatedName, relativePath: f.relativePath, valueKind: f.valueKind, distinct: f.distinct })),
      items: detected.items.map((item, j) => ({ key: keys[j] ?? '', nodeId: item.id, nodePath: item.path, values: { ...(values.get(item) ?? {}) } })),
      provenance: { kind: 'measured', source: 'a11y-tree', stateId: base.id, viewport: { ...base.viewport }, evidenceId: base.evidenceId, capturedAt, confidence: 1 },
    };
    return { definition, identity, fields, itemTag: definition.item.tag, baseKeys: keys, values: byKey };
  });
}

/** The column of the control when it sits in a table header cell: its index among the header row's cells. */
function columnOf(state: UiState, path: string): { index: number; header: UiNode } | null {
  const index = new CollectionIndex(state.nodes);
  const node = index.byPath.get(path);
  if (node === undefined) return null;
  const header = [node, ...index.ancestors(node)].find((n) => n.tag === 'th' || n.role === 'columnheader');
  if (header === undefined) return null;
  const row = index.parent(header);
  if (row === null) return null;
  return { index: index.children(row).findIndex((cell) => cell.id === header.id), header };
}

function controlKind(state: UiState, transition: Transition): CollectionRule['control']['kind'] {
  if (transition.action.type === 'fill') return 'searchbox';
  const path = transition.action.target?.nodePath;
  if (path !== undefined && columnOf(state, path) !== null) return 'sort-header';
  const node = path === undefined ? undefined : state.nodes.find((n) => n.path === path);
  if (node?.attrs['aria-pressed'] !== undefined) return 'toggle-button';
  if (node?.role === 'tab') return 'tab';
  if (node?.tag === 'select') return 'select';
  return 'button';
}

/** Build the facet; null when no page has a collection. */
export function buildCollections(input: {
  readonly pages: readonly { readonly id: string; readonly bases: readonly UiState[] }[];
  readonly states: ReadonlyMap<string, UiState>;
  readonly transitions: readonly Transition[];
  readonly capturedAt: string;
}): Collections | null {
  const byPage = new Map<string, Measured[]>();
  let next = 1;
  for (const page of input.pages) {
    const widest = [...page.bases].sort((a, b) => b.viewport.width - a.viewport.width)[0];
    if (widest === undefined) continue;
    const measured = measurePage(page.id, widest, input.capturedAt, next);
    next += measured.length;
    if (measured.length > 0) byPage.set(page.id, measured);
  }
  if (byPage.size === 0) return null;

  const rules: CollectionRule[] = [];
  for (const transition of input.transitions) {
    // A side effect is never replayed or reproduced; neither is a navigation to another page.
    if (transition.sideEffects || (transition.navigation ?? null) !== null) continue;
    const from = input.states.get(transition.from);
    const to = input.states.get(transition.to);
    if (from === undefined || to?.pageId !== from.pageId) continue;
    for (const measured of byPage.get(from.pageId) ?? []) {
      const before = viewOf(from, measured);
      const after = viewOf(to, measured);
      if (before === null || after === null) continue;
      const target = transition.action.target;
      const column = target === null ? null : columnOf(from, target.nodePath);
      const columnFieldId = column === null ? null : (measured.fields.find((f) => f.relativePath === String(column.index))?.id ?? null);
      const label = transition.action.type === 'fill' ? (target?.name ?? null) : (target?.name ?? null);
      const change = classifyCollectionChange({
        baseKeys: measured.baseKeys,
        before: before.keys,
        after: after.keys,
        values: measured.values,
        fields: measured.fields,
        action: { type: transition.action.type, value: transition.action.value, label },
        columnFieldId,
      });
      if (change === null || target === null) continue;
      const afterHeader = column === null ? null : (to.nodes.find((n) => n.path === column.header.path) ?? null);
      const ariaSort = afterHeader?.attrs['aria-sort'];
      rules.push({
        id: `crl_${pad(rules.length + 1)}`,
        kind: change.kind,
        collectionId: measured.definition.id,
        transitionId: transition.id,
        control: { target: { ...target }, kind: controlKind(from, transition), label: target.name },
        event: transition.action.type === 'fill' ? { type: 'fill', value: transition.action.value ?? '' } : { type: 'click' },
        before: { stateId: from.id, keys: before.keys, emptyState: null },
        after: { stateId: to.id, keys: after.keys, emptyState: after.keys.length === 0 ? emptyStateOf(from, after) : null },
        ...(change.search === undefined ? {} : { search: { query: transition.action.value ?? '', match: change.search.match, fieldIds: [...change.search.fieldIds], explainsExcluded: change.search.explainsExcluded } }),
        ...(change.filter === undefined
          ? {}
          : { filter: { predicate: change.filter.predicate.op === 'in-keys' ? { op: 'in-keys', keys: [...change.filter.predicate.keys] } : { ...change.filter.predicate } } }),
        ...(change.sort === undefined ? {} : { sort: { ...change.sort, ariaSort: ariaSort === 'ascending' || ariaSort === 'descending' ? ariaSort : null } }),
        provenance: { ...transition.provenance, stateId: from.id },
      });
    }
  }
  return { definitions: [...byPage.values()].flat().map((m) => m.definition), rules };
}
