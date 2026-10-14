/**
 * The "safe" interaction policy. Pure: given a captured state it decides
 * which interactions the explorer may try (hover and focus on every visible
 * interactive element; clicks only on elements that cannot submit, navigate
 * or carry a denied name) and reports every exclusion with its reason, one
 * entry per node and excluded kind, so nothing is skipped silently.
 */
import type { UiNode } from '@rohzzn/uidna-schema';
import type { CapturedState, NetworkEntry } from '../browser/types.js';

/** Interaction kinds the policy decides about. */
export type InteractionKind = 'click' | 'hover' | 'focus';

/** An interaction the explorer may perform. Lower `priority` runs first. */
export interface InteractionCandidate {
  readonly node: UiNode;
  readonly kind: InteractionKind;
  /** Lower runs first: disclosure clicks, button clicks, other clicks, hovers, focuses. Ties keep document order. */
  readonly priority: number;
}

/** An interaction the policy excluded, with the reason (which names the kind). */
export interface SkippedInteraction {
  readonly node: UiNode;
  readonly kind: InteractionKind;
  /** `<kind>: <reason>`, e.g. `click: link navigates`. */
  readonly reason: string;
}

/** Options of `classifyInteractions`. */
export interface ClassifyOptions {
  /** Deny phrases to use instead of `DEFAULT_DENY_NAMES` (callers that want both pass the concatenation). */
  readonly denyNames?: readonly string[];
}

/** Result of `classifyInteractions`. */
export interface Classification {
  /** Sorted by priority, stable by document order. */
  readonly candidates: InteractionCandidate[];
  readonly skipped: SkippedInteraction[];
}

/** A page-level key press tried once per base state. */
export type PageLevelAction = { readonly kind: 'key'; readonly key: 'Escape' } | { readonly kind: 'key'; readonly key: 'Tab' };

/**
 * Accessible-name phrases that are never clicked. Matched as whole words,
 * case-insensitively, against the accessible name and the own text: `sign
 * out` matches "Sign out of Lumen", `confirm` does not match "confirmation".
 */
export const DEFAULT_DENY_NAMES: readonly string[] = [
  'delete',
  'remove',
  'pay',
  'buy',
  'checkout',
  'send',
  'submit',
  'sign out',
  'log out',
  'logout',
  'unsubscribe',
  'confirm',
];

/** Priorities, lower first. Exported so callers can reason about the order. */
export const CLICK_DISCLOSURE_PRIORITY = 0;
export const CLICK_BUTTON_PRIORITY = 1;
export const CLICK_OTHER_PRIORITY = 2;
export const HOVER_PRIORITY = 3;
export const FOCUS_PRIORITY = 4;

/** Roles whose click is considered safe when nothing else excludes it. */
export const SAFE_CLICK_ROLES: ReadonlySet<string> = new Set(['tab', 'button']);

/** Request methods that are not side effects. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const WORD_CHAR = '[\\p{L}\\p{N}_]';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile one deny phrase into a whole-word, case-insensitive pattern (inner whitespace matches any whitespace run). */
function denyPattern(phrase: string): RegExp | null {
  const words = phrase.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const body = words.map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'iu');
}

/** The first deny phrase (as given) that matches `text` as a whole word, or null. */
export function matchDenyName(text: string | null | undefined, denyNames: readonly string[] = DEFAULT_DENY_NAMES): string | null {
  if (!text) return null;
  for (const phrase of denyNames) {
    if (denyPattern(phrase)?.test(text)) return phrase;
  }
  return null;
}

function lower(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().toLowerCase();
}

/** True when the element is a disclosure or menu trigger (explored first and reverted with Escape). */
export function isDisclosureTrigger(node: UiNode): boolean {
  const tag = node.tag.toLowerCase();
  return tag === 'summary' || node.attrs['aria-expanded'] !== undefined || node.attrs['aria-haspopup'] !== undefined;
}

/** True when the node is a `<button>` whose click cannot submit (type button, or no type outside a form). */
function isPlainButton(node: UiNode): boolean {
  if (node.tag.toLowerCase() !== 'button') return false;
  const type = lower(node.attrs.type);
  if (type === 'button') return true;
  return type === undefined && !node.inForm;
}

/**
 * Why a click on an eligible node is excluded, or null when it is allowed.
 * Checks run in the order of the policy: form membership, links, submit
 * controls, denied names, then the allowlist of click triggers. Denied
 * names are looked for in the accessible name, the own text and, when the
 * caller passes it, `subtreeText` (the text of the node's descendants), so a
 * `<button><span>Delete</span></button>` is caught even when no accessible
 * name could be computed or an `aria-label` hides the visible label.
 */
