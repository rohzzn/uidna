/**
 * Font capture. Two measured sources are merged:
 *
 * - declared faces from `document.fonts` (family, weight, style, load status)
 *   joined with `@font-face` rules from accessible stylesheets for `src`;
 * - platform fonts that actually rendered text, from CDP
 *   `CSS.getPlatformFontsForNode` on one representative node per distinct
 *   (font-family, font-weight, font-style) combination. This is what reports
 *   system fonts such as "Segoe UI" that never appear in `document.fonts`.
 */
import type { CDPSession, Page } from 'playwright';
import { toError } from '../domain/errors.js';
import { FontFacesResultSchema, PlatformFontsResultSchema } from './cdp-schemas.js';
import type { RawTree } from './dom-tree.js';
import { evaluateInPage } from './in-page.js';
import type { BuiltState } from './nodes.js';
import { redactPageUrl } from './redact.js';
import type { CapturedFont } from './types.js';

/** Fonts plus what could not be measured. */
export interface FontCollection {
  readonly fonts: readonly CapturedFont[];
  readonly limitations: readonly string[];
}

/** Maximum representative nodes queried for platform fonts per capture. */
const MAX_FONT_PROBES = 40;

/** Collect declared and rendered fonts. Never throws. */
export async function collectFonts(page: Page, cdp: CDPSession | null, state: BuiltState, tree: RawTree): Promise<FontCollection> {
  const limitations: string[] = [];
  const fonts = new Map<string, CapturedFont>();
  const add = (font: CapturedFont): void => {
    const key = `${font.family.toLowerCase()}|${font.weight ?? ''}|${font.style ?? ''}|${font.source}`;
    const existing = fonts.get(key);
    if (!existing) {
      fonts.set(key, font);
      return;
    }
    // A measured render beats a declared status.
    if (font.status === 'loaded' && existing.status !== 'loaded') fonts.set(key, { ...existing, status: 'loaded' });
  };

  // 1. Declared faces.
  let declaredFamilies = new Set<string>();
  try {
    const raw: unknown = await evaluateInPage(page, readFontFaces);
    const parsed = FontFacesResultSchema.safeParse(raw);
    if (!parsed.success) {
      limitations.push('document.fonts could not be read: unexpected in-page result.');
    } else {
      const { faces, rules, inaccessibleStyleSheets } = parsed.data;
      if (inaccessibleStyleSheets > 0) {
        limitations.push(`${inaccessibleStyleSheets} cross-origin stylesheet(s) could not be read for @font-face sources.`);
      }
      declaredFamilies = new Set(faces.map((face) => normalizeFamily(face.family).toLowerCase()));
      for (const face of faces) {
        const family = normalizeFamily(face.family);
        const rule = rules.find(
          (candidate) =>
            normalizeFamily(candidate.family).toLowerCase() === family.toLowerCase() &&
            (candidate.weight === face.weight || candidate.weight === '') &&
            (candidate.style === face.style || candidate.style === ''),
        );
        const source = rule ? sourceFromSrc(rule.src) : null;
        if (source === null) {
          limitations.push(`Font "${family}" has no readable @font-face src; reported as local.`);
        }
        const font: { -readonly [K in keyof CapturedFont]: CapturedFont[K] } = {
          family,
          source: source?.source ?? 'local',
          weight: face.weight,
          style: face.style,
          status: face.status === 'loaded' ? 'loaded' : face.status === 'error' ? 'error' : 'unloaded',
        };
        if (source?.url !== undefined) font.url = redactPageUrl(source.url);
        add(font);
      }
    }
  } catch (cause) {
    limitations.push(`document.fonts could not be read: ${toError(cause, 'capture').message}`);
  }

  // 2. Platform fonts that rendered text.
  if (cdp === null) {
    limitations.push('Rendered platform fonts were not measured: CDP is unavailable.');
    return { fonts: [...fonts.values()], limitations };
  }
  const { probes, distinct } = pickFontProbes(state, tree);
  if (distinct > probes.length) {
    limitations.push(`Rendered platform fonts were measured for ${probes.length} of ${distinct} distinct font-family/weight/style combinations (probe cap).`);
  }
  if (probes.length === 0) return { fonts: [...fonts.values()], limitations };
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: 0 });
    const pushed = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: probes.map((probe) => probe.backendNodeId) });
    for (let i = 0; i < probes.length; i += 1) {
      const probe = probes[i];
      const nodeId = pushed.nodeIds[i];
      if (!probe || nodeId === undefined) continue;
      const raw: unknown = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      const parsed = PlatformFontsResultSchema.safeParse(raw);
      if (!parsed.success) continue;
      for (const platform of parsed.data.fonts) {
        if (platform.glyphCount <= 0) continue;
        const key = platform.familyName.toLowerCase();
        if (platform.isCustomFont && declaredFamilies.has(key)) {
          // Already present as a declared face; mark it as rendered.
          for (const [existingKey, existing] of fonts) {
            if (existing.family.toLowerCase() === key && existing.status !== 'loaded') fonts.set(existingKey, { ...existing, status: 'loaded' });
          }
          continue;
        }
        add({ family: platform.familyName, source: 'local', weight: probe.weight, style: probe.style, status: 'loaded' });
      }
    }
  } catch (cause) {
    limitations.push(`Rendered platform fonts were not measured: ${toError(cause, 'capture').message}`);
  }
  return { fonts: [...fonts.values()], limitations };
}

