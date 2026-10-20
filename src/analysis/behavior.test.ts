import { describe, expect, it } from 'vitest';
import { BehaviorRuleSchema, type Transition, type UiNode, type UiState } from 'uidna-schema';
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

/* ------------------------------------------------------- forms and pages */

type FormFacts = NonNullable<UiNode['form']>;

interface FormStateOptions {
  readonly id: string;
  readonly kind: 'base' | 'derived';
  readonly parent: string | null;
  /** Overrides for the name control's form facts, attributes and a11y props. */
  readonly name: Partial<FormFacts> & { readonly attrs?: Record<string, string>; readonly a11y?: UiNode['a11y'] };
  /** Text of the error element; null keeps it hidden and empty. */
  readonly error: string | null;
  readonly url?: string;
}

/** A minimal signup form: body > main > form > (input#name, p#name-error, button submit). */
function formState(options: FormStateOptions): UiState {
  const at = '2026-10-13T12:05:00.000Z';
  const viewport = { width: 1280, height: 800 };
  const node = (partial: Partial<UiNode> & Pick<UiNode, 'id' | 'path' | 'tag'>): UiNode => ({
    parentId: null,
    depth: partial.path === '' ? 0 : partial.path.split('/').length,
    role: null,
    name: null,
    attrs: {},
    text: null,
    box: { x: 0, y: 0, width: 320, height: 40 },
    styleId: 's_block',
    a11y: {},
    visible: true,
    interactive: false,
    inForm: false,
    childIds: [],
    ...partial,
  });
  const { attrs: nameAttrs, a11y: nameA11y, ...nameFacts } = options.name;
  const form: FormFacts = { valid: false, validationMessage: 'Please fill out this field.', required: true, type: 'text', hasValue: false, ...nameFacts };
  const nodes: UiNode[] = [
    node({ id: 'n0', path: '', tag: 'body', childIds: ['n1'] }),
    node({ id: 'n1', parentId: 'n0', path: '0', tag: 'main', role: 'main', childIds: ['n2'] }),
    node({ id: 'n2', parentId: 'n1', path: '0/0', tag: 'form', role: 'form', attrs: { id: 'signup' }, childIds: ['n3', 'n4', 'n5'] }),
    node({
      id: 'n3',
      parentId: 'n2',
      path: '0/0/0',
      tag: 'input',
      role: 'textbox',
      name: 'Full name',
      attrs: { id: 'name', name: 'name', type: 'text', ...(nameAttrs ?? {}) },
      a11y: { focusable: true, nth: 0, ...(nameA11y ?? {}) },
      interactive: true,
      inForm: true,
      styleId: 's_input',
      form,
    }),
    node({
      id: 'n4',
      parentId: 'n2',
      path: '0/0/1',
      tag: 'p',
      role: options.error === null ? null : 'alert',
      attrs: options.error === null ? { id: 'name-error', hidden: '' } : { id: 'name-error' },
      text: options.error,
      box: options.error === null ? null : { x: 0, y: 44, width: 320, height: 20 },
      visible: options.error !== null,
      inForm: true,
      styleId: options.error === null ? 's_hidden' : 's_error',
    }),
    node({
      id: 'n5',
      parentId: 'n2',
      path: '0/0/2',
      tag: 'button',
      role: 'button',
      name: 'Create account',
      attrs: { type: 'submit' },
      text: 'Create account',
      a11y: { focusable: true, nth: 0 },
      interactive: true,
      inForm: true,
      styleId: 's_button',
      form: { valid: true, validationMessage: null, required: false, type: 'submit', hasValue: false },
    }),
  ];
  return {
    id: options.id,
    pageId: 'pg_01',
    kind: options.kind,
    parentStateId: options.parent,
    url: options.url ?? 'http://127.0.0.1:4173/',
    title: 'Lumen — Create your account',
    viewport,
    capturedAt: at,
    evidenceId: 'ev_000000000005',
    screenshot: null,
    roleTreeDigest: `rt-${options.id}`,
    domDigest: `dom-${options.id}`,
    document: { width: 1280, height: 600, scrollHeight: 600 },
    nodeCount: nodes.length,
    nodes,
    styles: {
      s_block: { display: 'block' },
      s_input: { display: 'inline-block', 'border-top-color': 'rgb(223, 227, 236)' },
      s_hidden: { display: 'none' },
      s_error: { display: 'block', color: 'rgb(176, 32, 32)' },
      s_button: { display: 'inline-flex', 'background-color': 'rgb(47, 91, 234)' },
    },
    roleTree: [],
    provenance: { kind: 'measured', source: 'computed-style', stateId: options.id, viewport, evidenceId: 'ev_000000000005', capturedAt: at, confidence: 1 },
  };
}

