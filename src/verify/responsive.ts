/**
 * Breakpoint checks, the pure part: compare the layout values the original
 * takes on either side of a located breakpoint (read while probing) with the
 * generated app's at the same widths.
 */
import type { ResponsiveRule } from 'uidna-schema';
import { SIGNATURE_PROPERTIES } from '../domain/responsive.js';

/** A layout value that differs between the original and the generated app at one width. */
export interface SideMismatch {
  readonly side: 'lower' | 'upper';
  readonly width: number;
  readonly path: string;
  readonly property: string;
  readonly original: string;
  readonly generated: string;
}

const SIGNATURE: ReadonlySet<string> = new Set(SIGNATURE_PROPERTIES);

/** Value of a signature key, with the defaults an absent key stands for (as in the document's rules). */
export function signatureValue(signature: Readonly<Record<string, string>>, path: string, property: string): string {
  const value = signature[`${path}|${property}`];
  if (value !== undefined) return value;
  switch (property) {
    case 'position':
      return 'static';
    case 'float':
      return 'none';
    case 'grid-columns':
      return '0';
    case 'flex-direction':
      return 'none';
    case 'rendered':
      return 'false';
    default:
      return 'absent';
  }
}

/**
 * Compare both sides of one breakpoint for the layout properties its rules
 * record. Only signature properties are compared: the probe read exactly those
 * at the bracket widths; stylesheet-attributed values (sizes, fonts) were
 * read at the scanned widths and are checked by the visual comparison there.
 */
export function compareBreakpointSides(input: {
  readonly rules: readonly Pick<ResponsiveRule, 'nodePath' | 'property'>[];
  readonly widths: { readonly lower: number; readonly upper: number };
  readonly original: { readonly lower: Readonly<Record<string, string>>; readonly upper: Readonly<Record<string, string>> };
  readonly generated: { readonly lower: Readonly<Record<string, string>>; readonly upper: Readonly<Record<string, string>> };
}): { checked: number; mismatches: SideMismatch[] } {
  const mismatches: SideMismatch[] = [];
  let checked = 0;
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!SIGNATURE.has(rule.property)) continue;
    const key = `${rule.nodePath}|${rule.property}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const side of ['lower', 'upper'] as const) {
      checked += 1;
      const original = signatureValue(input.original[side], rule.nodePath, rule.property);
      const generated = signatureValue(input.generated[side], rule.nodePath, rule.property);
      if (original !== generated) mismatches.push({ side, width: input.widths[side], path: rule.nodePath, property: rule.property, original, generated });
    }
  }
  return { checked, mismatches };
}