interface FontProbe {
  readonly backendNodeId: number;
  readonly weight: string;
  readonly style: string;
}

/** One representative text node per distinct family/weight/style, capped at `MAX_FONT_PROBES`; `distinct` is the uncapped count. */
function pickFontProbes(state: BuiltState, tree: RawTree): { probes: FontProbe[]; distinct: number } {
  const seen = new Set<string>();
  const probes: FontProbe[] = [];
  for (const node of state.nodes) {
    if (node.text === null || node.box === null || !node.visible) continue;
    const rawIndex = state.elementIndexByNodeId.get(node.id);
    const element = rawIndex === undefined ? undefined : tree.elements[rawIndex];
    if (element?.backendNodeId === null || element?.backendNodeId === undefined || element.style === null) continue;
    const family = element.style['font-family'] ?? '';
    const weight = element.style['font-weight'] ?? '';
    const style = element.style['font-style'] ?? '';
    const key = `${family}|${weight}|${style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (probes.length < MAX_FONT_PROBES) probes.push({ backendNodeId: element.backendNodeId, weight, style });
  }
  return { probes, distinct: seen.size };
}

function normalizeFamily(family: string): string {
  return family.trim().replace(/^["']|["']$/g, '');
}

function sourceFromSrc(src: string): { source: CapturedFont['source']; url?: string } | null {
  const urlMatch = /url\((["']?)([^"')]+)\1\)/.exec(src);
  if (urlMatch?.[2] !== undefined) {
    const url = urlMatch[2].trim();
    if (url.startsWith('data:')) return { source: 'data' };
    return { source: 'url', url };
  }
  if (src.includes('local(')) return { source: 'local' };
  return null;
}

/* ------------------------------------------------------------ in-page code */

function readFontFaces(): {
  faces: { family: string; weight: string; style: string; status: string }[];
  rules: { family: string; weight: string; style: string; src: string }[];
  inaccessibleStyleSheets: number;
} {
  const faces: { family: string; weight: string; style: string; status: string }[] = [];
  document.fonts.forEach((face) => {
    faces.push({ family: face.family, weight: face.weight, style: face.style, status: face.status });
  });
  const rules: { family: string; weight: string; style: string; src: string }[] = [];
  let inaccessible = 0;
  const resolveSrc = (src: string, base: string): string =>
    src.replace(/url\((["']?)([^"')]+)\1\)/g, (_match, quote: string, url: string) => {
      try {
        const absolute = url.startsWith('data:') ? url : new URL(url, base).href;
        return `url(${quote}${absolute}${quote})`;
      } catch {
        return `url(${quote}${url}${quote})`;
      }
    });
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      inaccessible += 1;
      continue;
    }
    const base = sheet.href ?? document.baseURI;
    for (const rule of Array.from(cssRules)) {
      if (rule instanceof CSSFontFaceRule) {
        rules.push({
          family: rule.style.getPropertyValue('font-family'),
          weight: rule.style.getPropertyValue('font-weight'),
          style: rule.style.getPropertyValue('font-style'),
          src: resolveSrc(rule.style.getPropertyValue('src'), base),
        });
      }
    }
  }
  return { faces, rules, inaccessibleStyleSheets: inaccessible };
}
