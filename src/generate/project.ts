/**
 * Static project files (package.json, tsconfig, Vite config, index.html,
 * main.tsx, index.css), typed mocks, the README and the manifest.
 * Nothing here embeds a timestamp: two runs over the same document produce
 * byte-identical output.
 */
import type { Asset } from '@rohzzn/uidna-schema';
import type { PlaceholderRecord } from './assets.js';
import type { BehaviorPlan, FormBehavior } from './behavior.js';
import type { ComponentPlanning } from './components.js';
import { commentText, jsString } from './jsx.js';
import type { GenerationModel } from './model.js';
import type { SectionPlan } from './render.js';
import { routeAlias, type RouterMode, type SitePlan } from './site.js';
import type { SkippedProperty } from './tailwind-map.js';
import type { BehaviorSpecSummary } from './tests.js';
import type { ResolvedTokens } from './tokens.js';

/** A mock recorded in the generate record. */
export interface MockRecord {
  readonly name: string;
  readonly file: string;
  readonly reason: string;
}

/** Name of the manifest file written to the project root (`GeneratedManifest`). */
export const MANIFEST_FILE = 'uidna.generated.json';

/** The manifest written to `uidna.generated.json`. */
export interface GeneratedManifest {
  readonly scanId: string;
  readonly dnaVersion: string;
  readonly components: readonly { readonly name: string; readonly file: string; readonly definitionId: string }[];
  readonly placeholders: readonly PlaceholderRecord[];
  readonly mocks: readonly MockRecord[];
  readonly viewports: readonly { readonly width: number; readonly height: number; readonly breakpoint: string | null }[];
  /** Every generated file (relative, forward slashes); used to remove stale files on the next run. */
  readonly files: readonly string[];
  /** How pages are wired and which page renders at which route; only the listed pages were generated (the verifier compares those). */
  readonly router: RouterMode;
  readonly pages: readonly { readonly pageId: string; readonly name: string; readonly file: string; readonly route: string }[];
  /** Behavior tests written to `tests/behavior.spec.ts`, or null when they were not requested. */
  readonly behaviorTests: BehaviorSpecSummary | null;
}

/** Project features that change the scaffolding. */
export interface ProjectFeatures {
  /** Add react-router-dom (multi-page documents). */
  readonly router: boolean;
  /** Add @playwright/test, the `test:behavior` script and the tests directory. */
  readonly behaviorTests: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** npm package name derived from the scan id. */
export function packageName(scanId: string): string {
  const cleaned = scanId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '');
  return cleaned.length > 0 ? `uidna-${cleaned}` : 'uidna-generated';
}

/** package.json content. */
export function renderPackageJson(scanId: string, features: ProjectFeatures = { router: false, behaviorTests: false }): string {
  const pkg = {
    name: packageName(scanId),
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
      typecheck: 'tsc --noEmit -p tsconfig.json',
      ...(features.behaviorTests ? { 'test:behavior': 'playwright test' } : {}),
    },
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      ...(features.router ? { 'react-router-dom': '^7.0.0' } : {}),
    },
    devDependencies: {
      ...(features.behaviorTests ? { '@playwright/test': '^1.64.0' } : {}),
      '@tailwindcss/vite': '^4.0.0',
      ...(features.behaviorTests ? { '@types/node': '^24.0.0' } : {}),
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      '@vitejs/plugin-react': '^5.0.0',
      tailwindcss: '^4.0.0',
      typescript: '^5.9.0',
      vite: '^7.0.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

/** tsconfig.json content; the tests directory and the Playwright config are type-checked too when behavior tests are written. */
export function renderTsconfig(features: ProjectFeatures = { router: false, behaviorTests: false }): string {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      forceConsistentCasingInFileNames: true,
      types: features.behaviorTests ? ['vite/client', 'node'] : ['vite/client'],
    },
    include: features.behaviorTests ? ['src', 'tests', 'vite.config.ts', 'playwright.config.ts'] : ['src', 'vite.config.ts'],
  };
  return JSON.stringify(config, null, 2) + '\n';
}

