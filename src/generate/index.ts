/**
 * Project generation: UI DNA document → React 19 + TypeScript + Tailwind 4 +
 * Vite 7 project. Deterministic, no LLM. The generated project builds with
 * `npm run build`; every element carries `data-uidna-path` for verification.
 * Multi-page documents get react-router routes, a shared layout and one
 * component per page; submit transitions become validated forms; captured
 * JSON responses become typed mocks; every implemented transition gets a
 * Playwright behavior test.
 */
import { collectionContainerPaths, planCollections, renderCollectionLib, type CollectionPlan, type CollectionPlanning } from './collections.js';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { formatIssues, validateUiDna, type UiDnaDocument } from 'uidna-schema';
import type { GenerateRecord } from '../application/records.js';
import { silentProgress, type ProgressReporter } from '../domain/budget.js';
import { isoNow, systemClock, type Clock } from '../domain/clock.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import { AssetRegistry, dataAssets, jsonAssets } from './assets.js';
import { planBehavior, type BehaviorPlan, type BehaviorReport, type FormBehavior, type HoistedLocation } from './behavior.js';
import { buildProject, installProject } from './build.js';
import { planComponents, type ComponentPlan, type ComponentPlanning } from './components.js';
import { compareStrings } from './jsx.js';
import { mockNames, renderDataMock, type DataMockInput } from './mocks.js';
import { isAncestorPath, type GenNode, type GenerationModel } from './model.js';
import {
  MANIFEST_FILE,
  renderGitignore,
  renderIndexCss,
  renderIndexHtml,
  renderMain,
  renderManifest,
  renderMocks,
  renderPackageJson,
  renderReadme,
  renderTsconfig,
  renderValidityLib,
  renderViteConfig,
  type GeneratedManifest,
  type MockRecord,
  type ProjectFeatures,
} from './project.js';
import { bodyClasses, makeScopeResolver, planPageSections, planSections, renderApp, renderComponent, renderLayout, renderRouterApp, renderSection, type RenderContext, type SectionPlan, renderSharedStateLib } from './render.js';
import { makeRouteResolver, planSite, type RouterMode } from './site.js';
import { responsiveClasses, type NodeClasses } from './styles.js';
import type { SkippedProperty } from './tailwind-map.js';
import { renderBehaviorSpec, renderPlaywrightConfig, type BehaviorSpecSummary } from './tests.js';
import { renderTokensCss, resolveTokens } from './tokens.js';

