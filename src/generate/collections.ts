/**
 * Collections in the generated project: a collection with observed search,
 * filter or sort rules renders its items from data through React state,
 * so the generated app narrows and reorders them the way the original did.
 *
 * - Items are the base items the scan measured (their displayed text per
 *   field, and parsed numbers and dates for sorting); each row keeps the
 *   generated markup of its captured element and gains `data-uidna-item`.
 * - The search control becomes a controlled input; the match (substring or
 *   word prefix, on the fields that explained the observed result) is the
 *   observed one.
 * - Each filter control applies the predicate observed for it (a field equal
 *   to a value, or the observed membership); a sibling toggle without a rule
 *   ("All") clears the filter.
 * - Each sort control sorts by the observed field; clicking the active
 *   column reverses it, as observed. `aria-sort` and `aria-pressed` follow
 *   the state; an empty-state message and an item count follow the view.
 *
 * Nothing is fetched: items are static data from the capture.
 */
import { emissionInState, transitionClasses, viewInState } from './styles.js';
import type { TokenIndex } from './tailwind-map.js';
import type { Collection, CollectionRule, UiDnaDocument, UiNode } from 'uidna-schema';
import { CollectionIndex, itemKeys, parseDate, parseNumber } from '../domain/collections.js';
import type { Expectation } from './behavior.js';
import { jsString, type JsxAttrValue } from './jsx.js';
import type { GenerationModel } from './model.js';
import type { ScopeResolver } from './behavior.js';

/** Attribute overrides of one rendered control. */
export interface ControlRender {
  readonly set: readonly (readonly [string, JsxAttrValue])[];
  readonly remove: readonly string[];
  readonly removeClasses: readonly string[];
  /** Variant classes that follow the control's state (`aria-pressed:…`), from the observed styles. */
  readonly addClasses?: readonly string[];
}

/** One implemented collection. */
export interface CollectionPlan {
  readonly id: string;
  /** Two-digit suffix of the generated names (`query01`, `visible01`, …). */
  readonly suffix: string;
  readonly file: string;
  readonly containerPath: string;
  /** Item root path → key, in base order. */
  readonly itemPaths: ReadonlyMap<string, string>;
  readonly hasSearch: boolean;
  readonly hasFilter: boolean;
  readonly hasSort: boolean;
  /** `COLLECTION_NN` constant (TypeScript source). */
  readonly constant: string;
  readonly initialSort: { readonly field: string; readonly direction: 'ascending' | 'descending' } | null;
  readonly ruleIds: readonly string[];
  /** README lines. */
  readonly notes: readonly string[];
}

/** A transition reproduced by a collection: reported implemented, with its test expectations. */
export interface CollectionClaim {
  readonly detail: string;
  readonly file: string;
  readonly expectations: readonly Expectation[];
}

export interface CollectionPlanning {
  readonly plans: readonly CollectionPlan[];
  /** Render path → the plan whose container it is. */
  readonly containers: ReadonlyMap<string, CollectionPlan>;
  /** Render path → plan and key of an item root. */
  readonly itemRoots: ReadonlyMap<string, { readonly plan: CollectionPlan; readonly key: string }>;
  readonly controls: ReadonlyMap<string, ControlRender>;
  /** Render path → expression code of a text that follows the view (an item count). */
  readonly texts: ReadonlyMap<string, string>;
  readonly claimed: ReadonlyMap<string, CollectionClaim>;
  /** Collections with rules the generator could not implement, with the reason. */
  readonly notImplemented: readonly { readonly id: string; readonly reason: string }[];
}

const EMPTY: CollectionPlanning = { plans: [], containers: new Map(), itemRoots: new Map(), controls: new Map(), texts: new Map(), claimed: new Map(), notImplemented: [] };

const pad = (n: number): string => String(n).padStart(2, '0');

/** The informative search rule: one that kept some items with an explained match. */
function searchSpec(rules: readonly CollectionRule[]): { fieldIds: readonly string[]; match: 'substring' | 'word-prefix' } | null {
  const searches = rules.filter((r) => r.kind === 'search' && r.search !== undefined);
  if (searches.length === 0) return null;
  const informative = searches.find((r) => r.after.keys.length > 0 && r.search?.match !== 'unknown') ?? searches.find((r) => r.search?.match !== 'unknown');
  const search = informative?.search;
  if (search === undefined || search.match === 'unknown') return { fieldIds: [], match: 'substring' };
  return { fieldIds: [...search.fieldIds], match: search.match };
}