/** `src/lib/validity.ts`: the helper generated forms call to check one control. */
export function renderValidityLib(): string {
  return [
    '// Generated by UI DNA: constraint validation helper for generated forms.',
    '',
    '/**',
    ' * Validity of one control of `form`, located by its `name` or `id` (`key`) and',
    ' * otherwise by the data-uidna-path attribute the generator wrote. A radio',
    ' * group is valid when every radio reports valid; a missing control counts as',
    ' * valid so a renamed field never blocks the form.',
    ' */',
    'export function controlValidity(form: HTMLFormElement, key: string | null, path: string): boolean {',
    '  const named = key === null ? null : form.elements.namedItem(key);',
    '  const control = named ?? form.querySelector(`[data-uidna-path="${path}"]`);',
    '  if (control instanceof RadioNodeList) return Array.from(control).every((item) => !(item instanceof HTMLInputElement) || item.checkValidity());',
    '  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) return control.checkValidity();',
    '  return true;',
    '}',
    '',
  ].join('\n');
}

/** vite.config.ts content. */
export function renderViteConfig(): string {
  return ["import { defineConfig } from 'vite';", "import react from '@vitejs/plugin-react';", "import tailwindcss from '@tailwindcss/vite';", '', 'export default defineConfig({', '  plugins: [react(), tailwindcss()],', '});', ''].join('\n');
}

/** index.html content; the body carries the scanned body's own classes. */
export function renderIndexHtml(title: string, lang: string, bodyClasses: readonly string[]): string {
  const safeLang = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : 'en';
  const classAttr = bodyClasses.length > 0 ? ` class="${escapeHtml(bodyClasses.join(' '))}"` : '';
  return [
    '<!doctype html>',
    `<html lang="${safeLang}">`,
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${escapeHtml(title)}</title>`,
    '  </head>',
    `  <body${classAttr} data-uidna-path="">`,
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/** src/main.tsx content. */
export function renderMain(): string {
  return [
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { App } from './App';",
    "import './index.css';",
    '',
    "const container = document.getElementById('root');",
    'if (container) {',
    '  createRoot(container).render(',
    '    <StrictMode>',
    '      <App />',
    '    </StrictMode>,',
    '  );',
    '}',
    '',
  ].join('\n');
}

/** src/index.css content. */
export function renderIndexCss(): string {
  return ['@import "tailwindcss";', '@import "./styles/tokens.css";', ''].join('\n');
}

/** .gitignore for the generated project. */
export function renderGitignore(): string {
  return ['node_modules/', 'dist/', '.uidna/', ''].join('\n');
}

/** JSON assets become typed mocks when their content could be read; otherwise a labeled `unknown` with the reason. */
export function renderMocks(assets: readonly { asset: Asset; json: unknown; reason: string | null }[]): { code: string; mocks: MockRecord[] } | null {
  if (assets.length === 0) return null;
  const lines: string[] = ['// Generated by UI DNA: JSON responses observed during the scan, as labeled mocks. No backend is implied.', ''];
  const mocks: MockRecord[] = [];
  assets.forEach(({ asset, json, reason }, index) => {
    const n = (index + 1).toString().padStart(2, '0');
    const typeName = `Mock${n}`;
    const constName = `mock${n}`;
    // Asset url, mime and error text come from the scanned page or its responses: never let them close the comment.
    lines.push(`/** ${commentText(asset.url)} (${commentText(asset.id)}${asset.mime ? `, ${commentText(asset.mime)}` : ''}). */`);
    if (json === null) {
      lines.push(`export type ${typeName} = unknown;`);
      lines.push(`/** Content unavailable: ${commentText(reason ?? 'no local copy')}. */`);
      lines.push(`export const ${constName}: ${typeName} = null;`);
      mocks.push({ name: constName, file: 'src/mocks/data.ts', reason: reason ?? 'content unavailable' });
    } else {
      lines.push(`export type ${typeName} = ${typeOf(json, 1)};`);
      lines.push(`export const ${constName}: ${typeName} = ${JSON.stringify(json, null, 2)};`);
      mocks.push({ name: constName, file: 'src/mocks/data.ts', reason: 'JSON response observed during the scan' });
    }
    lines.push('');
  });
  return { code: lines.join('\n'), mocks };
}

function typeOf(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return first === undefined || depth > 4 ? 'unknown[]' : `${typeOf(first, depth + 1)}[]`;
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      if (depth > 4) return 'Record<string, unknown>';
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .map((key) => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : jsString(key)}: ${typeOf(record[key], depth + 1)}`);
      return entries.length === 0 ? 'Record<string, unknown>' : `{ ${entries.join('; ')} }`;
    }
    default:
      return 'unknown';
  }
}

