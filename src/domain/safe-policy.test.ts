import { describe, expect, it } from 'vitest';
import type { UiNode } from 'uidna-schema';
import { buildFixtureACapture, findNode, findNodes } from '../analysis/testing.js';
import { pageKey } from '../application/scan.js';
import type { CapturedState, NetworkEntry } from '../browser/types.js';
import {
  CLICK_BUTTON_PRIORITY,
  CLICK_DISCLOSURE_PRIORITY,
  CLICK_OTHER_PRIORITY,
  classifyForms,
  classifyInteractions,
  clickExclusion,
  DEFAULT_DENY_NAMES,
  FOCUS_PRIORITY,
  HOVER_PRIORITY,
  isDisclosureTrigger,
  isSideEffect,
  linkTarget,
  matchDenyName,
  NAVIGATE_PRIORITY,
  pageLevelActions,
  submitDenial,
  SYNTHETIC_VALUES,
  type NavigationOptions,
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

/* ------------------------------------------------------------ navigation */

const PAGE_URL = 'http://127.0.0.1:4173/';

function navigationOptions(pageId = 'pg_01'): NavigationOptions {
  return {
    pageUrl: PAGE_URL,
    pageId,
    pagesByKey: new Map([
      [pageKey(PAGE_URL), 'pg_01'],
      [pageKey(`${PAGE_URL}features.html`), 'pg_02'],
      [pageKey(`${PAGE_URL}pricing.html`), 'pg_03'],
    ]),
    keyOf: pageKey,
  };
}

describe('classifyInteractions with crawled pages', () => {
  const links: NodeInit[] = [
    { tag: 'button', attrs: { type: 'button' }, name: 'Menu' },
    { tag: 'a', role: 'link', name: 'Features', attrs: { href: '/features.html' } },
    { tag: 'a', role: 'link', name: 'Plans', attrs: { href: 'pricing.html#plans' } },
    { tag: 'a', role: 'link', name: 'Home', attrs: { href: '/' } },
    { tag: 'a', role: 'link', name: 'Status', attrs: { href: 'https://example.com/' } },
    { tag: 'a', role: 'link', name: 'About', attrs: { href: '/about.html' } },
    { tag: 'a', role: 'link', name: 'Top', attrs: { href: '#top' } },
    { tag: 'a', role: 'link', name: 'Pay now', attrs: { href: '/pricing.html' } },
    { tag: 'a', role: 'link', name: 'Mail', attrs: { href: 'mailto:ada@example.com' } },
    { tag: 'a', role: 'link', name: 'Inside', attrs: { href: '/features.html' }, inForm: true },
  ];

  it('turns links to other crawled pages into navigate candidates, after clicks and before hovers', () => {
    const result = classifyInteractions(state(links), { navigation: navigationOptions() });
    expect(result.candidates.slice(0, 3).map((c) => `${c.kind}:${c.node.id}`)).toEqual(['click:n1', 'navigate:n2', 'navigate:n3']);
    expect(result.candidates.find((c) => c.kind === 'navigate' && c.node.id === 'n2')).toMatchObject({ priority: NAVIGATE_PRIORITY, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } });
    expect(result.candidates.find((c) => c.kind === 'navigate' && c.node.id === 'n3')?.navigation).toEqual({ toPageId: 'pg_03', url: 'http://127.0.0.1:4173/pricing.html' });
    expect(result.candidates.filter((c) => c.kind === 'navigate')).toHaveLength(2);
    expect(result.candidates[3]?.kind).toBe('hover');
    for (const id of ['n2', 'n3']) expect(skippedReasons(result, id)).toEqual([]);
    expect(skippedReasons(result, 'n4')).toEqual(['click: link navigates to the current page']);
    expect(skippedReasons(result, 'n5')).toEqual(['click: link navigates to another origin']);
    expect(skippedReasons(result, 'n6')).toEqual(['click: link navigates to an uncrawled page']);
    expect(skippedReasons(result, 'n7')).toEqual(['click: fragment link: scroll only']);
    expect(skippedReasons(result, 'n8')).toEqual(['click: denied name: pay']);
    expect(skippedReasons(result, 'n9')).toEqual(['click: link navigates to a mailto: URL']);
    expect(skippedReasons(result, 'n10')).toEqual(['click: inside a form']);
    for (let i = 2; i <= 10; i += 1) expect(kindsOf(result, `n${i}`)).toEqual(expect.arrayContaining(['hover', 'focus']));
    expect(CLICK_OTHER_PRIORITY < NAVIGATE_PRIORITY && NAVIGATE_PRIORITY < HOVER_PRIORITY).toBe(true);
  });

  it('without crawled pages every link stays an excluded click, exactly as before', () => {
    const result = classifyInteractions(state(links));
    expect(result.candidates.filter((c) => c.kind === 'navigate')).toEqual([]);
    for (const id of ['n2', 'n3', 'n4', 'n5', 'n6', 'n8', 'n9']) expect(skippedReasons(result, id)).toEqual(['click: link navigates']);
  });

  it('resolves link targets, and clickExclusion allows a crawled link only when the pages are given', () => {
    const features = node({ tag: 'a', role: 'link', name: 'Features', attrs: { href: '/features.html' } }, 1);
    expect(linkTarget(features, navigationOptions())).toEqual({ kind: 'navigate', toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' });
    expect(linkTarget(features, navigationOptions('pg_02'))).toEqual({ kind: 'excluded', reason: 'link navigates to the current page' });
    expect(linkTarget(node({ tag: 'button' }, 1), navigationOptions())).toBeNull();
    expect(linkTarget(node({ tag: 'a', attrs: { href: '#x' } }, 1), navigationOptions())).toBeNull();
    expect(linkTarget(node({ tag: 'a', attrs: { href: 'http://127.0.0.1:4173/pricing.html' }, name: null, text: null }, 1), navigationOptions(), DEFAULT_DENY_NAMES, 'Buy now')).toEqual({
      kind: 'excluded',
      reason: 'denied name: buy',
    });
    expect(clickExclusion(features)).toBe('link navigates');
    expect(clickExclusion(features, DEFAULT_DENY_NAMES, null, navigationOptions())).toBeNull();
    expect(clickExclusion(features, DEFAULT_DENY_NAMES, null, navigationOptions('pg_02'))).toBe('link navigates to the current page');
  });
});

/* ----------------------------------------------------------------- forms */

/** A body holding a `<form>` (n1) whose children are `controls`, followed by `outside` nodes. */
function formState(controls: readonly NodeInit[], outside: readonly NodeInit[] = [], formInit: NodeInit = { tag: 'form' }): CapturedState {
  const captured = state([{ interactive: false, attrs: { id: 'f' }, ...formInit }, ...controls.map((c) => ({ inForm: true, ...c })), ...outside]);
  const body = captured.nodes[0];
  const form = captured.nodes[1];
  if (!body || !form) throw new Error('builder');
  const children = captured.nodes.slice(2, 2 + controls.length);
  form.childIds = children.map((n) => n.id);
  children.forEach((child, i) => {
    child.parentId = form.id;
    child.depth = 2;
    child.path = `0/${i}`;
  });
  body.childIds = [form.id, ...captured.nodes.slice(2 + controls.length).map((n) => n.id)];
  return captured;
}

/** Move `optionIds` under the select node `selectId`. */
function withOptions(captured: CapturedState, selectId: string, optionIds: string[]): CapturedState {
  const select = captured.nodes.find((n) => n.id === selectId);
  const form = captured.nodes.find((n) => n.id === select?.parentId);
  if (!select || !form) throw new Error('builder');
  select.childIds = optionIds;
  form.childIds = form.childIds.filter((id) => !optionIds.includes(id));
  for (const option of captured.nodes.filter((n) => optionIds.includes(n.id))) option.parentId = select.id;
  return captured;
}

function fillReasons(result: ReturnType<typeof classifyForms>, nodeId: string): string[] {
  return result.skipped.filter((s) => s.node.id === nodeId).map((s) => s.reason);
}

describe('classifyForms', () => {
  const signup = (): CapturedState =>
    withOptions(
      formState(
        [
          { tag: 'input', role: 'textbox', name: 'Full name', attrs: { type: 'text', name: 'name', autocomplete: 'name', required: '' } },
          { tag: 'input', role: 'textbox', name: 'Email', attrs: { type: 'email', name: 'email' } },
          { tag: 'input', attrs: { type: 'password', name: 'password', autocomplete: 'new-password' } },
          { tag: 'input', attrs: { type: 'tel', name: 'phone' } },
          { tag: 'input', attrs: { type: 'url', name: 'site' } },
          { tag: 'input', attrs: { type: 'number', name: 'seats' } },
          { tag: 'input', attrs: { type: 'date', name: 'start' } },
          { tag: 'input', attrs: { type: 'search', name: 'q' } },
          { tag: 'input', attrs: { type: 'text', name: 'username' } },
          { tag: 'input', attrs: { type: 'text', name: 'company' } },
          { tag: 'input', attrs: { type: 'text', id: 'first-name' } },
          { tag: 'textarea', attrs: { name: 'bio' } },
          { tag: 'select', attrs: { name: 'plan' } },
          { tag: 'option', interactive: false, attrs: { value: '' }, text: 'Choose' },
          { tag: 'option', interactive: false, attrs: { value: 'pro' }, text: 'Pro' },
          { tag: 'option', interactive: false, attrs: { value: 'team' }, text: 'Team' },
          { tag: 'input', attrs: { type: 'checkbox', name: 'terms', required: '' } },
          { tag: 'input', attrs: { type: 'checkbox', name: 'newsletter' } },
          { tag: 'input', attrs: { type: 'radio', name: 'size', value: 's', required: '' } },
          { tag: 'input', attrs: { type: 'radio', name: 'size', value: 'l' } },
          { tag: 'input', attrs: { type: 'radio', name: 'color', value: 'red' } },
          { tag: 'input', interactive: false, visible: false, box: null, attrs: { type: 'hidden', name: 'token' } },
          { tag: 'input', attrs: { type: 'file', name: 'avatar' } },
          { tag: 'input', attrs: { type: 'text', name: 'locked', disabled: '' } },
          { tag: 'input', attrs: { type: 'text', name: 'fixed', readonly: '' } },
          { tag: 'input', attrs: { type: 'color', name: 'tint' } },
          { tag: 'input', visible: false, box: null, attrs: { type: 'text', name: 'later' } },
          { tag: 'button', role: 'button', name: 'Create account', attrs: { type: 'submit' } },
          { tag: 'button', role: 'button', name: 'Fill example', attrs: { type: 'button' } },
          { tag: 'input', attrs: { type: 'submit', value: 'Go' } },
        ],
        [{ tag: 'input', attrs: { type: 'text', name: 'search' } }, { tag: 'button', attrs: { type: 'button' }, name: 'Reload' }],
      ),
      'n14',
      ['n15', 'n16', 'n17'],
    );

  it('picks the first enabled submit control and one synthetic value per fillable control, in document order', () => {
    const result = classifyForms(signup());
    expect(result.forms).toHaveLength(1);
    const plan = result.forms[0];
    if (!plan) return;
    expect(plan.form.id).toBe('n1');
    expect(plan.submitTarget.name).toBe('Create account');
    expect(plan.fills.map((f) => [f.node.id, f.value])).toEqual([
      ['n2', SYNTHETIC_VALUES.name],
      ['n3', SYNTHETIC_VALUES.email],
      ['n4', SYNTHETIC_VALUES.password],
      ['n5', SYNTHETIC_VALUES.tel],
      ['n6', SYNTHETIC_VALUES.url],
      ['n7', SYNTHETIC_VALUES.number],
      ['n8', SYNTHETIC_VALUES.date],
      ['n9', SYNTHETIC_VALUES.text],
      ['n10', SYNTHETIC_VALUES.text],
      ['n11', SYNTHETIC_VALUES.text],
      ['n12', SYNTHETIC_VALUES.name],
      ['n13', SYNTHETIC_VALUES.textarea],
      ['n14', 'pro'],
      ['n18', SYNTHETIC_VALUES.checked],
      ['n20', SYNTHETIC_VALUES.checked],
    ]);
    expect(plan.fills.find((f) => f.node.id === 'n2')?.source).toBe('autocomplete name');
    expect(plan.fills.find((f) => f.node.id === 'n3')?.source).toBe('type email');
    expect(plan.fills.find((f) => f.node.id === 'n12')?.source).toBe('name looks like a person name field');
    expect(plan.fills.find((f) => f.node.id === 'n14')?.source).toBe('first option with a value');
    expect(plan.fills.find((f) => f.node.id === 'n20')?.source).toBe('first button of a required radio group');
  });

  it('reports every control it leaves alone with the reason', () => {
    const result = classifyForms(signup());
    expect(fillReasons(result, 'n19')).toEqual(['fill: optional checkbox left as is']);
    expect(fillReasons(result, 'n21')).toEqual(['fill: radio group "size" is checked through its first button']);
    expect(fillReasons(result, 'n22')).toEqual(['fill: optional radio left as is']);
    expect(fillReasons(result, 'n23')).toEqual(['fill: hidden inputs are never filled']);
    expect(fillReasons(result, 'n24')).toEqual(['fill: file inputs are never filled: UI DNA does not upload files']);
    expect(fillReasons(result, 'n25')).toEqual(['fill: disabled']);
    expect(fillReasons(result, 'n26')).toEqual(['fill: read-only']);
    expect(fillReasons(result, 'n27')).toEqual(['fill: <input type="color"> is not a text-like control']);
    expect(fillReasons(result, 'n28')).toEqual(['fill: not visible']);
    expect(fillReasons(result, 'n32')).toEqual(['fill: not inside a <form>']);
    for (const id of ['n29', 'n30', 'n31', 'n33']) expect(fillReasons(result, id)).toEqual([]);
    expect(result.skipped.every((s) => s.reason.startsWith(`${s.kind}: `))).toBe(true);
    expect(result.skipped).toHaveLength(10);
  });

  it("prefers the caller's synthetic values by control name or id", () => {
    const result = classifyForms(signup(), { formValues: { email: 'grace@example.org', 'first-name': 'Grace', plan: 'team', terms: 'false' } });
    const plan = result.forms[0];
    const value = (id: string) => plan?.fills.find((f) => f.node.id === id);
    expect(value('n3')).toMatchObject({ value: 'grace@example.org', source: 'formValues["email"]' });
    expect(value('n12')).toMatchObject({ value: 'Grace', source: 'formValues["first-name"]' });
    expect(value('n14')).toMatchObject({ value: 'team', source: 'formValues["plan"]' });
    expect(value('n18')).toMatchObject({ value: 'false', source: 'formValues["terms"]' });
    expect(value('n2')?.value).toBe(SYNTHETIC_VALUES.name);
  });

  it('never submits a form whose only submit controls carry a denied name, and does not fill it either', () => {
    const result = classifyForms(formState([{ tag: 'input', attrs: { type: 'text', name: 'card' } }, { tag: 'button', name: 'Pay now', attrs: { type: 'submit' } }]));
    expect(result.forms).toEqual([]);
    expect(fillReasons(result, 'n3')).toEqual(['submit: denied name: pay']);
    expect(fillReasons(result, 'n2')).toEqual(['fill: its form is never submitted (denied name: pay), so it is not filled']);
    const named = classifyForms(formState([{ tag: 'input', attrs: { type: 'text', name: 'x' } }, { tag: 'button', name: 'Continue', attrs: { type: 'submit' } }], [], { tag: 'form', name: 'Checkout', attrs: { id: 'f' } }));
    expect(named.forms).toEqual([]);
    expect(fillReasons(named, 'n1')).toEqual(['submit: denied name: checkout']);
    expect(fillReasons(named, 'n2')).toEqual(['fill: its form is never submitted (denied name: checkout), so it is not filled']);
    const denied = classifyForms(formState([{ tag: 'button', name: 'Archive', attrs: { type: 'submit' } }]), { denyNames: ['archive'] });
    expect(denied.forms).toEqual([]);
    expect(fillReasons(denied, 'n2')).toEqual(['submit: denied name: archive']);
  });

  it('submits through the first allowed submit control, a default-type button, or the form itself', () => {
    const second = classifyForms(formState([{ tag: 'button', name: 'Pay now', attrs: { type: 'submit' } }, { tag: 'button', name: 'Save draft', attrs: { type: 'submit' } }]));
    expect(second.forms[0]?.submitTarget.name).toBe('Save draft');
    const untyped = classifyForms(formState([{ tag: 'button', name: 'Go', attrs: {} }, { tag: 'button', name: 'Other', attrs: { type: 'button' } }]));
    expect(untyped.forms[0]?.submitTarget.name).toBe('Go');
    const none = classifyForms(formState([{ tag: 'input', attrs: { type: 'text', name: 'q' } }]));
    expect(none.forms[0]?.submitTarget.id).toBe('n1');
    expect(none.forms[0]?.fills.map((f) => f.node.id)).toEqual(['n2']);
    const disabled = classifyForms(formState([{ tag: 'input', attrs: { type: 'text', name: 'q' } }, { tag: 'button', name: 'Go', attrs: { type: 'submit', disabled: '' } }]));
    expect(disabled.forms).toEqual([]);
    expect(fillReasons(disabled, 'n1')).toEqual(['submit: every submit control is disabled']);
    const hiddenSubmit = classifyForms(formState([{ tag: 'button', name: 'Hidden', attrs: { type: 'submit' }, visible: false, box: null }, { tag: 'button', name: 'Shown', attrs: { type: 'submit' } }]));
    expect(hiddenSubmit.forms[0]?.submitTarget.name).toBe('Shown');
  });

  it('associates a control with the form its `form` attribute names and ignores selects without a usable option', () => {
    const captured = formState([{ tag: 'select', attrs: { name: 'empty' } }, { tag: 'option', interactive: false, attrs: { value: '' }, text: '' }], [{ tag: 'input', attrs: { type: 'text', name: 'outside', form: 'f' } }]);
    withOptions(captured, 'n2', ['n3']);
    const result = classifyForms(captured);
    expect(result.forms[0]?.fills.map((f) => f.node.id)).toEqual(['n4']);
    expect(fillReasons(result, 'n2')).toEqual(['fill: <select> has no option with a value']);
  });

  it('never takes an inherited object member for a value when the page names a control, a token or a type after one', () => {
    const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
    const captured = formState([
      ...inherited.map((name): NodeInit => ({ tag: 'input', attrs: { type: 'text', name } })),
      ...inherited.map((token): NodeInit => ({ tag: 'input', attrs: { type: 'text', id: `ac-${token}`, autocomplete: token } })),
      ...inherited.map((type): NodeInit => ({ tag: 'input', attrs: { type, id: `ty-${type}` }, form: { valid: true, validationMessage: null, required: false, type, hasValue: false } })),
      { tag: 'input', attrs: { type: 'text', id: 'constructor' } },
      { tag: 'button', name: 'Go', attrs: { type: 'submit' } },
    ]);
    const variants: readonly Readonly<Record<string, string>>[] = [{}, { email: 'grace@example.org' }];
    for (const formValues of variants) {
      const result = classifyForms(captured, { formValues });
      const fills = result.forms[0]?.fills ?? [];
      // Every text control is filled with a built-in synthetic value; the unknown types are reported as not text-like.
      expect(fills).toHaveLength(inherited.length * 2 + 1);
      for (const fill of fills) {
        expect(typeof fill.value, fill.node.id).toBe('string');
        expect(fill.value, fill.node.id).toBe(SYNTHETIC_VALUES.text);
        expect(fill.source, fill.node.id).not.toContain('formValues');
        expect(fill.source, fill.node.id).not.toContain('autocomplete');
      }
      for (const type of inherited) {
        const node = captured.nodes.find((n) => n.attrs.id === `ty-${type}`);
        expect(fillReasons(result, node?.id ?? ''), type).toEqual([`fill: <input type="${type.toLowerCase()}"> is not a text-like control`]);
      }
    }
    // A caller's own value under such a name is still honoured (an own property, a string).
    const own = classifyForms(captured, { formValues: JSON.parse('{"__proto__":"proto value","constructor":"ctor value"}') as Record<string, string> });
    const byName = (name: string) => own.forms[0]?.fills.find((f) => f.node.attrs.name === name);
    expect(byName('__proto__')).toMatchObject({ value: 'proto value', source: 'formValues["__proto__"]' });
    expect(byName('constructor')).toMatchObject({ value: 'ctor value', source: 'formValues["constructor"]' });
    expect(own.forms[0]?.fills.find((f) => f.node.attrs.id === 'constructor')).toMatchObject({ value: 'ctor value', source: 'formValues["constructor"]' });
    expect(byName('toString')).toMatchObject({ value: SYNTHETIC_VALUES.text });
    // A non-string own value is ignored too.
    const odd = classifyForms(captured, { formValues: JSON.parse('{"valueOf":42}') as Record<string, string> });
    expect(odd.forms[0]?.fills.find((f) => f.node.attrs.name === 'valueOf')).toMatchObject({ value: SYNTHETIC_VALUES.text });
  });

  it('re-checks the deny list on a submit control or a form found again in a later state', () => {
    const captured = formState([{ tag: 'input', attrs: { type: 'text', name: 'q' } }, { tag: 'button', name: 'Save', attrs: { type: 'submit', 'aria-label': 'Save' }, text: 'Save' }]);
    const button = captured.nodes.find((n) => n.tag === 'button');
    const form = captured.nodes.find((n) => n.tag === 'form');
    if (!button || !form) throw new Error('builder');
    expect(submitDenial(button, captured)).toBeNull();
    expect(submitDenial({ ...button, text: 'Delete everything' }, captured)).toBe('delete');
    expect(submitDenial({ ...button, name: 'Pay now' }, captured, ['pay'])).toBe('pay');
    expect(submitDenial(form, captured)).toBeNull();
    expect(submitDenial({ ...form, attrs: { ...form.attrs, 'aria-label': 'Checkout' } }, captured)).toBe('checkout');
    // A form is judged by its own name, not by the text of everything inside it.
    expect(submitDenial(form, formState([{ tag: 'p', interactive: false, text: 'Send me updates' }]))).toBeNull();
  });

  it('is deterministic, never mutates its input and yields nothing for a page without forms', () => {
    const input = signup();
    const before = JSON.stringify(input);
    const first = JSON.stringify(classifyForms(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(classifyForms(signup()))).toBe(first);
    expect(classifyForms(state([{ tag: 'button', attrs: { type: 'button' } }]))).toEqual({ forms: [], skipped: [] });
  });
});
