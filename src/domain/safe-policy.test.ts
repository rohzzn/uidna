import { describe, expect, it } from 'vitest';
import type { UiNode } from '@rohzzn/uidna-schema';
import { buildFixtureACapture, findNode, findNodes } from '../analysis/testing.js';
import type { CapturedState, NetworkEntry } from '../browser/types.js';
import {
  CLICK_BUTTON_PRIORITY,
  CLICK_DISCLOSURE_PRIORITY,
  CLICK_OTHER_PRIORITY,
  classifyInteractions,
  clickExclusion,
  DEFAULT_DENY_NAMES,
  FOCUS_PRIORITY,
  HOVER_PRIORITY,
  isDisclosureTrigger,
  isSideEffect,
  matchDenyName,
  pageLevelActions,
} from './safe-policy.js';

/* ------------------------------------------------------------- builders */

type NodeInit = Partial<UiNode> & Pick<UiNode, 'tag'>;

/** A visible, interactive node with sensible defaults; `path` is derived from the index when omitted. */
function node(init: NodeInit, index: number): UiNode {
  return {
    id: `n${index}`,
    parentId: index === 0 ? null : 'n0',
    path: index === 0 ? '' : `${index - 1}`,
    depth: index === 0 ? 0 : 1,
    role: null,
    name: null,
    attrs: {},
    text: null,
    box: { x: 0, y: index * 30, width: 100, height: 20 },
    styleId: 's1',
    a11y: {},
    visible: true,
    interactive: true,
    inForm: false,
    childIds: [],
    ...init,
  };
}

/** A minimal captured state whose body holds `inits` as children in order. */
function state(inits: readonly NodeInit[]): CapturedState {
  const nodes = [node({ tag: 'body', interactive: false, box: { x: 0, y: 0, width: 1280, height: 800 } }, 0), ...inits.map((init, i) => node(init, i + 1))];
  const body = nodes[0];
  if (body) body.childIds = nodes.slice(1).map((n) => n.id);
  return {
    url: 'http://127.0.0.1:4173/',
    title: 'Synthetic',
    viewport: { width: 1280, height: 800 },
    capturedAt: '2026-10-13T12:00:00.000Z',
    document: { width: 1280, height: 800, scrollHeight: 800 },
    nodes,
    styles: { s1: {} },
    roleTree: [],
    roleTreeDigest: 'role',
    domDigest: 'dom',
    screenshot: null,
    fonts: [],
    assets: [],
    network: [],
    limitations: [],
  };
}

function kindsOf(result: ReturnType<typeof classifyInteractions>, nodeId: string): string[] {
  return result.candidates.filter((c) => c.node.id === nodeId).map((c) => c.kind);
}

function skippedReasons(result: ReturnType<typeof classifyInteractions>, nodeId: string): string[] {
  return result.skipped.filter((s) => s.node.id === nodeId).map((s) => s.reason);
}

/* ------------------------------------------------------------ deny names */

describe('DEFAULT_DENY_NAMES and matchDenyName', () => {
  it('is the documented list', () => {
    expect(DEFAULT_DENY_NAMES).toEqual(['delete', 'remove', 'pay', 'buy', 'checkout', 'send', 'submit', 'sign out', 'log out', 'logout', 'unsubscribe', 'confirm']);
  });

  it('matches whole words case-insensitively and multi-word phrases across whitespace', () => {
    expect(matchDenyName('Sign out of Lumen')).toBe('sign out');
    expect(matchDenyName('SIGN   OUT')).toBe('sign out');
    expect(matchDenyName('Delete note')).toBe('delete');
    expect(matchDenyName('Confirm order')).toBe('confirm');
    expect(matchDenyName('Pay now')).toBe('pay');
    expect(matchDenyName('Log out')).toBe('log out');
    expect(matchDenyName('Logout')).toBe('logout');
  });

  it('does not match inside other words', () => {
    expect(matchDenyName('confirmation')).toBeNull();
    expect(matchDenyName('Order confirmation')).toBeNull();
    expect(matchDenyName('Undelete')).toBeNull();
    expect(matchDenyName('Payment plans')).toBeNull();
    expect(matchDenyName('Removed items')).toBeNull();
    expect(matchDenyName('Signout')).toBeNull();
    expect(matchDenyName('Submitted')).toBeNull();
  });

  it('treats punctuation as a boundary and ignores empty input', () => {
    expect(matchDenyName('Delete?')).toBe('delete');
    expect(matchDenyName('(Remove)')).toBe('remove');
    expect(matchDenyName('Buy, now')).toBe('buy');
    expect(matchDenyName('')).toBeNull();
    expect(matchDenyName(null)).toBeNull();
    expect(matchDenyName(undefined)).toBeNull();
  });

  it('uses the given phrases instead of the defaults and escapes regex characters', () => {
    expect(matchDenyName('Delete note', ['archive'])).toBeNull();
    expect(matchDenyName('Archive note', ['archive'])).toBe('archive');
    expect(matchDenyName('Buy (2+1)', ['(2+1)'])).toBe('(2+1)');
    expect(matchDenyName('a.b', ['a.b'])).toBe('a.b');
    expect(matchDenyName('axb', ['a.b'])).toBeNull();
    expect(matchDenyName('anything', ['', '   '])).toBeNull();
  });
});