/** Inputs of the README. */
export interface ReadmeInput {
  readonly scanId: string;
  readonly dnaVersion: string;
  readonly pageTitle: string;
  readonly model: GenerationModel;
  readonly sections: readonly SectionPlan[];
  readonly components: ComponentPlanning;
  readonly placeholders: readonly PlaceholderRecord[];
  readonly mocks: readonly MockRecord[];
  readonly behavior: BehaviorPlan;
  readonly tokens: ResolvedTokens;
  readonly skipped: readonly SkippedProperty[];
  /** Multi-page facts; absent for the single-page baseline (then the README is byte-identical to Phase 1 plus the new sections). */
  readonly site?: SitePlan;
  /** Forms with a generated onSubmit, across every file. */
  readonly forms?: readonly FormBehavior[];
  /** Behavior tests summary, or null when not written. */
  readonly behaviorTests?: BehaviorSpecSummary | null;
  /** Per-page body classes when they differ from the seed page (the body is rendered once in index.html). */
  readonly bodyClassNotes?: readonly string[];
  /** Site planning notes for the single-page layout (pages left out, derived routes); multi-page documents list them under "Pages and routes". */
  readonly siteNotes?: readonly string[];
}

/** Page-derived text for the README: one line, no table breaks, no code spans, no raw HTML. */
function md(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'").replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** README.md content. */
export function renderReadme(input: ReadmeInput): string {
  const lines: string[] = [];
  lines.push(`# ${md(input.pageTitle) || 'Generated project'}`);
  lines.push('');
  lines.push(`Generated by UI DNA from scan \`${input.scanId}\` (UI DNA ${input.dnaVersion}). React 19, TypeScript, Tailwind 4, Vite 7. No LLM was involved: every value comes from the measured document, and every name below is a placeholder for you to rename.`);
  lines.push('');
  lines.push('## Run');
  lines.push('');
  lines.push('```sh');
  lines.push('npm install');
  lines.push('npm run dev      # Vite dev server');
  lines.push('npm run build    # production build into dist/');
  lines.push('npm run typecheck');
  if (input.behaviorTests) lines.push('npm run test:behavior   # Playwright behavior tests against `vite preview` (build first)');
  lines.push('```');
  lines.push('');
  if (input.site !== undefined) lines.push(...readmePages(input.site, input.sections));
  lines.push('## Viewports and breakpoints');
  lines.push('');
  lines.push('Styles are mobile-first: the narrowest scanned viewport is the base and each wider viewport adds prefixed utilities only for the properties that differ.');
  lines.push('');
  lines.push('| Viewport | State | Breakpoint |');
  lines.push('| --- | --- | --- |');
  for (const slot of input.model.slots) lines.push(`| ${slot.width}×${slot.state.viewport.height} | \`${slot.state.id}\` | ${slot.breakpoint === null ? 'base' : `\`${slot.breakpoint}:\` (--breakpoint-${slot.breakpoint}: ${slot.width}px)`} |`);
  lines.push('');
  lines.push('## Structure');
  lines.push('');
  lines.push('| File | Contents |');
  lines.push('| --- | --- |');
  for (const section of input.sections) lines.push(`| \`${section.file}\` | ${section.roots.map((r) => `\`<${r.renderedTag}>\` at path \`${r.path}\``).join(', ')} |`);
  lines.push('');
  const notes = [...(input.siteNotes ?? []), ...(input.bodyClassNotes ?? [])];
  if (notes.length > 0) {
    for (const note of notes) lines.push(`- ${md(note)}`);
    lines.push('');
  }
  lines.push('## Components');
  lines.push('');
  if (input.components.components.length === 0) lines.push('No component definition had two or more non-nested, structurally identical instances in the narrowest base state.');
  else {
    lines.push('| Component | Generated name | Definition | File | Instances | Props | Variants |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const plan of input.components.components) {
      const props = plan.props.map((p) => `${p.name}${p.declared ? '' : ' (observed)'}`).join(', ') || '—';
      const variants = plan.variants ? `${plan.variants.ids.join(', ')}${plan.variants.declared ? '' : ' (synthesized)'}` : '—';
      lines.push(`| \`${plan.name}\` | ${md(plan.generatedName)} | \`${plan.definitionId}\` | \`${plan.file}\` | ${plan.instances.length} | ${md(props)} | ${md(variants)} |`);
    }
    for (const plan of input.components.components) for (const note of plan.notes) lines.push(`- \`${plan.name}\`: ${md(note)}`);
  }
  if (input.components.rejected.length > 0) {
    lines.push('');
    lines.push('Definitions rendered inline instead:');
    lines.push('');
    for (const r of input.components.rejected) lines.push(`- \`${r.definitionId}\` (${md(r.generatedName)}): ${md(r.reason)}`);
  }
  lines.push('');
  lines.push('## Placeholders');
  lines.push('');
  if (input.placeholders.length === 0) lines.push('No placeholders: every image was authorized and copied, and no unreproducible element was found.');
  else {
    lines.push('Assets that are not authorized (or cannot be captured) are rendered as labeled boxes with the measured size. Authorize assets with `annotate_dna` and regenerate, or replace the boxes by hand.');
    lines.push('');
    lines.push('| Kind | Asset | URL | Reason | File |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const p of input.placeholders) lines.push(`| ${md(p.kind)} | \`${md(p.assetId)}\` | ${md(p.url)} | ${md(p.reason)} | \`${p.file}\` |`);
  }
  lines.push('');
  lines.push('## Mocks');
  lines.push('');
  if (input.mocks.length === 0) lines.push('No JSON responses were observed, so no mocks were generated and no backend is implied.');
  else {
    lines.push('Each mock is a typed copy of a JSON response observed during the scan (interface inferred from the stored, redacted copy; secret-looking keys hold the literal `[redacted]`). Nothing imports them: wire them into your data layer or replace them with real requests.');
    lines.push('');
    for (const m of input.mocks) lines.push(`- \`${m.name}\` in \`${m.file}\`: ${md(m.reason)}`);
  }
  lines.push('');
  lines.push(...readmeForms(input.forms ?? []));
  lines.push('## Behavior');
  lines.push('');
  const implemented = input.behavior.reports.filter((r) => r.status === 'implemented');
  const notImplemented = input.behavior.reports.filter((r) => r.status === 'not-implemented');
  lines.push('### Implemented');
  lines.push('');
  if (implemented.length === 0) lines.push('No observed transition could be reproduced.');
  else for (const r of implemented) lines.push(`- \`${r.transitionId}\` ${md(r.action)} on ${md(r.target)} → \`${r.file ?? ''}\`: ${md(r.detail)}`);
  lines.push('');
  lines.push('### Not implemented');
  lines.push('');
  if (notImplemented.length === 0) lines.push('Every observed transition was reproduced.');
  else for (const r of notImplemented) lines.push(`- \`${r.transitionId}\` ${md(r.action)} on ${md(r.target)}: ${md(r.detail)}`);
  lines.push('');
  if (input.behaviorTests !== undefined) lines.push(...readmeBehaviorTests(input.behaviorTests));
  lines.push('## Tokens');
  lines.push('');
  lines.push('`src/styles/tokens.css` defines a Tailwind `@theme` (colors, font sizes, radii, font families, breakpoints) and `:root` reference variables (spacing, shadows). Utilities use the theme class when a measured value matches a token (`bg-color-01`) and an arbitrary value otherwise (`bg-[#2f5bea]`).');
  lines.push('');
  const families: [string, readonly { name: string; id: string; value: string | null }[]][] = [
    ['Colors', input.tokens.colors],
    ['Font sizes', input.tokens.fontSizes],
    ['Radii', input.tokens.radii],
    ['Font families', input.tokens.fontFamilies],
    ['Spacing', input.tokens.spacing],
    ['Shadows', input.tokens.shadows],
  ];
  for (const [label, family] of families) {
    if (family.length === 0) continue;
    lines.push(`- ${label}: ${family.map((t) => `\`${t.name}\` (${t.id}) = ${t.value === null ? 'unknown' : md(t.value)}`).join(', ')}`);
  }
  lines.push('');
  lines.push('## How styles were derived');
  lines.push('');
  lines.push('- Original class names are never copied. Every element gets utilities derived from its filtered computed style; properties at their default value, values the tag gets for free under Tailwind preflight, and inherited values equal to the parent are omitted.');
  lines.push('- `width`/`height` are emitted only when the measured box is evidence of an authored size: empty boxes, replaced elements, positioned elements, and boxes larger than their content. Flow-sized containers keep their size from padding, gaps, max-width and grid templates.');
  lines.push('- Own text is written before element children; the capture does not record where text sits between children.');
  lines.push('- Pseudo-element content is rendered with `before:`/`after:` utilities when it is a plain string.');
  if (input.skipped.length > 0) {
    lines.push('');
    lines.push('Properties that could not be expressed as utilities:');
    lines.push('');
    const seen = new Set<string>();
    for (const s of input.skipped) {
      const key = `${s.property}=${s.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- \`${s.property}: ${md(s.value)}\`: ${md(s.reason)}`);
    }
  }
  lines.push('');
  lines.push('## Verification');
  lines.push('');
  lines.push('Every generated element carries `data-uidna-path="<node path>"`, the structural path of the scanned node (element-child indices from `<body>`). `verify_reconstruction` matches generated elements to scanned nodes through this attribute. Component instances receive it through the `uidnaPath` prop. You may strip the attributes once you no longer verify against the scan.');
  lines.push('');
  lines.push('The manifest `uidna.generated.json` lists every generated file; regenerating overwrites those files and leaves everything else in this directory alone.');
  lines.push('');
  return lines.join('\n');
}

