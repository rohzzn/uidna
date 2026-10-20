/**
 * Collections, the pure part: repeated items in one container (table rows,
 * list items, a card grid), their identity across states, their fields and
 * values, the search query a search control is tried with, and how a
 * transition changed a collection (search, filter, sort, reset).
 *
 * Works on the node lists of captures and document states alike. Item
 * identity never uses node paths (they are positional per capture): an
 * identity attribute shared by every item with distinct values, else a
 * digest of the item's text.
 */
import type { UiNode } from 'uidna-schema';
import { digestValue } from './digest.js';

/** Minimum number of repeated items for a container to be a collection. */
export const MIN_ITEMS = 3;
/** Share of a container's visible children the repeated items must make up. */
export const ITEM_SHARE = 0.6;
/** Attributes tried, in order, as item identity. */
export const IDENTITY_ATTRIBUTES = ['data-id', 'data-key', 'data-item-id', 'data-row-key', 'data-testid', 'id'] as const;
/** Landmarks whose repeated children are menus or footer links, not collections. */
const EXCLUDED_ANCESTOR_ROLES: ReadonlySet<string> = new Set(['navigation', 'banner', 'contentinfo', 'menu', 'menubar', 'tablist', 'listbox', 'radiogroup', 'combobox']);
const NON_CONTAINER_TAGS: ReadonlySet<string> = new Set(['tr', 'thead', 'tfoot', 'select', 'datalist', 'optgroup', 'svg', 'head', 'html', 'script', 'style', 'template', 'picture', 'video', 'audio']);
/** Synthetic queries that match nothing, tried in order until one is absent from the page. */
export const NO_MATCH_QUERIES = ['zqxj', 'xqzv', 'qjzx'] as const;

/** Node lookups of one state. */
export class CollectionIndex {
  readonly byId: ReadonlyMap<string, UiNode>;
  readonly byPath: ReadonlyMap<string, UiNode>;

  constructor(readonly nodes: readonly UiNode[]) {
    this.byId = new Map(nodes.map((n) => [n.id, n] as const));
    this.byPath = new Map(nodes.map((n) => [n.path, n] as const));
  }

  children(node: UiNode): UiNode[] {
    return node.childIds.map((id) => this.byId.get(id)).filter((n): n is UiNode => n !== undefined);
  }

  parent(node: UiNode): UiNode | null {
    return node.parentId === null ? null : (this.byId.get(node.parentId) ?? null);
  }

  /** Ancestors from the parent up to `<body>`. */
  ancestors(node: UiNode): UiNode[] {
    const out: UiNode[] = [];
    let current = this.parent(node);
    while (current !== null) {
      out.push(current);
      current = this.parent(current);
    }
    return out;
  }

  /** The node and its descendants in document order. */
  subtree(node: UiNode): UiNode[] {
    const out: UiNode[] = [];
    const walk = (n: UiNode): void => {
      out.push(n);
      for (const child of this.children(n)) walk(child);
    };
    walk(node);
    return out;
  }
}

const isRendered = (node: UiNode): boolean => node.visible && node.box !== null && node.box.width > 0 && node.box.height > 0;