/* ------------------------------------------------------- click exclusion */

describe('clickExclusion', () => {
  it('excludes form members before anything else', () => {
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, inForm: true }, 1))).toBe('inside a form');
    expect(clickExclusion(node({ tag: 'button', inForm: true }, 1))).toBe('inside a form');
  });

  it('distinguishes fragment links from navigating links', () => {
    expect(clickExclusion(node({ tag: 'a', role: 'link', attrs: { href: '#faq' } }, 1))).toBe('fragment link: scroll only');
    expect(clickExclusion(node({ tag: 'a', role: 'link', attrs: { href: ' #top' } }, 1))).toBe('fragment link: scroll only');
    expect(clickExclusion(node({ tag: 'a', role: 'link', attrs: { href: '/pricing' } }, 1))).toBe('link navigates');
    expect(clickExclusion(node({ tag: 'a', role: 'link', attrs: { href: 'https://example.com/' } }, 1))).toBe('link navigates');
    expect(clickExclusion(node({ tag: 'a', role: 'link', attrs: { href: '' } }, 1))).toBe('link navigates');
  });

  it('excludes submit, reset and image controls', () => {
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'submit' } }, 1))).toBe('submits');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'Reset' } }, 1))).toBe('submits');
    expect(clickExclusion(node({ tag: 'input', attrs: { type: 'submit' } }, 1))).toBe('submits');
    expect(clickExclusion(node({ tag: 'input', attrs: { type: 'image' } }, 1))).toBe('submits');
    expect(clickExclusion(node({ tag: 'input', attrs: { type: 'reset' } }, 1))).toBe('submits');
  });

  it('excludes denied names found in the accessible name or the own text', () => {
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: 'Delete note' }, 1))).toBe('denied name: delete');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: null, text: 'Sign out of Lumen' }, 1))).toBe('denied name: sign out');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: 'Open confirmation' }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: 'Archive' }, 1), ['archive'])).toBe('denied name: archive');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: 'Delete' }, 1), ['archive'])).toBeNull();
  });

  it('excludes denied names found only in the descendants (no accessible name, or an aria-label that hides the visible label)', () => {
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: null, text: null }, 1), DEFAULT_DENY_NAMES, 'Delete')).toBe('denied name: delete');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: 'Close', text: null }, 1), DEFAULT_DENY_NAMES, 'Sign out')).toBe('denied name: sign out');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: 'Close', text: null }, 1), DEFAULT_DENY_NAMES, 'Close the panel')).toBeNull();
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' }, name: null, text: null }, 1), DEFAULT_DENY_NAMES, null)).toBeNull();
  });

  it('allows the documented click triggers and nothing else', () => {
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button' } }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'button' }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'summary' }, 1))).toBeNull();
    for (const role of ['tab', 'button']) {
      expect(clickExclusion(node({ tag: 'div', role, attrs: { tabindex: '0' } }, 1))).toBeNull();
    }
    for (const role of ['menuitem', 'switch', 'checkbox', 'radio', 'option', 'treeitem']) {
      expect(clickExclusion(node({ tag: 'div', role, attrs: { tabindex: '0' } }, 1)), role).toContain('not a known safe click target');
    }
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button', form: 'checkout' } }, 1))).toBe('submits');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button', 'aria-label': 'Delete note' }, name: null, text: null }, 1))).toBe('denied name: delete');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button', title: 'Pay now' }, name: null, text: null }, 1))).toBe('denied name: pay');
    expect(clickExclusion(node({ tag: 'button', attrs: { type: 'button', formaction: '/pay' } }, 1))).toBe('submits');
    expect(clickExclusion(node({ tag: 'div', attrs: { 'aria-expanded': 'false' } }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'div', attrs: { 'aria-controls': 'panel' } }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'div', attrs: { 'aria-haspopup': 'menu' } }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'div', attrs: { role: 'combobox' } }, 1))).toBeNull();
    expect(clickExclusion(node({ tag: 'div', attrs: { tabindex: '0' } }, 1))).toContain('not a known safe click target');
    expect(clickExclusion(node({ tag: 'input', attrs: { type: 'text' }, role: 'textbox' }, 1))).toContain('not a known safe click target');
    expect(clickExclusion(node({ tag: 'a', role: 'link' }, 1))).toContain('not a known safe click target');
  });

  it('recognizes disclosure triggers', () => {
    expect(isDisclosureTrigger(node({ tag: 'summary' }, 1))).toBe(true);
    expect(isDisclosureTrigger(node({ tag: 'button', attrs: { 'aria-expanded': 'false' } }, 1))).toBe(true);
    expect(isDisclosureTrigger(node({ tag: 'button', attrs: { 'aria-haspopup': 'true' } }, 1))).toBe(true);
    expect(isDisclosureTrigger(node({ tag: 'button', attrs: { 'aria-controls': 'x' } }, 1))).toBe(false);
    expect(isDisclosureTrigger(node({ tag: 'div', role: 'tab' }, 1))).toBe(false);
  });
});

