/**
 * Tokens: build the lookup index used by the class mapper and render
 * `src/styles/tokens.css` (a Tailwind `@theme` block plus `:root` reference
 * variables). Every token line carries its sample count and provenance kind.
 */
import type { ProvenanceKind, Token, UiDnaDocument } from 'uidna-schema';
import { compareStrings } from './jsx.js';
import type { BreakpointPlan, GenerationModel } from './model.js';
import { normalizeColor, normalizeFontFamily, tokenClassName, type TokenIndex } from './tailwind-map.js';

/** A token resolved for generation. */
export interface ResolvedToken {
  readonly id: string;
  readonly kind: Token['kind'];
  /** Class-safe name used in the theme (`color-01`). */
  readonly name: string;
  readonly generatedName: string;
  readonly annotated: boolean;
  /** Known value, or null with the reason in `reason`. */
  readonly value: string | null;
  readonly reason: string | null;
  readonly sampleCount: number;
  /** Provenance kind of the token value, copied from the document (never invented here). */
  readonly provenance: ProvenanceKind;
}

/** Tokens grouped per family, in document order, with unique names. */
export interface ResolvedTokens {
  readonly colors: readonly ResolvedToken[];
  readonly fontSizes: readonly ResolvedToken[];
  readonly radii: readonly ResolvedToken[];
  readonly fontFamilies: readonly ResolvedToken[];
  readonly spacing: readonly ResolvedToken[];
  readonly shadows: readonly ResolvedToken[];
  readonly index: TokenIndex;
}

function resolveFamily(tokens: readonly Token[]): ResolvedToken[] {
  const used = new Set<string>();
  return [...tokens]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((token) => {
      const annotatedName = token.name?.value ?? null;
      let name = tokenClassName(annotatedName ?? token.generatedName);
      if (used.has(name)) {
        const fallback = tokenClassName(token.generatedName);
        name = used.has(fallback) ? `${fallback}-${used.size + 1}` : fallback;
      }
      used.add(name);
      const value = token.value.value;
      return {
        id: token.id,
        kind: token.kind,
        name,
        generatedName: token.generatedName,
        annotated: annotatedName !== null,
        value: value === null ? null : value.trim(),
        reason: token.value.provenance.kind === 'unknown' ? token.value.provenance.reason : null,
        sampleCount: token.cluster.sampleCount,
        provenance: token.value.provenance.kind,
      };
    });
}

/** Resolve the document's tokens into class names and the lookup index. */
export function resolveTokens(dna: UiDnaDocument): ResolvedTokens {
  const colors = resolveFamily(dna.visual.tokens.colors);
  const fontSizes = resolveFamily(dna.visual.tokens.fontSizes);
  const radii = resolveFamily(dna.visual.tokens.radii);
  const fontFamilies = resolveFamily(dna.visual.tokens.fontFamilies);
  const spacing = resolveFamily(dna.visual.tokens.spacing);
  const shadows = resolveFamily(dna.visual.tokens.shadows);

  const colorIndex = new Map<string, string>();
  for (const token of colors) {
    if (token.value === null || !isCssSafe(token.value)) continue;
    const key = normalizeColor(token.value);
    if (!colorIndex.has(key)) colorIndex.set(key, token.name);
  }
  const sizeIndex = new Map<string, string>();
  for (const token of fontSizes) {
    if (token.value === null || !isCssSafe(token.value)) continue;
    if (!sizeIndex.has(token.value)) sizeIndex.set(token.value, token.name);
  }
  const radiusIndex = new Map<string, string>();
  for (const token of radii) {
    if (token.value === null || !isCssSafe(token.value)) continue;
    if (!radiusIndex.has(token.value)) radiusIndex.set(token.value, token.name);
  }
  const familyIndex = new Map<string, string>();
  for (const token of fontFamilies) {
    if (token.value === null || !isCssSafe(token.value)) continue;
    const key = normalizeFontFamily(token.value);
    if (!familyIndex.has(key)) familyIndex.set(key, token.name);
  }
  return {
    colors,
    fontSizes,
    radii,
    fontFamilies,
    spacing,
    shadows,
    index: { colors: colorIndex, fontSizes: sizeIndex, radii: radiusIndex, fontFamilies: familyIndex },
  };
}