function readmePages(site: SitePlan, sections: readonly SectionPlan[]): string[] {
  const lines: string[] = [];
  lines.push('## Pages and routes');
  lines.push('');
  if (site.router === 'react-router') {
    lines.push(`\`src/App.tsx\` wraps the pages in a \`<BrowserRouter>\`; each page is a component under \`src/pages/\` rendered at the route pattern the scan recorded (\`react-router-dom\` 7). The Vite dev server serves \`index.html\` for every route (history fallback), and \`verify_reconstruction\` serves \`dist/\` the same way; configure the same fallback on your own host. Each page sets \`document.title\` to the title the scan recorded.`);
  } else {
    lines.push('Single-page layout: the page is split into landmark sections under `src/sections/` and `src/App.tsx` renders them in order.');
  }
  lines.push('');
  lines.push('| Page | URL | Route | Component | Layout | Base states |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const patterns = new Set(site.pages.map((p) => p.route));
  for (const page of site.pages) {
    const alias = routeAlias(page.route);
    const aliasNote = alias !== null && !patterns.has(alias) ? ` (also \`${md(alias)}\` for hosts that drop the extension)` : '';
    const route = (page.routeSource === 'document' ? `\`${md(page.route)}\`` : `\`${md(page.route)}\` (from the page URL; no route was recorded)`) + aliasNote;
    lines.push(`| \`${page.page.id}\` | ${md(page.page.url)} | ${route} | \`${page.file}\` | ${page.layout === null ? '—' : `\`${page.layout.name}\``} | ${page.model.slots.map((s) => `\`${s.state.id}\` (${s.width}px)`).join(', ')} |`);
  }
  lines.push('');
  if (site.layouts.length > 0) {
    lines.push('### Shared layout');
    lines.push('');
    for (const layout of site.layouts) {
      const parts: string[] = [];
      if (layout.header) parts.push(`the header (\`${layout.headerFile}\`)`);
      if (layout.footer) parts.push(`the footer (\`${layout.footerFile}\`)`);
      lines.push(`- \`${layout.name}\` (\`${layout.file}\`, document layout \`${layout.id}\`) renders ${parts.join(' and ')} of page \`${layout.sourcePageId}\` around an \`<Outlet />\` for pages ${layout.pageIds.map((id) => `\`${id}\``).join(', ')}. The other pages' own header and footer nodes are not rendered; differences between them (for example \`aria-current\` on the active link) are not reproduced.`);
    }
    lines.push('');
  }
  if (site.router === 'react-router') {
    lines.push('Same-origin links whose target is a generated page render as `<Link to="<route>">` (sections, pages, and components where every instance resolves); other links stay `<a href>`.');
    lines.push('');
  }
  const pageSections = sections.filter((s) => s.kind === 'page');
  if (pageSections.length > 0) {
    lines.push('| Page component | Own content |');
    lines.push('| --- | --- |');
    for (const section of pageSections) lines.push(`| \`${section.file}\` | ${section.roots.map((r) => `\`<${r.renderedTag}>\` at path \`${r.path}\``).join(', ') || 'none (everything is in the shared layout)'} |`);
    lines.push('');
  }
  for (const note of site.notes) lines.push(`- ${md(note)}`);
  if (site.notes.length > 0) lines.push('');
  return lines;
}

function readmeForms(forms: readonly FormBehavior[]): string[] {
  const lines: string[] = [];
  lines.push('## Forms');
  lines.push('');
  if (forms.length === 0) {
    lines.push('No submit transition was recorded, so no form has a generated `onSubmit`; form controls are rendered uncontrolled with their captured constraint attributes.');
    lines.push('');
    return lines;
  }
  lines.push('Forms keep their original controls (type, name, required, minLength/maxLength, pattern, min/max/step, placeholder, autocomplete, aria-*). A submit transition becomes a controlled `onSubmit` that prevents the default, runs `checkValidity()` per control (`src/lib/validity.ts`) and toggles the validation messages the scan observed; fills need no code because the controls stay uncontrolled. No request is ever made: the handler ends where your API call belongs.');
  lines.push('');
  for (const form of forms) {
    const noValidate = form.noValidate === 'captured' ? 'noValidate as captured' : form.noValidate === 'implied' ? 'noValidate set by the generator because the page showed its own messages' : 'native validation bubbles';
    lines.push(`- ${md(form.describe)} (${form.transitionIds.map((id) => `\`${id}\``).join(', ')}): \`${form.handler}\`, ${noValidate}.`);
    for (const control of form.controls) {
      const messages = control.messages.length > 0 ? control.messages.map((m) => `"${md(m)}"`).join(', ') : 'no message text (attributes only)';
      lines.push(`  - \`${control.state.name}\`: ${md(control.describe)} → ${messages}${control.nativeMessage === null ? '' : ` (browser message during the scan: "${md(control.nativeMessage)}")`}`);
    }
    if (form.invalid !== null) lines.push(`  - \`${form.invalid.name}\`: form-level changes while any control is invalid`);
    if (form.submitted !== null) lines.push(`  - \`${form.submitted.name}\`: changes observed after a valid submit (status message); backend call not reproduced`);
  }
  lines.push('');
  return lines;
}

