/**
 * Builds the normalized node list, deduplicated style table, role tree and
 * digests from a raw tree and an accessibility index. `capture()` and
 * `snapshot()` share this code so that the digests of an unchanged page are
 * identical whichever one computed them.
 */
import type { A11yProps, RoleTreeNode, UiNode } from '@rohzzn/uidna-schema';
import { digestValue } from '../domain/digest.js';
import type { AxIndex } from './ax.js';
import { collapseWhitespace } from './ax.js';
import { readInvalid } from './ax.js';
import { elementPaths, type RawElement, type RawTree } from './dom-tree.js';
import type { FormFactsIndex } from './forms.js';
import { redactPageUrl, redactSrcset, SENSITIVE_PARAM_PATTERN } from './redact.js';
import { CAPTURED_ATTRIBUTES, CAPTURED_ATTRIBUTE_PREFIXES, MAX_ATTR_LENGTH, MAX_TEXT_LENGTH, STYLE_DEFAULTS } from './style-properties.js';

/** Attributes whose values are URLs and are redacted before storage. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src', 'action']);

/** Counts of values clipped to `MAX_ATTR_LENGTH` / `MAX_TEXT_LENGTH` while building a state. */
export interface TruncationCounts {
  attrs: number;
  text: number;
}

/** Roles that make a node interactive regardless of its tag. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'option',
  'combobox',
  'textbox',
  'slider',
  'spinbutton',
  'searchbox',
  'treeitem',
]);

/** Options for `buildState`. */
export interface BuildOptions {
  /** Keep nodes without layout (display: none). Default true. */
  readonly includeHiddenNodes?: boolean;
  /** Build the style table. Snapshots pass false and get a placeholder style id. */
  readonly withStyles?: boolean;
  /**
   * Form facts by node path (from `collectFormFacts`): they become `UiNode.form`
   * and `A11yProps.errorMessage`. Snapshots omit them; digests never depend on them.
   */
  readonly formFacts?: FormFactsIndex;
}

/** Everything derived from one raw tree. */
export interface BuiltState {
  readonly nodes: readonly UiNode[];
  readonly styles: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly roleTree: readonly RoleTreeNode[];
  readonly roleTreeDigest: string;
  readonly domDigest: string;
  /** Node id by CDP backend node id (empty when the tree was collected without CDP). */
  readonly nodeIdByBackendId: ReadonlyMap<number, string>;
  /** Raw element index by node id, for callers that need collector data (assets, fonts). */
  readonly elementIndexByNodeId: ReadonlyMap<string, number>;
  /** How many attribute values and text contents were clipped to the stored maximum. */
  readonly truncated: Readonly<TruncationCounts>;
}

const PLACEHOLDER_STYLE_ID = 'unstyled';

/**
 * Build nodes, styles, role tree and digests. Pure: never throws for well-formed input.
 *
 * Conventions: node ids are `n` + preorder index; `RoleTreeNode.depth` is the
 * number of role-bearing ancestors (role-tree depth, not DOM depth), so the
 * role tree is self-consistent when generic wrappers are added or removed.
 */