/** Parsed sort values of an item by field kind. */
function sortValues(collection: Collection, values: Readonly<Record<string, string>>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const field of collection.fields) {
    const text = values[field.id] ?? '';
    const parsed = field.valueKind === 'number' ? parseNumber(text) : field.valueKind === 'date' ? parseDate(text) : null;
    out[field.id] = parsed ?? text;
  }
  return out;
}

/**
 * Paths that must render as plain elements for the page's implemented
 * collections: each container (its rows render from data), each control, and
 * the group holding a filter control (its sibling toggles share the filter).
 * Component instances rooted there are not planned.
 */
export function collectionContainerPaths(dna: UiDnaDocument, model: GenerationModel): string[] {
  const rules = dna.collections?.rules ?? [];
  const index = new CollectionIndex(model.narrowest.state.nodes);
  const out = new Set<string>();
  for (const definition of dna.collections?.definitions ?? []) {
    if (definition.pageId !== model.pageId) continue;
    const own = rules.filter((r) => r.collectionId === definition.id);
    if (!own.some((r) => r.kind === 'search' || r.kind === 'filter' || r.kind === 'sort')) continue;
    out.add(definition.container.nodePath);
    for (const rule of own) {
      const path = rule.control.target.nodePath;
      out.add(path);
      const node = index.byPath.get(path);
      const parent = node === undefined ? null : index.parent(node);
      if (rule.kind === 'filter' && parent !== null && parent.path !== '') out.add(parent.path);
    }
  }
  return [...out];
}