/** Text of a subtree: own texts in document order, whitespace collapsed. Hidden nodes count when `all` is true. */
export function subtreeText(index: CollectionIndex, node: UiNode, all = false): string {
  return index
    .subtree(node)
    .filter((n) => all || isRendered(n))
    .map((n) => n.text ?? '')
    .filter((t) => t.trim() !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Structure of an item ignoring text, attributes and style: tag and role, children to `depth`. */
export function structureSignature(index: CollectionIndex, node: UiNode, depth = 3): string {
  const head = `${node.tag}${node.role === null ? '' : `[${node.role}]`}`;
  if (depth <= 0) return head;
  const kids = index.children(node).map((child) => structureSignature(index, child, depth - 1));
  return kids.length === 0 ? head : `${head}(${kids.join(',')})`;
}

export interface DetectedCollection {
  readonly container: UiNode;
  readonly items: readonly UiNode[];
  readonly signature: string;
  readonly layout: 'table' | 'list' | 'grid';
}

/** Containers whose visible children repeat one structure (see `MIN_ITEMS`, `ITEM_SHARE`). */
export function detectCollections(nodes: readonly UiNode[]): DetectedCollection[] {
  const index = new CollectionIndex(nodes);
  const out: DetectedCollection[] = [];
  for (const node of nodes) {
    if (!isRendered(node) || NON_CONTAINER_TAGS.has(node.tag)) continue;
    const visible = index.children(node).filter(isRendered);
    if (visible.length < MIN_ITEMS) continue;
    if (index.ancestors(node).some((a) => a.role !== null && EXCLUDED_ANCESTOR_ROLES.has(a.role)) || (node.role !== null && EXCLUDED_ANCESTOR_ROLES.has(node.role))) continue;
    const groups = new Map<string, UiNode[]>();
    for (const child of visible) {
      const signature = structureSignature(index, child);
      groups.set(signature, [...(groups.get(signature) ?? []), child]);
    }
    let best: [string, UiNode[]] | null = null;
    for (const entry of groups) if (best === null || entry[1].length > best[1].length) best = entry;
    if (best === null || best[1].length < MIN_ITEMS || best[1].length < ITEM_SHARE * visible.length) continue;
    if (!best[1].every((item) => subtreeText(index, item, true) !== '')) continue;
    // Leaf items (no element children: paragraphs of a card, a row of buttons) are a collection only in a real list.
    const isList = node.tag === 'ul' || node.tag === 'ol' || node.role === 'list' || node.role === 'feed';
    if (!isList && best[1].every((item) => index.children(item).length === 0)) continue;
    const layout = node.tag === 'tbody' || node.tag === 'table' || node.role === 'rowgroup' ? 'table' : node.tag === 'ul' || node.tag === 'ol' || node.role === 'list' || node.role === 'feed' ? 'list' : 'grid';
    out.push({ container: node, items: best[1], signature: best[0], layout });
  }
  return out;
}

/** How items are identified across states. */
export interface Identity {
  readonly basis: 'attribute' | 'text';
  readonly attribute: string | null;
}

/** The first identity attribute present on every item with distinct values, else text. */
export function chooseIdentity(items: readonly UiNode[]): Identity {
  for (const attribute of IDENTITY_ATTRIBUTES) {
    const values = items.map((item) => item.attrs[attribute]);
    if (values.every((v) => v !== undefined && v !== '') && new Set(values).size === items.length) return { basis: 'attribute', attribute };
  }
  return { basis: 'text', attribute: null };
}

/** Keys of items in order; duplicates get an occurrence suffix (`#2`). */
export function itemKeys(index: CollectionIndex, items: readonly UiNode[], identity: Identity): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const raw =
      identity.basis === 'attribute' && identity.attribute !== null && item.attrs[identity.attribute] !== undefined
        ? `${identity.attribute}:${item.attrs[identity.attribute] ?? ''}`
        : `t:${digestValue(subtreeText(index, item, true).toLowerCase(), 12)}`;
    const count = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, count);
    return count === 1 ? raw : `${raw}#${count}`;
  });
}

/** One field of a collection's items. */
export interface DetectedField {
  readonly id: string;
  readonly name: string | null;
  readonly generatedName: string;
  readonly relativePath: string;
  readonly valueKind: 'number' | 'date' | 'text';
  readonly distinct: number;
}

