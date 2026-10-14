/**
 * Read-only responsive instruments that run inside the page:
 *
 * - `readStyleConditions` walks the page's readable stylesheets (inline and
 *   same-origin sheets, `@import`s, `@media` nested in `@supports` or
 *   `@layer`) and returns every width-relevant condition with the nodes its
 *   style rules match and the properties they declare. Cross-origin sheets
 *   cannot be read through CSSOM and are listed as unreadable.
 * - `readLayoutSignature` records, per element, the few properties that
 *   describe layout structure (see `SIGNATURE_PROPERTIES`), keyed by node
 *   path or by an attribute (the generated app's `data-uidna-path`).
 *
 * Neither touches the page: no clicks, focus, scrolling or keys.
 */
import type { Page } from 'playwright';
import { z } from 'zod';
import { toError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { evaluateInPage } from './in-page.js';

/** A node a conditioned style rule matches, with the properties the rule declares. */
export const ConditionTargetSchema = z.strictObject({ path: z.string(), properties: z.array(z.string()) });

export const StyleConditionReadingSchema = z.strictObject({
  text: z.string(),
  kind: z.enum(['media', 'import', 'link-media']),
  sheet: z.strictObject({ url: z.string().nullable(), origin: z.enum(['same-origin', 'cross-origin', 'inline']) }),
  ruleCount: z.number().int().min(0),
  targets: z.array(ConditionTargetSchema),
});
export type StyleConditionReading = z.infer<typeof StyleConditionReadingSchema>;

export const StyleConditionsSchema = z.strictObject({
  conditions: z.array(StyleConditionReadingSchema),
  /** URLs of stylesheets whose rules could not be read (cross-origin). */
  unreadable: z.array(z.string()),
  /** Pixels per em in media queries (the initial font size). */
  emPx: z.number().positive(),
  /** `@container` rules seen; container queries are not width breakpoints of the viewport. */
  containerRules: z.number().int().min(0),
  truncated: z.boolean(),
});
export type StyleConditions = z.infer<typeof StyleConditionsSchema>;

export const LayoutSignatureReadingSchema = z.strictObject({
  entries: z.record(z.string(), z.string()),
  nodes: z.number().int().min(0),
  truncated: z.boolean(),
});
export type LayoutSignatureReading = z.infer<typeof LayoutSignatureReadingSchema>;

interface StyleConditionLimits {
  readonly maxTargetsPerRule: number;
  readonly maxTargets: number;
}

/** In-page: every width-relevant stylesheet condition with the nodes its rules match. */
function collectStyleConditions(limits: StyleConditionLimits): unknown {
  interface Sheet {
    url: string | null;
    origin: 'same-origin' | 'cross-origin' | 'inline';
  }
  interface Condition {
    text: string;
    kind: 'media' | 'import' | 'link-media';
    sheet: Sheet;
    ruleCount: number;
    rules: { selector: string; properties: string[] }[];
  }
  const conditions: Condition[] = [];
  const unreadable: string[] = [];
  let containerRules = 0;
  let truncated = false;
  const originOf = (href: string | null): Sheet['origin'] => {
    if (href === null) return 'inline';
    try {
      return new URL(href, location.href).origin === location.origin ? 'same-origin' : 'cross-origin';
    } catch {
      return 'cross-origin';
    }
  };
  const visit = (rules: CSSRuleList, sheet: Sheet, condition: Condition | null): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSImportRule) {
        const text = rule.media.mediaText.trim();
        const inner: Condition | null = text === '' ? condition : { text, kind: 'import', sheet, ruleCount: 0, rules: [] };
        if (inner !== null && inner !== condition) conditions.push(inner);
        const imported = rule.styleSheet;
        if (imported === null) continue;
        let importedRules: CSSRuleList | null = null;
        try {
          importedRules = imported.cssRules;
        } catch {
          unreadable.push(imported.href ?? rule.href);
        }
        if (importedRules !== null) visit(importedRules, { url: imported.href, origin: originOf(imported.href) }, inner);
      } else if (rule instanceof CSSMediaRule) {
        const own: Condition = { text: rule.conditionText || rule.media.mediaText, kind: 'media', sheet, ruleCount: 0, rules: [] };
        conditions.push(own);
        visit(rule.cssRules, sheet, own);
      } else if (rule instanceof CSSStyleRule) {
        if (condition !== null) {
          condition.ruleCount += 1;
          const properties: string[] = [];
          for (let p = 0; p < rule.style.length; p += 1) {
            const name = rule.style.item(p);
            if (name !== '') properties.push(name);
          }
          condition.rules.push({ selector: rule.selectorText, properties });
        }
      } else if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) {
        containerRules += 1;
      } else if ('cssRules' in rule) {
        const nested = (rule as CSSGroupingRule).cssRules;
        visit(nested, sheet, condition);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    const info: Sheet = { url: sheet.href, origin: originOf(sheet.href) };
    const mediaText = sheet.media.mediaText.trim();
    const whole: Condition | null = mediaText === '' ? null : { text: mediaText, kind: 'link-media', sheet: info, ruleCount: 0, rules: [] };
    if (whole !== null) conditions.push(whole);
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      unreadable.push(sheet.href ?? 'inline stylesheet');
    }
    if (rules !== null) visit(rules, info, whole);
  }

  const pathOf = (element: Element): string | null => {
    const parts: number[] = [];
    let node: Element | null = element;
    while (node !== null && node !== document.body) {
      const parent: Element | null = node.parentElement;
      if (parent === null) return null;
      parts.unshift(Array.prototype.indexOf.call(parent.children, node));
      node = parent;
    }
    return node === null ? null : parts.join('/');
  };
  // Pseudo-elements and state pseudo-classes do not change which elements a rule can apply to.
  const strip = (selector: string): string =>
    selector
      .replace(/::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button)\b/gi, '')
      .replace(/:(hover|focus-visible|focus-within|focus|active|visited|target|checked|disabled|enabled)\b/gi, '');
  let total = 0;
  const out = conditions.map((condition) => {
    const byPath = new Map<string, Set<string>>();
    for (const rule of condition.rules) {
      let matches: NodeListOf<Element> | null = null;
      try {
        matches = document.querySelectorAll(strip(rule.selector) || '*:not(*)');
      } catch {
        matches = null;
      }
      if (matches === null) continue;
      let taken = 0;
      for (const element of Array.from(matches)) {
        if (taken >= limits.maxTargetsPerRule || total >= limits.maxTargets) {
          truncated = true;
          break;
        }
        const path = pathOf(element);
        if (path === null) continue;
        let set = byPath.get(path);
        if (set === undefined) {
          set = new Set();
          byPath.set(path, set);
          total += 1;
        }
        for (const property of rule.properties) set.add(property);
        taken += 1;
      }
    }
    return {
      text: condition.text,
      kind: condition.kind,
      sheet: condition.sheet,
      ruleCount: condition.ruleCount,
      targets: [...byPath.entries()].map(([path, set]) => ({ path, properties: [...set].sort() })),
    };
  });

  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;font-size:medium;';
  document.documentElement.appendChild(probe);
  const emPx = parseFloat(getComputedStyle(probe).fontSize) || 16;
  probe.remove();
  return { conditions: out, unreadable, emPx, containerRules, truncated };
}

