/**
 * HTML escaping for the static report. Page content is untrusted: every
 * page-derived string (node names, text, URLs, token values, limitation
 * messages) goes through these helpers before it is written into markup.
 */
import { formatCssColor, parseCssColor } from '../domain/color.js';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for an HTML text node (`&`, `<`, `>`, `"` and `'`). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Escape text for a double-quoted attribute value; newlines and tabs become character references. */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '&#10;').replace(/\t/g, '&#9;');
}

/** Render ` name="value"` with the value escaped. The name must be a plain attribute name. */
export function attr(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) return '';
  return ` ${name}="${escapeAttr(String(value))}"`;
}

/**
 * A CSS color safe to inline in a `style` attribute, or null when the value
 * is not a parseable color. The output is re-serialized, never the raw text.
 */
export function safeCssColor(value: string): string | null {
  const color = parseCssColor(value);
  return color === null ? null : formatCssColor(color);
}

/** Format a number for display with at most `digits` decimals (no trailing zeros). */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  return Number(value.toFixed(digits)).toString();
}

/** Format a ratio in [0, 1] as a percentage with two decimals. */
export function formatPercent(ratio: number | null): string {
  return ratio === null ? 'n/a' : `${formatNumber(ratio * 100, 2)}%`;
}
