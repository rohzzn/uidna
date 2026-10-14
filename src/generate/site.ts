/**
 * Site planning for multi-page documents: which pages are generated, their
 * component names and route patterns, which layouts share a header or footer
 * across pages, and how a same-origin link resolves to a route. A single-page
 * document without an explicit router keeps the Phase 1 layout untouched.
 */
import type { Page, UiDnaDocument, UiNode } from '@rohzzn/uidna-schema';
import { uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { compareStrings, pascalCase } from './jsx.js';
import { buildPageModel, planBreakpoints, splitLandmarks, type BreakpointPlan, type GenerationModel } from './model.js';

/** How pages are wired in the generated project. */
export type RouterMode = 'none' | 'react-router';

/** A layout shared by several pages: header and/or footer rendered once around an `<Outlet />`. */
export interface LayoutPlan {
  /** Layout id from the document. */
  readonly id: string;
  /** Component name (`Layout`, `Layout2`, …) and file. */
  readonly name: string;
  readonly file: string;
  /** Page whose header and footer are rendered for the group (the first page of the group in document order). */
  readonly sourcePageId: string;
  readonly pageIds: readonly string[];
  /** True when the group's banner/navigation landmarks are hoisted into `headerFile`. */
  readonly header: boolean;
  /** True when the group's contentinfo landmark is hoisted into `footerFile`. */
  readonly footer: boolean;
  readonly headerName: string;
  readonly headerFile: string;
  readonly footerName: string;
  readonly footerFile: string;
}

/** A generated page. */
export interface PagePlan {
  readonly page: Page;
  readonly model: GenerationModel;
  /** PascalCase component name, unique across pages and components. */
  readonly name: string;
  /** `src/pages/<Name>.tsx` (react-router), or the single-page `src/sections/Main.tsx` is used instead. */
  readonly file: string;
  /** Route pattern that renders the page. */
  readonly route: string;
  /** Where the pattern came from: a recorded route, or the page URL's path when no route was recorded. */
  readonly routeSource: 'document' | 'url';
  readonly layout: LayoutPlan | null;
}

/** Result of `planSite`. */
export interface SitePlan {
  readonly router: RouterMode;
  /** Pages in document order (seed first). */
  readonly pages: readonly PagePlan[];
  readonly layouts: readonly LayoutPlan[];
  /** Page id → route pattern. */
  readonly routeByPageId: ReadonlyMap<string, string>;
  /** Breakpoint name per base-state width, shared by every page. */
  readonly breakpoints: ReadonlyMap<number, string | null>;
  /** The site-wide breakpoint plan (see `planBreakpoints`). */
  readonly plan: BreakpointPlan;
  /** What was left out or derived, for the README. */
  readonly notes: readonly string[];
}

/** Names that page components may not take (React, react-router and generator names). */
export const RESERVED_PAGE_NAMES: ReadonlySet<string> = new Set([
  'App',
  'Layout',
  'Header',
  'Main',
  'Footer',
  'Link',
  'NavLink',
  'Outlet',
  'Route',
  'Routes',
  'BrowserRouter',
  'Navigate',
  'Fragment',
  'React',
  'Component',
  'StrictMode',
]);

/**
 * Identity of a page for link resolution: the URL without its fragment, with a
 * normalized trailing slash. Mirrors `pageKey` of the crawler so links resolve
 * to the pages the crawl visited.
 */
export function pageKeyOf(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.endsWith('/') && parsed.pathname.length > 1 ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Extension-less alias of a `.html`/`.htm` route pattern (`/features.html` → `/features`), or null.
 * Hosts and verifiers that drop the extension reach the page through the alias; links keep the recorded pattern.
 */
export function routeAlias(pattern: string): string | null {
  const match = /^(.+)\.html?$/i.exec(pattern);
  return match?.[1] !== undefined && match[1].length > 0 ? match[1] : null;
}

/**
 * True when a route pattern is a literal path a browser can be sent to, by
 * react-router's rules: it starts with `/`, no segment starts with `:` (a
 * parameter) and no segment contains `*` (a splat). A colon inside a segment
 * is literal (`/wiki/Help:Contents`).
 */
export function isLiteralRoute(pattern: string): boolean {
  return pattern.startsWith('/') && pattern.split('/').every((segment) => !segment.startsWith(':') && !segment.includes('*'));
}

/** Route pattern derived from a page URL: its path (`/` when the URL cannot be parsed). */
export function routeFromUrl(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

/** Candidate page name from the URL path (`/` → Home, `/features.html` → Features), then the title, then `fallback`. */
export function pageNameFor(page: Page, fallback: string): string {
  let pathname = '';
  try {
    pathname = new URL(page.url).pathname;
  } catch {
    pathname = '';
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === undefined) return pathname === '' ? pascalCase(page.title.value ?? '', fallback) : 'Home';
  const stem = last.replace(/\.[A-Za-z0-9]+$/, '');
  const fromPath = pascalCase(stem, '');
  if (fromPath.length > 0) return fromPath;
  return pascalCase(page.title.value ?? '', fallback);
}

function uniqueName(candidate: string, used: Set<string>): string {
  let name = RESERVED_PAGE_NAMES.has(candidate) ? `${candidate}Page` : candidate;
  const taken = (value: string): boolean => used.has(value.toLowerCase());
  if (taken(name)) {
    let n = 2;
    while (taken(`${name}${n}`)) n += 1;
    name = `${name}${n}`;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Plan the site: pages, names, routes and shared layouts. `usedNames` collects the page names (lower-cased) so components never clash with them. */
export function planSite(dna: UiDnaDocument, router: RouterMode | undefined, usedNames: Set<string>): Result<SitePlan> {
  const notes: string[] = [];
  const candidates: Page[] = [];
  for (const page of dna.app.pages) {
    if (dna.states.items.some((s) => s.kind === 'base' && s.pageId === page.id)) candidates.push(page);
    else notes.push(`page ${page.id} (${page.url}) has no base state and was not generated`);
  }
  const first = candidates[0];
  if (first === undefined) return err(uidnaError('generate', dna.app.pages.length === 0 ? 'the UI DNA document has no page' : `page ${dna.app.pages[0]?.id ?? '?'} has no base state`));

  const mode: RouterMode = router ?? (candidates.length > 1 ? 'react-router' : 'none');
  let selected = candidates;
  if (mode === 'none' && candidates.length > 1) {
    selected = [first];
    notes.push(`router "none": only the first page ${first.id} (${first.url}) was generated; ${candidates.slice(1).map((p) => `${p.id} (${p.url})`).join(', ')} left out`);
  }

  // Routes: recorded pattern first, else the page URL's path; duplicates drop the later page.
  const routeByPageId = new Map<string, string>();
  const routeSource = new Map<string, PagePlan['routeSource']>();
  const takenPatterns = new Set<string>();
  const routed: Page[] = [];
  const recorded = [...dna.app.routes].sort((a, b) => compareStrings(a.id, b.id));
  for (const page of selected) {
    const route = recorded.find((r) => r.pageId === page.id);
    const pattern = route?.pattern ?? routeFromUrl(page.url);
    if (route === undefined && mode === 'react-router') notes.push(`page ${page.id}: no route was recorded; the pattern ${pattern} is the path of the page URL`);
    if (mode === 'react-router' && takenPatterns.has(pattern)) {
      notes.push(`page ${page.id} (${page.url}) was not generated: its route pattern ${pattern} is already taken by another page`);
      continue;
    }
    takenPatterns.add(pattern);
    routeByPageId.set(page.id, pattern);
    routeSource.set(page.id, route === undefined ? 'url' : 'document');
    routed.push(page);
  }

  const plan = planBreakpoints(
    dna,
    routed.map((p) => p.id),
  );
  const breakpoints = new Map(plan.nameAt);

  // Models first: layouts can only hoist landmarks that are direct children of <body> on the source page.
  const modelByPage = new Map<string, GenerationModel>();
  for (const page of routed) {
    const model = buildPageModel(dna, page, mode === 'react-router' ? plan : undefined);
    if (!model.ok) return model;
    modelByPage.set(page.id, model.value);
  }

  // Layouts: groups of two or more generated pages sharing banner/navigation and/or contentinfo landmarks.
  const layouts: LayoutPlan[] = [];
  const layoutByPage = new Map<string, LayoutPlan>();
  if (mode === 'react-router') {
    const order = new Map(routed.map((p, i) => [p.id, i] as const));
    for (const layout of [...dna.app.layouts].sort((a, b) => compareStrings(a.id, b.id))) {
      const members = layout.pageIds.filter((id) => order.has(id) && !layoutByPage.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      if (members.length < 2) continue;
      const roles = new Set(layout.regions.map((r) => r.role.toLowerCase()));
      const declaresHeader = roles.has('banner') || roles.has('navigation');
      const declaresFooter = roles.has('contentinfo');
      if (!declaresHeader && !declaresFooter) {
        notes.push(`layout ${layout.id} groups ${members.join(', ')} but shares no banner, navigation or contentinfo landmark; nothing was hoisted`);
        continue;
      }
      const source = members[0];
      const sourceModel = source === undefined ? undefined : modelByPage.get(source);
      if (source === undefined || sourceModel === undefined) continue;
      // The layout file imports the hoisted sections, so a region is only hoisted when the source page
      // really has it as a top-level landmark; a header nested in a wrapper stays in the page content.
      const landmarks = splitLandmarks(sourceModel);
      const header = declaresHeader && landmarks.header.length > 0;
      const footer = declaresFooter && landmarks.footer.length > 0;
      if (declaresHeader && !header) notes.push(`layout ${layout.id}: page ${source} has no banner or navigation landmark as a direct child of <body>, so the header was not hoisted`);
      if (declaresFooter && !footer) notes.push(`layout ${layout.id}: page ${source} has no contentinfo landmark as a direct child of <body>, so the footer was not hoisted`);
      if (!header && !footer) continue;
      for (const id of members.slice(1)) {
        const model = modelByPage.get(id);
        if (model === undefined) continue;
        const own = splitLandmarks(model);
        if (header && own.header.length === 0) notes.push(`layout ${layout.id}: page ${id} has no top-level banner or navigation landmark to replace; the header of page ${source} is rendered above its content, which may repeat it`);
        if (footer && own.footer.length === 0) notes.push(`layout ${layout.id}: page ${id} has no top-level contentinfo landmark to replace; the footer of page ${source} is rendered below its content, which may repeat it`);
      }
      const suffix = layouts.length === 0 ? '' : String(layouts.length + 1);
      const plan: LayoutPlan = {
        id: layout.id,
        name: `Layout${suffix}`,
        file: `src/layouts/Layout${suffix}.tsx`,
        sourcePageId: source,
        pageIds: members,
        header,
        footer,
        headerName: `Header${suffix}`,
        headerFile: `src/sections/Header${suffix}.tsx`,
        footerName: `Footer${suffix}`,
        footerFile: `src/sections/Footer${suffix}.tsx`,
      };
      layouts.push(plan);
      for (const id of members) layoutByPage.set(id, plan);
      // App.tsx imports layouts next to pages and layouts import their sections: no page or component may take these names.
      for (const taken of [plan.name, plan.headerName, plan.footerName]) usedNames.add(taken.toLowerCase());
    }
  }

  const pages: PagePlan[] = [];
  for (const page of routed) {
    const model = modelByPage.get(page.id);
    if (model === undefined) return err(uidnaError('generate', `page ${page.id} has no generation model`));
    const name = mode === 'react-router' ? uniqueName(pageNameFor(page, `Page${(pages.length + 1).toString().padStart(2, '0')}`), usedNames) : 'Main';
    pages.push({
      page,
      model,
      name,
      file: mode === 'react-router' ? `src/pages/${name}.tsx` : 'src/sections/Main.tsx',
      route: routeByPageId.get(page.id) ?? '/',
      routeSource: routeSource.get(page.id) ?? 'url',
      layout: layoutByPage.get(page.id) ?? null,
    });
  }
  return ok({ router: mode, pages, layouts, routeByPageId, breakpoints, plan, notes });
}

/**
 * Build the resolver that turns a page's `<a href>` into a route pattern: the
 * document's navigation edges first (the crawl followed them), then the href
 * resolved against the page URL and matched to a generated page. Fragment
 * links of the same page and everything that is not a generated page stay
 * `<a>` (null). Always null without a router.
 */
export function makeRouteResolver(dna: UiDnaDocument, site: SitePlan, page: PagePlan): (node: UiNode) => string | null {
  if (site.router !== 'react-router') return () => null;
  const byKey = new Map<string, string>();
  for (const p of site.pages) byKey.set(pageKeyOf(p.page.url), p.page.id);
  const edges = dna.app.navigation.filter((e) => e.fromPageId === page.page.id);
  return (node) => {
    if (node.tag.toLowerCase() !== 'a') return null;
    const href = node.attrs.href;
    if (href === undefined || href.trim().length === 0 || href.trim().startsWith('#')) return null;
    const edge = edges.find((e) => e.via.nodePath === node.path);
    let targetPageId: string | null = null;
    let hash = '';
    if (edge !== undefined) {
      if (edge.to.pageId === null || (edge.to.fragment && edge.to.pageId === page.page.id)) return null;
      targetPageId = edge.to.pageId;
      try {
        hash = new URL(edge.to.url).hash;
      } catch {
        hash = '';
      }
    } else {
      let resolved: URL;
      try {
        resolved = new URL(href, page.page.url);
      } catch {
        return null;
      }
      if (!/^https?:$/.test(resolved.protocol)) return null;
      targetPageId = byKey.get(pageKeyOf(resolved.href)) ?? null;
      hash = resolved.hash;
    }
    if (targetPageId === null) return null;
    const pattern = site.routeByPageId.get(targetPageId);
    if (pattern === undefined) return null;
    return /^#[A-Za-z0-9_-]*$/.test(hash) && hash.length > 1 ? `${pattern}${hash}` : pattern;
  };
}