function readmeBehaviorTests(summary: BehaviorSpecSummary | null): string[] {
  const lines: string[] = [];
  lines.push('### Behavior tests');
  lines.push('');
  if (summary === null) {
    lines.push('Behavior tests were not requested (`behaviorTests: false`).');
    lines.push('');
    return lines;
  }
  const unreproduced = summary.skipped - summary.notReplayed.length;
  const skips = [
    unreproduced > 0 ? `${unreproduced} that the generator did not reproduce` : null,
    summary.notReplayed.length > 0
      ? `${summary.notReplayed.map((id) => `\`${id}\``).join(', ')}, which caused a side effect when ${summary.notReplayed.length === 1 ? 'it was' : 'they were'} observed and ${summary.notReplayed.length === 1 ? 'is' : 'are'} never replayed`
      : null,
  ].filter((part) => part !== null);
  lines.push(`\`tests/behavior.spec.ts\` replays ${summary.tests} implemented transition${summary.tests === 1 ? '' : 's'} with Playwright (one test per target, action and viewport${summary.deduplicated.length > 0 ? `; ${summary.deduplicated.map((id) => `\`${id}\``).join(', ')} share a test with an earlier transition` : ''})${skips.length > 0 ? ` and skips ${skips.join(' and ')}, each with its reason` : ''}. Targets are located by role and exact accessible name, then by \`data-uidna-path\`; assertions cover the observed attribute, visibility, text, value and URL deltas.`);
  lines.push('');
  lines.push('```sh');
  lines.push('npx playwright install chromium   # once');
  lines.push('npm run build');
  lines.push('npm run test:behavior             # PORT=… or BASE_URL=… to point at another server');
  lines.push('```');
  lines.push('');
  return lines;
}

/** Manifest content. */
export function renderManifest(manifest: GeneratedManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
