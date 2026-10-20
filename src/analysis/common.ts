/**
 * Helpers shared by the analysis modules: per-state provenance contexts,
 * style lookups that honour the dropped UA defaults, and node-path utilities.
 */
import type { ProvenanceContext, UiNode } from 'uidna-schema';
import { STYLE_DEFAULTS } from '../browser/style-properties.js';
import type { CapturedState } from '../browser/types.js';

/** A capture keyed by its state id. */
export type CaptureMap = ReadonlyMap<string, CapturedState>;

/** Evidence ids per state id, as recorded in `scan.json`. */
export type EvidenceIndex = Readonly<Record<string, string>>;

/** Provenance context for values measured in one state. */
export function stateContext(stateId: string, capture: CapturedState, evidence: EvidenceIndex | undefined): ProvenanceContext {
  const evidenceId = evidence?.[stateId];
  return {
    stateId,
    viewport: capture.viewport,
    capturedAt: capture.capturedAt,
    ...(evidenceId === undefined ? {} : { evidenceId }),
  };
}

/** The style object of a node, or `undefined` when the state's style table lacks it. */
export function styleOf(capture: CapturedState, node: UiNode): Readonly<Record<string, string>> | undefined {
  return capture.styles[node.styleId];
}

/** A property value, falling back to the UA default the instrument dropped. */
export function styleValue(style: Readonly<Record<string, string>> | undefined, property: string): string | undefined {
  const own = style?.[property];
  if (own !== undefined) return own;
  return (STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[property];
}

/** Path segments as numbers (`<body>` is the empty path). */
export function pathSegments(path: string): number[] {
  return path === '' ? [] : path.split('/').map((s) => Number(s));
}

/** Order node paths by document position (segment by segment, parents before children). */
export function comparePaths(a: string, b: string): number {
  const sa = pathSegments(a);
  const sb = pathSegments(b);
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (sa[i] ?? 0) - (sb[i] ?? 0);
    if (d !== 0) return d;
  }
  return sa.length - sb.length;
}

/** True when `ancestor` is a proper ancestor path of `descendant`. */
export function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;
  if (ancestor === '') return true;
  return descendant.startsWith(`${ancestor}/`);
}

/** Path of a node relative to a component root (`''` for the root itself). */
export function relativePath(rootPath: string, path: string): string {
  if (rootPath === '') return path;
  if (path === rootPath) return '';
  return path.slice(rootPath.length + 1);
}

/** The latest `capturedAt` among captures (ISO strings compare lexically); `fallback` when there are none. */
export function latestCapturedAt(captures: CaptureMap, fallback: string): string {
  let latest: string | null = null;
  for (const capture of captures.values()) {
    if (latest === null || capture.capturedAt > latest) latest = capture.capturedAt;
  }
  return latest ?? fallback;
}

/** Collapse whitespace, strip quotes around font family names and normalize separators. */
export function normalizeFontFamily(value: string): string {
  return value
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' '))
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * Identity of a page for matching links against crawled pages: the URL without
 * its fragment, with a normalized trailing slash. This is the same rule the
 * crawler applies (`pageKey` in `src/application/scan.ts`); it is repeated here
 * because the analysis layer must not import the scan workflow (that module
 * imports the analysis layer, and a cycle would leave `assembleDna` undefined
 * at load time). `pageKey.test.ts` checks that the two agree.
 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.endsWith('/') && parsed.pathname.length > 1 ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Distinct values preserving first-seen order. */
export function distinct<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
