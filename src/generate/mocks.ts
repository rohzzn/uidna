/**
 * Typed mocks from captured JSON responses (`data` assets). Each asset becomes
 * `src/mocks/<name>.ts` with an interface inferred from the stored copy and
 * the data as a typed constant. Nothing is wired into components: a mock is
 * evidence of what the backend answered, not a backend.
 */
import type { Asset } from '@rohzzn/uidna-schema';
import { REDACTED, SENSITIVE_PARAM_PATTERN } from '../browser/redact.js';
import { camelCase, commentText, compareStrings, jsString, pascalCase } from './jsx.js';
import type { MockRecord } from './project.js';

/** Input of `renderDataMock`: the asset, its parsed JSON (null when unavailable) and why it is unavailable. */
export interface DataMockInput {
  readonly asset: Asset;
  readonly json: unknown;
  readonly reason: string | null;
}

/** Deepest nesting the type inference describes; deeper values are `unknown`. */
const MAX_DEPTH = 8;

/** Base identifier for an asset from its request path: `/api/items.json` → `itemsJson`. */
export function mockBaseName(asset: Asset): string {
  let pathname = '';
  try {
    pathname = new URL(asset.url).pathname;
  } catch {
    pathname = asset.url.replace(/[?#].*$/, '');
  }
  const segments = pathname.split('/').filter((s) => s.length > 0 && s !== '[redacted]');
  const last = segments[segments.length - 1] ?? '';
  return camelCase(last, 'response');
}

/** Unique camelCase name for each asset, in asset-id order. */
export function mockNames(assets: readonly Asset[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const asset of [...assets].sort((a, b) => compareStrings(a.id, b.id))) {
    const base = mockBaseName(asset);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}${n}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    out.set(asset.id, name);
  }
  return out;
}

/** Replace the values of secret-looking keys with the `[redacted]` literal, recursively. Never throws. */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const inner = (value as Record<string, unknown>)[key];
      const redacted = SENSITIVE_PARAM_PATTERN.test(key) && (typeof inner === 'string' || typeof inner === 'number') ? REDACTED : redactJson(inner, depth + 1);
      // `JSON.parse` yields `__proto__` as an own property; plain assignment would set the prototype and drop the field.
      Object.defineProperty(out, key, { value: redacted, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/* ------------------------------------------------------------- inference */

/** A structural type: primitives, arrays, object shapes (named interfaces) and unions. */
type Shape =
  | { readonly kind: 'primitive'; readonly name: 'string' | 'number' | 'boolean' | 'null' | 'unknown' }
  | { readonly kind: 'array'; readonly element: Shape }
  | { readonly kind: 'object'; readonly fields: Map<string, { shape: Shape; optional: boolean }>; readonly interfaceName: string }
  | { readonly kind: 'union'; readonly members: Shape[] };

interface Inference {
  readonly interfaces: { name: string; fields: Map<string, { shape: Shape; optional: boolean }> }[];
  readonly used: Set<string>;
}

function singular(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
}

function interfaceName(parent: string, key: string, inference: Inference, arrayElement: boolean): string {
  const base = `${parent}${pascalCase(arrayElement ? singular(key) : key, arrayElement ? 'Item' : 'Value')}`;
  let name = base;
  let n = 2;
  while (inference.used.has(name)) {
    name = `${base}${n}`;
    n += 1;
  }
  inference.used.add(name);
  return name;
}

function shapeOf(value: unknown, parent: string, key: string, inference: Inference, depth: number, arrayElement: boolean): Shape {
  if (depth > MAX_DEPTH) return { kind: 'primitive', name: 'unknown' };
  if (value === null) return { kind: 'primitive', name: 'null' };
  if (Array.isArray(value)) {
    const elements = value.map((item) => shapeOf(item, parent, key, inference, depth + 1, true));
    return { kind: 'array', element: elements.length === 0 ? { kind: 'primitive', name: 'unknown' } : merge(elements, inference) };
  }
  switch (typeof value) {
    case 'string':
      return { kind: 'primitive', name: 'string' };
    case 'number':
      return { kind: 'primitive', name: 'number' };
    case 'boolean':
      return { kind: 'primitive', name: 'boolean' };
    case 'object': {
      const record = value as Record<string, unknown>;
      const name = depth === 0 ? parent : interfaceName(parent, key, inference, arrayElement);
      const fields = new Map<string, { shape: Shape; optional: boolean }>();
      for (const field of Object.keys(record).sort(compareStrings)) fields.set(field, { shape: shapeOf(record[field], name, field, inference, depth + 1, false), optional: false });
      inference.interfaces.push({ name, fields });
      return { kind: 'object', fields, interfaceName: name };
    }
    default:
      return { kind: 'primitive', name: 'unknown' };
  }
}

/** Merge the shapes of array elements: objects fold into one interface (fields missing somewhere become optional), the rest form a union. */
function merge(shapes: readonly Shape[], inference: Inference): Shape {
  const objects = shapes.filter((s): s is Extract<Shape, { kind: 'object' }> => s.kind === 'object');
  const others = shapes.filter((s) => s.kind !== 'object');
  const members: Shape[] = [];
  if (objects.length > 0) {
    const first = objects[0];
    if (first !== undefined) {
      // Fold every element's fields into the first element's interface; drop the interfaces of the others.
      const keys = new Set<string>();
      for (const object of objects) for (const key of object.fields.keys()) keys.add(key);
      for (const key of [...keys].sort(compareStrings)) {
        const present = objects.filter((o) => o.fields.has(key));
        const fieldShapes = present.map((o) => o.fields.get(key)?.shape).filter((s): s is Shape => s !== undefined);
        first.fields.set(key, { shape: fieldShapes.length === 1 && fieldShapes[0] !== undefined ? fieldShapes[0] : merge(fieldShapes, inference), optional: present.length < objects.length });
      }
      for (const object of objects.slice(1)) {
        const index = inference.interfaces.findIndex((i) => i.name === object.interfaceName);
        if (index >= 0) inference.interfaces.splice(index, 1);
        inference.used.delete(object.interfaceName);
      }
      members.push(first);
    }
  }
  const arrays = others.filter((s): s is Extract<Shape, { kind: 'array' }> => s.kind === 'array');
  if (arrays.length > 0) members.push({ kind: 'array', element: merge(arrays.map((a) => a.element), inference) });
  for (const other of others) {
    if (other.kind === 'array') continue;
    if (other.kind === 'union') members.push(...other.members);
    else members.push(other);
  }
  const unique: Shape[] = [];
  for (const member of members) if (!unique.some((u) => printShape(u) === printShape(member))) unique.push(member);
  if (unique.length === 1 && unique[0] !== undefined) return unique[0];
  if (unique.length === 0) return { kind: 'primitive', name: 'unknown' };
  return { kind: 'union', members: unique };
}

function printShape(shape: Shape): string {
  switch (shape.kind) {
    case 'primitive':
      return shape.name;
    case 'array': {
      const inner = printShape(shape.element);
      return shape.element.kind === 'union' ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object':
      return shape.interfaceName;
    case 'union':
      return shape.members.map(printShape).sort(compareStrings).join(' | ');
    default:
      return 'unknown';
  }
}

function fieldName(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : jsString(key);
}

/** Infer the TypeScript declarations for a JSON value: `interfaces` (root first) and the type expression of the root. */
export function inferTypes(json: unknown, rootName: string): { declarations: string[]; rootType: string } {
  const inference: Inference = { interfaces: [], used: new Set([rootName]) };
  const root = shapeOf(json, rootName, '', inference, 0, false);
  const declarations: string[] = [];
  const ordered = [...inference.interfaces].sort((a, b) => (a.name === rootName ? -1 : b.name === rootName ? 1 : compareStrings(a.name, b.name)));
  for (const iface of ordered) {
    declarations.push(`export interface ${iface.name} {`);
    for (const [key, field] of [...iface.fields.entries()].sort(([a], [b]) => compareStrings(a, b))) {
      declarations.push(`  ${fieldName(key)}${field.optional ? '?' : ''}: ${printShape(field.shape)};`);
    }
    declarations.push('}');
    declarations.push('');
  }
  if (root.kind === 'object') return { declarations, rootType: rootName };
  declarations.push(`export type ${rootName} = ${printShape(root)};`);
  declarations.push('');
  return { declarations, rootType: rootName };
}

/* --------------------------------------------------------------- render */

/** Render one data asset as `src/mocks/<name>.ts`. */
export function renderDataMock(input: DataMockInput, constName: string): { file: string; code: string; record: MockRecord } {
  const { asset, json, reason } = input;
  const typeName = pascalCase(constName, 'Response');
  const file = `src/mocks/${constName}.ts`;
  const method = asset.request?.method ?? 'GET';
  const lines: string[] = [];
  lines.push(`// Generated by UI DNA: the JSON response observed during the scan for ${commentText(`${method} ${asset.url}`)}.`);
  lines.push('// A typed copy of what the backend answered, not a backend: nothing imports it. Secret-looking keys hold the literal "[redacted]".');
  lines.push('');
  if (json === null && reason !== null) {
    lines.push(`/** ${commentText(asset.url)} (${commentText(asset.id)}): content unavailable, ${commentText(reason)}. */`);
    lines.push(`export type ${typeName} = unknown;`);
    lines.push('');
    lines.push(`export const ${constName}: ${typeName} = null;`);
    lines.push('');
    return { file, code: lines.join('\n'), record: { name: constName, file, reason: `content unavailable: ${reason}` } };
  }
  const redacted = redactJson(json);
  const inferred = inferTypes(redacted, typeName);
  lines.push(...inferred.declarations);
  lines.push(`/** ${commentText(`${method} ${asset.url}`)} (${commentText(asset.id)}${asset.request?.status === undefined || asset.request.status === null ? '' : `, status ${asset.request.status}`}${asset.mime ? `, ${commentText(asset.mime)}` : ''}). */`);
  lines.push(`export const ${constName}: ${inferred.rootType} = ${JSON.stringify(redacted, null, 2)};`);
  lines.push('');
  return { file, code: lines.join('\n'), record: { name: constName, file, reason: `JSON response observed during the scan (${method} ${asset.url})` } };
}