/** True when a token value can be written verbatim into a CSS declaration. */
export function isCssSafe(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[;{}\n\r]/.test(value) && !value.includes('/*') && !value.includes('*/') && !value.includes('</');
}

function cssComment(text: string): string {
  return `/* ${text.replace(/\*\//g, '* /').replace(/[\n\r]+/g, ' ')} */`;
}

function tokenLines(tokens: readonly ResolvedToken[], variable: (name: string) => string, indent: string): string[] {
  const lines: string[] = [];
  for (const token of tokens) {
    const origin = token.annotated ? `${token.name} (${token.id}, generated name ${token.generatedName})` : `${token.name} (${token.id})`;
    if (token.value === null) {
      lines.push(`${indent}${cssComment(`${origin}: unknown, ${token.reason ?? 'no reason recorded'}`)}`);
      continue;
    }
    if (!isCssSafe(token.value)) {
      lines.push(`${indent}${cssComment(`${origin}: value omitted, it contains characters that are not safe in CSS`)}`);
      continue;
    }
    lines.push(`${indent}${cssComment(`${origin}: ${token.sampleCount} samples, ${token.provenance}`)}`);
    lines.push(`${indent}${variable(token.name)}: ${token.value};`);
  }
  return lines;
}

/**
 * Render `src/styles/tokens.css`. `plan` (from `planSite` for a routed site)
 * declares every breakpoint any generated page uses; without it the model's
 * own plan is declared. A `md:` utility whose breakpoint is not declared is
 * dropped by Tailwind, so the declaration must cover every page, not one.
 */
export function renderTokensCss(tokens: ResolvedTokens, model: GenerationModel, scanId: string, plan: BreakpointPlan = model.breakpoints): string {
  const lines: string[] = [];
  lines.push(cssComment(`Design tokens generated by UI DNA from scan ${scanId}. Values are measured; names are placeholders to rename.`));
  lines.push('@theme {');
  const located = plan.ordered.some((bp) => bp.source !== 'scanned');
  lines.push(
    `  ${cssComment(
      located
        ? 'breakpoints located by the scan (stylesheet conditions and probing) and, where none was located, the scanned viewports (mobile-first: the narrowest viewport is the base)'
        : 'breakpoints from the scanned viewports (mobile-first: the narrowest viewport is the base)',
    )}`,
  );
  lines.push('  --breakpoint-*: initial;');
  for (const bp of plan.ordered) {
    const note =
      !located
        ? ''
        : bp.source === 'scanned'
          ? ` ${cssComment(`no located breakpoint below ${bp.minWidth}px: the ${bp.minWidth}px capture applies from its own width`)}`
          : ` ${cssComment(`${bp.breakpointId ?? ''} ${bp.source === 'css' ? `stylesheet ${bp.conditions.map((c) => `"${c}"`).join(', ')}` : 'located by probing'}`)}`;
    lines.push(`  --breakpoint-${bp.name}: ${bp.minWidth}px;${note}`);
  }
  const theme: [string, readonly ResolvedToken[], (name: string) => string][] = [
    ['colors', tokens.colors, (name) => `--color-${name}`],
    ['font sizes', tokens.fontSizes, (name) => `--text-${name}`],
    ['radii', tokens.radii, (name) => `--radius-${name}`],
    ['font families', tokens.fontFamilies, (name) => `--font-${name}`],
  ];
  for (const [label, family, variable] of theme) {
    lines.push('');
    lines.push(`  ${cssComment(label)}`);
    if (family.length === 0) lines.push(`  ${cssComment(`no ${label} tokens in the document`)}`);
    lines.push(...tokenLines(family, variable, '  '));
  }
  lines.push('}');
  lines.push('');
  lines.push(':root {');
  lines.push(`  ${cssComment('spacing (reference only: utilities use the measured pixel values)')}`);
  if (tokens.spacing.length === 0) lines.push(`  ${cssComment('no spacing tokens in the document')}`);
  lines.push(...tokenLines(tokens.spacing, (name) => `--${name}`, '  '));
  lines.push('');
  lines.push(`  ${cssComment('shadows (reference only)')}`);
  if (tokens.shadows.length === 0) lines.push(`  ${cssComment('no shadow tokens in the document')}`);
  lines.push(...tokenLines(tokens.shadows, (name) => `--${name}`, '  '));
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
