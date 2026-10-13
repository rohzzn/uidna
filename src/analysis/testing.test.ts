import { describe, expect, it } from 'vitest';
import { ScanRecordSchema } from '../application/records.js';
import { CapturedStateSchema } from '../browser/schemas.js';
import { buildFixtureACapture, buildFixtureACaptures, buildFixtureAScanRecord, findNode, findNodes } from './testing.js';

describe('buildFixtureACapture', () => {
  it('validates against the capture schema at both viewports and with the menu open', () => {
    for (const options of [{ viewportWidth: 1280 }, { viewportWidth: 390 }, { viewportWidth: 390, menuOpen: true }, { viewportWidth: 1280, withEmbeds: true }]) {
      const parsed = CapturedStateSchema.safeParse(buildFixtureACapture(options));
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildFixtureACapture({ viewportWidth: 390 }))).toBe(JSON.stringify(buildFixtureACapture({ viewportWidth: 390 })));
  });

  it('mirrors Fixture A: landmarks, hamburger visibility, card grid columns and hidden menu', () => {
    const desktop = buildFixtureACapture({ viewportWidth: 1280 });
    const phone = buildFixtureACapture({ viewportWidth: 390 });
    expect(desktop.nodes[0]!.tag).toBe('body');
    expect(desktop.nodes.filter((n) => n.role !== null).map((n) => n.role)).toEqual(expect.arrayContaining(['banner', 'navigation', 'main', 'contentinfo']));
    expect(findNode(desktop, '.nav-toggle')!.visible).toBe(false);
    expect(findNode(phone, '.nav-toggle')!.visible).toBe(true);
    expect(findNode(desktop, '#primary-menu')!.visible).toBe(true);
    expect(findNode(phone, '#primary-menu')!.visible).toBe(false);
    expect(findNode(phone, '#primary-menu')!.box).toBeNull();
    expect(findNodes(desktop, '.card')).toHaveLength(3);
    expect(findNodes(desktop, '.nav-link')).toHaveLength(4);
    expect(findNodes(desktop, 'details')).toHaveLength(3);
    const gridStyle = (c: typeof desktop) => c.styles[findNode(c, '.card-grid')!.styleId]!['grid-template-columns'];
    expect(gridStyle(desktop)!.split(' ')).toHaveLength(3);
    expect(gridStyle(phone)!.split(' ')).toHaveLength(1);
  });

  it('keeps boxes coherent: children inside parents, sibling cards non-overlapping', () => {
    const capture = buildFixtureACapture({ viewportWidth: 1280 });
    const byId = new Map(capture.nodes.map((n) => [n.id, n]));
    for (const node of capture.nodes) {
      if (!node.box || node.parentId === null) continue;
      const parent = byId.get(node.parentId)!;
      if (!parent.box) continue;
      expect(node.box.x).toBeGreaterThanOrEqual(parent.box.x - 0.01);
      expect(node.box.y).toBeGreaterThanOrEqual(parent.box.y - 0.01);
      expect(node.box.x + node.box.width).toBeLessThanOrEqual(parent.box.x + parent.box.width + 0.01);
    }
    const [a, b, c] = findNodes(capture, '.card').map((n) => n.box!);
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
    expect(b!.x + b!.width).toBeLessThanOrEqual(c!.x);
    expect(a!.y).toBe(b!.y);
  });

  it('drops UA defaults from styles and dedupes identical style objects', () => {
    const capture = buildFixtureACapture({ viewportWidth: 1280 });
    for (const style of Object.values(capture.styles)) {
      expect(style.position).not.toBe('static');
      expect(style['margin-top']).not.toBe('0px');
    }
    const ids = capture.nodes.map((n) => n.styleId);
    expect(new Set(ids).size).toBeLessThan(ids.length);
    for (const node of capture.nodes) expect(capture.styles[node.styleId]).toBeDefined();
  });

  it('models the open menu as a visible flex column with aria-expanded true', () => {
    const open = buildFixtureACapture({ viewportWidth: 390, menuOpen: true });
    const toggle = findNode(open, '.nav-toggle')!;
    expect(toggle.attrs['aria-expanded']).toBe('true');
    expect(toggle.a11y.expanded).toBe(true);
    const menu = findNode(open, '#primary-menu')!;
    expect(menu.visible).toBe(true);
    expect(menu.attrs.class).toBe('nav-menu is-open');
    expect(open.styles[menu.styleId]!['flex-direction']).toBe('column');
    for (const link of findNodes(open, '.nav-link')) expect(link.visible).toBe(true);
  });
});

describe('buildFixtureAScanRecord', () => {
  it('produces a valid scan record consistent with the captures', () => {
    const captures = buildFixtureACaptures();
    const record = buildFixtureAScanRecord({ captures });
    expect(ScanRecordSchema.safeParse(record).success).toBe(true);
    expect(record.states.map((s) => [s.stateId, s.kind, s.viewport.width])).toEqual([
      ['st_01', 'base', 1280],
      ['st_02', 'base', 390],
    ]);
    expect(record.states[0]!.capturePath).toBe('states/st_01/capture.json');
  });
});