/** Plan the collections of one page. */
export function planCollections(dna: UiDnaDocument, model: GenerationModel, resolve: ScopeResolver, tokens: TokenIndex): CollectionPlanning {
  const definitions = (dna.collections?.definitions ?? []).filter((d) => d.pageId === model.pageId);
  if (definitions.length === 0) return EMPTY;
  const allRules = dna.collections?.rules ?? [];
  const index = new CollectionIndex(model.narrowest.state.nodes);
  const plans: CollectionPlan[] = [];
  const containers = new Map<string, CollectionPlan>();
  const itemRoots = new Map<string, { plan: CollectionPlan; key: string }>();
  const controls = new Map<string, ControlRender>();
  const texts = new Map<string, string>();
  const claimed = new Map<string, CollectionClaim>();
  const notImplemented: { id: string; reason: string }[] = [];

  for (const definition of definitions) {
    const rules = allRules.filter((r) => r.collectionId === definition.id);
    if (!rules.some((r) => r.kind === 'search' || r.kind === 'filter' || r.kind === 'sort')) continue;
    const skip = (reason: string): void => {
      notImplemented.push({ id: definition.id, reason });
    };
    const containerGn = model.byPath.get(definition.container.nodePath);
    const location = resolve(definition.container.nodePath);
    if (containerGn?.kind !== 'element' || location === null) {
      skip('its container is not a rendered element of the narrowest base state');
      continue;
    }
    if (location.instanceRoot !== null) {
      skip('its container is inside a component instance; collection state is not hoisted into components');
      continue;
    }
    const containerNode = index.byPath.get(definition.container.nodePath);
    if (containerNode === undefined) {
      skip('its container is missing from the narrowest base state');
      continue;
    }
    const items = index.children(containerNode).filter((child) => child.tag === definition.item.tag);
    const keys = itemKeys(index, items, { basis: definition.identity.basis, attribute: definition.identity.attribute });
    const pathByKey = new Map(keys.map((key, i) => [key, items[i]?.path ?? ''] as const));
    if (!definition.items.every((item) => pathByKey.has(item.key))) {
      skip('its items differ between the narrowest and the widest base state');
      continue;
    }
    const sameFile = (path: string): boolean => {
      const where = resolve(path);
      return where !== null && where.file === location.file && where.instanceRoot === null;
    };
    const usable = rules.filter((r) => sameFile(r.control.target.nodePath));
    const dropped = rules.filter((r) => !usable.includes(r));
    const suffix = pad(plans.length + 1);
    const query = `query${suffix}`;
    const filter = `filter${suffix}`;
    const sort = `sort${suffix}`;
    const visible = `visible${suffix}`;
    const notes: string[] = [];

    // Search
    const search = searchSpec(usable);
    const searchControls = [...new Set(usable.filter((r) => r.kind === 'search' || (r.kind === 'reset' && r.event.type === 'fill')).map((r) => r.control.target.nodePath))];
    for (const path of searchControls) {
      controls.set(path, { set: [['value', { kind: 'expr', code: query }], ['onChange', { kind: 'expr', code: `(event) => set${cap(query)}(event.target.value)` }]], remove: ['value', 'defaultValue'], removeClasses: [] });
    }
    if (search !== null) {
      const names = search.fieldIds.map((id) => definition.fields.find((f) => f.id === id)?.name ?? id);
      notes.push(`search: ${search.match} match on ${names.length === 0 ? 'all visible text' : names.join(', ')}, as observed (${usable.filter((r) => r.kind === 'search').map((r) => `"${r.event.value ?? ''}" in ${r.transitionId}`).join(', ')})`);
    }

    // Filters
    const filters: Record<string, { op: string; fieldId?: string; value?: string; keys?: string[] }> = {};
    const filterRules = usable.filter((r) => r.kind === 'filter' && r.event.type === 'click' && r.filter !== undefined);
    const filterPaths = [...new Set(filterRules.map((r) => r.control.target.nodePath))];
    filterPaths.forEach((path, i) => {
      const rule = filterRules.find((r) => r.control.target.nodePath === path);
      if (rule?.filter === undefined) return;
      const key = `c${i + 1}`;
      const predicate = rule.filter.predicate;
      filters[key] = predicate.op === 'in-keys' ? { op: 'in-keys', keys: [...predicate.keys] } : { op: predicate.op, fieldId: predicate.fieldId, value: predicate.value };
      const node = index.byPath.get(path);
      const pressed = pressedAttribute(node);
      const set: [string, JsxAttrValue][] = [['onClick', { kind: 'expr', code: pressed === null ? `() => set${cap(filter)}(${jsString(key)})` : `() => set${cap(filter)}((current) => (current === ${jsString(key)} ? null : ${jsString(key)}))` }]];
      if (pressed !== null) set.push([pressed, { kind: 'expr', code: `${filter} === ${jsString(key)} ? 'true' : 'false'` }]);
      // The pressed look, as observed when this control was clicked from the base view.
      const addClasses = pressed === null ? [] : stateClasses(model, tokens, dna, path, rule.before.stateId, rule.after.stateId, `${pressed}:`);
      controls.set(path, { set, remove: pressed === null ? [] : [pressed], removeClasses: [], addClasses });
      const field = predicate.op === 'in-keys' ? null : definition.fields.find((f) => f.id === predicate.fieldId);
      notes.push(`filter "${rule.control.label ?? path}": ${predicate.op === 'in-keys' ? `the ${predicate.keys.length} items observed (no visible field explains it)` : `${field?.name ?? predicate.fieldId} ${predicate.op} "${predicate.value}"`}`);
    });
    // Sibling toggles without a rule (an "All" chip) clear the filter.
    for (const path of filterPaths) {
      const node = index.byPath.get(path);
      const pressed = pressedAttribute(node);
      const parent = node === undefined ? null : index.parent(node);
      if (pressed === null || parent === null) continue;
      for (const sibling of index.children(parent)) {
        if (filterPaths.includes(sibling.path) || sibling.attrs[pressed] === undefined || controls.has(sibling.path) || !sameFile(sibling.path)) continue;
        // Pressed in the base view: its unpressed look, as observed while another filter was active.
        const sample = filterRules.find((r) => r.control.target.nodePath !== sibling.path);
        const addClasses = sample === undefined ? [] : stateClasses(model, tokens, dna, sibling.path, sample.before.stateId, sample.after.stateId, `${pressed.replace(/^aria-/, 'aria-[')}=false]:`);
        controls.set(sibling.path, { set: [['onClick', { kind: 'expr', code: `() => set${cap(filter)}(null)` }], [pressed, { kind: 'expr', code: `${filter} === null ? 'true' : 'false'` }]], remove: [pressed], removeClasses: [], addClasses });
        notes.push(`"${sibling.name ?? sibling.path}" clears the filter (a sibling toggle with no observed effect from the base view)`);
      }
    }

    // Sorts
    const sortRules = usable.filter((r) => r.kind === 'sort' && r.sort?.fieldId !== null && r.sort?.fieldId !== undefined && r.sort.direction !== null);
    const initialSort = initialSortOf(index, containerNode, definition);
    const sortPaths = [...new Set(sortRules.map((r) => r.control.target.nodePath))];
    for (const path of sortPaths) {
      const rule = sortRules.find((r) => r.control.target.nodePath === path);
      const fieldId = rule?.sort?.fieldId;
      const direction = rule?.sort?.direction;
      if (fieldId === undefined || fieldId === null || direction === undefined || direction === null) continue;
      // The first click on another column sorts ascending unless it was observed otherwise; on the active column it reverses.
      const first = initialSort?.field === fieldId ? 'ascending' : direction;
      controls.set(path, {
        set: [['onClick', { kind: 'expr', code: `() => set${cap(sort)}((current) => (current?.field === ${jsString(fieldId)} ? { field: ${jsString(fieldId)}, direction: current.direction === 'ascending' ? 'descending' : 'ascending' } : { field: ${jsString(fieldId)}, direction: ${jsString(first)} }))` }]],
        remove: [],
        removeClasses: [],
      });
      const header = headerOf(index, path);
      if (header !== null) controls.set(header.path, { set: [['aria-sort', { kind: 'expr', code: `${sort}?.field === ${jsString(fieldId)} ? ${sort}.direction : undefined` }]], remove: ['aria-sort'], removeClasses: [] });
      const field = definition.fields.find((f) => f.id === fieldId);
      notes.push(`sort "${rule?.control.label ?? path}": by ${field?.name ?? fieldId} (${rule?.sort?.comparator ?? 'text'}), first click ${first}, again to reverse`);
    }

    // Empty state and count
    for (const rule of usable) {
      const empty = rule.after.emptyState;
      if (empty === null || !sameFile(empty.nodePath)) continue;
      controls.set(empty.nodePath, { set: [['hidden', { kind: 'expr', code: `${visible}.length !== 0` }]], remove: ['hidden'], removeClasses: ['hidden'] });
    }
    for (const counter of countTexts(dna, usable, definition, index)) {
      if (!sameFile(counter.path) || texts.has(counter.path)) continue;
      texts.set(counter.path, counter.template.split(COUNT_MARK).map((part) => jsString(part)).join(` + String(${visible}.length) + `));
    }

    const data = {
      items: definition.items.map((item) => ({ key: item.key, text: item.values, sort: sortValues(definition, item.values) })),
      search,
      filters,
      fields: Object.fromEntries(definition.fields.map((f) => [f.id, f.valueKind])),
      initialSort,
    };
    const plan: CollectionPlan = {
      id: definition.id,
      suffix,
      file: location.file,
      containerPath: definition.container.nodePath,
      itemPaths: new Map(definition.items.map((item) => [pathByKey.get(item.key) ?? '', item.key] as const)),
      hasSearch: search !== null && searchControls.length > 0,
      hasFilter: Object.keys(filters).length > 0,
      hasSort: sortPaths.length > 0,
      constant: `const COLLECTION_${suffix}: CollectionSpec = ${JSON.stringify(data, null, 2)};`,
      initialSort,
      ruleIds: usable.map((r) => r.id),
      notes: [...notes, ...dropped.map((r) => `${r.id} (${r.kind}) not reproduced: its control is rendered in another file than the collection`)],
    };
    plans.push(plan);
    containers.set(plan.containerPath, plan);
    for (const [path, key] of plan.itemPaths) itemRoots.set(path, { plan, key });
    for (const rule of usable) {
      const expectations: Expectation[] = [{ kind: 'collection', containerPath: plan.containerPath, keys: [...rule.after.keys] }];
      if (rule.after.emptyState !== null) expectations.push({ kind: 'visible', locator: { path: rule.after.emptyState.nodePath, role: null, name: null, nth: null }, visible: true });
      claimed.set(rule.transitionId, { detail: `collection rule ${rule.id} (${rule.kind}) of ${definition.id} in ${location.file}`, file: location.file, expectations });
    }
  }
  return { plans, containers, itemRoots, controls, texts, claimed, notImplemented };
}

