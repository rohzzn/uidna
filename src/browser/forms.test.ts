import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaticServer } from '../application/static-server.js';
import { unwrap } from '../domain/result.js';
import { planFill } from './forms.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { BLOCKED_NAVIGATION_FAILURE, BLOCKED_REQUEST_FAILURE } from './session.js';
import { DESKTOP, FIXTURE_C_DIR, makeTempDir, serveCountingDir, serveDir, serveFixtureC, writeSite, type CountingDirServer, type TempDir } from './test-helpers.js';
import type { BrowserSession, CapturedState, UiNode } from './types.js';

const PASSWORD = 'analytical-engine';

let fixture: StaticServer;
let counting: CountingDirServer;
let siteForms: StaticServer;
let temp: TempDir;
let session: BrowserSession;

beforeAll(async () => {
  fixture = await serveFixtureC();
  counting = await serveCountingDir(FIXTURE_C_DIR);
  temp = await makeTempDir('uidna-forms-');
  await writeSite(temp.path, {
    'index.html': `<!doctype html><html><head><title>Controls</title></head><body>
      <h1 id="title">Controls</h1>
      <form id="classic" method="post" action="/api/classic">
        <input id="hidden" type="hidden" name="h" value="1">
        <input id="disabled" type="text" name="d" disabled>
        <input id="readonly" type="text" name="r" readonly value="ro">
        <input id="file" type="file" name="f">
        <input id="color" type="color" name="c">
        <input id="radio-a" type="radio" name="choice" value="a"><input id="radio-b" type="radio" name="choice" value="b">
        <textarea id="notes" name="notes"></textarea>
        <select id="size" name="size"><option value="s">Small</option><option value="l">Large</option></select>
        <div id="editor" contenteditable="true"></div>
        <button type="submit">Send</button>
      </form>
      <form id="search" method="get" action="/search"><input id="q" name="q"><button type="submit">Go</button></form>
      <form id="nobutton" method="post" action="/api/nobutton"><input id="nb" name="nb"></form>
      <form id="two" method="post" action="/api/two">
        <input id="two-field" name="x">
        <button id="draft" type="submit" formaction="/api/draft">Save draft</button>
        <button id="publish" type="submit" formaction="/api/publish">Publish</button>
        <button id="archive" type="submit" formaction="/api/archive" disabled>Archive</button>
      </form>
      <p id="outside">outside any form</p>
    </body></html>`,
  });
  siteForms = await serveDir(temp.path);
  session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
});

afterAll(async () => {
  await session.close();
  await siteForms.close();
  await counting.close();
  await fixture.close();
  await temp.cleanup();
});

function byId(state: CapturedState, id: string): UiNode {
  const node = state.nodes.find((candidate) => candidate.attrs.id === id);
  if (!node) throw new Error(`no node with id ${id}`);
  return node;
}

describe('planFill', () => {
  const base = { found: true, disabled: false, readOnly: false, contentEditable: false, options: [] };
  it('types into text-like inputs, textareas and contenteditable elements', () => {
    for (const type of ['text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'month', 'week', 'time']) {
      expect(planFill({ ...base, tag: 'input', type }, 'x')).toEqual({ kind: 'fill' });
    }
    expect(planFill({ ...base, tag: 'textarea', type: 'textarea' }, 'x')).toEqual({ kind: 'fill' });
    expect(planFill({ ...base, tag: 'div', type: null, contentEditable: true }, 'x')).toEqual({ kind: 'fill' });
  });
  it('checks checkboxes and radios only for the value "true"', () => {
    expect(planFill({ ...base, tag: 'input', type: 'checkbox' }, 'true')).toEqual({ kind: 'check', checked: true });
    expect(planFill({ ...base, tag: 'input', type: 'radio' }, 'yes')).toEqual({ kind: 'check', checked: false });
  });
  it('selects by value, then by label, and refuses unknown options', () => {
    const options = [
      { value: 'free', label: 'Free' },
      { value: 'pro', label: 'Pro' },
    ];
    expect(planFill({ ...base, tag: 'select', type: 'select-one', options }, 'pro')).toEqual({ kind: 'select', option: { value: 'pro' } });
    expect(planFill({ ...base, tag: 'select', type: 'select-one', options }, 'Pro')).toEqual({ kind: 'select', option: { label: 'Pro' } });
    expect(planFill({ ...base, tag: 'select', type: 'select-one', options }, 'team')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('no option') });
  });
  it('refuses hidden, file, disabled, read-only, non-text inputs and non-controls with a reason', () => {
    expect(planFill({ ...base, tag: 'input', type: 'hidden' }, 'x')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('Hidden') });
    expect(planFill({ ...base, tag: 'input', type: 'file' }, 'x')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('File') });
    expect(planFill({ ...base, tag: 'input', type: 'text', disabled: true }, 'x')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('disabled') });
    expect(planFill({ ...base, tag: 'input', type: 'text', readOnly: true }, 'x')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('read-only') });
    expect(planFill({ ...base, tag: 'input', type: 'submit' }, 'x')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('not a text-like') });
    expect(planFill({ ...base, tag: 'h1', type: null }, 'x')).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('not a form control') });
    expect(planFill({ ...base, found: false, tag: '', type: null }, 'x')).toMatchObject({ kind: 'refuse' });
  });
});