/** Path of `node` relative to `root` (`''` for the root itself), or null when it is not inside. */
export function relativePath(root: UiNode, node: UiNode): string | null {
  if (node.path === root.path) return '';
  const prefix = root.path === '' ? '' : `${root.path}/`;
  return node.path.startsWith(prefix) ? node.path.slice(prefix.length) : null;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Parse a displayed value as a number (`$1,240.00`, `12%`, `-3.5`), or null. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  // A currency symbol or a 3-letter code with a space may lead; a percent sign or a short unit may follow. `ORD-1001` is not a number.
  const match = /^((?:[A-Z]{3}\s)|[^\p{L}\p{N}\s\-−(]{0,3})?\s*([-−(]?)\s*([\d,]*\.?\d+)\)?\s*(%|[^\p{L}\p{N}\s]{0,3}|\s?[A-Za-z]{1,4})?$/u.exec(trimmed);
  if (match === null) return null;
  const digits = (match[3] ?? '').replace(/,/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const negative = match[2] === '-' || match[2] === '−' || match[2] === '(';
  return negative ? -value : value;
}

/** Parse a displayed value as a date (ISO `2026-09-14`, or a date with a month name and a 4-digit year), as epoch ms; null otherwise. */
export function parseDate(text: string): number | null {
  const trimmed = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(trimmed);
  if (iso !== null) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0));
    return Number.isFinite(ms) ? ms : null;
  }
  if (/\b\d{4}\b/.test(trimmed) && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b/i.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** `number` or `date` when every non-empty value parses as one, else `text`. */
export function valueKindOf(values: readonly string[]): 'number' | 'date' | 'text' {
  const present = values.filter((v) => v.trim() !== '');
  if (present.length === 0) return 'text';
  if (present.every((v) => parseDate(v) !== null)) return 'date';
  if (present.every((v) => parseNumber(v) !== null)) return 'number';
  return 'text';
}

/** Header texts of the table that holds `container` (a `tbody`), by column index. */
function headerTexts(index: CollectionIndex, container: UiNode): (string | null)[] {
  const table = container.tag === 'table' ? container : index.ancestors(container).find((a) => a.tag === 'table');
  if (table === undefined) return [];
  const thead = index.children(table).find((c) => c.tag === 'thead');
  const row = thead === undefined ? undefined : index.children(thead).find((c) => c.tag === 'tr');
  if (row === undefined) return [];
  return index.children(row).map((cell) => {
    const text = subtreeText(index, cell, true);
    return text === '' ? null : text;
  });
}

/** Fields of the items: table columns, or text-bearing parts present in most items. */
export function detectFields(index: CollectionIndex, collection: DetectedCollection): { fields: DetectedField[]; values: Map<UiNode, Record<string, string>> } {
  const items = collection.items;
  const values = new Map<UiNode, Record<string, string>>(items.map((item) => [item, {}]));
  const fields: DetectedField[] = [];
  const add = (name: string | null, generatedBase: string, rel: string, perItem: readonly string[]): void => {
    const id = `f${String(fields.length + 1).padStart(2, '0')}`;
    const used = new Set(fields.map((f) => f.generatedName));
    let generatedName = generatedBase === '' ? `field-${fields.length + 1}` : generatedBase;
    for (let n = 2; used.has(generatedName); n += 1) generatedName = `${generatedBase}-${n}`;
    fields.push({ id, name, generatedName, relativePath: rel, valueKind: valueKindOf(perItem), distinct: new Set(perItem).size });
    items.forEach((item, i) => {
      const record = values.get(item);
      if (record !== undefined) record[id] = perItem[i] ?? '';
    });
  };
  if (collection.layout === 'table') {
    const headers = headerTexts(index, collection.container);
    const columns = Math.max(...items.map((item) => index.children(item).length));
    for (let column = 0; column < columns; column += 1) {
      const perItem = items.map((item) => {
        const cell = index.children(item)[column];
        return cell === undefined ? '' : subtreeText(index, cell, true);
      });
      const name = headers[column] ?? null;
      add(name, slug(name ?? '') || `col-${column + 1}`, String(column), perItem);
    }
    return { fields, values };
  }
  // Lists and grids: relative paths of nodes with own text in at least 80% of items.
  const counts = new Map<string, { tag: string; count: number }>();
  for (const item of items) {
    const seen = new Set<string>();
    for (const node of index.subtree(item)) {
      if ((node.text ?? '').trim() === '') continue;
      const rel = relativePath(item, node);
      if (rel === null || seen.has(rel)) continue;
      seen.add(rel);
      counts.set(rel, { tag: node.tag, count: (counts.get(rel)?.count ?? 0) + 1 });
    }
  }
  const kept = [...counts.entries()].filter(([, v]) => v.count >= 0.8 * items.length).sort(([a], [b]) => comparePathStrings(a, b));
  for (const [rel, { tag }] of kept) {
    const perItem = items.map((item) => {
      const node = index.byPath.get(rel === '' ? item.path : `${item.path}/${rel}`);
      return node === undefined ? '' : subtreeText(index, node, true);
    });
    add(null, `${tag}-text`, rel, perItem);
  }
  return { fields, values };
}

function comparePathStrings(a: string, b: string): number {
  const pa = a === '' ? [] : a.split('/').map(Number);
  const pb = b === '' ? [] : b.split('/').map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return pa.length - pb.length;
}

/** Fold for case- and accent-insensitive comparison. */
export function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * The query a search control is tried with: a letter sequence from the
 * items' identifying fields (at least half distinct values) that occurs in a
 * strict, non-empty subset of the items, as close as possible to a third of
 * them; ties go to the longer sequence, then the earliest occurrence. Never a
 * digit run, an email or a URL. Null when no sequence selects a strict subset.
 */
export function chooseSearchQuery(items: readonly Readonly<Record<string, string>>[], fields: readonly DetectedField[]): { query: string; matches: number } | null {
  const n = items.length;
  if (n < 2) return null;
  const sources = fields.filter((f) => f.valueKind === 'text' && f.distinct >= 0.5 * n);
  if (sources.length === 0) return null;
  const haystacks = items.map((item) => fold(sources.map((f) => item[f.id] ?? '').join(' ')));
  const target = Math.max(2, Math.floor(n / 3));
  const candidates = new Map<string, { df: number; order: number }>();
  let order = 0;
  for (const item of items) {
    for (const field of sources) {
      for (const word of fold(item[field.id] ?? '').split(/[^a-z]+/)) {
        if (word.length < 3 || word.length > 24) continue;
        for (let length = 3; length <= Math.min(6, word.length); length += 1) {
          for (let start = 0; start + length <= word.length; start += 1) {
            const token = word.slice(start, start + length);
            if (candidates.has(token)) continue;
            candidates.set(token, { df: haystacks.filter((h) => h.includes(token)).length, order: order++ });
          }
        }
      }
    }
  }
  const ranked = [...candidates.entries()]
    .filter(([, c]) => c.df >= 1 && c.df <= n - 1)
    .sort(([ta, a], [tb, b]) => {
      const preferSubset = Number(b.df >= 2) - Number(a.df >= 2);
      if (preferSubset !== 0) return preferSubset;
      const distance = Math.abs(a.df - target) - Math.abs(b.df - target);
      if (distance !== 0) return distance;
      if (ta.length !== tb.length) return tb.length - ta.length;
      if (a.order !== b.order) return a.order - b.order;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  const best = ranked[0];
  return best === undefined ? null : { query: best[0], matches: best[1].df };
}

/** A synthetic query that occurs in none of the texts. */
export function chooseNoMatchQuery(texts: readonly string[]): string {
  const folded = texts.map(fold);
  return NO_MATCH_QUERIES.find((q) => !folded.some((t) => t.includes(q))) ?? `${NO_MATCH_QUERIES[0]}${texts.length}`;
}

/* ---------------------------------------------------------- classification */

/** A collection's items as one state shows them. */
export interface CollectionSnapshot {
  readonly keys: readonly string[];
}

/** Values of the base items by key: field id → displayed text. */
export type BaseValues = ReadonlyMap<string, Readonly<Record<string, string>>>;

export type ChangeKind = 'search' | 'filter' | 'sort' | 'reset';

export interface ClassifiedChange {
  readonly kind: ChangeKind;
  readonly search?: { readonly match: 'substring' | 'word-prefix' | 'unknown'; readonly fieldIds: readonly string[]; readonly explainsExcluded: boolean };
  readonly filter?: { readonly predicate: { readonly op: 'equals' | 'contains'; readonly fieldId: string; readonly value: string } | { readonly op: 'in-keys'; readonly keys: readonly string[] } };
  readonly sort?: { readonly fieldId: string | null; readonly direction: 'ascending' | 'descending' | null; readonly comparator: 'number' | 'date' | 'text' | null };
}

const sameSequence = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);
const sameMultiset = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/** Comparable value of a displayed field value. */
export function sortValue(text: string, kind: 'number' | 'date' | 'text'): number | string {
  if (kind === 'number') return parseNumber(text) ?? Number.NaN;
  if (kind === 'date') return parseDate(text) ?? Number.NaN;
  return text;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Compare two displayed values by kind. */
export function compareValues(a: string, b: string, kind: 'number' | 'date' | 'text'): number {
  if (kind === 'text') return collator.compare(a, b);
  const x = sortValue(a, kind) as number;
  const y = sortValue(b, kind) as number;
  return x === y ? 0 : x < y ? -1 : 1;
}

function monotonic(values: readonly string[], kind: 'number' | 'date' | 'text'): 'ascending' | 'descending' | null {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < values.length; i += 1) {
    const c = compareValues(values[i - 1] ?? '', values[i] ?? '', kind);
    if (c > 0) ascending = false;
    if (c < 0) descending = false;
  }
  if (ascending && descending) return null;
  return ascending ? 'ascending' : descending ? 'descending' : null;
}

/** Which field values explain a search result. */
function explainSearch(baseKeys: readonly string[], after: readonly string[], query: string, values: BaseValues, fields: readonly DetectedField[]): NonNullable<ClassifiedChange['search']> {
  const q = fold(query.trim());
  const kept = new Set(after);
  const textOf = (key: string, fieldIds: readonly string[]): string => fold(fieldIds.map((id) => values.get(key)?.[id] ?? '').join(' '));
  const matchers: { match: 'substring' | 'word-prefix'; test: (text: string) => boolean }[] = [
    { match: 'substring', test: (text) => text.includes(q) },
    { match: 'word-prefix', test: (text) => text.split(/[^a-z0-9]+/).some((word) => word.startsWith(q)) },
  ];
  const explains = (fieldIds: readonly string[], test: (text: string) => boolean): boolean => baseKeys.every((key) => test(textOf(key, fieldIds)) === kept.has(key));
  const allIds = fields.map((f) => f.id);
  for (const { match, test } of matchers) {
    // One field explains it best: a narrower rule than all text. Ties go to document order.
    for (const field of fields) if (explains([field.id], test)) return { match, fieldIds: [field.id], explainsExcluded: true };
    if (explains(allIds, test)) return { match, fieldIds: [], explainsExcluded: true };
  }
  return { match: 'unknown', fieldIds: [], explainsExcluded: false };
}

/** Which field value explains a filter result. */
function explainFilter(baseKeys: readonly string[], after: readonly string[], label: string | null, values: BaseValues, fields: readonly DetectedField[]): NonNullable<ClassifiedChange['filter']> {
  const kept = new Set(after);
  const removed = baseKeys.filter((key) => !kept.has(key));
  const valueOf = (key: string, fieldId: string): string => values.get(key)?.[fieldId] ?? '';
  // Categorical fields first: a status column explains a status filter better than a name column that happens to agree.
  // A constant field (every item shows the same value) can never be what a filter narrows by.
  const ordered = fields.filter((f) => f.distinct >= 2).sort((a, b) => a.distinct - b.distinct);
  const wanted = label === null ? null : fold(label.trim());
  if (wanted !== null && wanted !== '') {
    for (const op of ['equals', 'contains'] as const) {
      const test = (text: string): boolean => (op === 'equals' ? fold(text.trim()) === wanted : fold(text).includes(wanted));
      for (const field of ordered) {
        if (after.every((key) => test(valueOf(key, field.id))) && removed.every((key) => !test(valueOf(key, field.id)))) {
          // An empty result proves nothing about identifying fields (every name differs from "Cancelled"): only categorical ones may explain it.
          if (after.length === 0 && field.distinct > 0.5 * baseKeys.length) continue;
          return { predicate: { op, fieldId: field.id, value: label?.trim() ?? '' } };
        }
      }
    }
  }
  // A value shared by the kept items explains the filter only when at least two items share it: one item shares all its values.
  if (after.length >= 2) {
    for (const field of ordered) {
      const shared = valueOf(after[0] ?? '', field.id);
      if (shared !== '' && after.every((key) => valueOf(key, field.id) === shared) && removed.every((key) => valueOf(key, field.id) !== shared)) {
        return { predicate: { op: 'equals', fieldId: field.id, value: shared } };
      }
    }
  }
  return { predicate: { op: 'in-keys', keys: [...after] } };
}

/** Which field order explains a sort. `columnFieldId` is the field of the column whose header holds the control, when known. */
function explainSort(after: readonly string[], before: readonly string[], values: BaseValues, fields: readonly DetectedField[], columnFieldId: string | null): NonNullable<ClassifiedChange['sort']> {
  const qualifying: { field: DetectedField; direction: 'ascending' | 'descending' }[] = [];
  for (const field of fields) {
    if (field.distinct < 2) continue;
    const afterValues = after.map((key) => values.get(key)?.[field.id] ?? '');
    const direction = monotonic(afterValues, field.valueKind);
    if (direction === null) continue;
    const beforeDirection = monotonic(
      before.map((key) => values.get(key)?.[field.id] ?? ''),
      field.valueKind,
    );
    if (beforeDirection === direction) continue;
    qualifying.push({ field, direction });
  }
  const chosen = qualifying.find((q) => q.field.id === columnFieldId) ?? qualifying[0];
  if (chosen === undefined) return { fieldId: null, direction: null, comparator: null };
  return { fieldId: chosen.field.id, direction: chosen.direction, comparator: chosen.field.valueKind };
}

/**
 * How a transition changed a collection, judged by item identity against the
 * base items (the universe): `reset` back to the base view, `sort` (same
 * items, new order), `search` (a fill on a search control left a subset),
 * `filter` (any other action left a subset). Null for no change and for
 * anything else (items replaced or added: pagination, load more).
 */
export function classifyCollectionChange(input: {
  readonly baseKeys: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly values: BaseValues;
  readonly fields: readonly DetectedField[];
  readonly action: { readonly type: string; readonly value?: string | undefined; readonly label: string | null };
  readonly columnFieldId: string | null;
}): ClassifiedChange | null {
  const { baseKeys, before, after } = input;
  if (sameSequence(after, before)) return null;
  if (sameSequence(after, baseKeys)) return { kind: 'reset' };
  if (sameMultiset(after, baseKeys)) return { kind: 'sort', sort: explainSort(after, before, input.values, input.fields, input.columnFieldId) };
  const base = new Set(baseKeys);
  if (!after.every((key) => base.has(key)) || after.length >= baseKeys.length) return null;
  if (input.action.type === 'fill' && input.action.value !== undefined && input.action.value.trim() !== '') {
    return { kind: 'search', search: explainSearch(baseKeys, after, input.action.value, input.values, input.fields) };
  }
  return { kind: 'filter', filter: explainFilter(baseKeys, after, input.action.label, input.values, input.fields) };
}

/* ---------------------------------------------------------- search controls */

const SEARCH_WORDS = /\b(search|filter|find)\b/i;
const NON_SEARCH_TYPES: ReadonlySet<string> = new Set(['password', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color']);

/** A search control and the collection it narrows. */
export interface SearchControl {
  readonly control: UiNode;
  readonly collection: DetectedCollection;
}

/**
 * Text inputs that search a detected collection: `type=search`, a
 * `searchbox`, a text input inside `role=search`, or one whose name or
 * placeholder says search, filter or find. Only inputs outside forms are
 * returned (a search inside a form belongs to the forms policy), never a
 * password, email or similar input. Bound to the collection its
 * `aria-controls` names (or an ancestor of), else to the nearest collection
 * that shares an ancestor below `<body>`.
 */
export function findSearchControls(nodes: readonly UiNode[], collections: readonly DetectedCollection[]): SearchControl[] {
  const index = new CollectionIndex(nodes);
  const out: SearchControl[] = [];
  for (const node of nodes) {
    if (node.tag !== 'input' && node.role !== 'searchbox') continue;
    const type = (node.attrs.type ?? 'text').toLowerCase();
    if (node.tag === 'input' && NON_SEARCH_TYPES.has(type)) continue;
    if (!isRendered(node) || node.inForm || node.attrs.disabled !== undefined || node.attrs.readonly !== undefined) continue;
    const ancestors = index.ancestors(node);
    const searchish =
      type === 'search' ||
      node.role === 'searchbox' ||
      ancestors.some((a) => a.role === 'search' || a.tag === 'search') ||
      SEARCH_WORDS.test(`${node.name ?? ''} ${node.attrs.placeholder ?? ''} ${node.attrs.name ?? ''} ${node.attrs['aria-label'] ?? ''}`);
    if (!searchish) continue;
    const controls = (node.attrs['aria-controls'] ?? '').split(/\s+/).filter((id) => id !== '');
    const byControls = collections.find((c) => [c.container, ...index.ancestors(c.container)].some((n) => n.attrs.id !== undefined && controls.includes(n.attrs.id)));
    const nearest = byControls ?? nearestCollection(node, ancestors, collections);
    if (nearest !== null) out.push({ control: node, collection: nearest });
  }
  return out;
}

function nearestCollection(node: UiNode, ancestors: readonly UiNode[], collections: readonly DetectedCollection[]): DetectedCollection | null {
  // The deepest ancestor of the control (below <body>) that also holds a collection.
  for (const ancestor of ancestors) {
    if (ancestor.path === '') break;
    const prefix = `${ancestor.path}/`;
    const inside = collections.filter((c) => c.container.path.startsWith(prefix));
    if (inside.length === 0) continue;
    // In document order after the control first, then before it.
    const after = inside.filter((c) => comparePathStrings(c.container.path, node.path) > 0);
    return after[0] ?? inside[0] ?? null;
  }
  return null;
}
