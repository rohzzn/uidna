/**
 * Project generation: UI DNA document → React 19 + TypeScript + Tailwind 4 +
 * Vite 7 project. Deterministic, no LLM. The generated project builds with
 * `npm run build`; every element carries `data-uidna-path` for verification.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { formatIssues, validateUiDna, type UiDnaDocument } from '@rohzzn/uidna-schema';
import type { GenerateRecord } from '../application/records.js';
import { silentProgress, type ProgressReporter } from '../domain/budget.js';
import { isoNow, systemClock, type Clock } from '../domain/clock.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import { AssetRegistry, jsonAssets } from './assets.js';
import { compareStrings } from './jsx.js';
import { planBehavior } from './behavior.js';
import { buildProject, installProject } from './build.js';
import { planComponents } from './components.js';
import { buildModel, walk, type GenNode } from './model.js';
import {
  renderGitignore,
  renderIndexCss,
  renderIndexHtml,
  renderMain,
  renderManifest,
  renderMocks,
  renderPackageJson,
  renderReadme,
  renderTsconfig,
  renderViteConfig,
  type GeneratedManifest,
  type MockRecord,
} from './project.js';
import { bodyClasses, makeScopeResolver, planSections, renderApp, renderComponent, renderSection, type RenderContext } from './render.js';
import { responsiveClasses, type NodeClasses } from './styles.js';
import type { SkippedProperty } from './tailwind-map.js';
import { renderTokensCss, resolveTokens } from './tokens.js';

export { buildProject, installProject, BUILD_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from './build.js';
export type { BuildOptions, BuildOutcome, InstallOutcome } from './build.js';
export { classesFor, normalizeColor, arbitraryValue } from './tailwind-map.js';
export type { TokenIndex, ClassMapping, SkippedProperty } from './tailwind-map.js';
export type { GeneratedManifest, MockRecord } from './project.js';
export type { PlaceholderRecord } from './assets.js';

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
  evidenceId: z.string().min(1),
});

/** Name of the manifest file written to the project root. */
export const MANIFEST_FILE = 'uidna.generated.json';

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

/**
 * Generate a project from a UI DNA document. Writes the files, copies
 * authorized assets, then optionally installs and builds. Never throws.
 */
export async function generateProject(input: GenerateInput): Promise<Result<GenerateRecord>> {
  const options = OptionsSchema.safeParse({ scanDir: input.scanDir, outDir: input.outDir, install: input.install, build: input.build, evidenceId: input.evidenceId });
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
  const outDir = resolve(options.data.outDir);
  const scanDir = resolve(options.data.scanDir);
  const cancelled = (): Result<never> | null => (input.signal?.aborted === true ? err(uidnaError('cancelled', 'generation cancelled by caller')) : null);

  progress.report({ message: 'Building generation model', current: 1, total: 7 });
  const modelResult = buildModel(dna);
  if (!modelResult.ok) return modelResult;
  const model = modelResult.value;
  const tokens = resolveTokens(dna);

  const classCache = new Map<string, NodeClasses>();
  const classesOf = (node: GenNode): NodeClasses => {
    const cached = classCache.get(node.path);
    if (cached) return cached;
    const computed = responsiveClasses(node, model, tokens.index);
    classCache.set(node.path, computed);
    return computed;
  };

  progress.report({ message: 'Planning components and behavior', current: 2, total: 7 });
  const assets = new AssetRegistry(dna, model, scanDir);
  const components = planComponents(dna, model, assets, classesOf);
  const sections = planSections(model);
  const resolver = makeScopeResolver(model, sections, components);
  const behavior = planBehavior(model, dna.states.transitions, tokens.index, resolver);

  const ctx: RenderContext = { model, tokens: tokens.index, assets, components, behavior, classesOf, scanId: dna.target.scanId };

  progress.report({ message: 'Rendering sections and components', current: 3, total: 7 });
  const files = new Map<string, string>();
  for (const plan of components.components) {
    const rendered = renderComponent(plan, ctx);
    files.set(rendered.file, rendered.code);
  }
  for (const section of sections) {
    const rendered = renderSection(section, ctx);
    files.set(rendered.file, rendered.code);
  }
  const app = renderApp(sections, ctx);
  files.set(app.file, app.code);

  const skipped: SkippedProperty[] = [];
  walk(model.body, (node) => {
    skipped.push(...classesOf(node).skipped);
  });

  // Mocks from JSON assets.
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

  const lang = model.body.node.attrs.lang ?? 'en';
  files.set('package.json', renderPackageJson(dna.target.scanId));
  files.set('tsconfig.json', renderTsconfig());
  files.set('vite.config.ts', renderViteConfig());
  files.set('index.html', renderIndexHtml(model.pageTitle, lang, bodyClasses(ctx)));
  files.set('src/main.tsx', renderMain());
  files.set('src/index.css', renderIndexCss());
  files.set('src/styles/tokens.css', renderTokensCss(tokens, model, dna.target.scanId));
  files.set('.gitignore', renderGitignore());

  const copies = assets.copyList();
  const placeholders = [...assets.placeholders].sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.assetId, b.assetId));
  const manifestComponents = components.components.map((plan) => ({ name: plan.name, file: plan.file, definitionId: plan.definitionId }));
  const allFiles = [...files.keys(), ...copies.map((c) => c.to), 'README.md', MANIFEST_FILE].sort();
  const manifest: GeneratedManifest = {
    scanId: dna.target.scanId,
    dnaVersion: dna.dnaVersion,
    components: manifestComponents,
    placeholders,
    mocks,
    viewports: model.slots.map((slot) => ({ width: slot.width, height: slot.state.viewport.height, breakpoint: slot.breakpoint })),
    files: allFiles,
  };
  files.set(
    'README.md',
    renderReadme({
      scanId: dna.target.scanId,
      dnaVersion: dna.dnaVersion,
      pageTitle: model.pageTitle,
      model,
      sections,
      components,
      placeholders,
      mocks,
      behavior,
      tokens,
      skipped,
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
    components: components.components.map((plan) => ({ name: plan.name, file: plan.file, definitionId: plan.definitionId, instances: plan.instances.length })),
    placeholders,
    mocks,
    install: record.install,
    build: record.build,
  });
}
