/**
 * A tiny JSX document model and printer. Page content is untrusted: every
 * text and attribute value goes through `JSON.stringify` unless it is provably
 * safe to write as a plain JSX literal, so nothing from the scanned page can
 * become code.
 */

/** An attribute value. */
export type JsxAttrValue = { readonly kind: 'string'; readonly value: string } | { readonly kind: 'expr'; readonly code: string } | { readonly kind: 'true' };

/** An element. */
export interface JsxElement {
  readonly kind: 'element';
  readonly tag: string;
  readonly attrs: readonly (readonly [string, JsxAttrValue])[];
  readonly children: readonly JsxChild[];
  readonly selfClosing: boolean;
}

/** A child: element, literal text or a JS expression. */
export type JsxChild = JsxElement | { readonly kind: 'text'; readonly value: string } | { readonly kind: 'expr'; readonly code: string };

/** Create an element. */
export function element(tag: string, attrs: readonly (readonly [string, JsxAttrValue])[], children: readonly JsxChild[], selfClosing = false): JsxElement {
  return { kind: 'element', tag, attrs, children, selfClosing };
}

/** A JS string literal (double quoted, escaped) for untrusted text. */
export function jsString(value: string): string {
  const ls = String.fromCharCode(0x2028);
  const ps = String.fromCharCode(0x2029);
  return JSON.stringify(value).split(ls).join('\\' + 'u2028').split(ps).join('\\' + 'u2029');
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Make untrusted text safe inside a `//` or `/* … *\/` comment: comment
 * terminators and line breaks (including U+2028/U+2029) are neutralized so
 * page content cannot end the comment and become code.
 */
export function commentText(text: string): string {
  return text.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').split(LINE_SEPARATOR).join(' ').split(PARAGRAPH_SEPARATOR).join(' ');
}

/** Code-point string order. Locale independent, unlike `localeCompare`, so output is identical on every machine. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SAFE_ATTR = /^[^"\\\n\r{}<>&`]*$/;
const SAFE_TEXT = /^[^{}<>&\n\r\t`\s][^{}<>&\n\r\t`]*[^{}<>&\n\r\t`\s]$|^[^{}<>&\n\r\t`\s]$/;

/** Render an attribute value: plain when safe, otherwise a JS string expression. */
export function printAttrValue(value: JsxAttrValue): string {
  switch (value.kind) {
    case 'true':
      return '';
    case 'expr':
      return `={${value.code}}`;
    case 'string':
      return SAFE_ATTR.test(value.value) ? `="${value.value}"` : `={${jsString(value.value)}}`;
    default:
      return '';
  }
}

/** Render a text child: plain JSX text when safe, otherwise a JS string expression. */
export function printText(value: string): string {
  return SAFE_TEXT.test(value) ? value : `{${jsString(value)}}`;
}

/** Print a JSX tree as indented lines. */
export function printJsx(node: JsxChild, indent = ''): string[] {
  if (node.kind === 'text') return [`${indent}${printText(node.value)}`];
  if (node.kind === 'expr') return [`${indent}{${node.code}}`];
  const attrs = node.attrs.map(([name, value]) => ` ${name}${printAttrValue(value)}`).join('');
  if (node.selfClosing || node.children.length === 0) return [`${indent}<${node.tag}${attrs} />`];
  const single = node.children.length === 1 ? node.children[0] : undefined;
  if (single?.kind === 'text') {
    const text = printText(single.value);
    const line = `${indent}<${node.tag}${attrs}>${text}</${node.tag}>`;
    if (line.length <= 120) return [line];
  }
  const lines = [`${indent}<${node.tag}${attrs}>`];
  for (const child of node.children) lines.push(...printJsx(child, `${indent}  `));
  lines.push(`${indent}</${node.tag}>`);
  return lines;
}

/** Make a safe PascalCase identifier from untrusted text; `fallback` when nothing usable remains. */
export function pascalCase(text: string, fallback: string): string {
  const words = text
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const joined = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const cleaned = joined.replace(/^[0-9]+/, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Make a safe camelCase identifier from untrusted text. */
export function camelCase(text: string, fallback: string): string {
  const pascal = pascalCase(text, '');
  if (pascal.length === 0) return fallback;
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return RESERVED.has(camel) ? `${camel}Value` : camel;
}

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'arguments',
  'eval',
  'key',
  'ref',
  'children',
  'className',
  'style',
  'uidnaPath',
  'variant',
]);

/** HTML attribute → JSX prop name for the attributes the generator keeps. */
export function jsxAttrName(attr: string): string {
  switch (attr) {
    case 'for':
      return 'htmlFor';
    case 'tabindex':
      return 'tabIndex';
    case 'autocomplete':
      return 'autoComplete';
    case 'readonly':
      return 'readOnly';
    case 'maxlength':
      return 'maxLength';
    case 'minlength':
      return 'minLength';
    case 'novalidate':
      return 'noValidate';
    case 'value':
      return 'defaultValue';
    case 'checked':
      return 'defaultChecked';
    default:
      return attr;
  }
}

/** Sanitize a URL attribute from the page: scripting schemes become `#`. */
export function safeUrl(value: string): string {
  const trimmed = value.trim();
  if (/^\s*(?:javascript|vbscript|data):/i.test(trimmed)) return '#';
  return trimmed;
}
