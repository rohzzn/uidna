import { describe, expect, it } from 'vitest';
import { buildFixtureACapture, findNode, findNodes } from '../analysis/testing.js';
import { fingerprintNode, styleClassOf, fontSizeBucket } from './fingerprint.js';
import { unwrap } from './result.js';

const capture = buildFixtureACapture({ viewportWidth: 1280 });

describe('fingerprintNode', () => {
  it('gives the three cards the same fingerprint although their text differs', () => {
    const cards = findNodes(capture, '.card');
    expect(cards).toHaveLength(3);
    const prints = cards.map((card) => unwrap(fingerprintNode(capture, card.id)));
    expect(new Set(prints.map((p) => p.fingerprint)).size).toBe(1);
    expect(prints[0]).toMatchObject({ signature: 'article>div+h3+p', depth: 1, childCount: 3 });
  });

  it('separates a card from the hero section', () => {
    const card = findNode(capture, '.card')!;
    const hero = findNode(capture, '.hero')!;
    expect(unwrap(fingerprintNode(capture, card.id)).fingerprint).not.toBe(unwrap(fingerprintNode(capture, hero.id)).fingerprint);
  });

  it('ignores text and class names but not tag/role structure', () => {
    const [first, second] = findNodes(capture, '.card');
    const altered = {
      nodes: capture.nodes.map((node) =>
        node.id === first!.id ? { ...node, attrs: { ...node.attrs, class: 'card card-featured' }, text: 'different' } : node,
      ),
      styles: capture.styles,
    };
    expect(unwrap(fingerprintNode(altered, first!.id)).fingerprint).toBe(unwrap(fingerprintNode(capture, second!.id)).fingerprint);

    const retagged = {
      nodes: capture.nodes.map((node) => (node.id === first!.id ? { ...node, tag: 'section' } : node)),
      styles: capture.styles,
    };
    expect(unwrap(fingerprintNode(retagged, first!.id)).fingerprint).not.toBe(unwrap(fingerprintNode(capture, second!.id)).fingerprint);
  });

  it('fails with not-found for an unknown node id', () => {
    const result = fingerprintNode(capture, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe('not-found');
  });
});

describe('styleClassOf', () => {
  it('reads display, background, radius and font-size bucket with UA defaults for missing properties', () => {
    expect(styleClassOf({ display: 'inline-flex', 'background-color': 'rgb(47, 91, 234)', 'border-top-left-radius': '12px', 'font-size': '16px' })).toEqual({
      display: 'inline-flex',
      flexDirection: 'row',
      hasBackground: true,
      hasRadius: true,
      fontSizeBucket: 'md',
    });
    expect(styleClassOf({ display: 'block', 'background-color': 'rgba(0, 0, 0, 0)' })).toMatchObject({ hasBackground: false, hasRadius: false, fontSizeBucket: 'unknown' });
  });

  it('buckets font sizes coarsely', () => {
    expect([12, 14, 18, 24, 36, 48].map(fontSizeBucket)).toEqual(['xs', 'sm', 'md', 'lg', 'xl', 'xxl']);
  });
});