/** Marks the item count inside a count text template; never in page text (a NUL character). */
const COUNT_MARK = '\u0000COUNT\u0000';

/**
 * Classes, under `prefix`, that turn the node at `path` from its look in
 * `fromStateId` into its look in `toStateId` (the observed styles of one
 * control state).
 */
function stateClasses(model: GenerationModel, tokens: TokenIndex, dna: UiDnaDocument, path: string, fromStateId: string, toStateId: string, prefix: string): string[] {
  const gn = model.byPath.get(path);
  const from = dna.states.items.find((s) => s.id === fromStateId);
  const to = dna.states.items.find((s) => s.id === toStateId);
  if (gn === undefined || from === undefined || to === undefined) return [];
  const viewFrom = viewInState(gn, from, new Map(from.nodes.map((n) => [n.path, n] as const)));
  const viewTo = viewInState(gn, to, new Map(to.nodes.map((n) => [n.path, n] as const)));
  if (viewFrom === null || viewTo === null) return [];
  const options = { skipUaDefaults: false, inheritedSkip: null };
  return transitionClasses(emissionInState(viewFrom, from, options), emissionInState(viewTo, to, options), tokens, prefix).classes;
}

const cap = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** `aria-pressed` for toggle buttons, `aria-selected` for tabs, else null. */
function pressedAttribute(node: UiNode | undefined): string | null {
  if (node === undefined) return null;
  if (node.attrs['aria-pressed'] !== undefined) return 'aria-pressed';
  if (node.role === 'tab' && node.attrs['aria-selected'] !== undefined) return 'aria-selected';
  return null;
}