export function buildState(tree: RawTree, ax: AxIndex | null, options: BuildOptions = {}): BuiltState {
  const includeHidden = options.includeHiddenNodes ?? true;
  const withStyles = options.withStyles ?? true;
  const paths = elementPaths(tree.elements);
  const styles: Record<string, Readonly<Record<string, string>>> = {};
  const styleId = (style: Readonly<Record<string, string>> | null): string => {
    if (!withStyles) return PLACEHOLDER_STYLE_ID;
    const filtered = dropDefaults(style ?? {});
    const id = digestValue(filtered);
    if (!(id in styles)) styles[id] = filtered;
    return id;
  };

  interface Draft {
    node: {
      -readonly [K in keyof UiNode]: UiNode[K];
    };
    rawIndex: number;
    opacityZero: boolean;
    /** Inside a closed <details> (other than its summary): Chromium keeps retained layout boxes there, but nothing renders. */
    inClosedDetails: boolean;
    roleDepth: number;
    controlsBackendIds: readonly number[];
  }
  const drafts: Draft[] = [];
  const draftByRaw = new Map<number, Draft>();
  const nodeIdByBackendId = new Map<number, string>();
  const elementIndexByNodeId = new Map<string, number>();
  const truncated: TruncationCounts = { attrs: 0, text: 0 };

  tree.elements.forEach((element, rawIndex) => {
    const parentDraft = element.parent === null ? null : (draftByRaw.get(element.parent) ?? null);
    if (element.parent !== null && parentDraft === null) return; // parent was skipped: skip the subtree
    const inClosedDetails =
      parentDraft !== null &&
      (parentDraft.inClosedDetails || (parentDraft.node.tag === 'details' && parentDraft.node.attrs.open === undefined && element.tag !== 'summary'));
    if (!includeHidden && (element.box === null || inClosedDetails) && element.parent !== null) return;
    const id = `n${drafts.length}`;
    const axInfo = element.backendNodeId === null ? undefined : ax?.get(element.backendNodeId);
    const style = withStyles ? (element.style ?? {}) : null;
    const ownOpacityZero = style?.opacity === '0';
    const opacityZero = ownOpacityZero || (parentDraft?.opacityZero ?? false);
    const attrs = filterAttributes(element, truncated);
    const box = inClosedDetails ? null : element.box;
    const visible = box !== null && box.width > 0 && box.height > 0 && style?.visibility !== 'hidden' && !opacityZero;
    const role = axInfo?.role ?? null;
    const a11y: { -readonly [K in keyof A11yProps]: A11yProps[K] } = axInfo ? { ...axInfo.props } : {};
    if (axInfo?.description) a11y.description = axInfo.description;
    // `aria-invalid` is authoritative when it says invalid; Chrome's AX tree supplies the rest (including native validity it chose to expose).
    const ariaInvalid = attrs['aria-invalid'];
    if (ariaInvalid !== undefined && readInvalid(ariaInvalid.trim().toLowerCase()) === true) a11y.invalid = true;
    const facts = options.formFacts?.get(paths[rawIndex] ?? '');
    const errorMessage = facts?.errorMessage ?? (a11y.invalid === true ? facts?.describedBy : null) ?? null;
    if (errorMessage !== null) a11y.errorMessage = errorMessage;
    const pseudo = buildPseudo(element, withStyles, styleId);
    const node: Draft['node'] = {
      id,
      parentId: parentDraft?.node.id ?? null,
      path: paths[rawIndex] ?? '',
      depth: parentDraft === null ? 0 : parentDraft.node.depth + 1,
      tag: element.tag,
      role,
      name: axInfo?.name ?? null,
      attrs,
      text: normalizeText(element.text, truncated),
      box,
      styleId: styleId(style),
      a11y,
      visible,
      interactive: isInteractive(element.tag, attrs, role),
      inForm: parentDraft !== null && (parentDraft.node.inForm || parentDraft.node.tag === 'form'),
      childIds: [],
    };
    if (pseudo) node.pseudo = pseudo;
    if (facts?.form) node.form = facts.form;
    const draft: Draft = {
      node,
      rawIndex,
      opacityZero,
      inClosedDetails,
      roleDepth: parentDraft === null ? 0 : parentDraft.roleDepth + (parentDraft.node.role === null ? 0 : 1),
      controlsBackendIds: axInfo?.controlsBackendIds ?? [],
    };
    drafts.push(draft);
    draftByRaw.set(rawIndex, draft);
    elementIndexByNodeId.set(id, rawIndex);
    if (element.backendNodeId !== null) nodeIdByBackendId.set(element.backendNodeId, id);
    if (parentDraft) parentDraft.node.childIds.push(id);
  });

  // nth among nodes with the same role and name, controls resolved to node ids.
  const counters = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.node.role !== null) {
      const key = `${draft.node.role}\u0000${draft.node.name ?? ''}`;
      const nth = counters.get(key) ?? 0;
      counters.set(key, nth + 1);
      draft.node.a11y.nth = nth;
    }
    if (draft.controlsBackendIds.length > 0) {
      const controls = draft.controlsBackendIds.map((backendId) => nodeIdByBackendId.get(backendId)).filter((value): value is string => value !== undefined);
      if (controls.length > 0) draft.node.a11y.controls = controls;
    }
  }

  const roleTree: RoleTreeNode[] = [];
  for (const draft of drafts) {
    if (draft.node.role === null) continue;
    roleTree.push({
      nodeId: draft.node.id,
      role: draft.node.role,
      name: draft.node.name ?? '',
      depth: draft.roleDepth,
      states: roleStates(draft.node.a11y),
    });
  }
  const nodes = drafts.map((draft) => draft.node);
  return {
    nodes,
    styles,
    roleTree,
    roleTreeDigest: roleTreeDigest(roleTree),
    domDigest: domDigest(nodes),
    nodeIdByBackendId,
    elementIndexByNodeId,
    truncated,
  };
}

/** Digest of the role tree without node ids (so it is stable across captures). */
export function roleTreeDigest(roleTree: readonly RoleTreeNode[]): string {
  return digestValue(roleTree.map(({ role, name, depth, states }) => ({ role, name, depth, states })));
}

/** Digest of tag, attributes and own text in document order (no boxes, no styles). */
export function domDigest(nodes: readonly Pick<UiNode, 'tag' | 'attrs' | 'text'>[]): string {
  return digestValue(nodes.map((node) => [node.tag, node.attrs, node.text]));
}

/** Drop properties whose value equals the UA default listed in `STYLE_DEFAULTS`. */
export function dropDefaults(style: Readonly<Record<string, string>>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const property of Object.keys(style).sort()) {
    const value = style[property];
    if (value === undefined) continue;
    const fallback = (STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[property];
    if (fallback !== undefined && fallback === value) continue;
    filtered[property] = value;
  }
  return filtered;
}

/**
 * Keep allowlisted attributes, truncated (clips are counted in `truncated`
 * when given). Secrets are never stored: the `value` of password and hidden
 * inputs and of inputs whose `name` looks like a credential is dropped, and
 * URL attributes have secret-looking query parameters redacted.
 */