function formTransition(id: string, from: string, to: string, action: Transition['action'], extra: Partial<Transition> = {}): Transition {
  return {
    id,
    from,
    action,
    to,
    sideEffects: false,
    network: { requests: 0, nonGet: 0 },
    revert: { method: 'reload', succeeded: true },
    change: { domChanged: true, roleTreeChanged: true, screenshotChanged: true, changedNodeIds: [] },
    provenance: { kind: 'observed', source: 'interaction', stateId: from, evidenceId: 'ev_000000000006', capturedAt: '2026-10-13T12:06:00.000Z', confidence: 1 },
    ...extra,
  };
}

const input = { nodeId: 'n3', nodePath: '0/0/0', role: 'textbox', name: 'Full name', tag: 'input', nth: 0 } as const;
const submitButton = { nodeId: 'n5', nodePath: '0/0/2', role: 'button', name: 'Create account', tag: 'button', nth: 0 } as const;

describe('deriveBehavior on forms and navigation', () => {
  const empty = formState({ id: 'st_10', kind: 'base', parent: null, name: {}, error: null });
  const filled = formState({ id: 'st_11', kind: 'derived', parent: 'st_10', name: { hasValue: true, valid: true, validationMessage: null }, error: null });
  const invalid = formState({
    id: 'st_12',
    kind: 'derived',
    parent: 'st_10',
    name: { attrs: { 'aria-invalid': 'true', 'aria-errormessage': 'name-error' }, a11y: { invalid: true, errorMessage: 'Enter your full name.' } },
    error: 'Enter your full name.',
  });
  const formStates = [empty, filled, invalid];

  it('reports a fill as the control gaining a value, without the value, plus the validity change', () => {
    const fill = formTransition('tr_10', 'st_10', 'st_11', { type: 'fill', target: { ...input }, value: 'Ada Lovelace' });
    const [rule] = deriveBehavior(formStates, [fill]);
    expect(BehaviorRuleSchema.safeParse(rule).success).toBe(true);
    expect(rule!.event).toEqual({ type: 'fill', target: input, value: 'Ada Lovelace' });
    expect(rule!.effects).toEqual([
      { kind: 'set-attribute', attribute: 'value', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'synthetic value typed' },
      { kind: 'unknown', from: 'invalid', to: 'valid', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'native constraint validity changed' },
    ]);
    expect(JSON.stringify(rule!.effects)).not.toContain('Ada');
  });

  it('never copies a value attribute of a form control into a rule, even when the capture reports it', () => {
    const withValueAttr: UiState = { ...filled, id: 'st_13', nodes: filled.nodes.map((n) => (n.id === 'n3' ? { ...n, attrs: { ...n.attrs, value: 'Ada Lovelace' } } : n)) };
    const fill = formTransition('tr_11', 'st_10', 'st_13', { type: 'fill', target: { ...input }, value: 'Ada Lovelace' });
    const [rule] = deriveBehavior([...formStates, withValueAttr], [fill]);
    const valueEffects = rule!.effects.filter((e) => e.attribute === 'value');
    expect(valueEffects).toEqual([{ kind: 'set-attribute', attribute: 'value', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'synthetic value typed' }]);
    expect(JSON.stringify(rule!.effects)).not.toContain('Ada');
  });

  it('keeps a control value out of the rule even when the capture carries no form facts for the control', () => {
    // A capture whose form facts could not be read (its limitations say so) still never lends a value to a rule.
    const strip = (state: UiState, id: string): UiState => ({
      ...state,
      id,
      nodes: state.nodes.map((n) => {
        if (n.id !== 'n3') return n;
        const { form, ...rest } = n;
        expect(form).toBeDefined();
        return id === 'st_16' ? { ...rest, attrs: { ...rest.attrs, value: 'Ada Lovelace' } } : rest;
      }),
    });
    const before = strip(empty, 'st_15');
    const after = strip(filled, 'st_16');
    const fill = formTransition('tr_17', 'st_15', 'st_16', { type: 'fill', target: { ...input }, value: 'Ada Lovelace' });
    const [rule] = deriveBehavior([before, after], [fill]);
    expect(BehaviorRuleSchema.safeParse(rule).success).toBe(true);
    expect(rule!.effects).toEqual([{ kind: 'set-attribute', attribute: 'value', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'synthetic value typed' }]);
    expect(JSON.stringify(rule!.effects)).not.toContain('Ada');
  });

  it('reports a script filling a control (a click) as the control gaining a value, and clearing it', () => {
    const fillButton = formTransition('tr_14', 'st_10', 'st_11', { type: 'click', target: { ...submitButton } });
    const [rule] = deriveBehavior(formStates, [fillButton]);
    expect(rule!.effects.find((e) => e.attribute === 'value')).toEqual({ kind: 'set-attribute', attribute: 'value', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'control gained a value' });
    const [cleared] = deriveBehavior(formStates, [formTransition('tr_15', 'st_11', 'st_10', { type: 'click', target: { ...submitButton } })]);
    expect(cleared!.effects.find((e) => e.attribute === 'value')).toMatchObject({ kind: 'set-attribute', details: 'value cleared' });
    expect(cleared!.effects.find((e) => e.kind === 'unknown')).toMatchObject({ from: 'valid', to: 'invalid', details: 'native constraint validity changed: Please fill out this field.' });
  });

  it('reports an empty submit as aria-invalid set on the control and the error element shown with its message', () => {
    const submit = formTransition('tr_12', 'st_10', 'st_12', { type: 'submit', target: { ...submitButton } });
    const [rule] = deriveBehavior(formStates, [submit]);
    expect(rule!.event).toEqual({ type: 'submit', target: submitButton });
    expect(rule!.effects).toEqual(
      expect.arrayContaining([
        { kind: 'set-attribute', attribute: 'aria-errormessage', to: 'name-error', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'attribute added' },
        { kind: 'set-attribute', attribute: 'aria-invalid', to: 'true', targetNodeId: 'n3', targetNodePath: '0/0/0', details: 'attribute added' },
        { kind: 'set-attribute', attribute: 'hidden', from: '', targetNodeId: 'n4', targetNodePath: '0/0/1', details: 'attribute removed' },
        { kind: 'show', to: 'Enter your full name.', targetNodeId: 'n4', targetNodePath: '0/0/1', details: 'own text changed' },
      ]),
    );
    // The message travels on the show effect only: no second `unknown` text effect, nothing about the untouched button.
    expect(rule!.effects.filter((e) => e.kind === 'unknown')).toEqual([]);
    expect(rule!.effects.filter((e) => e.targetNodeId === 'n4').map((e) => e.kind)).toEqual(['set-attribute', 'show']);
    expect(rule!.effects.some((e) => e.targetNodeId === 'n5')).toBe(false);
  });

  it('reduces a transition that navigated to another crawled page to one navigate effect at the link', () => {
    const features = formState({ id: 'st_14', kind: 'base', parent: null, name: {}, error: null, url: 'http://127.0.0.1:4173/features.html' });
    const link = { nodeId: 'n9', nodePath: '0/1', role: 'link', name: 'Features', tag: 'a', nth: 0 } as const;
    const navigated = formTransition('tr_13', 'st_10', 'st_14', { type: 'click', target: { ...link } }, { sideEffects: true, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } });
    const [rule] = deriveBehavior([...formStates, features], [navigated]);
    expect(rule!.effects).toEqual([
      { kind: 'navigate', from: 'http://127.0.0.1:4173/', to: 'http://127.0.0.1:4173/features.html', targetNodeId: 'n9', targetNodePath: '0/1', details: 'http://127.0.0.1:4173/features.html' },
    ]);
    expect(BehaviorRuleSchema.safeParse(rule).success).toBe(true);
    // Without the navigation marker the same pair of states is diffed node by node, as before.
    const [diffed] = deriveBehavior([...formStates, features], [{ ...navigated, navigation: null }]);
    expect(diffed!.effects[0]).toEqual({ kind: 'navigate', from: 'http://127.0.0.1:4173/', to: 'http://127.0.0.1:4173/features.html' });
    // A navigation whose landing state was not captured still names the target.
    const [landingMissing] = deriveBehavior(formStates, [{ ...navigated, id: 'tr_16', to: 'st_99' }]);
    expect(landingMissing!.effects).toEqual([{ kind: 'navigate', from: 'http://127.0.0.1:4173/', to: 'http://127.0.0.1:4173/features.html', targetNodeId: 'n9', targetNodePath: '0/1', details: 'http://127.0.0.1:4173/features.html' }]);
  });
});