/** The header cell holding the control at `path`. */
function headerOf(index: CollectionIndex, path: string): UiNode | null {
  const node = index.byPath.get(path);
  if (node === undefined) return null;
  return [node, ...index.ancestors(node)].find((n) => n.tag === 'th' || n.role === 'columnheader') ?? null;
}

/** The sort the base view shows: a header cell of the collection's table with `aria-sort`. */
function initialSortOf(index: CollectionIndex, container: UiNode, definition: Collection): CollectionPlan['initialSort'] {
  const table = [container, ...index.ancestors(container)].find((n) => n.tag === 'table');
  if (table === undefined) return null;
  for (const node of index.subtree(table)) {
    const sorted = node.attrs['aria-sort'];
    if ((node.tag !== 'th' && node.role !== 'columnheader') || (sorted !== 'ascending' && sorted !== 'descending')) continue;
    const row = index.parent(node);
    const column = row === null ? -1 : index.children(row).findIndex((cell) => cell.id === node.id);
    const field = definition.fields.find((f) => f.relativePath === String(column));
    if (field !== undefined) return { field: field.id, direction: sorted };
  }
  return null;
}

/**
 * Texts that state the number of visible items ("Showing 4 of 10 orders"):
 * nodes whose text differs between a rule's before and after states only in
 * tokens equal to the item counts. The template marks the count with `COUNT_MARK`.
 */