/** Field names and autocomplete tokens whose values are personal or financial and never stored. */
const SENSITIVE_FIELD_PATTERN = /^cc-|card|cvv|cvc|ccv|expir|iban|bic|swift|routing|account|ssn|social|passport|license|licence|one-time|new-password|current-password|birth|dob|phone|tel\b|email/i;

export function filterAttributes(element: Pick<RawElement, 'tag' | 'attrs'>, truncated?: TruncationCounts): Record<string, string> {
  const allowed = new Set<string>(CAPTURED_ATTRIBUTES);
  const attrs: Record<string, string> = {};
  let dropValue = false;
  if (element.tag === 'input' || element.tag === 'textarea') {
    for (const [name, value] of element.attrs) {
      const lower = value.toLowerCase();
      if (name === 'type' && (lower === 'password' || lower === 'hidden')) dropValue = true;
      if ((name === 'name' || name === 'id' || name === 'autocomplete') && (SENSITIVE_PARAM_PATTERN.test(value) || SENSITIVE_FIELD_PATTERN.test(value))) dropValue = true;
    }
  }
  for (const [name, rawValue] of element.attrs) {
    if (!allowed.has(name) && !CAPTURED_ATTRIBUTE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (name === 'value' && dropValue) continue;
    if (name in attrs) continue;
    const value = URL_ATTRIBUTES.has(name) ? redactPageUrl(rawValue) : name === 'srcset' ? redactSrcset(rawValue) : rawValue;
    if (value.length > MAX_ATTR_LENGTH) {
      if (truncated) truncated.attrs += 1;
      attrs[name] = value.slice(0, MAX_ATTR_LENGTH);
    } else {
      attrs[name] = value;
    }
  }
  return attrs;
}

/** Collapse whitespace, truncate (counted in `truncated` when given), null when empty. */
export function normalizeText(text: string | null, truncated?: TruncationCounts): string | null {
  if (text === null) return null;
  const collapsed = collapseWhitespace(text);
  if (collapsed === '') return null;
  if (collapsed.length > MAX_TEXT_LENGTH) {
    if (truncated) truncated.text += 1;
    return collapsed.slice(0, MAX_TEXT_LENGTH);
  }
  return collapsed;
}

/** Interactive per the UI DNA definition (tag, attributes or role). */
export function isInteractive(tag: string, attrs: Readonly<Record<string, string>>, role: string | null): boolean {
  if (tag === 'button' || tag === 'summary' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'a' && attrs.href !== undefined) return true;
  if (tag === 'input' && (attrs.type ?? '').toLowerCase() !== 'hidden') return true;
  const editable = attrs.contenteditable;
  if (editable !== undefined && editable.toLowerCase() !== 'false') return true;
  const tabindex = attrs.tabindex;
  if (tabindex !== undefined && Number.parseInt(tabindex, 10) >= 0) return true;
  if (role !== null && INTERACTIVE_ROLES.has(role)) return true;
  const explicitRole = attrs.role;
  if (explicitRole !== undefined && INTERACTIVE_ROLES.has(explicitRole.trim().toLowerCase())) return true;
  return attrs['aria-expanded'] !== undefined || attrs['aria-haspopup'] !== undefined || attrs['aria-controls'] !== undefined;
}

function buildPseudo(
  element: RawElement,
  withStyles: boolean,
  styleId: (style: Readonly<Record<string, string>> | null) => string,
): UiNode['pseudo'] | undefined {
  if (!withStyles) return undefined;
  const pseudo: { before?: { content: string; styleId: string }; after?: { content: string; styleId: string } } = {};
  if (element.pseudo.before) pseudo.before = { content: unquoteContent(element.pseudo.before.content), styleId: styleId(stripContentProperty(element.pseudo.before.style)) };
  if (element.pseudo.after) pseudo.after = { content: unquoteContent(element.pseudo.after.content), styleId: styleId(stripContentProperty(element.pseudo.after.style)) };
  return pseudo.before || pseudo.after ? pseudo : undefined;
}

function stripContentProperty(style: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const rest: Record<string, string> = {};
  for (const [property, value] of Object.entries(style)) if (property !== 'content') rest[property] = value;
  return rest;
}

/** `"+"` becomes `+`; non-string content (`url(...)`, counters) is kept verbatim. */
export function unquoteContent(content: string): string {
  const value = content.trim();
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(value) ?? /^'((?:[^'\\]|\\.)*)'$/.exec(value);
  if (match?.[1] !== undefined) return match[1].replace(/\\(.)/g, '$1');
  return value;
}

function roleStates(a11y: A11yProps): Record<string, string | boolean | number> {
  const states: Record<string, string | boolean | number> = {};
  if (a11y.expanded !== undefined) states.expanded = a11y.expanded;
  if (a11y.pressed !== undefined) states.pressed = a11y.pressed;
  if (a11y.selected !== undefined) states.selected = a11y.selected;
  if (a11y.checked !== undefined) states.checked = a11y.checked;
  if (a11y.disabled !== undefined) states.disabled = a11y.disabled;
  if (a11y.level !== undefined) states.level = a11y.level;
  if (a11y.haspopup !== undefined) states.haspopup = a11y.haspopup;
  return states;
}