interface SignatureOptions {
  readonly keyAttribute: string | null;
  readonly maxNodes: number;
}

/** In-page: the layout signature of the document (see `SIGNATURE_PROPERTIES`). */
function collectLayoutSignature(options: SignatureOptions): unknown {
  const entries: Record<string, string> = {};
  const skipped = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'LINK', 'META']);
  let nodes = 0;
  let truncated = false;
  const tracks = (value: string): string => {
    // Computed track lists are space-separated sizes; bracketed line names are not tracks.
    const cleaned = value.replace(/\[[^\]]*\]/g, ' ').trim();
    return cleaned === '' || cleaned === 'none' ? '0' : String(cleaned.split(/\s+/).length);
  };
  const record = (element: Element, key: string): void => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const rendered = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    entries[`${key}|rendered`] = rendered ? 'true' : 'false';
    entries[`${key}|display`] = style.display;
    if (style.position !== 'static') entries[`${key}|position`] = style.position;
    if (style.display.includes('flex')) entries[`${key}|flex-direction`] = style.flexDirection;
    if (style.float !== 'none') entries[`${key}|float`] = style.float;
    if (style.display.includes('grid')) entries[`${key}|grid-columns`] = tracks(style.gridTemplateColumns);
  };
  const walk = (parent: Element, path: string): void => {
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i];
      if (child === undefined || skipped.has(child.tagName)) continue;
      if (nodes >= options.maxNodes) {
        truncated = true;
        return;
      }
      nodes += 1;
      const childPath = path === '' ? String(i) : `${path}/${i}`;
      const key = options.keyAttribute === null ? childPath : child.getAttribute(options.keyAttribute);
      if (key !== null) record(child, key);
      walk(child, childPath);
    }
  };
  walk(document.body, '');
  return { entries, nodes, truncated };
}

/** Read the page's width conditions. Never throws. */
export async function readStyleConditions(page: Page, limits: StyleConditionLimits = { maxTargetsPerRule: 200, maxTargets: 4000 }): Promise<Result<StyleConditions>> {
  try {
    const parsed = StyleConditionsSchema.safeParse(await evaluateInPage(page, collectStyleConditions, limits));
    if (!parsed.success) return err(toError(parsed.error, 'browser', 'Stylesheet conditions had an unexpected shape'));
    return ok(parsed.data);
  } catch (cause) {
    return err(toError(cause, 'browser', 'Stylesheet conditions could not be read'));
  }
}

/** Read the layout signature, keyed by node path or by `keyAttribute`. Never throws. */
export async function readLayoutSignature(page: Page, options: { readonly keyAttribute?: string; readonly maxNodes?: number } = {}): Promise<Result<LayoutSignatureReading>> {
  try {
    const parsed = LayoutSignatureReadingSchema.safeParse(await evaluateInPage(page, collectLayoutSignature, { keyAttribute: options.keyAttribute ?? null, maxNodes: options.maxNodes ?? 6000 }));
    if (!parsed.success) return err(toError(parsed.error, 'browser', 'Layout signature had an unexpected shape'));
    return ok(parsed.data);
  } catch (cause) {
    return err(toError(cause, 'browser', 'Layout signature could not be read'));
  }
}
