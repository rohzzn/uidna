/**
 * The interaction policies. Pure: given a captured state they decide which
 * interactions the explorer may try and report every exclusion with its
 * reason, one entry per node and excluded kind, so nothing is skipped
 * silently.
 *
 * - `classifyInteractions` is the "safe" policy: hover and focus on every
 *   visible interactive element; clicks only on elements that cannot submit,
 *   navigate or carry a denied name. When the caller names the crawled pages
 *   (`ClassifyOptions.navigation`), same-origin links to one of them become
 *   `navigate` candidates (a click the browser may follow to that page);
 *   every other link stays excluded with a reason that says where it leads.
 * - `classifyForms` is the extra step of the "forms" policy: for every
 *   `<form>` it picks the submit control the explorer may submit through
 *   (never one with a denied name) and a synthetic value for every fillable
 *   control. Values are synthetic by construction: they come from this
 *   module or from the caller's `formValues`, never from the page.
 */
import type { Transition, UiNode } from 'uidna-schema';
import type { CapturedState, NetworkEntry } from '../browser/types.js';

/** Interaction kinds the policies decide about. */
export type InteractionKind = 'click' | 'hover' | 'focus' | 'navigate' | 'fill' | 'submit';

/** An interaction the explorer may perform. Lower `priority` runs first. */
export interface InteractionCandidate {
  readonly node: UiNode;
  readonly kind: InteractionKind;
  /** Lower runs first: disclosure clicks, button clicks, other clicks, navigations, hovers, focuses. Ties keep document order. */
  readonly priority: number;
  /** For `navigate` candidates: the crawled page the link leads to and the resolved URL. */
  readonly navigation?: { readonly toPageId: string; readonly url: string };
}

/** An interaction the policy excluded, with the reason (which names the kind). */
export interface SkippedInteraction {
  readonly node: UiNode;
  readonly kind: InteractionKind;
  /** `<kind>: <reason>`, e.g. `click: link navigates`. */
  readonly reason: string;
}

/** The crawled pages a link click may lead to; see `ClassifyOptions.navigation`. */
export interface NavigationOptions {
  /** URL of the captured page; relative hrefs resolve against it. */
  readonly pageUrl: string;
  /** Page id of the captured page: links back to it are not navigation candidates. */
  readonly pageId: string;
  /** Page id by page key of every crawled page (the key as `keyOf` computes it). */
  readonly pagesByKey: ReadonlyMap<string, string>;
  /** Page identity of a URL: the crawl's `pageKey` (origin, path without a trailing slash, query; no fragment). */
  readonly keyOf: (url: string) => string;
}