export { buildProject, installProject, BUILD_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from './build.js';
export type { BuildOptions, BuildOutcome, InstallOutcome } from './build.js';
export { classesFor, normalizeColor, arbitraryValue } from './tailwind-map.js';
export type { TokenIndex, ClassMapping, SkippedProperty } from './tailwind-map.js';
export type { GeneratedManifest, MockRecord, ProjectFeatures } from './project.js';
export type { PlaceholderRecord } from './assets.js';
export type { RouterMode, SitePlan, PagePlan, LayoutPlan } from './site.js';
export type { BehaviorReport, TransitionTest, Expectation, FormBehavior } from './behavior.js';
export type { BehaviorSpecSummary } from './tests.js';

/** Input of `generateProject`. */
export interface GenerateInput {
  readonly dna: UiDnaDocument;
  /** Scan directory (`.uidna/<scan-id>`); asset copies are resolved against it. */
  readonly scanDir: string;
  readonly outDir: string;
  /** Run `npm install` after writing (default true, as the tool contract says). */
  readonly install?: boolean;
  /** Run `npm run build` after install (default true). */
  readonly build?: boolean;
  /** How pages are wired: `react-router` (default when the document has more than one page) or `none` (first page only). */
  readonly router?: RouterMode;
  /** Write Playwright behavior tests that replay every implemented transition (default true). */
  readonly behaviorTests?: boolean;
  readonly clock?: Clock;
  readonly progress?: ProgressReporter;
  readonly signal?: AbortSignal;
  readonly evidenceId: string;
}

const OptionsSchema = z.object({
  scanDir: z.string().min(1),
  outDir: z.string().min(1),
  install: z.boolean().optional(),
  build: z.boolean().optional(),
  router: z.enum(['none', 'react-router']).optional(),
  behaviorTests: z.boolean().optional(),
  evidenceId: z.string().min(1),
});

export { MANIFEST_FILE };

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Files listed by the previous run's manifest. A missing manifest is the normal first run;
 * an unreadable one is an I/O error; an unparsable one is reported and treated as absent.
 */
async function readPreviousManifest(outDir: string, progress: ProgressReporter): Promise<Result<string[]>> {
  const path = join(outDir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return ok([]);
    return err(toError(cause, 'io', `read previous manifest ${path}`));
  }
  const json = tryCatch((): unknown => JSON.parse(raw), (cause) => toError(cause, 'validation'));
  const parsed = json.ok ? z.object({ files: z.array(z.string()) }).safeParse(json.value) : null;
  if (!parsed?.success) {
    progress.report({ message: `${path} is not a generated manifest; files from the previous run that this run does not produce are left in place` });
    return ok([]);
  }
  return ok(parsed.data.files);
}

function insideDir(root: string, candidate: string): boolean {
  const abs = resolve(root, candidate);
  return abs === root || abs.startsWith(root + sep);
}

/** Read and parse the stored copies of the document's `data` assets (never throws; failures become reasons). */
async function readDataAssets(dna: UiDnaDocument, scanDir: string): Promise<DataMockInput[]> {
  const inputs: DataMockInput[] = [];
  for (const asset of dataAssets(dna)) {
    if (asset.localPath === undefined || !insideDir(scanDir, asset.localPath)) {
      inputs.push({ asset, json: null, reason: asset.localPath === undefined ? 'no local copy was stored during the scan' : 'stored copy path escapes the scan directory' });
      continue;
    }
    try {
      const raw = await readFile(resolve(scanDir, asset.localPath), 'utf8');
      inputs.push({ asset, json: JSON.parse(raw) as unknown, reason: null });
    } catch (cause) {
      inputs.push({ asset, json: null, reason: `stored copy could not be read as JSON: ${toError(cause, 'io').message}` });
    }
  }
  return inputs;
}

/**
 * Generate a project from a UI DNA document. Writes the files, copies
 * authorized assets, then optionally installs and builds. Never throws.
 */
export async function generateProject(input: GenerateInput): Promise<Result<GenerateRecord>> {
  const options = OptionsSchema.safeParse({ scanDir: input.scanDir, outDir: input.outDir, install: input.install, build: input.build, router: input.router, behaviorTests: input.behaviorTests, evidenceId: input.evidenceId });
  if (!options.success) return err(uidnaError('validation', `invalid generate input: ${options.error.issues.map((i) => i.message).join('; ')}`));
  const validation = validateUiDna(input.dna);
  if (!validation.success) {
    const issues = formatIssues(validation);
    return err(uidnaError('validation', `UI DNA document is invalid: ${issues.slice(0, 5).join('; ')}`, { details: { issues } }));
  }
  const dna = validation.data;
  const clock = input.clock ?? systemClock;
  const progress = input.progress ?? silentProgress;
  const install = options.data.install ?? true;
  const build = options.data.build ?? true;
  const behaviorTests = options.data.behaviorTests ?? true;
  const outDir = resolve(options.data.outDir);
  const scanDir = resolve(options.data.scanDir);
  const cancelled = (): Result<never> | null => (input.signal?.aborted === true ? err(uidnaError('cancelled', 'generation cancelled by caller')) : null);

  progress.report({ message: 'Building generation model', current: 1, total: 7 });
  const usedNames = new Set<string>();
  const siteResult = planSite(dna, options.data.router, usedNames);
  if (!siteResult.ok) return siteResult;
  const site = siteResult.value;
  const multi = site.router === 'react-router';
  const tokens = resolveTokens(dna);

  const classCache = new Map<string, NodeClasses>();
  const classesForModel =
    (model: GenerationModel) =>
    (node: GenNode): NodeClasses => {
      const key = `${model.pageId}\u0000${node.path}`;
      const cached = classCache.get(key);
      if (cached) return cached;
      const computed = responsiveClasses(node, model, tokens.index);
      classCache.set(key, computed);
      return computed;
    };

  progress.report({ message: 'Planning components and behavior', current: 2, total: 7 });
  const files = new Map<string, string>();
  const allSections: SectionPlan[] = [];
  const componentPlans: ComponentPlan[] = [];
  const rejectedComponents: { definitionId: string; generatedName: string; reason: string }[] = [];
  const reports: BehaviorReport[] = [];
  const forms: FormBehavior[] = [];
  const collectionPlans: CollectionPlan[] = [];
  let sharedState = false;
  const collectionGaps: { readonly id: string; readonly reason: string }[] = [];
  const skipped: SkippedProperty[] = [];
  const bodyClassNotes: string[] = [];
  let registry: AssetRegistry | null = null;
  let firstCtx: RenderContext | null = null;
  let firstBody: string | null = null;
  let singleSections: SectionPlan[] = [];

  for (const page of site.pages) {
    const model = page.model;
    const classesOf = classesForModel(model);
    const assets: AssetRegistry = registry === null ? new AssetRegistry(dna, model, scanDir) : registry.forModel(model);
    registry ??= assets;
    const routeOf = makeRouteResolver(dna, site, page);
    const planned = multi ? planPageSections(page) : { sections: planSections(model), hoisted: { header: [], footer: [] } };
    const { sections, hoisted } = planned;
    const layout = page.layout;
    const isSource = layout !== null && layout.sourcePageId === page.page.id;
    const hoistedList = [...hoisted.header, ...hoisted.footer];
    const excludedRoots = isSource ? [] : hoistedList.map((root) => root.path);
    const hoistedLookup = (path: string): HoistedLocation | null => {
      if (layout === null || isSource) return null;
      const root = hoistedList.find((r) => r.path === path || isAncestorPath(r.path, path));
      if (root === undefined) return null;
      const sourcePage = site.pages.find((p) => p.page.id === layout.sourcePageId);
      if (sourcePage === undefined) return null;
      const inHeader = hoisted.header.includes(root);
      return { file: inHeader ? layout.headerFile : layout.footerFile, sectionName: inHeader ? layout.headerName : layout.footerName, sourcePageId: layout.sourcePageId, sourceModel: sourcePage.model };
    };
    const pageTransitions = dna.states.transitions.filter((t) => model.statesById.get(t.from)?.pageId === page.page.id);
    // Components whose instances change together with nodes outside them are rendered inline so the
    // state of a transition lives in one file; planning repeats with those definitions excluded.
    const namesBefore = new Set(usedNames);
    const excludedDefinitions = new Set<string>();
    // Collections with observed search, filter or sort render their items from data: their rows stay out of component instances.
    const collectionContainers = collectionContainerPaths(dna, model);
    const planPage = (): { components: ComponentPlanning; behavior: BehaviorPlan; collections: CollectionPlanning } => {
      usedNames.clear();
      for (const name of namesBefore) usedNames.add(name);
      const components = planComponents(dna, model, assets, classesOf, { usedNames, routeOf, skipAbsent: multi, excludedRoots: [...excludedRoots, ...collectionContainers], excludedDefinitions });
      const resolver = makeScopeResolver(model, sections, components);
      const collections = planCollections(dna, model, resolver, tokens.index);
      const behavior = planBehavior(model, pageTransitions, tokens.index, resolver, { routeOf, routeByPageId: site.routeByPageId, pageRoute: page.route, hoisted: hoistedLookup, claimed: collections.claimed });
      return { components, behavior, collections };
    };
    let planned2 = planPage();
    for (let pass = 0; pass < 4 && planned2.behavior.conflictingInstanceRoots.size > 0; pass += 1) {
      const before = excludedDefinitions.size;
      for (const root of planned2.behavior.conflictingInstanceRoots) {
        const owner = planned2.components.instanceByPath.get(root);
        if (owner) excludedDefinitions.add(owner.plan.definitionId);
      }
      if (excludedDefinitions.size === before) break;
      planned2 = planPage();
    }
    const { components, behavior, collections } = planned2;
    const ctx: RenderContext = { model, tokens: tokens.index, assets, components, behavior, classesOf, scanId: dna.target.scanId, routeOf, collections };
    collectionPlans.push(...collections.plans);
    if ([...behavior.stateVars.values()].some((vars) => vars.some((v) => v.shared !== undefined))) sharedState = true;
    collectionGaps.push(...collections.notImplemented);

    progress.report({ message: `Rendering ${multi ? `page ${page.page.id}` : 'sections and components'}`, current: 3, total: 7 });
    for (const plan of components.components) {
      const rendered = renderComponent(plan, ctx);
      files.set(rendered.file, rendered.code);
    }
    for (const section of sections) {
      const rendered = section.kind === 'page' ? renderSection(section, ctx, { title: model.pageTitle, doc: `page ${page.page.id} at route ${page.route}` }) : renderSection(section, ctx);
      files.set(rendered.file, rendered.code);
    }
    const excluded = new Set(excludedRoots);
    const visit = (node: GenNode): void => {
      if (node.kind === 'skipped' || excluded.has(node.path)) return;
      skipped.push(...classesOf(node).skipped);
      for (const child of node.children) visit(child);
    };
    visit(model.body);

    allSections.push(...sections);
    componentPlans.push(...components.components);
    rejectedComponents.push(...components.rejected);
    reports.push(...behavior.reports);
    for (const list of behavior.forms.values()) forms.push(...list);
    const body = bodyClasses(ctx).join(' ');
    if (firstCtx === null) {
      firstCtx = ctx;
      firstBody = body;
      singleSections = sections;
    } else if (body !== firstBody) {
      bodyClassNotes.push(`page ${page.page.id} measured different <body> classes (${body || 'none'}); index.html carries the seed page's (${firstBody ?? 'none'})`);
    }
  }
  if (firstCtx === null) return err(uidnaError('generate', 'no page was generated'));
  const ctx = firstCtx;

  if (multi) {
    for (const layout of site.layouts) {
      const rendered = renderLayout(layout, dna.target.scanId);
      files.set(rendered.file, rendered.code);
    }
    const app = renderRouterApp(site, dna.target.scanId);
    files.set(app.file, app.code);
  } else {
    const app = renderApp(singleSections, ctx);
    files.set(app.file, app.code);
  }
  if (forms.length > 0) files.set('src/lib/validity.ts', renderValidityLib());
  if (collectionPlans.length > 0) files.set('src/lib/collection.ts', renderCollectionLib());
  if (sharedState) files.set('src/lib/shared-state.ts', renderSharedStateLib());

  // Mocks: Phase 1 JSON assets stay in src/mocks/data.ts; captured responses (`data` assets) get one typed file each.
  const mockInputs: { asset: (typeof dna.assets)[number]; json: unknown; reason: string | null }[] = [];
  for (const asset of jsonAssets(dna)) {
    if (asset.localPath === undefined || !insideDir(scanDir, asset.localPath)) {
      mockInputs.push({ asset, json: null, reason: asset.localPath === undefined ? 'no local copy was stored during the scan' : 'stored copy path escapes the scan directory' });
      continue;
    }
    try {
      const raw = await readFile(resolve(scanDir, asset.localPath), 'utf8');
      mockInputs.push({ asset, json: JSON.parse(raw) as unknown, reason: null });
    } catch (cause) {
      mockInputs.push({ asset, json: null, reason: `stored copy could not be read as JSON: ${toError(cause, 'io').message}` });
    }
  }
  const mocksRendered = renderMocks(mockInputs);
  const mocks: MockRecord[] = mocksRendered?.mocks ?? [];
  if (mocksRendered) files.set('src/mocks/data.ts', mocksRendered.code);
  const dataInputs = await readDataAssets(dna, scanDir);
  const names = mockNames(dataInputs.map((d) => d.asset));
  for (const dataInput of dataInputs) {
    const name = names.get(dataInput.asset.id);
    if (name === undefined) continue;
    const rendered = renderDataMock(dataInput, name);
    files.set(rendered.file, rendered.code);
    mocks.push(rendered.record);
  }

  // Behavior tests.
  let behaviorSummary: BehaviorSpecSummary | null = null;
  if (behaviorTests) {
    const spec = renderBehaviorSpec(dna.target.scanId, reports);
    files.set('playwright.config.ts', renderPlaywrightConfig());
    files.set('tests/behavior.spec.ts', spec.code);
    behaviorSummary = spec.summary;
  }

  const features: ProjectFeatures = { router: multi, behaviorTests };
  const lang = ctx.model.body.node.attrs.lang ?? 'en';
  files.set('package.json', renderPackageJson(dna.target.scanId, features));
  files.set('tsconfig.json', renderTsconfig(features));
  files.set('vite.config.ts', renderViteConfig());
  files.set('index.html', renderIndexHtml(ctx.model.pageTitle, lang, bodyClasses(ctx)));
  files.set('src/main.tsx', renderMain());
  files.set('src/index.css', renderIndexCss());
  // Multi-page projects declare the breakpoints of every page, not only the seed page's: a page captured
  // at a width the seed lacks would otherwise emit `md:` utilities Tailwind drops.
  files.set('src/styles/tokens.css', renderTokensCss(tokens, ctx.model, dna.target.scanId, multi ? site.plan : ctx.model.breakpoints));
  files.set('.gitignore', renderGitignore());

  const assets = registry ?? ctx.assets;
  const copies = assets.copyList();
  const placeholders = [...assets.placeholders].sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.assetId, b.assetId));
  const manifestComponents = componentPlans.map((plan) => ({ name: plan.name, file: plan.file, definitionId: plan.definitionId }));
  const allFiles = [...files.keys(), ...copies.map((c) => c.to), 'README.md', MANIFEST_FILE].sort();
  const manifest: GeneratedManifest = {
    scanId: dna.target.scanId,
    dnaVersion: dna.dnaVersion,
    components: manifestComponents,
    placeholders,
    mocks,
    viewports: ctx.model.slots.map((slot) => ({ width: slot.width, height: slot.state.viewport.height, breakpoint: slot.breakpoint })),
    files: allFiles,
    router: site.router,
    pages: site.pages.map((page) => ({ pageId: page.page.id, name: page.name, file: page.file, route: page.route })),
    behaviorTests: behaviorSummary,
  };
  files.set(
    'README.md',
    renderReadme({
      scanId: dna.target.scanId,
      dnaVersion: dna.dnaVersion,
      pageTitle: ctx.model.pageTitle,
      model: ctx.model,
      sections: allSections,
      components: { components: componentPlans, instanceByPath: new Map(), rejected: rejectedComponents },
      placeholders,
      mocks,
      behavior: { byPath: new Map(), stateVars: new Map(), forms: new Map(), reports, conflictingInstanceRoots: new Set() },
      tokens,
      skipped,
      ...(multi ? { site } : { siteNotes: site.notes }),
      forms,
      behaviorTests: behaviorSummary,
      bodyClassNotes,
    }),
  );
  files.set(MANIFEST_FILE, renderManifest(manifest));

  const aborted = cancelled();
  if (aborted) return aborted;

  progress.report({ message: `Writing ${allFiles.length} files to ${outDir}`, current: 4, total: 7 });
  try {
    await mkdir(outDir, { recursive: true });
    const previous = await readPreviousManifest(outDir, progress);
    if (!previous.ok) return previous;
    const current = new Set(allFiles);
    for (const stale of previous.value) {
      if (current.has(stale) || !insideDir(outDir, stale)) continue;
      await rm(resolve(outDir, stale), { force: true });
    }
    for (const [relative, content] of [...files.entries()].sort(([a], [b]) => compareStrings(a, b))) {
      const target = resolve(outDir, relative);
      if (!insideDir(outDir, relative)) return err(uidnaError('generate', `refusing to write outside the output directory: ${relative}`));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    for (const copy of copies) {
      const target = resolve(outDir, copy.to);
      await mkdir(dirname(target), { recursive: true });
      const source = await stat(copy.from);
      if (!source.isFile()) return err(uidnaError('io', `asset copy source is not a file: ${copy.from}`));
      await copyFile(copy.from, target);
    }
  } catch (cause) {
    return err(toError(cause, 'io', `write generated project to ${outDir}`));
  }

  const record: {
    install: GenerateRecord['install'];
    build: GenerateRecord['build'];
  } = {
    install: { attempted: false, ok: null, logPath: null, durationMs: 0 },
    build: { attempted: false, ok: null, logPath: null, durationMs: 0, distDir: null },
  };

  if (install) {
    const abortedBeforeInstall = cancelled();
    if (abortedBeforeInstall) return abortedBeforeInstall;
    progress.report({ message: 'Running npm install', current: 5, total: 7 });
    const installed = await installProject(outDir, { signal: input.signal });
    if (!installed.ok) {
      record.install = { attempted: true, ok: false, logPath: null, durationMs: 0 };
      progress.report({ message: `npm install could not run: ${installed.error.message}` });
    } else {
      record.install = { attempted: true, ok: installed.value.ok, logPath: toPosix(installed.value.logPath), durationMs: Math.round(installed.value.durationMs) };
    }
  }
  if (build && (!install || record.install.ok === true)) {
    const abortedBeforeBuild = cancelled();
    if (abortedBeforeBuild) return abortedBeforeBuild;
    progress.report({ message: 'Running npm run build', current: 6, total: 7 });
    const built = await buildProject(outDir, { signal: input.signal });
    if (!built.ok) {
      record.build = { attempted: true, ok: false, logPath: null, durationMs: 0, distDir: null };
      progress.report({ message: `npm run build could not run: ${built.error.message}` });
    } else {
      record.build = {
        attempted: true,
        ok: built.value.ok,
        logPath: toPosix(built.value.logPath),
        durationMs: Math.round(built.value.durationMs),
        distDir: built.value.distDir === null ? null : toPosix(built.value.distDir),
      };
    }
  }

  progress.report({ message: 'Generation finished', current: 7, total: 7 });
  return ok({
    scanId: dna.target.scanId,
    outDir: toPosix(outDir),
    generatedAt: isoNow(clock),
    evidenceId: options.data.evidenceId,
    files: allFiles,
    components: componentPlans.map((plan) => ({ name: plan.name, file: plan.file, definitionId: plan.definitionId, instances: plan.instances.length })),
    placeholders,
    mocks,
    install: record.install,
    build: record.build,
  });
}
