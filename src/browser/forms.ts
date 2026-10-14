/**
 * Form support for the browser layer.
 *
 * - `collectFormFacts` reads, for every form control and every element with
 *   `aria-errormessage` / `aria-describedby`, the facts a capture stores as
 *   `UiNode.form` and `A11yProps.errorMessage`: native validity, the
 *   browser's validation message, `required`, the control type, whether a
 *   value is present (never the value itself) and the text of the referenced
 *   error elements.
 * - `planFill` decides how a `fill` action is performed from the control's
 *   facts: `fill()` for text-like inputs, textareas and contenteditable
 *   elements, `selectOption` for selects, `setChecked` for checkboxes and
 *   radios, and a refusal with a reason for everything else.
 * - `readControlFacts` and `submitFormAt` are the in-page halves of the
 *   `fill` and `submit` actions; `submitFormAt` calls `requestSubmit()` on
 *   the form that owns the target. The submitter is the target itself when
 *   it is an enabled submit button (so its `formaction` / `formmethod`
 *   apply, as they would for a user pressing it), otherwise the form's first
 *   enabled submit button (the default button), if any. A disabled submit
 *   button as target is a refusal: a user could not press it either.
 *
 * Validity is read as `willValidate ? validity.valid : true`, which is what
 * `checkValidity()` returns, without dispatching the `invalid` events that
 * `checkValidity()` fires: a capture must not change the page it measures.
 */
import type { Page } from 'playwright';
import { toError } from '../domain/errors.js';
import { collapseWhitespace } from './ax.js';
import { FormFactsResultSchema, type ControlFacts } from './cdp-schemas.js';
import { elementPaths, type RawTree } from './dom-tree.js';
import { evaluateInPage } from './in-page.js';

/** Tags that carry `UiNode.form`. */
export const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set(['input', 'select', 'textarea', 'button']);

/** Maximum stored length of `A11yProps.errorMessage`. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** `<input type>` values a `fill` action types into with `locator.fill()`. */
export const FILLABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'email',
  'search',
  'tel',
  'url',
  'number',
  'password',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/** Facts about one node, keyed by node path in `FormFactsIndex`. */
export interface FormFacts {
  /** `UiNode.form`, or null for elements that are not form controls. */
  readonly form: {
    readonly valid: boolean | null;
    readonly validationMessage: string | null;
    readonly required: boolean;
    readonly type: string | null;
    readonly hasValue: boolean;
  } | null;
  /** Collapsed, truncated text of the elements `aria-errormessage` references, or null. */
  readonly errorMessage: string | null;
  /** Collapsed, truncated text of the elements `aria-describedby` references, or null. */
  readonly describedBy: string | null;
}

/** Form facts by node path. */
export type FormFactsIndex = ReadonlyMap<string, FormFacts>;

/** Facts plus what could not be read. */
export interface FormFactsCollection {
  readonly facts: FormFactsIndex;
  readonly limitation: string | null;
}

/** True when a raw element needs form facts: a form control, or an element that references error or description text. */
export function needsFormFacts(element: { readonly tag: string; readonly attrs: readonly (readonly [string, string])[] }): boolean {
  if (FORM_CONTROL_TAGS.has(element.tag)) return true;
  return element.attrs.some(([name]) => name === 'aria-errormessage' || name === 'aria-describedby');
}

/** Read form facts for the elements of `tree` that need them. Never throws; a failure becomes the limitation. */
export async function collectFormFacts(page: Page, tree: RawTree): Promise<FormFactsCollection> {
  const paths = elementPaths(tree.elements);
  const wanted: string[] = [];
  tree.elements.forEach((element, i) => {
    if (needsFormFacts(element)) wanted.push(paths[i] ?? '');
  });
  if (wanted.length === 0) return { facts: new Map(), limitation: null };
  let raw: unknown;
  try {
    raw = await evaluateInPage(page, readFormFacts, wanted);
  } catch (cause) {
    return { facts: new Map(), limitation: `Form facts of ${wanted.length} node(s) could not be read: ${toError(cause, 'capture').message}` };
  }
  const parsed = FormFactsResultSchema.safeParse(raw);
  if (!parsed.success) return { facts: new Map(), limitation: `Form facts of ${wanted.length} node(s) could not be read: unexpected in-page result` };
  const facts = new Map<string, FormFacts>();
  let unresolved = 0;
  parsed.data.forEach((entry, k) => {
    const path = wanted[k];
    if (path === undefined) return;
    if (entry === null) {
      unresolved += 1;
      return;
    }
    facts.set(path, {
      form: entry.form,
      errorMessage: clipText(entry.errorMessage),
      describedBy: clipText(entry.describedBy),
    });
  });
  return { facts, limitation: unresolved > 0 ? `${unresolved} node(s) could not be resolved by path for form facts.` : null };
}

