/**
 * Page and route helpers for multi-page verification. Pure over the
 * document: which route the generated app registers for a page (the same
 * decision `planSite` makes), whether a URL pathname reaches that route (the
 * pattern itself or its extension-less alias), and the order in which base
 * states are compared (grouped by page in document order, widest first).
 */
import type { Page, UiDnaDocument, UiState } from '@rohzzn/uidna-schema';
import { routeAlias, routeFromUrl } from '../generate/site.js';

/** Code-point string order: locale independent. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Strip a trailing slash from a pathname longer than `/`. */
function trimSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** The page a state belongs to, or undefined when the document does not list it. */
export function pageOf(dna: Pick<UiDnaDocument, 'app'>, state: Pick<UiState, 'pageId'>): Page | undefined {
  return dna.app.pages.find((page) => page.id === state.pageId);
}

/**
 * Route pattern the generated app registers for a page, decided like
 * `planSite`: the recorded route for the page (lowest route id first), else
 * the path of the page URL. Null when the document does not list the page.
 */
export function pageRoute(dna: Pick<UiDnaDocument, 'app'>, pageId: string): string | null {
  const page = dna.app.pages.find((p) => p.id === pageId);
  if (page === undefined) return null;
  const recorded = [...dna.app.routes].sort((a, b) => compareStrings(a.id, b.id)).find((route) => route.pageId === pageId);
  return recorded?.pattern ?? routeFromUrl(page.url);
}

/** True when a route pattern is a literal path a browser can be sent to (no `:param` or `*` segments). */
export function isLiteralRoute(pattern: string): boolean {
  return pattern.startsWith('/') && !/[:*]/.test(pattern);
}

/**
 * True when `pathname` reaches `route`: the pattern itself or its
 * extension-less alias (`/features.html` is also served at `/features`),
 * ignoring a trailing slash. A pattern with parameters never matches: the
 * verifier cannot tell which page a parameterized path rendered.
 */
export function routeReached(route: string, pathname: string): boolean {
  if (!isLiteralRoute(route)) return false;
  const actual = trimSlash(pathname);
  if (actual === trimSlash(route)) return true;
  const alias = routeAlias(route);
  return alias !== null && actual === trimSlash(alias);
}

/** Pathname of a URL (`/` when it cannot be parsed). */
export function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * Base states in comparison order: grouped by page in document order (states
 * of pages the document does not list come last, grouped by page id), widest
 * viewport first within a page, then by state id.
 */
export function orderByPage(dna: Pick<UiDnaDocument, 'app'>, states: readonly UiState[]): UiState[] {
  const order = new Map(dna.app.pages.map((page, index) => [page.id, index] as const));
  const rank = (state: UiState): number => order.get(state.pageId) ?? Number.MAX_SAFE_INTEGER;
  return [...states].sort((a, b) => rank(a) - rank(b) || compareStrings(a.pageId, b.pageId) || b.viewport.width - a.viewport.width || compareStrings(a.id, b.id));
}
