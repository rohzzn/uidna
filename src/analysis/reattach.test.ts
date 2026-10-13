import { describe, expect, it } from 'vitest';
import { assembleDna } from './assemble.js';
import { buildFixtureACaptures, buildFixtureAScanRecord } from './testing.js';

const AT = '2026-10-13T17:29:00.000Z';

function assembled() {
  const captures = buildFixtureACaptures();
  const scan = buildFixtureAScanRecord({ captures });
  const result = assembleDna({ scan, captures, toolVersion: '0.1.0' });
  if (!result.ok) throw new Error(result.error.message);
  return { scan, captures, document: result.value };
}

describe('re-assembly keeps agent annotate readings', () => {
  it('re-attaches an annotation whose measured value is unchanged', () => {
    const { scan, captures, document } = assembled();
    const color = document.visual.tokens.colors[0];
    expect(color).toBeDefined();
    if (!color) return;
    color.value.annotation = { value: 'brand', provenance: { kind: 'inferred', source: 'agent', capturedAt: AT, confidence: 0.8, rationale: 'brand guide' } };
    document.annotations.push({ id: 'an_001', appliedAt: AT, path: '/visual/tokens/colors/0/value/annotation', op: 'annotate', value: 'brand', provenance: { kind: 'inferred', source: 'agent', capturedAt: AT, confidence: 0.8 } });

    const again = assembleDna({ scan, captures, previous: document, toolVersion: '0.1.0' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.visual.tokens.colors[0]?.value.annotation?.value).toBe('brand');
    expect(again.value.visual.tokens.colors[0]?.value.annotation?.provenance.source).toBe('agent');
    expect(again.value.visual.tokens.colors[0]?.value.provenance.kind).toBe('measured');
    expect(again.value.annotations).toHaveLength(1);
    expect(again.value.limitations.some((l) => l.subject === 'annotation an_001')).toBe(false);
  });

  it('records a limitation instead of guessing when the value at the path changed', () => {
    const { scan, captures, document } = assembled();
    const color = document.visual.tokens.colors[0];
    if (!color) throw new Error('no color token');
    color.value.annotation = { value: 'brand', provenance: { kind: 'inferred', source: 'agent', capturedAt: AT, confidence: 0.8 } };
    // Pretend the previous measurement differed: the reading must not be carried onto a different value.
    color.value.value = '#000001';
    document.annotations.push({ id: 'an_002', appliedAt: AT, path: '/visual/tokens/colors/0/value/annotation', op: 'annotate', value: 'brand', provenance: { kind: 'inferred', source: 'agent', capturedAt: AT, confidence: 0.8 } });

    const again = assembleDna({ scan, captures, previous: document, toolVersion: '0.1.0' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.visual.tokens.colors[0]?.value.annotation).toBeUndefined();
    const limitation = again.value.limitations.find((l) => l.subject === 'annotation an_002');
    expect(limitation?.kind).toBe('not-observed');
    expect(limitation?.reason).toContain('/visual/tokens/colors/0/value/annotation');
  });
});