function countTexts(dna: UiDnaDocument, rules: readonly CollectionRule[], definition: Collection, index: CollectionIndex): { path: string; template: string }[] {
  const states = new Map(dna.states.items.map((s) => [s.id, s] as const));
  const out = new Map<string, string>();
  for (const rule of rules) {
    const before = states.get(rule.before.stateId);
    const after = states.get(rule.after.stateId);
    if (before === undefined || after === undefined || rule.before.keys.length === rule.after.keys.length) continue;
    const afterByPath = new Map(after.nodes.map((n) => [n.path, n] as const));
    for (const node of before.nodes) {
      const text = node.text;
      const later = afterByPath.get(node.path)?.text;
      if (text === null || later === null || later === undefined || text === later || node.path.startsWith(`${definition.container.nodePath}/`)) continue;
      const a = text.split(' ');
      const b = later.split(' ');
      if (a.length !== b.length) continue;
      let ok = true;
      let counted = false;
      const template = a.map((token, i) => {
        if (token === b[i]) return token;
        if (token === String(rule.before.keys.length) && b[i] === String(rule.after.keys.length)) {
          counted = true;
          return COUNT_MARK;
        }
        ok = false;
        return token;
      });
      if (ok && counted && index.byPath.get(node.path)?.text === text) out.set(node.path, template.join(' '));
    }
  }
  return [...out.entries()].map(([path, template]) => ({ path, template }));
}

/** `src/lib/collection.ts`: the view logic every collection uses. */
export function renderCollectionLib(): string {
  return `// Generated by UI DNA: search, filter and sort over the items a collection shows.
export interface CollectionItem {
  readonly key: string;
  /** Displayed text per field id. */
  readonly text: Readonly<Record<string, string>>;
  /** Comparable value per field id (parsed number or date, else the text). */
  readonly sort: Readonly<Record<string, number | string>>;
}

export type Predicate =
  | { readonly op: 'equals' | 'contains'; readonly fieldId?: string; readonly value?: string }
  | { readonly op: 'in-keys'; readonly keys?: readonly string[] };

export interface CollectionSpec {
  readonly items: readonly CollectionItem[];
  readonly search: { readonly fieldIds: readonly string[]; readonly match: 'substring' | 'word-prefix' } | null;
  readonly filters: Readonly<Record<string, Predicate>>;
  readonly fields: Readonly<Record<string, 'number' | 'date' | 'text'>>;
  readonly initialSort: { readonly field: string; readonly direction: 'ascending' | 'descending' } | null;
}

export interface CollectionView {
  readonly query: string;
  readonly filter: string | null;
  readonly sort: { readonly field: string; readonly direction: 'ascending' | 'descending' } | null;
}

const fold = (text: string): string => text.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function matchesQuery(spec: CollectionSpec, item: CollectionItem, query: string): boolean {
  if (spec.search === null) return true;
  const ids = spec.search.fieldIds.length > 0 ? spec.search.fieldIds : Object.keys(item.text);
  const text = fold(ids.map((id) => item.text[id] ?? '').join(' '));
  const q = fold(query.trim());
  if (spec.search.match === 'word-prefix') return text.split(/[^a-z0-9]+/).some((word) => word.startsWith(q));
  return text.includes(q);
}

function matchesPredicate(predicate: Predicate | undefined, item: CollectionItem): boolean {
  if (predicate === undefined) return true;
  if (predicate.op === 'in-keys') return (predicate.keys ?? []).includes(item.key);
  const value = fold((item.text[predicate.fieldId ?? ''] ?? '').trim());
  const wanted = fold((predicate.value ?? '').trim());
  return predicate.op === 'equals' ? value === wanted : value.includes(wanted);
}

function compare(a: CollectionItem, b: CollectionItem, field: string, kind: 'number' | 'date' | 'text'): number {
  const x = a.sort[field];
  const y = b.sort[field];
  if (kind !== 'text' && typeof x === 'number' && typeof y === 'number') return x === y ? 0 : x < y ? -1 : 1;
  return collator.compare(String(x ?? ''), String(y ?? ''));
}

/** The items to show for a view, in order. */
export function applyView(spec: CollectionSpec, view: CollectionView): readonly CollectionItem[] {
  let items = spec.items.filter((item) => matchesPredicate(view.filter === null ? undefined : spec.filters[view.filter], item));
  if (view.query.trim() !== '') items = items.filter((item) => matchesQuery(spec, item, view.query));
  const sort = view.sort;
  const initial = spec.initialSort;
  if (sort !== null && !(initial !== null && initial.field === sort.field && initial.direction === sort.direction)) {
    const kind = spec.fields[sort.field] ?? 'text';
    items = [...items].sort((a, b) => (sort.direction === 'ascending' ? 1 : -1) * compare(a, b, sort.field, kind));
  }
  return items;
}
`;
}