/** Options of `classifyInteractions`. */
export interface ClassifyOptions {
  /** Deny phrases to use instead of `DEFAULT_DENY_NAMES` (callers that want both pass the concatenation). */
  readonly denyNames?: readonly string[];
  /** The crawled pages; when given, links to them become `navigate` candidates. When absent no link is ever clicked. */
  readonly navigation?: NavigationOptions;
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
/** Navigation clicks run after every other click and before hovers. */
export const NAVIGATE_PRIORITY = 3;
export const HOVER_PRIORITY = 4;
export const FOCUS_PRIORITY = 5;

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

/** The first deny phrase found in the node's accessible name, own text, aria-label, title or the given subtree text. */
function deniedName(node: UiNode, denyNames: readonly string[], subtree: string | null): string | null {
  return (
    matchDenyName(node.name, denyNames) ??
    matchDenyName(node.text, denyNames) ??
    matchDenyName(node.attrs['aria-label'], denyNames) ??
    matchDenyName(node.attrs.title, denyNames) ??
    matchDenyName(subtree, denyNames)
  );
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

/** What a link leads to, resolved against the crawled pages. */
export type LinkTarget =
  | { readonly kind: 'navigate'; readonly toPageId: string; readonly url: string }
  | { readonly kind: 'excluded'; readonly reason: string };

/**
 * Where a link (`<a href>` that is not a fragment) leads, given the crawled
 * pages: a `navigate` target when it is a same-origin link to another crawled
 * page without a denied name, else the reason it is not followed. Null when
 * the node is not such a link.
 */
export function linkTarget(node: UiNode, navigation: NavigationOptions, denyNames: readonly string[] = DEFAULT_DENY_NAMES, subtreeText: string | null = null): LinkTarget | null {
  if (node.tag.toLowerCase() !== 'a') return null;
  const href = node.attrs.href;
  if (href === undefined || href.trim().startsWith('#')) return null;
  let resolved: URL;
  try {
    resolved = new URL(href.trim(), navigation.pageUrl);
  } catch {
    return { kind: 'excluded', reason: 'link href could not be resolved against the page URL' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return { kind: 'excluded', reason: `link navigates to a ${resolved.protocol} URL` };
  let pageOrigin: string;
  try {
    pageOrigin = new URL(navigation.pageUrl).origin;
  } catch {
    return { kind: 'excluded', reason: 'page URL could not be parsed; the link origin is unknown' };
  }
  if (resolved.origin !== pageOrigin) return { kind: 'excluded', reason: 'link navigates to another origin' };
  const denied = deniedName(node, denyNames, subtreeText);
  if (denied !== null) return { kind: 'excluded', reason: `denied name: ${denied}` };
  resolved.hash = '';
  const toPageId = navigation.pagesByKey.get(navigation.keyOf(resolved.href));
  if (toPageId === undefined) return { kind: 'excluded', reason: 'link navigates to an uncrawled page' };
  if (toPageId === navigation.pageId) return { kind: 'excluded', reason: 'link navigates to the current page' };
  return { kind: 'navigate', toPageId, url: resolved.href };
}

/**
 * Why a click on an eligible node is excluded, or null when it is allowed.
 * Checks run in the order of the policy: form membership, links, submit
 * controls, denied names, then the allowlist of click triggers. Denied
 * names are looked for in the accessible name, the own text and, when the
 * caller passes it, `subtreeText` (the text of the node's descendants), so a
 * `<button><span>Delete</span></button>` is caught even when no accessible
 * name could be computed or an `aria-label` hides the visible label. With
 * `navigation`, a link to another crawled page is allowed (the explorer
 * follows it as a navigation); without it no link is ever clicked.
 */
export function clickExclusion(node: UiNode, denyNames: readonly string[] = DEFAULT_DENY_NAMES, subtreeText: string | null = null, navigation: NavigationOptions | null = null): string | null {
  const tag = node.tag.toLowerCase();
  if (node.inForm) return 'inside a form';
  const href = node.attrs.href;
  if (tag === 'a' && href !== undefined) {
    if (href.trim().startsWith('#')) return 'fragment link: scroll only';
    if (navigation === null) return 'link navigates';
    const target = linkTarget(node, navigation, denyNames, subtreeText);
    return target === null || target.kind === 'navigate' ? null : target.reason;
  }
  const type = lower(node.attrs.type);
  if (tag === 'button' && (type === 'submit' || type === 'reset')) return 'submits';
  if (tag === 'input' && (type === 'submit' || type === 'image' || type === 'reset')) return 'submits';
  if (node.attrs.form !== undefined || node.attrs.formaction !== undefined) return 'submits';
  const denied = deniedName(node, denyNames, subtreeText);
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

/** True when the node is disabled for interaction purposes (native, AX tree or aria-disabled). */
function isDisabled(node: UiNode): boolean {
  return node.a11y.disabled === true || node.attrs.disabled !== undefined || lower(node.attrs['aria-disabled']) === 'true';
}

/** Why an interactive node is not eligible for any interaction, or null. */
function eligibilityExclusion(node: UiNode): string | null {
  if (!node.visible || node.box === null) return 'not visible';
  if (isDisabled(node)) return 'disabled';
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
 * A link to another crawled page (when `options.navigation` names the pages)
 * is a `navigate` candidate instead of an excluded click.
 */
export function classifyInteractions(state: CapturedState, options: ClassifyOptions = {}): Classification {
  const denyNames = options.denyNames ?? DEFAULT_DENY_NAMES;
  const navigation = options.navigation ?? null;
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
    const subtree = subtreeText(node, byId);
    const link = navigation === null || node.inForm ? null : linkTarget(node, navigation, denyNames, subtree);
    if (link !== null && link.kind === 'navigate') {
      candidates.push({ candidate: { node, kind: 'navigate', priority: NAVIGATE_PRIORITY, navigation: { toPageId: link.toPageId, url: link.url } }, index });
    } else {
      const clickReason = clickExclusion(node, denyNames, subtree, navigation);
      if (clickReason === null) candidates.push({ candidate: { node, kind: 'click', priority: clickPriority(node) }, index });
      else skipped.push({ node, kind: 'click', reason: `click: ${clickReason}` });
    }
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

/** True for a request whose method is not GET, HEAD or OPTIONS: a side effect, counted as `nonGet`. */
export function isNonGetRequest(entry: Pick<NetworkEntry, 'method'>): boolean {
  return !READ_METHODS.has(entry.method.toUpperCase());
}

/** Count requests whose method is not GET, HEAD or OPTIONS (a side effect) among `entries`. */
export function isSideEffect(entries: readonly NetworkEntry[]): { nonGet: number; total: number } {
  let nonGet = 0;
  for (const entry of entries) {
    if (isNonGetRequest(entry)) nonGet += 1;
  }
  return { nonGet, total: entries.length };
}

/* ------------------------------------------------------------------ forms */

/** Synthetic values the forms policy types, by control kind. None is a real credential. */
export const SYNTHETIC_VALUES = {
  email: 'ada@example.com',
  password: 'Synthetic-Passw0rd!',
  tel: '+1 555 0100',
  url: 'https://example.com/',
  number: '42',
  date: '2026-01-15',
  'datetime-local': '2026-01-15T09:30',
  month: '2026-01',
  week: '2026-W03',
  time: '09:30',
  name: 'Ada Lovelace',
  text: 'Synthetic value',
  textarea: 'Synthetic text',
  checked: 'true',
} as const;

/** Options of `classifyForms`. */
export interface FormsOptions {
  /** Deny phrases to use instead of `DEFAULT_DENY_NAMES`. */
  readonly denyNames?: readonly string[];
  /** Caller-chosen synthetic values by control `name` or `id`; they win over the built-in ones. */
  readonly formValues?: Readonly<Record<string, string>>;
}

/** One control the explorer fills, with the synthetic value and where it came from. */
export interface FillCandidate {
  readonly node: UiNode;
  readonly value: string;
  /** How the value was chosen, e.g. `formValues["email"]`, `type email`, `autocomplete name`, `first option`. */
  readonly source: string;
}

/** The forms-policy plan of one `<form>`. */
export interface FormPlan {
  /** The `<form>` node. */
  readonly form: UiNode;
  /** The control a submit action targets: the first enabled submit control without a denied name, else the form itself. */
  readonly submitTarget: UiNode;
  /** Fillable controls in document order with their synthetic values. */
  readonly fills: FillCandidate[];
}

/** Result of `classifyForms`. */
export interface FormClassification {
  /** Forms the explorer may submit, in document order. */
  readonly forms: FormPlan[];
  /** Every control not filled and every form not submitted, with the reason. */
  readonly skipped: SkippedInteraction[];
}

/** Input types `fill()` types into (the browser layer's `FILLABLE_INPUT_TYPES`, kept here so the policy stays pure). */
const TEXT_LIKE_TYPES: ReadonlySet<string> = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'month', 'week', 'time']);

/** Autocomplete tokens that pick a synthetic value regardless of the input type. */
const AUTOCOMPLETE_VALUES: Readonly<Record<string, string>> = {
  email: SYNTHETIC_VALUES.email,
  'new-password': SYNTHETIC_VALUES.password,
  'current-password': SYNTHETIC_VALUES.password,
  tel: SYNTHETIC_VALUES.tel,
  'tel-national': SYNTHETIC_VALUES.tel,
  url: SYNTHETIC_VALUES.url,
  name: SYNTHETIC_VALUES.name,
  'given-name': 'Ada',
  'family-name': 'Lovelace',
  'additional-name': 'Augusta',
  nickname: 'Ada',
  'honorific-prefix': 'Ms',
};

/**
 * The string `record` holds under `key` as its own property. The keys come
 * from the page (control names, ids, autocomplete tokens, types), so an
 * inherited member such as `constructor`, `toString` or `__proto__` is never
 * taken for a value.
 */
function ownValue(record: Readonly<Record<string, string>>, key: string | undefined): string | undefined {
  if (key === undefined || !Object.hasOwn(record, key)) return undefined;
  const value: unknown = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** The control type as the browser normalizes it (`form.type`), else the attribute, else `text`. */
function controlType(node: UiNode): string {
  const tag = node.tag.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return (node.form?.type ?? 'select-one').toLowerCase();
  return (node.form?.type ?? node.attrs.type ?? 'text').trim().toLowerCase();
}

function isRequired(node: UiNode): boolean {
  return node.form?.required === true || node.attrs.required !== undefined;
}

/** First `<option>` descendant with a non-empty value (the `value` attribute, else its text), or null. */
function firstOptionValue(select: UiNode, byId: ReadonlyMap<string, UiNode>): string | null {
  const queue: string[] = [...select.childIds];
  const seen = new Set<string>([select.id]);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (child === undefined) continue;
    if (child.tag.toLowerCase() === 'option') {
      const value = child.attrs.value ?? child.text ?? '';
      if (value.length > 0) return value;
    }
    queue.push(...child.childIds);
  }
  return null;
}

/** Synthetic value for a text-like control from its autocomplete token, type, then name or id. */
function textValue(node: UiNode, type: string): { value: string; source: string } {
  const tokens = (node.attrs.autocomplete ?? '').trim().toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  for (const token of tokens) {
    const value = ownValue(AUTOCOMPLETE_VALUES, token);
    if (value !== undefined) return { value, source: `autocomplete ${token}` };
  }
  if (type !== 'text' && type !== 'search') {
    const byType = ownValue(SYNTHETIC_VALUES, type);
    if (byType !== undefined) return { value: byType, source: `type ${type}` };
  }
  const label = `${node.attrs.name ?? ''} ${node.attrs.id ?? ''} ${node.name ?? ''}`;
  if (/e-?mail/i.test(label)) return { value: SYNTHETIC_VALUES.email, source: 'name looks like an email field' };
  if (/\b(tel|phone|mobile)/i.test(label)) return { value: SYNTHETIC_VALUES.tel, source: 'name looks like a phone field' };
  if (/\b(url|website|homepage)\b/i.test(label)) return { value: SYNTHETIC_VALUES.url, source: 'name looks like a URL field' };
  if (!/user/i.test(label) && /name/i.test(label)) return { value: SYNTHETIC_VALUES.name, source: 'name looks like a person name field' };
  return { value: SYNTHETIC_VALUES.text, source: `type ${type}` };
}

/** The owning `<form>` of a control: the `form` attribute's target when it names one, else the closest ancestor form. */
function formOf(node: UiNode, byId: ReadonlyMap<string, UiNode>, formsByElementId: ReadonlyMap<string, UiNode>): UiNode | null {
  const explicit = node.attrs.form;
  if (explicit !== undefined) {
    const named = formsByElementId.get(explicit.trim());
    if (named !== undefined) return named;
  }
  let current: UiNode | undefined = node.parentId === null ? undefined : byId.get(node.parentId);
  const seen = new Set<string>([node.id]);
  while (current !== undefined && !seen.has(current.id)) {
    if (current.tag.toLowerCase() === 'form') return current;
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return null;
}

/** True for a control that submits its form when pressed. */
function isSubmitControl(node: UiNode): boolean {
  const tag = node.tag.toLowerCase();
  const type = lower(node.attrs.type);
  if (tag === 'button') return type !== 'button' && type !== 'reset';
  if (tag === 'input') return type === 'submit' || type === 'image';
  return false;
}

/**
 * Plan the forms-policy steps of one captured state: for every `<form>` the
 * submit target and the synthetic fills. A form whose submit controls all
 * carry a denied name (or whose own name does) is never submitted and its
 * controls are not filled; every such decision is in `skipped`. Controls
 * outside any form are reported as not filled. Deterministic and pure.
 */
export function classifyForms(state: CapturedState, options: FormsOptions = {}): FormClassification {
  const denyNames = options.denyNames ?? DEFAULT_DENY_NAMES;
  const formValues = options.formValues ?? {};
  const byId = new Map(state.nodes.map((node) => [node.id, node] as const));
  const forms = state.nodes.filter((node) => node.tag.toLowerCase() === 'form');
  const formsByElementId = new Map<string, UiNode>();
  for (const form of forms) if (form.attrs.id !== undefined) formsByElementId.set(form.attrs.id, form);
  const controls = state.nodes.filter((node) => ['input', 'select', 'textarea', 'button'].includes(node.tag.toLowerCase()));
  const controlsByForm = new Map<string, UiNode[]>(forms.map((form) => [form.id, []]));
  const skipped: SkippedInteraction[] = [];
  for (const control of controls) {
    const owner = formOf(control, byId, formsByElementId);
    if (owner === null) {
      if (control.tag.toLowerCase() !== 'button') skipped.push({ node: control, kind: 'fill', reason: 'fill: not inside a <form>' });
      continue;
    }
    controlsByForm.get(owner.id)?.push(control);
  }

  const plans: FormPlan[] = [];
  for (const form of forms) {
    const members = controlsByForm.get(form.id) ?? [];
    const submitControls = members.filter(isSubmitControl);
    const enabled = submitControls.filter((control) => !isDisabled(control));
    const allowed = enabled.filter((control) => deniedName(control, denyNames, subtreeText(control, byId)) === null);
    let exclusion: string | null = null;
    const formDenied = matchDenyName(form.name, denyNames) ?? matchDenyName(form.attrs['aria-label'], denyNames) ?? matchDenyName(form.attrs.title, denyNames);
    if (formDenied !== null) exclusion = `denied name: ${formDenied}`;
    else if (enabled.length > 0 && allowed.length === 0) {
      const first = enabled[0];
      exclusion = `denied name: ${first === undefined ? '' : (deniedName(first, denyNames, subtreeText(first, byId)) ?? '')}`;
    } else if (submitControls.length > 0 && enabled.length === 0) exclusion = 'every submit control is disabled';
    const submitTarget = allowed.find((control) => control.visible && control.box !== null) ?? allowed[0] ?? form;
    if (exclusion !== null) {
      // Reported on what would have been submitted through: the first enabled (denied) control, else the form itself.
      const reportOn = formDenied === null ? (enabled[0] ?? form) : form;
      skipped.push({ node: reportOn, kind: 'submit', reason: `submit: ${exclusion}` });
      for (const control of members) {
        if (!isSubmitControl(control) && control.tag.toLowerCase() !== 'button') {
          skipped.push({ node: control, kind: 'fill', reason: `fill: its form is never submitted (${exclusion}), so it is not filled` });
        }
      }
      continue;
    }
    const fills: FillCandidate[] = [];
    // A radio group is required when any of its buttons is; its first button is the one checked.
    const radioGroups = new Map<string, { required: boolean; first: string }>();
    for (const control of members) {
      if (control.tag.toLowerCase() !== 'input' || controlType(control) !== 'radio') continue;
      const group = control.attrs.name ?? control.id;
      const known = radioGroups.get(group);
      if (known === undefined) radioGroups.set(group, { required: isRequired(control), first: control.id });
      else if (isRequired(control)) known.required = true;
    }
    for (const control of members) {
      const tag = control.tag.toLowerCase();
      if (tag === 'button' || isSubmitControl(control)) continue;
      const type = controlType(control);
      const skip = (reason: string): void => {
        skipped.push({ node: control, kind: 'fill', reason: `fill: ${reason}` });
      };
      if (type === 'hidden') {
        skip('hidden inputs are never filled');
        continue;
      }
      if (type === 'file') {
        skip('file inputs are never filled: UI DNA does not upload files');
        continue;
      }
      if (tag === 'input' && ['submit', 'image', 'reset', 'button'].includes(type)) continue;
      if (!control.visible || control.box === null) {
        skip('not visible');
        continue;
      }
      if (isDisabled(control)) {
        skip('disabled');
        continue;
      }
      if (control.attrs.readonly !== undefined) {
        skip('read-only');
        continue;
      }
      const byName = ownValue(formValues, control.attrs.name ?? '');
      const given = byName ?? ownValue(formValues, control.attrs.id ?? '');
      const givenSource = control.attrs.name !== undefined && byName !== undefined ? `formValues["${control.attrs.name}"]` : `formValues["${control.attrs.id ?? ''}"]`;
      if (type === 'checkbox') {
        if (!isRequired(control)) {
          skip('optional checkbox left as is');
          continue;
        }
        fills.push(given === undefined ? { node: control, value: SYNTHETIC_VALUES.checked, source: 'required checkbox' } : { node: control, value: given, source: givenSource });
        continue;
      }
      if (type === 'radio') {
        const group = radioGroups.get(control.attrs.name ?? control.id);
        if (group?.required !== true) {
          skip('optional radio left as is');
          continue;
        }
        if (group.first !== control.id) {
          skip(`radio group "${control.attrs.name ?? ''}" is checked through its first button`);
          continue;
        }
        fills.push(given === undefined ? { node: control, value: SYNTHETIC_VALUES.checked, source: 'first button of a required radio group' } : { node: control, value: given, source: givenSource });
        continue;
      }
      if (given !== undefined) {
        fills.push({ node: control, value: given, source: givenSource });
        continue;
      }
      if (tag === 'select') {
        const option = firstOptionValue(control, byId);
        if (option === null) skip('<select> has no option with a value');
        else fills.push({ node: control, value: option, source: 'first option with a value' });
        continue;
      }
      if (tag === 'textarea') {
        fills.push({ node: control, value: SYNTHETIC_VALUES.textarea, source: 'textarea' });
        continue;
      }
      if (!TEXT_LIKE_TYPES.has(type)) {
        skip(`<input type="${type}"> is not a text-like control`);
        continue;
      }
      const chosen = textValue(control, type);
      fills.push({ node: control, value: chosen.value, source: chosen.source });
    }
    plans.push({ form, submitTarget, fills });
  }
  return { forms: plans, skipped };
}

/**
 * The deny phrase that forbids submitting through `node` as `state` shows it
 * now, or null: for a submit control, its accessible name, own text,
 * `aria-label`, `title` or descendants' text, as `classifyForms` checks them;
 * for a form submitted directly, its name, `aria-label` or `title`. Used to
 * re-check a submit target found again in a state an earlier step produced.
 */
export function submitDenial(node: UiNode, state: CapturedState, denyNames: readonly string[] = DEFAULT_DENY_NAMES): string | null {
  if (node.tag.toLowerCase() === 'form') return matchDenyName(node.name, denyNames) ?? matchDenyName(node.attrs['aria-label'], denyNames) ?? matchDenyName(node.attrs.title, denyNames);
  const byId = new Map(state.nodes.map((candidate) => [candidate.id, candidate] as const));
  return deniedName(node, denyNames, subtreeText(node, byId));
}

/**
 * True for a transition that is never repeated, by the verifier or by the
 * generated behavior tests: one that caused a non-GET request when it was
 * observed, or, unless it is a recorded same-origin navigation (a crawled
 * page), any side effect. A navigation that sent no non-GET request is
 * replayed as such.
 */
export function neverReplayed(transition: Pick<Transition, 'sideEffects' | 'network' | 'navigation'>): boolean {
  return (transition.navigation ?? null) !== null ? transition.network.nonGet > 0 : transition.sideEffects;
}