export function clickExclusion(node: UiNode, denyNames: readonly string[] = DEFAULT_DENY_NAMES, subtreeText: string | null = null): string | null {
  const tag = node.tag.toLowerCase();
  if (node.inForm) return 'inside a form';
  const href = node.attrs.href;
  if (tag === 'a' && href !== undefined) return href.trim().startsWith('#') ? 'fragment link: scroll only' : 'link navigates';
  const type = lower(node.attrs.type);
  if (tag === 'button' && (type === 'submit' || type === 'reset')) return 'submits';
  if (tag === 'input' && (type === 'submit' || type === 'image' || type === 'reset')) return 'submits';
  if (node.attrs.form !== undefined || node.attrs.formaction !== undefined) return 'submits';
  const denied =
    matchDenyName(node.name, denyNames) ??
    matchDenyName(node.text, denyNames) ??
    matchDenyName(node.attrs['aria-label'], denyNames) ??
    matchDenyName(node.attrs.title, denyNames) ??
    matchDenyName(subtreeText, denyNames);
  if (denied !== null) return `denied name: ${denied}`;
  const allowed =
    isPlainButton(node) ||
    tag === 'summary' ||
    (node.role !== null && SAFE_CLICK_ROLES.has(node.role)) ||
    node.attrs['aria-expanded'] !== undefined ||
    node.attrs['aria-controls'] !== undefined ||
    node.attrs['aria-haspopup'] !== undefined ||
    lower(node.attrs.role) === 'combobox';
  if (!allowed) return 'not a known safe click target (button, summary, tab, disclosure, menu trigger or combobox)';
  return null;
}

function clickPriority(node: UiNode): number {
  if (isDisclosureTrigger(node)) return CLICK_DISCLOSURE_PRIORITY;
  if (node.tag.toLowerCase() === 'button') return CLICK_BUTTON_PRIORITY;
  return CLICK_OTHER_PRIORITY;
}

/** Why an interactive node is not eligible for any interaction, or null. */
function eligibilityExclusion(node: UiNode): string | null {
  if (!node.visible || node.box === null) return 'not visible';
  if (node.a11y.disabled === true || node.attrs.disabled !== undefined || lower(node.attrs['aria-disabled']) === 'true') return 'disabled';
  return null;
}

/** Own text of every descendant of `node` in document order, joined by spaces; null when there is none. */
function subtreeText(node: UiNode, byId: ReadonlyMap<string, UiNode>): string | null {
  const parts: string[] = [];
  const queue: string[] = [...node.childIds];
  const seen = new Set<string>([node.id]);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (child === undefined) continue;
    if (child.text !== null) parts.push(child.text);
    queue.push(...child.childIds);
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/**
 * Decide the safe interactions of one captured state. Only `interactive`
 * nodes are considered; non-interactive nodes are neither candidates nor
 * skipped. Hidden or disabled interactive nodes are skipped for every kind.
 */
export function classifyInteractions(state: CapturedState, options: ClassifyOptions = {}): Classification {
  const denyNames = options.denyNames ?? DEFAULT_DENY_NAMES;
  const kinds: readonly InteractionKind[] = ['click', 'hover', 'focus'];
  const candidates: { candidate: InteractionCandidate; index: number }[] = [];
  const skipped: SkippedInteraction[] = [];
  const byId = new Map(state.nodes.map((node) => [node.id, node] as const));

  state.nodes.forEach((node, index) => {
    if (!node.interactive) return;
    const ineligible = eligibilityExclusion(node);
    if (ineligible !== null) {
      for (const kind of kinds) skipped.push({ node, kind, reason: `${kind}: ${ineligible}` });
      return;
    }
    const clickReason = clickExclusion(node, denyNames, subtreeText(node, byId));
    if (clickReason === null) candidates.push({ candidate: { node, kind: 'click', priority: clickPriority(node) }, index });
    else skipped.push({ node, kind: 'click', reason: `click: ${clickReason}` });
    candidates.push({ candidate: { node, kind: 'hover', priority: HOVER_PRIORITY }, index });
    candidates.push({ candidate: { node, kind: 'focus', priority: FOCUS_PRIORITY }, index });
  });

  candidates.sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index);
  return { candidates: candidates.map((entry) => entry.candidate), skipped };
}

/** Key presses tried once per base state, after the element candidates. */
export function pageLevelActions(): PageLevelAction[] {
  return [
    { kind: 'key', key: 'Escape' },
    { kind: 'key', key: 'Tab' },
  ];
}

/** Count requests whose method is not GET, HEAD or OPTIONS (a side effect) among `entries`. */
export function isSideEffect(entries: readonly NetworkEntry[]): { nonGet: number; total: number } {
  let nonGet = 0;
  for (const entry of entries) {
    if (!READ_METHODS.has(entry.method.toUpperCase())) nonGet += 1;
  }
  return { nonGet, total: entries.length };
}
