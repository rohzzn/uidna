/**
 * Page and route helpers for multi-page verification. Pure: which routes the
 * generated app registers (read from the generator's manifest, or derived
 * from the document when the project has none written for the scan being
 * verified), whether a URL pathname
 * reaches a route (the pattern itself or its extension-less alias), and the
 * order in which base states are compared (grouped by page in document
 * order, widest first).
 */
import { z } from 'zod';
import type { Page, UiDnaDocument, UiState } from '@rohzzn/uidna-schema';
import { uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { MANIFEST_FILE } from '../generate/project.js';
import { isLiteralRoute, routeAlias, routeFromUrl } from '../generate/site.js';

export { isLiteralRoute };

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
 * Route pattern the document records for a page: the recorded route (lowest
 * route id first), else the path of the page URL. Null when the document does
 * not list the page. This is the generator's first choice, but not its whole
 * decision: `planSite` also drops a page whose pattern another page took and,
 * with router "none", every page but the first. The generated project's
 * manifest (`generatedRoutesFromManifest`) is the authority; this is the
 * fallback when it is missing, unusable or written for another scan.
 */
export function pageRoute(dna: Pick<UiDnaDocument, 'app'>, pageId: string): string | null {
  const page = dna.app.pages.find((p) => p.id === pageId);
  if (page === undefined) return null;
  const recorded = [...dna.app.routes].sort((a, b) => compareStrings(a.id, b.id)).find((route) => route.pageId === pageId);
  return recorded?.pattern ?? routeFromUrl(page.url);
}

/** The pages the generated app renders and their routes, and where that knowledge comes from. */
export interface GeneratedRoutes {
  /** `manifest`: the generated project's manifest (written for the scan being verified) lists exactly the generated pages; `document`: derived per page with `pageRoute` (no usable manifest, or one written for another scan). */
  readonly source: 'manifest' | 'document';
  /** Router mode the manifest records; null when derived from the document. */
  readonly router: 'none' | 'react-router' | null;
  /** Page id → route pattern of every page the generated app renders (with `source: 'document'`, of every page the document lists). */
  readonly routeByPageId: ReadonlyMap<string, string>;
}

/** The part of the generator's manifest (`GeneratedManifest`) the verifier reads; other keys are ignored. */
const ManifestRoutesSchema = z.object({
  scanId: z.string().min(1),
  router: z.enum(['none', 'react-router']),
  pages: z.array(z.object({ pageId: z.string().min(1), route: z.string().min(1) })).min(1),
});

/**
 * The generated pages and their routes as the generator's manifest
 * (`uidna.generated.json`, already parsed from JSON) records them, provided
 * it was generated from scan `scanId` (the scan being verified). A tagged
 * validation error when the value is not such a manifest (for example one
 * written before pages were recorded), or when it names another scan: page
 * ids are numbered per scan in crawl order (pg_01, pg_02, ...), so another
 * scan's pg_02, even of the same site, may be a different page, and its
 * routes and its list of generated pages say nothing about this scan's
 * pages. The caller then derives the routes from the document
 * (`generatedRoutesFromDocument`), which records each page by its own URL.
 */
export function generatedRoutesFromManifest(manifest: unknown, scanId: string): Result<GeneratedRoutes> {
  const parsed = ManifestRoutesSchema.safeParse(manifest);
  if (!parsed.success) {
    return err(uidnaError('validation', `${MANIFEST_FILE} does not record the scan and pages it was generated from: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')}`));
  }
  if (parsed.data.scanId !== scanId) {
    return err(uidnaError('validation', `${MANIFEST_FILE} was generated from scan ${parsed.data.scanId}, not ${scanId}; page ids are numbered per scan, so its page ids may name other pages`));
  }
  const routeByPageId = new Map<string, string>();
  for (const page of parsed.data.pages) if (!routeByPageId.has(page.pageId)) routeByPageId.set(page.pageId, page.route);
  return ok({ source: 'manifest', router: parsed.data.router, routeByPageId });
}

/** Routes derived from the document for every page it lists (`pageRoute`): the fallback when the generated project has no usable manifest. */
export function generatedRoutesFromDocument(dna: Pick<UiDnaDocument, 'app'>): GeneratedRoutes {
  const routeByPageId = new Map<string, string>();
  for (const page of dna.app.pages) {
    const route = pageRoute(dna, page.id);
    if (route !== null) routeByPageId.set(page.id, route);
  }
  return { source: 'document', router: null, routeByPageId };
}

/** True when the generated app does not render the page: the manifest leaves it out. Never true for routes derived from the document. */
export function pageNotGenerated(routes: GeneratedRoutes, pageId: string): boolean {
  return routes.source === 'manifest' && !routes.routeByPageId.has(pageId);
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
