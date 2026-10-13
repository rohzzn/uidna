import { describe, expect, it } from 'vitest';
import { BehaviorRuleSchema, type Transition, type UiState } from '@uidna/schema';
import type { CapturedState } from '../browser/types.js';
import { deriveBehavior } from './behavior.js';
import { buildFixtureACapture, findNode } from './testing.js';

function toState(id: string, capture: CapturedState, kind: 'base' | 'derived', parent: string | null): UiState {
  return {
    id,
    pageId: 'pg_01',
    kind,
    parentStateId: parent,
    url: capture.url,
    title: capture.title,
    viewport: capture.viewport,
    capturedAt: capture.capturedAt,
    evidenceId: 'ev_000000000002',
    screenshot: capture.screenshot,
    roleTreeDigest: capture.roleTreeDigest,
    domDigest: capture.domDigest,
    document: capture.document,
    nodeCount: capture.nodes.length,
    nodes: [...capture.nodes],
    styles: capture.styles,
    roleTree: [...capture.roleTree],
    provenance: { kind: 'measured', source: 'computed-style', stateId: id, viewport: capture.viewport, evidenceId: 'ev_000000000002', capturedAt: capture.capturedAt, confidence: 1 },
  };
}

const closed = buildFixtureACapture({ viewportWidth: 390, stateId: 'st_02' });
const open = buildFixtureACapture({ viewportWidth: 390, menuOpen: true, stateId: 'st_03' });
const states = [toState('st_02', closed, 'base', null), toState('st_03', open, 'derived', 'st_02')];
const toggle = findNode(closed, '.nav-toggle')!;
const menu = findNode(closed, '#primary-menu')!;

const transition: Transition = {
  id: 'tr_01',
  from: 'st_02',
  action: { type: 'click', target: { nodeId: toggle.id, nodePath: toggle.path, role: 'button', name: 'Open menu', tag: 'button', nth: 0 } },
  to: 'st_03',
  sideEffects: false,
  network: { requests: 0, nonGet: 0 },
  revert: { method: 'toggle', succeeded: true },
  change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: [toggle.id, menu.id] },
  provenance: { kind: 'observed', source: 'interaction', stateId: 'st_02', evidenceId: 'ev_000000000003', capturedAt: '2026-10-13T12:01:00.000Z', confidence: 1 },
};

describe('deriveBehavior', () => {
  const rules = deriveBehavior(states, [transition]);
  const rule = rules[0]!;

  it('yields one schema-valid rule per transition with observed provenance', () => {
    expect(rules).toHaveLength(1);
    expect(BehaviorRuleSchema.safeParse(rule).success).toBe(true);
    expect(rule.id).toBe('bhv_01');
    expect(rule.transitionId).toBe('tr_01');
    expect(rule.event).toEqual({ type: 'click', target: transition.action.target });
    expect(rule.provenance).toEqual({
      kind: 'observed',
      source: 'interaction',
      stateId: 'st_02',
      viewport: { width: 390, height: 844 },
      evidenceId: 'ev_000000000003',
      capturedAt: '2026-10-13T12:01:00.000Z',
      confidence: 1,
    });
  });

  it('reports the aria-expanded flip on the target as toggle-attribute', () => {
    const toggled = rule.effects.find((e) => e.kind === 'toggle-attribute')!;
    expect(toggled).toEqual({ kind: 'toggle-attribute', attribute: 'aria-expanded', from: 'false', to: 'true', targetNodeId: toggle.id, targetNodePath: toggle.path });
    expect(rule.effects[0]!.targetNodeId).toBe(toggle.id);
    const label = rule.effects.find((e) => e.attribute === 'aria-label')!;
    expect(label).toMatchObject({ kind: 'set-attribute', from: 'Open menu', to: 'Close menu' });
  });

  it('reports the menu becoming visible as show and its class change as toggle-class', () => {
    const shown = rule.effects.find((e) => e.kind === 'show' && e.targetNodeId === menu.id);
    expect(shown).toEqual({ kind: 'show', targetNodeId: menu.id, targetNodePath: menu.path });
    const classed = rule.effects.find((e) => e.kind === 'toggle-class' && e.targetNodeId === menu.id)!;
    expect(classed).toMatchObject({ attribute: 'class', from: 'nav-menu', to: 'nav-menu is-open', details: 'added: is-open' });
    expect(rule.effects.filter((e) => e.kind === 'show').length).toBeGreaterThanOrEqual(5);
    expect(rule.effects.some((e) => e.kind === 'unknown')).toBe(false);
  });

  it('reports no difference honestly as unknown', () => {
    const same: Transition = { ...transition, id: 'tr_02', to: 'st_02' };
    const [noop] = deriveBehavior(states, [same]);
    expect(noop!.effects).toEqual([{ kind: 'unknown', details: 'no attribute, text, visibility or style difference between the two states' }]);
  });

  it('reports a text change and a replaced element instead of claiming no difference', () => {
    const brand = findNode(closed, '.brand-name')!;
    const footer = findNode(closed, '.site-footer')!;
    const base = states[0]!;
    const edited: UiState = {
      ...base,
      id: 'st_04',
      nodes: base.nodes.map((n) => (n.id === brand.id ? { ...n, text: 'Lumen 2' } : n.id === footer.id ? { ...n, tag: 'aside' } : n)),
    };
    const [rule4] = deriveBehavior([...states, edited], [{ ...transition, id: 'tr_05', to: 'st_04' }]);
    expect(rule4!.effects).toContainEqual({ kind: 'unknown', from: 'Lumen', to: 'Lumen 2', targetNodeId: brand.id, targetNodePath: brand.path, details: 'own text changed' });
    const replaced = rule4!.effects.filter((e) => e.targetNodeId === footer.id);
    expect(replaced.map((e) => e.kind)).toEqual(['hide', 'show']);
    expect(replaced[0]!.details).toBe('node replaced: <footer> became <aside>');
    // The footer's own attributes are not diffed against the unrelated element.
    expect(rule4!.effects.some((e) => e.targetNodeId === footer.id && e.attribute !== undefined)).toBe(false);
  });

  it('falls back to the body as target for document-level key actions and flags missing states', () => {
    const key: Transition = { ...transition, id: 'tr_03', action: { type: 'key', target: null, key: 'Escape' } };
    const [rule3] = deriveBehavior(states, [key]);
    expect(rule3!.event.target).toMatchObject({ nodePath: '', tag: 'body', nth: 0 });
    expect(rule3!.event.key).toBe('Escape');
    const [missing] = deriveBehavior(states, [{ ...transition, id: 'tr_04', to: 'st_99' }]);
    expect(missing!.effects[0]).toMatchObject({ kind: 'unknown' });
    expect(missing!.effects[0]!.details).toContain('st_99');
  });
});