/** How a `fill` action is carried out, decided from the control's facts. */
export type FillPlan =
  | { readonly kind: 'fill' }
  | { readonly kind: 'check'; readonly checked: boolean }
  | { readonly kind: 'select'; readonly option: { readonly value: string } | { readonly label: string } }
  | { readonly kind: 'refuse'; readonly reason: string };

/**
 * Decide how to fill a control with `value`. Pure. Refuses file and hidden
 * inputs, disabled and read-only controls, non-fillable input types,
 * selects without a matching option and elements that are not controls.
 */
export function planFill(facts: ControlFacts, value: string): FillPlan {
  if (!facts.found) return { kind: 'refuse', reason: 'The target does not resolve to an element in the current document' };
  const describe = facts.type === null ? `<${facts.tag}>` : `<${facts.tag} type="${facts.type}">`;
  if (facts.disabled) return { kind: 'refuse', reason: `${describe} is disabled and cannot be filled` };
  if (facts.tag === 'input') {
    const type = (facts.type ?? 'text').toLowerCase();
    if (type === 'hidden') return { kind: 'refuse', reason: 'Hidden inputs are never filled' };
    if (type === 'file') return { kind: 'refuse', reason: 'File inputs are never filled: UI DNA does not upload files' };
    if (type === 'checkbox' || type === 'radio') return { kind: 'check', checked: value === 'true' };
    if (!FILLABLE_INPUT_TYPES.has(type)) return { kind: 'refuse', reason: `${describe} is not a text-like control and cannot be filled` };
    if (facts.readOnly) return { kind: 'refuse', reason: `${describe} is read-only and cannot be filled` };
    return { kind: 'fill' };
  }
  if (facts.tag === 'textarea') {
    if (facts.readOnly) return { kind: 'refuse', reason: '<textarea> is read-only and cannot be filled' };
    return { kind: 'fill' };
  }
  if (facts.tag === 'select') {
    if (facts.options.some((option) => option.value === value)) return { kind: 'select', option: { value } };
    if (facts.options.some((option) => option.label === value)) return { kind: 'select', option: { label: value } };
    return { kind: 'refuse', reason: `<select> has no option with value or label equal to the requested value (${facts.options.length} option(s))` };
  }
  if (facts.contentEditable) return { kind: 'fill' };
  return { kind: 'refuse', reason: `<${facts.tag}> is not a form control or contenteditable element and cannot be filled` };
}

function clipText(text: string | null): string | null {
  if (text === null) return null;
  const collapsed = collapseWhitespace(text);
  if (collapsed === '') return null;
  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH ? collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH) : collapsed;
}

/* ------------------------------------------------------------ in-page code */
/* These functions run inside the page: they must not reference module scope. */

interface InPageFormFacts {
  form: { valid: boolean | null; validationMessage: string | null; required: boolean; type: string | null; hasValue: boolean } | null;
  errorMessage: string | null;
  describedBy: string | null;
}

