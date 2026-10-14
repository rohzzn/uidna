import { describe, expect, it } from 'vitest';
import { TokensSchema } from '@rohzzn/uidna-schema';
import type { CapturedState } from '../browser/types.js';
import { buildFixtureACaptures, FIXTURE_A_CAPTURED_AT, FIXTURE_A_COLORS, FIXTURE_A_SHADOW, findNode } from './testing.js';
import { extractTokens } from './tokens.js';

const captures = buildFixtureACaptures();
const ctx = { capturedAt: FIXTURE_A_CAPTURED_AT, evidenceIdByState: { st_01: 'ev_000000000001', st_02: 'ev_000000000002' } };
const tokens = extractTokens(captures, ctx);

/**
 * Independent count of rendered uses of a value: text properties (`color`,
 * `font-size`) count where text renders (nodes with own text and pseudo
 * elements with content); other properties count every visible node.
 */
function countUses(property: string[], value: string): number {
  const textProperties = new Set(['color', 'font-size']);
  let count = 0;
  for (const capture of captures.values()) {
    for (const node of capture.nodes) {
      if (!node.visible) continue;
      const style = capture.styles[node.styleId] ?? {};
      const hasText = (node.text?.trim() ?? '').length > 0;
      for (const prop of property) {
        if (textProperties.has(prop) && !hasText) continue;
        if (style[prop] === value) count += 1;
      }
      const pseudoStyle = node.pseudo?.after ? capture.styles[node.pseudo.after.styleId] : undefined;
      for (const prop of property) {
        if (textProperties.has(prop) && pseudoStyle?.[prop] === value) count += 1;
        if (!textProperties.has(prop) && pseudoStyle?.[prop] === value) count += 1;
      }
    }
  }
  return count;
}