/* --------------------------------------------------- classifyInteractions */

describe('classifyInteractions on synthetic states', () => {
  it('ignores non-interactive nodes entirely', () => {
    const result = classifyInteractions(state([{ tag: 'p', interactive: false, text: 'Hello' }, { tag: 'h1', interactive: false, role: 'heading' }]));
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('skips hidden and disabled interactive nodes for every kind', () => {
    const result = classifyInteractions(
      state([
        { tag: 'button', attrs: { type: 'button' }, visible: false, box: null },
        { tag: 'button', attrs: { type: 'button' }, visible: false },
        { tag: 'button', attrs: { type: 'button' }, box: null },
        { tag: 'button', attrs: { type: 'button', disabled: '' } },
        { tag: 'button', attrs: { type: 'button' }, a11y: { disabled: true } },
      ]),
    );
    expect(result.candidates).toEqual([]);
    for (const id of ['n1', 'n2', 'n3']) expect(skippedReasons(result, id)).toEqual(['click: not visible', 'hover: not visible', 'focus: not visible']);
    for (const id of ['n4', 'n5']) expect(skippedReasons(result, id)).toEqual(['click: disabled', 'hover: disabled', 'focus: disabled']);
    expect(result.skipped).toHaveLength(15);
  });

  it('treats aria-disabled="true" as disabled even without an accessibility tree', () => {
    const result = classifyInteractions(state([{ tag: 'button', attrs: { type: 'button', 'aria-disabled': 'true' } }, { tag: 'button', attrs: { type: 'button', 'aria-disabled': 'false' } }]));
    expect(skippedReasons(result, 'n1')).toEqual(['click: disabled', 'hover: disabled', 'focus: disabled']);
    expect(kindsOf(result, 'n2')).toEqual(['click', 'hover', 'focus']);
  });

  it('denies a click when the denied word sits in a descendant and the node itself has no name or text', () => {
    const result = classifyInteractions(
      state([
        { tag: 'button', attrs: { type: 'button' }, name: null, text: null, childIds: ['n2'] },
        { tag: 'span', interactive: false, parentId: 'n1', depth: 2, path: '0/0', text: 'Delete' },
        { tag: 'button', attrs: { type: 'button' }, name: null, text: null, childIds: ['n4'] },
        { tag: 'span', interactive: false, parentId: 'n3', depth: 2, path: '2/0', text: 'Expand' },
      ]),
    );
    expect(kindsOf(result, 'n1')).toEqual(['hover', 'focus']);
    expect(skippedReasons(result, 'n1')).toEqual(['click: denied name: delete']);
    expect(kindsOf(result, 'n3')).toEqual(['click', 'hover', 'focus']);
  });

  it('allows hover and focus on nodes whose click is excluded, and reports the click exclusion once', () => {
    const result = classifyInteractions(
      state([
        { tag: 'a', role: 'link', name: 'Pricing', attrs: { href: '/pricing' } },
        { tag: 'button', attrs: { type: 'submit' }, inForm: true },
        { tag: 'button', attrs: { type: 'button' }, name: 'Delete' },
      ]),
    );
    expect(kindsOf(result, 'n1')).toEqual(['hover', 'focus']);
    expect(skippedReasons(result, 'n1')).toEqual(['click: link navigates']);
    expect(kindsOf(result, 'n2')).toEqual(['hover', 'focus']);
    expect(skippedReasons(result, 'n2')).toEqual(['click: inside a form']);
    expect(kindsOf(result, 'n3')).toEqual(['hover', 'focus']);
    expect(skippedReasons(result, 'n3')).toEqual(['click: denied name: delete']);
    expect(result.skipped.every((s) => s.reason.startsWith(`${s.kind}: `))).toBe(true);
  });

  it('orders clicks (disclosures, buttons, the rest) before hovers before focuses, stable by document order', () => {
    const result = classifyInteractions(
      state([
        { tag: 'div', role: 'tab', attrs: { tabindex: '0' }, name: 'Tab A' },
        { tag: 'button', attrs: { type: 'button' }, name: 'Plain' },
        { tag: 'summary', name: 'Question' },
        { tag: 'a', role: 'link', name: 'Home', attrs: { href: '#top' } },
        { tag: 'button', attrs: { type: 'button', 'aria-expanded': 'false' }, name: 'Menu' },
        { tag: 'div', role: 'button', attrs: { tabindex: '-1' }, name: 'Item' },
      ]),
    );
    expect(result.candidates.map((c) => `${c.kind}:${c.node.id}`)).toEqual([
      'click:n3',
      'click:n5',
      'click:n2',
      'click:n1',
      'click:n6',
      'hover:n1',
      'hover:n2',
      'hover:n3',
      'hover:n4',
      'hover:n5',
      'hover:n6',
      'focus:n1',
      'focus:n2',
      'focus:n3',
      'focus:n4',
      'focus:n5',
      'focus:n6',
    ]);
    const priority = (id: string, kind: string) => result.candidates.find((c) => c.node.id === id && c.kind === kind)?.priority;
    expect(priority('n3', 'click')).toBe(CLICK_DISCLOSURE_PRIORITY);
    expect(priority('n5', 'click')).toBe(CLICK_DISCLOSURE_PRIORITY);
    expect(priority('n2', 'click')).toBe(CLICK_BUTTON_PRIORITY);
    expect(priority('n1', 'click')).toBe(CLICK_OTHER_PRIORITY);
    expect(priority('n6', 'click')).toBe(CLICK_OTHER_PRIORITY);
    expect(priority('n1', 'hover')).toBe(HOVER_PRIORITY);
    expect(priority('n1', 'focus')).toBe(FOCUS_PRIORITY);
    expect(CLICK_DISCLOSURE_PRIORITY < CLICK_BUTTON_PRIORITY && CLICK_BUTTON_PRIORITY < CLICK_OTHER_PRIORITY && CLICK_OTHER_PRIORITY < HOVER_PRIORITY && HOVER_PRIORITY < FOCUS_PRIORITY).toBe(true);
  });

  it('uses the caller\'s deny list instead of the default one', () => {
    const nodes: NodeInit[] = [
      { tag: 'button', attrs: { type: 'button' }, name: 'Delete' },
      { tag: 'button', attrs: { type: 'button' }, name: 'Archive' },
    ];
    const defaults = classifyInteractions(state(nodes));
    expect(kindsOf(defaults, 'n1')).toEqual(['hover', 'focus']);
    expect(kindsOf(defaults, 'n2')).toEqual(['click', 'hover', 'focus']);
    const custom = classifyInteractions(state(nodes), { denyNames: ['archive'] });
    expect(kindsOf(custom, 'n1')).toEqual(['click', 'hover', 'focus']);
    expect(skippedReasons(custom, 'n2')).toEqual(['click: denied name: archive']);
    const both = classifyInteractions(state(nodes), { denyNames: [...DEFAULT_DENY_NAMES, 'archive'] });
    expect(both.candidates.filter((c) => c.kind === 'click')).toEqual([]);
  });

  it('never mutates the state it classifies', () => {
    const input = state([{ tag: 'button', attrs: { type: 'button' }, name: 'Plain' }]);
    const before = JSON.stringify(input);
    classifyInteractions(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('classifyInteractions on the synthetic Fixture A captures', () => {
  it('at 1280: links get hover and focus only, summaries get clicks first, the hamburger is hidden', () => {
    const capture = buildFixtureACapture({ viewportWidth: 1280 });
    const result = classifyInteractions(capture);
    const links = findNodes(capture, 'a');
    expect(links).toHaveLength(10);
    for (const link of links) {
      expect(kindsOf(result, link.id)).toEqual(['hover', 'focus']);
      expect(skippedReasons(result, link.id)).toEqual(['click: fragment link: scroll only']);
    }
    const summaries = findNodes(capture, 'summary');
    expect(summaries).toHaveLength(3);
    expect(result.candidates.slice(0, 3).map((c) => [c.kind, c.node.id, c.priority])).toEqual(summaries.map((s) => ['click', s.id, CLICK_DISCLOSURE_PRIORITY]));
    const hamburger = findNode(capture, '.nav-toggle');
    expect(hamburger).toBeDefined();
    if (!hamburger) return;
    expect(kindsOf(result, hamburger.id)).toEqual([]);
    expect(skippedReasons(result, hamburger.id)).toEqual(['click: not visible', 'hover: not visible', 'focus: not visible']);
    // 10 links × 2 + 3 summaries × 3 = 29 candidates; 10 link clicks + 3 hamburger kinds = 13 skipped.
    expect(result.candidates).toHaveLength(29);
    expect(result.skipped).toHaveLength(13);
  });

  it('at 390: the hamburger is the first click, nav links are hidden, footer links keep hover and focus', () => {
    const capture = buildFixtureACapture({ viewportWidth: 390 });
    const result = classifyInteractions(capture);
    const hamburger = findNode(capture, '.nav-toggle');
    expect(hamburger).toBeDefined();
    if (!hamburger) return;
    expect(result.candidates[0]).toMatchObject({ kind: 'click', priority: CLICK_DISCLOSURE_PRIORITY, node: { id: hamburger.id, name: 'Open menu' } });
    for (const link of findNodes(capture, '.nav-link')) {
      expect(kindsOf(result, link.id)).toEqual([]);
      expect(skippedReasons(result, link.id)).toEqual(['click: not visible', 'hover: not visible', 'focus: not visible']);
    }
    for (const link of findNodes(capture, '.footer-link')) {
      expect(kindsOf(result, link.id)).toEqual(['hover', 'focus']);
      expect(skippedReasons(result, link.id)).toEqual(['click: fragment link: scroll only']);
    }
    const visibleInteractive = capture.nodes.filter((n) => n.interactive && n.visible);
    expect(visibleInteractive).toHaveLength(10);
    const distinctCandidateNodes = new Set(result.candidates.map((c) => c.node.id));
    expect(distinctCandidateNodes.size).toBe(10);
  });

  it('is deterministic for equal input', () => {
    const capture = buildFixtureACapture({ viewportWidth: 390 });
    expect(JSON.stringify(classifyInteractions(capture))).toBe(JSON.stringify(classifyInteractions(buildFixtureACapture({ viewportWidth: 390 }))));
  });
});

/* ------------------------------------------------------- page-level, net */

describe('pageLevelActions and isSideEffect', () => {
  it('lists Escape then Tab', () => {
    expect(pageLevelActions()).toEqual([
      { kind: 'key', key: 'Escape' },
      { kind: 'key', key: 'Tab' },
    ]);
  });

  it('counts non-read methods case-insensitively and reports the total', () => {
    const entry = (method: string, id: string): NetworkEntry => ({ id, method, url: 'http://127.0.0.1/x', status: 200, resourceType: 'fetch', startedAt: '2026-10-13T12:00:00.000Z' });
    expect(isSideEffect([])).toEqual({ nonGet: 0, total: 0 });
    expect(isSideEffect([entry('GET', 'a'), entry('get', 'b'), entry('HEAD', 'c'), entry('options', 'd')])).toEqual({ nonGet: 0, total: 4 });
    expect(isSideEffect([entry('GET', 'a'), entry('POST', 'b'), entry('put', 'c'), entry('DELETE', 'd'), entry('PATCH', 'e')])).toEqual({ nonGet: 4, total: 5 });
  });
});