function readFormFacts(paths: string[]): (InPageFormFacts | null)[] {
  const resolve = (path: string): Element | null => {
    let el: Element | null = document.body;
    if (path === '') return el;
    for (const part of path.split('/')) {
      if (el === null) return null;
      el = el.children[Number(part)] ?? null;
    }
    return el;
  };
  const referencedText = (el: Element, attribute: string): string | null => {
    const refs = el.getAttribute(attribute);
    if (refs === null) return null;
    const parts: string[] = [];
    for (const id of refs.split(/\s+/)) {
      if (id === '') continue;
      const target = document.getElementById(id);
      if (target?.textContent) parts.push(target.textContent);
    }
    return parts.length === 0 ? null : parts.join(' ');
  };
  // The browser's message may quote the typed value ("'x' is missing an '@'"): values are never stored, so it is masked.
  const message = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, valid: boolean): string | null => {
    if (valid) return null;
    const text = el.validationMessage;
    if (text === '') return null;
    return el.value !== '' && text.includes(el.value) ? text.split(el.value).join('[value]') : text;
  };
  const controlFacts = (el: Element): InPageFormFacts['form'] => {
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase();
      const hasValue = type === 'checkbox' || type === 'radio' ? el.checked : type === 'file' ? (el.files ? el.files.length > 0 : false) : el.value !== '';
      const valid = el.willValidate ? el.validity.valid : true;
      return { valid, validationMessage: message(el, valid), required: el.required, type: el.type || null, hasValue };
    }
    if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const valid = el.willValidate ? el.validity.valid : true;
      return { valid, validationMessage: message(el, valid), required: el.required, type: el.type || null, hasValue: el.value !== '' };
    }
    if (el instanceof HTMLButtonElement) {
      return { valid: null, validationMessage: null, required: false, type: el.type || null, hasValue: el.value !== '' };
    }
    return null;
  };
  return paths.map((path) => {
    const el = resolve(path);
    if (el === null) return null;
    return { form: controlFacts(el), errorMessage: referencedText(el, 'aria-errormessage'), describedBy: referencedText(el, 'aria-describedby') };
  });
}

/** Inspect the control at `path` for `planFill`. Exported for the session; runs in the page. */
export function readControlFacts(path: string): ControlFacts {
  let el: Element | null = document.body;
  if (path !== '') {
    for (const part of path.split('/')) {
      if (el === null) break;
      el = el.children[Number(part)] ?? null;
    }
  }
  if (el === null) return { found: false, tag: '', type: null, disabled: false, readOnly: false, contentEditable: false, options: [] };
  const tag = el.tagName.toLowerCase();
  const options: { value: string; label: string }[] = [];
  if (el instanceof HTMLSelectElement) {
    for (const option of Array.from(el.options)) options.push({ value: option.value, label: option.label });
  }
  const type = el instanceof HTMLInputElement ? el.type : el instanceof HTMLSelectElement ? el.type : el instanceof HTMLTextAreaElement ? 'textarea' : null;
  const readOnly = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly;
  return {
    found: true,
    tag,
    type,
    disabled: el.matches(':disabled'),
    readOnly,
    contentEditable: el instanceof HTMLElement && el.isContentEditable,
    options,
  };
}

/** Submit the form that owns the element at `path` (or the form itself). Exported for the session; runs in the page. */
export function submitFormAt(path: string): { submitted: boolean; reason: string | null; method: string | null; viaSubmitter: boolean } {
  let el: Element | null = document.body;
  if (path !== '') {
    for (const part of path.split('/')) {
      if (el === null) break;
      el = el.children[Number(part)] ?? null;
    }
  }
  if (el === null) return { submitted: false, reason: 'The target does not resolve to an element in the current document', method: null, viaSubmitter: false };
  let form: HTMLFormElement | null = null;
  if (el instanceof HTMLFormElement) form = el;
  else if ('form' in el && el.form instanceof HTMLFormElement) form = el.form;
  else form = el.closest('form');
  if (form === null) return { submitted: false, reason: `<${el.tagName.toLowerCase()}> is not a form and belongs to no form`, method: null, viaSubmitter: false };
  const isSubmitButton = (control: Element): control is HTMLButtonElement | HTMLInputElement =>
    (control instanceof HTMLButtonElement && control.type === 'submit') || (control instanceof HTMLInputElement && (control.type === 'submit' || control.type === 'image'));
  let submitter: HTMLElement | null = null;
  if (isSubmitButton(el)) {
    // The target is a submit button: it is the submitter, so its own formaction/formmethod apply.
    if (el.matches(':disabled')) {
      return { submitted: false, reason: `<${el.tagName.toLowerCase()}> is a disabled submit button; the form was not submitted`, method: form.method, viaSubmitter: false };
    }
    submitter = el;
  } else {
    for (const control of Array.from(form.elements)) {
      if (isSubmitButton(control) && !control.matches(':disabled')) {
        submitter = control;
        break;
      }
    }
  }
  try {
    if (submitter !== null) form.requestSubmit(submitter);
    else form.requestSubmit();
  } catch (cause) {
    return { submitted: false, reason: cause instanceof Error ? cause.message : String(cause), method: form.method, viaSubmitter: submitter !== null };
  }
  return { submitted: true, reason: null, method: form.method, viaSubmitter: submitter !== null };
}
