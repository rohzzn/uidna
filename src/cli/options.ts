/**
 * Derives CLI positionals and options from a tool contract's Zod input, so
 * the CLI mirrors the MCP surface without a second hand-written definition.
 */
import type { Command } from 'commander';
import type { z } from 'zod';
import type { ToolContract } from '../contracts/types.js';

/** Shape of a field as the CLI needs to know it. */
export interface FieldInfo {
  readonly name: string;
  readonly kind: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
  readonly itemKind: 'string' | 'number' | 'unknown';
  readonly optional: boolean;
  readonly description: string;
  readonly values?: readonly string[];
}

interface CoreDef {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  entries?: Record<string, unknown>;
  values?: unknown[];
}

function coreDef(schema: z.ZodType): CoreDef {
  return (schema as unknown as { _zod: { def: CoreDef } })._zod.def;
}

function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let current = schema;
  let optional = false;
  for (let i = 0; i < 6; i += 1) {
    const def = coreDef(current);
    if ((def.type === 'optional' || def.type === 'nullable' || def.type === 'default' || def.type === 'nullish') && def.innerType) {
      optional = true;
      current = def.innerType;
      continue;
    }
    break;
  }
  return { inner: current, optional };
}

function kindOf(schema: z.ZodType): FieldInfo['kind'] {
  const type = coreDef(schema).type;
  switch (type) {
    case 'string':
    case 'enum':
    case 'literal':
      return 'string';
    case 'number':
    case 'int':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
    case 'record':
    case 'union':
    case 'discriminatedUnion':
      return 'object';
    default:
      return 'unknown';
  }
}

/** Describe every top-level field of a contract's input. */
export function describeFields(contract: ToolContract): FieldInfo[] {
  const shape = contract.input.shape as Record<string, z.ZodType>;
  return Object.entries(shape).map(([name, schema]) => {
    const { inner, optional } = unwrap(schema);
    const kind = kindOf(inner);
    let itemKind: FieldInfo['itemKind'] = 'unknown';
    if (kind === 'array') {
      const element = coreDef(inner).element;
      if (element) {
        const elementKind = kindOf(unwrap(element).inner);
        itemKind = elementKind === 'number' ? 'number' : elementKind === 'string' ? 'string' : 'unknown';
      }
    }
    const def = coreDef(inner);
    const values = def.type === 'enum' && def.entries ? Object.keys(def.entries) : def.type === 'literal' && def.values ? def.values.map(String) : undefined;
    const description = (schema.description ?? inner.description ?? '').trim();
    return { name, kind, itemKind, optional, description, ...(values ? { values } : {}) };
  });
}

/** `scanId` → `scan-id`. */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

/** Parse a CLI string into the field's type. Invalid values throw a plain Error naming the field. */
export function coerce(field: FieldInfo, raw: string | boolean | undefined): unknown {
  if (raw === undefined) return undefined;
  switch (field.kind) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : !['0', 'false', 'no'].includes(raw.toLowerCase());
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--${kebab(field.name)} expects a number, got "${String(raw)}"`);
      return n;
    }
    case 'array': {
      const text = String(raw);
      let parts: unknown[];
      if (text.startsWith('[')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`--${kebab(field.name)} expects a JSON array or a comma-separated list`);
        }
        if (!Array.isArray(parsed)) throw new Error(`--${kebab(field.name)} expects a JSON array`);
        parts = parsed;
        // Arrays of objects (e.g. annotation patches) are passed through untouched.
        if (field.itemKind === 'unknown') return parts;
      } else {
        parts = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }
      if (field.itemKind === 'number') {
        return parts.map((p) => {
          const n = Number(p);
          if (!Number.isFinite(n)) throw new Error(`--${kebab(field.name)} expects numbers, got "${String(p)}"`);
          return n;
        });
      }
      return parts.map(String);
    }
    case 'object': {
      try {
        return JSON.parse(String(raw)) as unknown;
      } catch {
        throw new Error(`--${kebab(field.name)} expects JSON`);
      }
    }
    default:
      return String(raw);
  }
}

/** Register positionals and options for a contract on a commander command. */
export function applyContract(command: Command, contract: ToolContract): FieldInfo[] {
  const fields = describeFields(contract);
  const positionals = new Set(contract.cli.positionals);
  for (const positional of contract.cli.positionals) {
    const field = fields.find((f) => f.name === positional);
    const optional = field?.optional ?? true;
    command.argument(optional ? `[${positional}]` : `<${positional}>`, field?.description ?? positional);
  }
  for (const field of fields) {
    if (positionals.has(field.name)) continue;
    const flag = kebab(field.name);
    const hint = field.values ? field.values.join('|') : field.kind === 'array' ? 'a,b,c' : field.kind === 'object' ? 'json' : field.kind;
    if (field.kind === 'boolean') {
      command.option(`--${flag}`, field.description || `enable ${field.name}`);
      command.option(`--no-${flag}`, `disable ${field.name}`);
    } else {
      command.option(`--${flag} <${hint}>`, field.description || field.name);
    }
  }
  return fields;
}

/** Build the tool input from parsed positionals and options. */
export function collectInput(contract: ToolContract, fields: FieldInfo[], positionals: readonly (string | undefined)[], options: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  contract.cli.positionals.forEach((name, index) => {
    const field = fields.find((f) => f.name === name);
    const value = positionals[index];
    if (value !== undefined && field) input[name] = coerce(field, value);
    else if (value !== undefined) input[name] = value;
  });
  for (const field of fields) {
    if (contract.cli.positionals.includes(field.name)) continue;
    const raw = options[field.name];
    if (raw === undefined) continue;
    input[field.name] = coerce(field, raw as string | boolean);
  }
  return input;
}
