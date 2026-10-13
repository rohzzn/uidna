/**
 * Static project files (package.json, tsconfig, Vite config, index.html,
 * main.tsx, index.css), typed mocks, the README and the manifest.
 * Nothing here embeds a timestamp: two runs over the same document produce
 * byte-identical output.
 */
import type { Asset } from '@uidna/schema';
import type { PlaceholderRecord } from './assets.js';
import type { BehaviorPlan } from './behavior.js';
import type { ComponentPlanning } from './components.js';
import { commentText, jsString } from './jsx.js';
import type { GenerationModel } from './model.js';
import type { SectionPlan } from './render.js';
import type { SkippedProperty } from './tailwind-map.js';
import type { ResolvedTokens } from './tokens.js';

/** A mock recorded in the generate record. */
export interface MockRecord {
  readonly name: string;
  readonly file: string;
  readonly reason: string;
}

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
export function renderPackageJson(scanId: string): string {
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
    },
    dependencies: {
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      '@tailwindcss/vite': '^4.0.0',
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

/** tsconfig.json content. */
export function renderTsconfig(): string {
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
      types: ['vite/client'],
    },
    include: ['src', 'vite.config.ts'],
  };
  return JSON.stringify(config, null, 2) + '\n';
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
  lines.push('```');
  lines.push('');
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
  else for (const m of input.mocks) lines.push(`- \`${m.name}\` in \`${m.file}\`: ${md(m.reason)}`);
  lines.push('');
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

/** Manifest content. */
export function renderManifest(manifest: GeneratedManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}