describe('extractTokens', () => {
  it('produces schema-valid tokens', () => {
    expect(TokensSchema.safeParse(tokens).success).toBe(true);
  });

  it('reports the primary blue as a color token with one sample per node using it', () => {
    const blue = tokens.colors.find((t) => t.value.value === '#2f5bea');
    expect(blue).toBeDefined();
    const expected = countUses(['color', 'background-color'], FIXTURE_A_COLORS.primary);
    expect(expected).toBeGreaterThan(0);
    expect(blue!.cluster.sampleCount).toBe(expected);
    expect(blue!.usage.count).toBe(expected);
    expect(blue!.cluster.members).toEqual([{ value: FIXTURE_A_COLORS.primary, count: expected }]);
    expect(blue!.cluster.properties).toEqual(['background-color', 'color']);
    expect(blue!.usage.stateIds).toEqual(['st_01', 'st_02']);
    expect(blue!.value.provenance).toMatchObject({ kind: 'measured', source: 'computed-style', confidence: 1, capturedAt: FIXTURE_A_CAPTURED_AT });
  });

  it('never samples transparent colors and lists every color with cluster evidence', () => {
    expect(tokens.colors.some((t) => t.value.value === 'rgba(0, 0, 0, 0)')).toBe(false);
    for (const token of tokens.colors) {
      expect(token.cluster.members.length).toBeGreaterThan(0);
      expect(token.cluster.sampleCount).toBe(token.cluster.members.reduce((s, m) => s + m.count, 0));
    }
    expect(tokens.colors.map((t) => t.value.value)).toEqual(expect.arrayContaining(['#1b1f2a', '#5b6474', '#ffffff', '#dfe3ec', '#1f9d6a', '#d98a1f']));
  });

  it('orders tokens by sample count then value and numbers ids and names', () => {
    const counts = tokens.colors.map((t) => t.cluster.sampleCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(tokens.colors[0]!.id).toBe('tok_color_01');
    expect(tokens.colors[0]!.generatedName).toBe('color-01');
    expect(tokens.fontSizes[0]!.id).toBe('tok_text_01');
    expect(tokens.spacing[0]!.generatedName).toBe('space-01');
    expect(tokens.radii[0]!.generatedName).toBe('radius-01');
    expect(tokens.shadows[0]!.generatedName).toBe('shadow-01');
  });

  it('keeps font sizes exact', () => {
    const values = tokens.fontSizes.map((t) => t.value.value);
    expect(values).toEqual(expect.arrayContaining(['48px', '32px', '20px', '16px', '15px', '13px']));
    for (const token of tokens.fontSizes) {
      expect(token.cluster.members).toHaveLength(1);
      expect(token.cluster.spread).toBeUndefined();
    }
    const size20 = tokens.fontSizes.find((t) => t.value.value === '20px')!;
    expect(size20.cluster.sampleCount).toBe(countUses(['font-size'], '20px') - countUses(['font-size'], 'never'));
  });

  it('normalizes font families', () => {
    expect(tokens.fontFamilies).toHaveLength(1);
    expect(tokens.fontFamilies[0]!.value.value).toBe('Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');
    expect(tokens.fontFamilies[0]!.kind).toBe('font-family');
  });

  it('extracts non-zero spacing, radii and shadows exactly', () => {
    expect(tokens.spacing.map((t) => t.value.value)).toEqual(expect.arrayContaining(['24px', '16px', '8px', '4px', '12px', '20px']));
    expect(tokens.spacing.some((t) => t.value.value === '0px')).toBe(false);
    expect(tokens.radii.map((t) => t.value.value)).toEqual(expect.arrayContaining(['12px', '6px', '999px', '2px']));
    expect(tokens.shadows.map((t) => t.value.value)).toEqual([FIXTURE_A_SHADOW]);
  });

  it('keeps percentage radii such as 50% instead of dropping the measured value', () => {
    const base = captures.get('st_01')!;
    const mark = findNode(base, '.brand-mark')!;
    const round: CapturedState = {
      ...base,
      styles: {
        ...base.styles,
        s_round: { ...base.styles[mark.styleId]!, 'border-top-left-radius': '50%', 'border-top-right-radius': '50%', 'border-bottom-right-radius': '50%', 'border-bottom-left-radius': '50%' },
      },
      nodes: base.nodes.map((n) => (n.id === mark.id ? { ...n, styleId: 's_round' } : n)),
    };
    const result = extractTokens(new Map([['st_01', round]]), ctx);
    const pct = result.radii.find((t) => t.value.value === '50%')!;
    expect(pct.cluster.sampleCount).toBe(4);
    expect(pct.cluster.properties).toEqual(['border-bottom-left-radius', 'border-bottom-right-radius', 'border-top-left-radius', 'border-top-right-radius']);
    expect(result.radii.some((t) => t.value.value === '0%')).toBe(false);
  });

  it('groups typography by exact composite style with measured fields', () => {
    expect(tokens.typography.length).toBeGreaterThan(3);
    const counts = tokens.typography.map((t) => t.sampleCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    const h1 = tokens.typography.find((t) => t.fontSize.value === '48px')!;
    expect(h1.fontWeight.value).toBe('700');
    expect(h1.lineHeight.value).toBe('52.8px');
    expect(h1.letterSpacing?.value).toBe('-0.96px');
    expect(h1.stateIds).toEqual(['st_01']);
    expect(h1.fontFamily.provenance).toMatchObject({ kind: 'measured', source: 'computed-style', stateId: 'st_01', evidenceId: 'ev_000000000001' });
    expect(tokens.typography[0]!.id).toBe('tok_type_01');
    expect(tokens.typography[0]!.generatedName).toBe('type-01');
  });

  it('reports 390px as a breakpoint when the two viewports differ', () => {
    expect(tokens.breakpoints).toHaveLength(1);
    const bp = tokens.breakpoints[0]!;
    expect(bp.value.value).toBe('390px');
    expect(bp.kind).toBe('breakpoint');
    expect(bp.generatedName).toBe('bp-01');
    expect(bp.value.provenance).toMatchObject({ kind: 'observed', source: 'bounding-box', confidence: 1 });
    expect(bp.cluster.members).toEqual([
      { value: '390px', count: 1 },
      { value: '1280px', count: 1 },
    ]);
    expect(bp.cluster.properties).toEqual(['box', 'visible']);
    expect(bp.usage.stateIds).toEqual(['st_02', 'st_01']);
  });

  it('has no breakpoints with a single viewport', () => {
    const one = extractTokens(new Map([['st_01', captures.get('st_01')!]]), ctx);
    expect(one.breakpoints).toEqual([]);
    expect(one.colors.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(extractTokens(buildFixtureACaptures(), ctx))).toBe(JSON.stringify(tokens));
  });
});
