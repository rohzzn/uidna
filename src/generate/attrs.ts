/**
 * Which captured attributes are written to the generated JSX. Classes are
 * never copied (every element gets utilities derived from its computed
 * style), `src` is handled by the asset registry and URLs are sanitized.
 */
import type { UiNode } from '@uidna/schema';
import { safeUrl } from './jsx.js';

/** Attributes kept on every element. */
const KEPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'role',
  'href',
  'alt',
  'type',
  'open',
  'for',
  'name',
  'placeholder',
  'rel',
  'target',
  'lang',
  'dir',
  'title',
  'disabled',
  'hidden',
  'tabindex',
  'value',
  'checked',
  'width',
  'height',
  'loading',
  'autocomplete',
  'method',
]);

/** Attributes written without a value when present. */
export const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set(['open', 'disabled', 'hidden', 'checked']);

/** Captured attributes that survive into the generated markup, in sorted order. */
export function keptAttributes(node: UiNode, renderedTag: string): Map<string, string> {
  const out = new Map<string, string>();
  const tag = node.tag.toLowerCase();
  const formish = tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option';
  for (const name of Object.keys(node.attrs).sort()) {
    const value = node.attrs[name];
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    const kept = KEPT_ATTRIBUTES.has(lower) || lower.startsWith('aria-') || lower.startsWith('data-');
    if (!kept) continue;
    if (lower === 'data-uidna-path' || lower === 'data-placeholder') continue;
    if ((lower === 'width' || lower === 'height' || lower === 'loading') && tag !== 'img') continue;
    if ((lower === 'value' || lower === 'checked') && !formish) continue;
    if (lower === 'open' && tag !== 'details' && tag !== 'dialog') continue;
    if (lower === 'type' && renderedTag === 'div') continue;
    if (lower === 'href') {
      out.set(lower, safeUrl(value));
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(lower)) continue;
    out.set(lower, value.length > 512 ? value.slice(0, 512) : value);
  }
  return out;
}