describe('Fixture C signup form', () => {
  it('reports form facts for the signup controls and nothing else', async () => {
    unwrap(await session.navigate(fixture.url));
    const state = unwrap(await session.capture());
    const name = byId(state, 'name');
    expect(name.form).toEqual({ valid: false, validationMessage: 'Please fill out this field.', required: true, type: 'text', hasValue: false });
    expect(name.a11y.invalid).toBe(false); // Chrome exposes native validity of text inputs only after interaction
    expect(name.a11y.errorMessage).toBeUndefined(); // the hint is a description, not an error, while the field is not invalid
    const email = byId(state, 'email');
    expect(email.form).toMatchObject({ required: true, type: 'email', hasValue: false, valid: false });
    const password = byId(state, 'password');
    expect(password.form).toMatchObject({ required: true, type: 'password', hasValue: false, valid: false });
    expect(password.attrs.value).toBeUndefined();
    const terms = byId(state, 'terms');
    expect(terms.form).toEqual({ valid: false, validationMessage: 'Please check this box if you want to proceed.', required: true, type: 'checkbox', hasValue: false });
    expect(terms.a11y.invalid).toBe(true); // Chrome exposes the native validity of an unchecked required checkbox
    expect(terms.a11y.errorMessage).toBeUndefined(); // invalid, but nothing is referenced yet
    const plan = byId(state, 'plan');
    expect(plan.form).toEqual({ valid: true, validationMessage: null, required: false, type: 'select-one', hasValue: true });
    const submit = state.nodes.find((node) => node.tag === 'button' && node.attrs.type === 'submit');
    expect(submit?.form).toEqual({ valid: null, validationMessage: null, required: false, type: 'submit', hasValue: false });
    expect(submit?.a11y.invalid).toBe(false);
    for (const node of state.nodes) {
      if (['input', 'select', 'textarea', 'button'].includes(node.tag)) expect(node.form, node.id).toBeDefined();
      else expect(node.form, node.id).toBeUndefined();
    }
    expect(state.nodes.filter((node) => node.form !== undefined)).toHaveLength(8);
    expect(byId(state, 'name-error').visible).toBe(false);
    expect(byId(state, 'status').visible).toBe(false);
  });

  it('submits the empty form: validation messages appear, nothing is sent', async () => {
    unwrap(await session.navigate(fixture.url));
    const before = unwrap(await session.capture());
    const marker = session.markNetwork();
    const outcome = unwrap(await session.act({ kind: 'submit', target: { nodeId: byId(before, 'name').id } }));
    expect(outcome).toMatchObject({ performed: true, navigated: false, url: fixture.url, blockedRequests: [] });
    expect(outcome.blockedNavigation).toBeUndefined();
    expect(session.networkSince(marker).filter((entry) => entry.method !== 'GET')).toEqual([]);
    const after = unwrap(await session.capture());
    const messages: Record<string, string> = {
      name: 'Enter your full name.',
      email: 'Enter a valid email address.',
      password: 'Use at least 8 characters.',
      terms: 'You must agree to the terms.',
    };
    for (const [id, message] of Object.entries(messages)) {
      const control = byId(after, id);
      expect(control.attrs['aria-invalid'], id).toBe('true');
      expect(control.attrs['aria-errormessage'], id).toBe(`${id}-error`);
      expect(control.a11y.invalid, id).toBe(true);
      expect(control.a11y.errorMessage, id).toBe(message);
      expect(control.form?.valid, id).toBe(false);
      const error = byId(after, `${id}-error`);
      expect(error.visible, id).toBe(true);
      expect(error.text, id).toBe(message);
      expect(error.role, id).toBe('alert');
    }
    expect(byId(after, 'plan').a11y.invalid).toBe(false);
    expect(byId(after, 'status').visible).toBe(false);
    expect(after.domDigest).not.toBe(before.domDigest);
    expect(byId(after, 'name').a11y.focused).toBe(true);
  });

  it('fills every control, submits, and the POST never reaches the server', async () => {
    unwrap(await session.navigate(counting.url));
    const base = unwrap(await session.capture());
    expect(unwrap(await session.act({ kind: 'fill', target: { role: 'textbox', name: 'Full name' }, value: 'Ada Lovelace' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { nodeId: byId(base, 'email').id }, value: 'ada@example.com' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { nodePath: byId(base, 'password').path }, value: PASSWORD })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#plan' }, value: 'Pro' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { role: 'checkbox', name: 'I agree to the terms' }, value: 'true' })).performed).toBe(true);
    const filled = unwrap(await session.capture());
    for (const id of ['name', 'email', 'password', 'terms']) expect(byId(filled, id).form, id).toMatchObject({ hasValue: true, valid: true, validationMessage: null });
    expect(byId(filled, 'plan').form?.hasValue).toBe(true);
    const json = JSON.stringify(filled);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain('Ada Lovelace');
    expect(json).not.toContain('ada@example.com');
    // The select value is a UI DNA choice, not page content, but it is not stored either: only `hasValue`.
    expect(byId(filled, 'plan').attrs.value).toBeUndefined();

    const marker = session.markNetwork();
    const outcome = unwrap(await session.act({ kind: 'submit', target: { role: 'button', name: 'Create account' } }));
    expect(outcome.performed).toBe(true);
    expect(outcome.navigated).toBe(false);
    expect(outcome.url).toBe(counting.url);
    expect(outcome.blockedRequests).toEqual([`${counting.url}api/signup`]);
    expect(outcome.blockedNavigation).toBeUndefined();
    expect(counting.hits('POST')).toBe(0);
    expect(counting.hits('GET')).toBeGreaterThan(0);
    const entry = session.networkSince(marker).find((candidate) => candidate.url === `${counting.url}api/signup`);
    expect(entry).toMatchObject({ method: 'POST', status: null, failure: BLOCKED_REQUEST_FAILURE, resourceType: 'fetch' });
    const after = unwrap(await session.capture());
    // No success message: the fixture's own fetch failure branch ran instead, because the blocked request rejected.
    const status = byId(after, 'status');
    expect(status.text).not.toContain('Welcome');
    expect(status.text).toBe('Could not reach the server.');
    expect(status.visible).toBe(true);
    for (const id of ['name', 'email', 'password', 'terms']) expect(byId(after, id).a11y.invalid, id).toBe(false);
    expect(JSON.stringify(after)).not.toContain(PASSWORD);
  });

  it('fills by value as well as by label and reports a validation message for a bad email', async () => {
    unwrap(await session.navigate(fixture.url));
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#plan' }, value: 'pro' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#email' }, value: 'not-an-email' })).performed).toBe(true);
    const unknown = unwrap(await session.act({ kind: 'fill', target: { selector: '#plan' }, value: 'enterprise' }));
    expect(unknown.performed).toBe(false);
    expect(unknown.reason).toContain('no option');
    const state = unwrap(await session.capture());
    expect(byId(state, 'email').form).toMatchObject({ valid: false, hasValue: true, type: 'email' });
    expect(byId(state, 'email').form?.validationMessage).toMatch(/@/);
    expect(JSON.stringify(state)).not.toContain('not-an-email');
  });
});

describe('fill and submit on generated controls', () => {
  it('refuses hidden, disabled, read-only, file and color inputs and non-controls, and fills the rest', async () => {
    unwrap(await session.navigate(siteForms.url));
    const refusals: [string, string][] = [
      ['#hidden', 'Hidden'],
      ['#disabled', 'disabled'],
      ['#readonly', 'read-only'],
      ['#file', 'File'],
      ['#color', 'not a text-like'],
      ['#title', 'not a form control'],
    ];
    for (const [selector, reason] of refusals) {
      const outcome = unwrap(await session.act({ kind: 'fill', target: { selector }, value: 'x' }));
      expect(outcome.performed, selector).toBe(false);
      expect(outcome.reason, selector).toContain(reason);
      expect(outcome.blockedRequests, selector).toEqual([]);
    }
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#radio-b' }, value: 'true' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#notes' }, value: 'line one\nline two' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#size' }, value: 'Large' })).performed).toBe(true);
    expect(unwrap(await session.act({ kind: 'fill', target: { selector: '#editor' }, value: 'edited' })).performed).toBe(true);
    const state = unwrap(await session.capture());
    expect(byId(state, 'radio-b').form).toMatchObject({ type: 'radio', hasValue: true });
    expect(byId(state, 'radio-a').form).toMatchObject({ type: 'radio', hasValue: false });
    expect(byId(state, 'notes').form).toMatchObject({ type: 'textarea', hasValue: true });
    expect(byId(state, 'size').form).toMatchObject({ type: 'select-one', hasValue: true });
    expect(byId(state, 'editor').text).toBe('edited');
    expect(byId(state, 'editor').form).toBeUndefined();
    expect(byId(state, 'hidden').form).toMatchObject({ type: 'hidden', hasValue: true, valid: true });
    expect(byId(state, 'hidden').attrs.value).toBeUndefined();
    expect(byId(state, 'disabled').form).toMatchObject({ valid: true, hasValue: false });
  });

  it('blocks a classic POST form submission as a navigation and as a request, with or without a submit button', async () => {
    unwrap(await session.navigate(siteForms.url));
    const marker = session.markNetwork();
    const withButton = unwrap(await session.act({ kind: 'submit', target: { selector: '#notes' } }));
    expect(withButton.performed).toBe(false);
    expect(withButton.navigated).toBe(false);
    expect(withButton.blockedNavigation).toBe(`${siteForms.url}api/classic`);
    expect(withButton.blockedRequests).toEqual([`${siteForms.url}api/classic`]);
    expect(withButton.reason).toContain('blocked');
    expect(session.currentUrl()).toBe(siteForms.url);
    const entry = session.networkSince(marker).find((candidate) => candidate.url === `${siteForms.url}api/classic`);
    expect(entry).toMatchObject({ method: 'POST', status: null, failure: BLOCKED_NAVIGATION_FAILURE });

    const noButton = unwrap(await session.act({ kind: 'submit', target: { selector: '#nobutton' } }));
    expect(noButton.performed).toBe(false);
    expect(noButton.blockedNavigation).toBe(`${siteForms.url}api/nobutton`);
    expect(noButton.blockedRequests).toEqual([`${siteForms.url}api/nobutton`]);

    const getForm = unwrap(await session.act({ kind: 'submit', target: { selector: '#q' } }));
    expect(getForm.performed).toBe(false);
    expect(getForm.blockedNavigation).toBe(`${siteForms.url}search?q=`);
    expect(getForm.blockedRequests).toEqual([]);

    const outside = unwrap(await session.act({ kind: 'submit', target: { selector: '#outside' } }));
    expect(outside.performed).toBe(false);
    expect(outside.reason).toContain('belongs to no form');
    expect(outside.blockedRequests).toEqual([]);
    // The page is intact.
    expect(unwrap(await session.snapshot()).nodeCount).toBeGreaterThan(10);
  });

  it('submits through the targeted submit button (its formaction applies), through the default button otherwise, and refuses a disabled one', async () => {
    unwrap(await session.navigate(siteForms.url));
    const publish = unwrap(await session.act({ kind: 'submit', target: { selector: '#publish' } }));
    expect(publish.performed).toBe(false);
    expect(publish.blockedNavigation).toBe(`${siteForms.url}api/publish`);
    expect(publish.blockedRequests).toEqual([`${siteForms.url}api/publish`]);

    const field = unwrap(await session.act({ kind: 'submit', target: { selector: '#two-field' } }));
    expect(field.blockedNavigation).toBe(`${siteForms.url}api/draft`);

    const form = unwrap(await session.act({ kind: 'submit', target: { selector: '#two' } }));
    expect(form.blockedNavigation).toBe(`${siteForms.url}api/draft`);

    const archive = unwrap(await session.act({ kind: 'submit', target: { selector: '#archive' } }));
    expect(archive.performed).toBe(false);
    expect(archive.reason).toContain('disabled submit button');
    expect(archive.blockedNavigation).toBeUndefined();
    expect(archive.blockedRequests).toEqual([]);
    expect(session.currentUrl()).toBe(siteForms.url);
  });
});
