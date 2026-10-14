import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, inferred, validateUiDna, type UiDnaDocument, type UiNode } from '@rohzzn/uidna-schema';
import type { GenerateRecord } from '../application/records.js';
import { fixedClock } from '../domain/clock.js';
import { unwrap } from '../domain/result.js';
import { generateProject, MANIFEST_FILE } from './index.js';
import { breakpointNames, buildModel } from './model.js';
import { FIXTURE_CAPTURED_AT, FIXTURE_PATHS, FIXTURE_SCAN_ID, fixtureDocument } from './testing.js';

const ROOT = join(process.cwd(), 'tests', '.tmp', 'generate-unit');
const SCAN_DIR = join(ROOT, 'scan');

async function generate(dna: UiDnaDocument, outDir: string): Promise<GenerateRecord> {
  return unwrap(await generateProject({ dna, scanDir: SCAN_DIR, outDir, install: false, build: false, clock: fixedClock('2026-10-13T17:30:00.000Z'), evidenceId: 'ev_000000000010' }), 'generateProject');
}

async function read(dir: string, file: string): Promise<string> {
  return readFile(join(dir, file), 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('synthetic document', () => {
  it('validates against the schema', () => {
    const validation = validateUiDna(fixtureDocument());
    expect(formatIssues(validation)).toEqual([]);
    expect(validation.success).toBe(true);
  });

  it('has the Fixture A structure at two viewports with matching paths', () => {
    const doc = fixtureDocument();
    const [mobile, desktop] = doc.states.items;
    expect(mobile?.viewport.width).toBe(390);
    expect(desktop?.viewport.width).toBe(1280);
    const paths = (state: typeof mobile): string[] => (state?.nodes ?? []).map((n) => n.path);
    expect(paths(mobile)).toEqual(paths(desktop));
    const menu = mobile?.nodes.find((n) => n.path === FIXTURE_PATHS.menu);
    expect(menu?.box).toBeNull();
    expect(desktop?.nodes.find((n) => n.path === FIXTURE_PATHS.menu)?.box).not.toBeNull();
  });
});

describe('model', () => {
  it('names breakpoints from the second-narrowest width', () => {
    expect(breakpointNames(0)).toEqual([]);
    expect(breakpointNames(1)).toEqual(['md']);
    expect(breakpointNames(2)).toEqual(['md', 'lg']);
    expect(breakpointNames(3)).toEqual(['sm', 'md', 'lg']);
    expect(breakpointNames(5)).toEqual(['sm', 'md', 'lg', 'xl', '2xl']);
  });

  it('sorts base states by width and matches nodes by path', () => {
    const model = unwrap(buildModel(fixtureDocument()));
    expect(model.slots.map((s) => [s.width, s.breakpoint])).toEqual([
      [390, null],
      [1280, 'md'],
    ]);
    const toggle = model.byPath.get(FIXTURE_PATHS.toggle);
    expect(toggle?.perViewport.map((n) => n?.box === null)).toEqual([false, true]);
    expect(model.byPath.get('3')?.kind).toBe('skipped');
  });
});

describe('generateProject', () => {
  const outDir = join(ROOT, 'project');
  let record: GenerateRecord;

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(SCAN_DIR, { recursive: true });
    record = await generate(fixtureDocument(), outDir);
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('writes the expected files and records them', async () => {
    const expected = [
      '.gitignore',
      'README.md',
      'index.html',
      'package.json',
      'src/App.tsx',
      'src/components/Component01.tsx',
      'src/components/NavItem.tsx',
      'src/index.css',
      'src/main.tsx',
      'src/sections/Footer.tsx',
      'src/sections/Header.tsx',
      'src/sections/Main.tsx',
      'src/styles/tokens.css',
      'tsconfig.json',
      MANIFEST_FILE,
      'vite.config.ts',
    ];
    expect(record.files).toEqual(expected);
    for (const file of expected) expect(await exists(join(outDir, file)), file).toBe(true);
    expect(record.scanId).toBe(FIXTURE_SCAN_ID);
    expect(record.install).toEqual({ attempted: false, ok: null, logPath: null, durationMs: 0 });
    expect(record.build.attempted).toBe(false);
  });

  it('writes a manifest with components, placeholders, mocks and viewports and no timestamp', async () => {
    const manifest = JSON.parse(await read(outDir, MANIFEST_FILE)) as Record<string, unknown>;
    expect(manifest.scanId).toBe(FIXTURE_SCAN_ID);
    expect(manifest.dnaVersion).toBe('0.1.0');
    expect(manifest.components).toEqual([
      { name: 'Component01', file: 'src/components/Component01.tsx', definitionId: 'cmp_01' },
      { name: 'NavItem', file: 'src/components/NavItem.tsx', definitionId: 'cmp_02' },
    ]);
    expect(manifest.viewports).toEqual([
      { width: 390, height: 844, breakpoint: null },
      { width: 1280, height: 800, breakpoint: 'md' },
    ]);
    expect(manifest.mocks).toEqual([]);
    expect(JSON.stringify(manifest)).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it('is byte-identical across two runs', async () => {
    const second = join(ROOT, 'project-2');
    await generate(fixtureDocument(), second);
    for (const file of record.files) {
      expect(await read(second, file), file).toBe(await read(outDir, file));
    }
    await rm(second, { recursive: true, force: true });
  });

  it('keeps semantic tags, writes data-uidna-path on every element and never copies class names', async () => {
    const header = await read(outDir, 'src/sections/Header.tsx');
    const main = await read(outDir, 'src/sections/Main.tsx');
    const footer = await read(outDir, 'src/sections/Footer.tsx');
    for (const tag of ['<header', '<nav', '<button', '<ul']) expect(header).toContain(tag);
    for (const tag of ['<main', '<section', '<h1', '<h2', '<p', '<a', '<figure', '<details', '<summary']) expect(main).toContain(tag);
    expect(footer).toContain('<footer');
    const all = header + main + footer;
    expect(all).not.toContain('<script');
    for (const path of [FIXTURE_PATHS.header, FIXTURE_PATHS.nav, FIXTURE_PATHS.toggle, FIXTURE_PATHS.menu, FIXTURE_PATHS.hero, FIXTURE_PATHS.footer]) {
      expect(all).toContain(`data-uidna-path="${path}"`);
    }
    const classNames = [...all.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map((m) => m[1] ?? m[2] ?? '');
    expect(classNames.length).toBeGreaterThan(10);
    for (const original of ['site-header', 'navbar', 'nav-toggle', 'nav-menu', 'hero', 'card', 'accordion-item', 'footer-inner']) {
      for (const cls of classNames) expect(cls.split(' ')).not.toContain(original);
    }
    for (const cls of classNames) expect(cls.split(' ')).toEqual([...new Set(cls.split(' '))]);
  });

  it('derives mobile-first utilities with breakpoint variants only for differing properties', async () => {
    const main = await read(outDir, 'src/sections/Main.tsx');
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(main).toContain('grid-cols-1 items-center max-w-[1120px] px-[16px] py-[48px] md:gap-[48px] md:grid-cols-2');
    expect(main).toContain('text-[32px] tracking-[-0.64px] md:leading-[52.8px] md:text-[48px]');
    expect(header).toContain('w-[40px] md:hidden');
    expect(header).toContain('md:static');
    expect(header).toContain('md:flex');
    expect(main).toContain('text-color-03 text-size-01');
    expect(main).toContain('rounded-radius-01');
    expect(main).not.toContain('<figure className');
  });

  it('wires the hamburger toggle as React state with aria attributes and conditional classes', async () => {
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(header).toContain("import { useEffect, useState } from 'react';");
    expect(header).toContain('const [state01, setState01] = useState(false);');
    expect(header).toContain('aria-expanded={state01 ? "true" : "false"}');
    expect(header).toContain('aria-label={state01 ? "Close menu" : "Open menu"}');
    expect(header).toContain('onClick={() => setState01((value) => !value)}');
    expect(header).toContain('${state01 ? "flex" : "hidden"}');
    expect(header).toContain("if (event.key === 'Escape') setState01(false);");
  });

  it('uses controlled <details> for the accordion and hover variants for the nav link', async () => {
    const main = await read(outDir, 'src/sections/Main.tsx');
    expect(main).toContain('open={state02} onToggle={(event) => setState02(event.currentTarget.open)}');
    expect(main).toMatch(/<details className="[^"]*(?:^| )group(?: |")/);
    expect(main).toContain("group-open:after:content-['−']");
    const navItem = await read(outDir, 'src/components/NavItem.tsx');
    expect(navItem).toContain('hover:text-color-02');
  });

  it('emits a component for the cards with props, synthesized variants and three usages', async () => {
    const component = await read(outDir, 'src/components/Component01.tsx');
    expect(component).toContain('export function Component01({ uidnaPath, title, body, variant = "variant01" }: Component01Props)');
    expect(component).toContain('<article');
    expect(component).toContain('{title}');
    expect(component).toContain('{body}');
    expect(component).toContain('data-uidna-path={`${uidnaPath}/1`}');
    expect(component).toContain('"variant02": { p0: "bg-[#1f9d6a]" }');
    const main = await read(outDir, 'src/sections/Main.tsx');
    expect(main.match(/<Component01 /g)).toHaveLength(3);
    expect(main).toContain('<Component01 uidnaPath="1/1/1/1" title={"Link naturally"}');
    expect(record.components).toEqual([
      { name: 'Component01', file: 'src/components/Component01.tsx', definitionId: 'cmp_01', instances: 3 },
      { name: 'NavItem', file: 'src/components/NavItem.tsx', definitionId: 'cmp_02', instances: 4 },
    ]);
  });

  it('uses declared link props and declared variant ids for the nav items', async () => {
    const navItem = await read(outDir, 'src/components/NavItem.tsx');
    expect(navItem).toContain('export type NavItemVariant = "var_01" | "var_02";');
    expect(navItem).toContain('link: { href: string; label: string };');
    expect(navItem).toContain('href={link.href}');
    expect(navItem).toContain('{link.label}');
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(header).toContain('<NavItem uidnaPath="0/0/2/3" link={{ href: "#start", label: "Get started" }} variant="var_02" />');
  });

  it('renders the unauthorized image as a labeled placeholder and records it', async () => {
    const main = await read(outDir, 'src/sections/Main.tsx');
    expect(main).toContain('data-placeholder="asset:asset_01"');
    expect(main).toContain('className="aspect-[520/400] bg-[#e5e7eb] flex items-center justify-center max-w-none overflow-hidden rounded-radius-01 text-[#6b7280] text-[12px] w-full"');
    expect(main).toContain('role="img"');
    expect(main).toContain('aria-label="Abstract illustration of connected notes"');
    expect(main).toContain('Placeholder: image not authorized (asset_01)');
    expect(main).not.toContain('<img');
    expect(record.placeholders).toEqual([
      {
        kind: 'image',
        assetId: 'asset_01',
        url: 'http://127.0.0.1:4173/assets/illustration.svg',
        reason: 'asset authorization is unknown (authorize it with annotate_dna to copy it)',
        file: 'src/sections/Main.tsx',
      },
    ]);
  });

  it('writes tokens.css with a @theme block, breakpoints and :root reference variables', async () => {
    const css = await read(outDir, 'src/styles/tokens.css');
    expect(css).toContain('@theme {');
    expect(css).toContain('--breakpoint-*: initial;');
    expect(css).toContain('--breakpoint-md: 1280px;');
    expect(css).toContain('--color-brand: #2f5bea;');
    expect(css).toContain('--color-color-02: #1b1f2a;');
    expect(css).toContain('--text-size-01: 16px;');
    expect(css).toContain('--radius-radius-01: 12px;');
    expect(css).toContain('--font-font-01: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;');
    expect(css).toContain('/* color-02 (tok_color_02): 14 samples, measured */');
    expect(css).toContain(':root {');
    expect(css).toContain('--space-01: 16px;');
    expect(css).toContain('--shadow-01: rgba(27, 31, 42, 0.08) 0px 8px 24px 0px;');
    expect(await read(outDir, 'src/index.css')).toBe('@import "tailwindcss";\n@import "./styles/tokens.css";\n');
  });

  it('writes the project scaffolding', async () => {
    const pkg = JSON.parse(await read(outDir, 'package.json')) as { name: string; private: boolean; type: string; dependencies: Record<string, string>; devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.name).toBe(`uidna-${FIXTURE_SCAN_ID}`);
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies.react).toMatch(/^\^19/);
    expect(pkg.devDependencies.vite).toMatch(/^\^7/);
    expect(pkg.devDependencies.tailwindcss).toMatch(/^\^4/);
    expect(pkg.scripts.build).toBe('vite build');
    const html = await read(outDir, 'index.html');
    expect(html).toContain('<title>Lumen — Notes that think with you</title>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<body class="bg-[#ffffff] font-font-01 font-normal leading-[24px] text-color-02 text-size-01" data-uidna-path="">');
    const app = await read(outDir, 'src/App.tsx');
    expect(app).toContain('<Header />');
    expect(app).toContain('<Main />');
    expect(app).toContain('<Footer />');
    expect(await read(outDir, 'vite.config.ts')).toContain('plugins: [react(), tailwindcss()]');
  });

  it('documents components, placeholders, behaviors and the verification aid in the README', async () => {
    const readme = await read(outDir, 'README.md');
    expect(readme).toContain('| `Component01` | Component01 | `cmp_01` | `src/components/Component01.tsx` | 3 |');
    expect(readme).toContain('| `NavItem` | Component02 | `cmp_02` | `src/components/NavItem.tsx` | 4 |');
    expect(readme).toContain('| image | `asset_01` | http://127.0.0.1:4173/assets/illustration.svg |');
    expect(readme).toContain('### Implemented');
    expect(readme).toContain('`tr_01` click on button "Open menu" at 0/0/1');
    expect(readme).toContain('`tr_03` click on button "Is there a free plan?"');
    expect(readme).toContain('`tr_04` hover on link "Features"');
    expect(readme).toContain('Escape resets it (tr_02)');
    expect(readme).toContain('data-uidna-path');
    expect(readme).toContain('No JSON responses were observed');
  });

  it('overwrites generated files, removes stale generated files and leaves other files alone', async () => {
    const keep = join(outDir, 'notes.txt');
    await writeFile(keep, 'mine', 'utf8');
    const stale = join(outDir, 'src', 'components', 'Old.tsx');
    await writeFile(stale, 'export const Old = 1;', 'utf8');
    const manifest = JSON.parse(await read(outDir, MANIFEST_FILE)) as { files: string[] };
    manifest.files.push('src/components/Old.tsx');
    await writeFile(join(outDir, MANIFEST_FILE), JSON.stringify(manifest), 'utf8');
    await writeFile(join(outDir, 'src', 'App.tsx'), '// tampered', 'utf8');
    await generate(fixtureDocument(), outDir);
    expect(await read(outDir, 'notes.txt')).toBe('mine');
    expect(await exists(stale)).toBe(false);
    expect(await read(outDir, 'src/App.tsx')).toContain('export function App()');
  });
});

describe('generateProject with authorized assets and json mocks', () => {
  const outDir = join(ROOT, 'authorized');

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('copies authorized assets into public/assets and renders a real <img>; json assets become typed mocks', async () => {
    await mkdir(join(SCAN_DIR, 'assets'), { recursive: true });
    await writeFile(join(SCAN_DIR, 'assets', 'abc.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
    await writeFile(join(SCAN_DIR, 'assets', 'def.json'), JSON.stringify({ items: [{ id: 1, name: 'one' }], total: 1 }), 'utf8');
    const dna = fixtureDocument();
    const image = dna.assets[0];
    if (image === undefined) throw new Error('fixture has no asset');
    dna.assets = [
      { ...image, authorization: 'authorized', localPath: 'assets/abc.svg' },
      {
        id: 'asset_02',
        kind: 'other',
        url: 'http://127.0.0.1:4173/api/items.json',
        origin: 'same-origin',
        mime: 'application/json',
        localPath: 'assets/def.json',
        authorization: 'unknown',
        usage: [],
        provenance: image.provenance,
      },
    ];
    const record = await generate(dna, outDir);
    expect(record.files).toContain('public/assets/abc.svg');
    expect(await read(outDir, 'public/assets/abc.svg')).toContain('<svg');
    const main = await read(outDir, 'src/sections/Main.tsx');
    expect(main).toContain('<img className="aspect-[520/400] max-w-none rounded-radius-01 w-full" alt="Abstract illustration of connected notes" height="400" src="/assets/abc.svg" width="520" data-uidna-path="1/0/1/0" />');
    expect(record.placeholders).toEqual([]);
    expect(record.mocks).toEqual([{ name: 'mock01', file: 'src/mocks/data.ts', reason: 'JSON response observed during the scan' }]);
    const mocks = await read(outDir, 'src/mocks/data.ts');
    expect(mocks).toContain('export type Mock01 = { items: { id: number; name: string }[]; total: number };');
    expect(mocks).toContain('export const mock01: Mock01 = {');
  });

  it('handles a single-viewport document without breakpoints and reports unusable definitions', async () => {
    const dna = fixtureDocument();
    const mobile = dna.states.items[0];
    if (mobile === undefined) throw new Error('fixture has no state');
    dna.states.items = [mobile];
    dna.states.transitions = [];
    dna.app.pages = dna.app.pages.map((page) => ({ ...page, stateIds: [mobile.id] }));
    dna.components.instances = dna.components.instances.filter((inst) => inst.stateId === mobile.id);
    dna.assets = dna.assets.map((asset) => ({ ...asset, usage: asset.usage.filter((u) => u.stateId === mobile.id) }));
    // Declare the card definition with a single instance to make it ineligible.
    dna.components.definitions = dna.components.definitions.map((def) => (def.id === 'cmp_01' ? { ...def, instanceCount: 1 } : def));
    const single = join(ROOT, 'single');
    const record = await generate(dna, single);
    expect(record.components.map((c) => c.name)).toEqual(['NavItem']);
    const css = await read(single, 'src/styles/tokens.css');
    expect(css).toContain('--breakpoint-*: initial;');
    expect(css).not.toContain('--breakpoint-md');
    const main = await read(single, 'src/sections/Main.tsx');
    expect(main).toContain('<article');
    expect(main).not.toContain('md:');
    const readme = await read(single, 'README.md');
    expect(readme).toContain('`cmp_01` (Component01): fewer than two instances');
    expect(readme).toContain('No observed transition could be reproduced.');
  });

  it('stops with a cancelled error when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await generateProject({ dna: fixtureDocument(), scanDir: SCAN_DIR, outDir: join(ROOT, 'cancelled'), install: false, build: false, evidenceId: 'ev_000000000012', signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe('cancelled');
    expect(await exists(join(ROOT, 'cancelled'))).toBe(false);
  });

  it('rejects an invalid document without writing', async () => {
    const dna = fixtureDocument();
    dna.states.items = [];
    const result = await generateProject({ dna, scanDir: SCAN_DIR, outDir: join(ROOT, 'invalid'), install: false, build: false, evidenceId: 'ev_000000000011' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe('validation');
    expect(await exists(join(ROOT, 'invalid'))).toBe(false);
  });
});

describe('generateProject hardening', () => {
  const root = join(ROOT, 'hardening');

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  function editNode(dna: UiDnaDocument, path: string, edit: (node: UiNode) => UiNode): void {
    for (const state of dna.states.items) state.nodes = state.nodes.map((node) => (node.path === path ? edit(node) : node));
  }

  it('never lets page content close a generated comment', async () => {
    await mkdir(join(SCAN_DIR, 'assets'), { recursive: true });
    await writeFile(join(SCAN_DIR, 'assets', 'evil.json'), '*/ not json', 'utf8');
    const dna = fixtureDocument();
    const image = dna.assets[0];
    if (image === undefined) throw new Error('fixture has no asset');
    dna.assets = [
      image,
      { id: 'asset_02', kind: 'other', url: 'http://127.0.0.1:4173/api/*/items.json', origin: 'same-origin', mime: 'application/json; x=*/', localPath: 'assets/evil.json', authorization: 'unknown', usage: [], provenance: image.provenance },
    ];
    const first = dna.states.transitions[0];
    if (first?.action.target === undefined || first.action.target === null) throw new Error('fixture has no transition target');
    first.action.target = { ...first.action.target, name: 'Open menu\n  alert(1); //' };
    const outDir = join(root, 'comments');
    await generate(dna, outDir);
    const mocks = await read(outDir, 'src/mocks/data.ts');
    expect(mocks).not.toContain('api/*/');
    expect(mocks).toContain('/** http://127.0.0.1:4173/api/* /items.json (asset_02, application/json; x=* /). */');
    for (const line of mocks.split('\n')) if (line.startsWith('/**')) expect(line.indexOf('*/'), line).toBe(line.length - 2);
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(header).toContain('// click on button "Open menu   alert(1); //" at 0/0/1 (tr_01)');
    expect(header).not.toContain('\n  alert(1)');
  });

  it('turns differing <img> src/alt inside component instances into an image prop and never writes the raw page src', async () => {
    const dna = fixtureDocument();
    FIXTURE_PATHS.cards.forEach((card, i) => {
      editNode(dna, `${card}/0`, (node) => ({ ...node, tag: 'img', attrs: { src: `https://cdn.example/icon-${i}.png`, alt: `Icon ${i + 1}` } }));
    });
    const outDir = join(root, 'images');
    const record = await generate(dna, outDir);
    const component = await read(outDir, 'src/components/Component01.tsx');
    expect(component).toContain('image01: { src: string; alt: string };');
    expect(component).toContain('aria-label={image01.alt}');
    expect(component).not.toContain('src01');
    expect(component).not.toContain('cdn.example');
    const main = await read(outDir, 'src/sections/Main.tsx');
    expect(main).toContain('image01={{ src: "", alt: "Icon 2" }}');
    expect(main).not.toContain('cdn.example');
    // The component's primary icon (no asset record) and the hero image (not authorized) are the only placeholders.
    expect(record.placeholders.map((p) => [p.assetId, p.file])).toEqual([
      [`missing:${FIXTURE_PATHS.cards[0]}/0`, 'src/components/Component01.tsx'],
      ['asset_01', 'src/sections/Main.tsx'],
    ]);
  });

  it('keeps a placeholder hidden where the scanned element was hidden', async () => {
    const dna = fixtureDocument();
    // Hide the hero image in every 390px state (base and derived) so the only difference is the viewport.
    for (const state of dna.states.items) {
      if (state.viewport.width !== 390) continue;
      const img = state.nodes.find((n) => n.path === FIXTURE_PATHS.heroImage);
      if (img === undefined) throw new Error(`fixture state ${state.id} has no hero image`);
      state.styles.hidden = { ...(state.styles[img.styleId] ?? {}), display: 'none' };
      state.nodes = state.nodes.map((n) => (n.path === FIXTURE_PATHS.heroImage ? { ...n, box: null, visible: false, styleId: 'hidden' } : n));
    }
    const outDir = join(root, 'hidden-placeholder');
    await generate(dna, outDir);
    const main = await read(outDir, 'src/sections/Main.tsx');
    const match = /className="([^"]*)" aria-label="Abstract illustration of connected notes" data-placeholder="asset:asset_01"/.exec(main);
    const classes = match?.[1]?.split(' ') ?? [];
    expect(classes).toContain('hidden');
    expect(classes).toContain('md:flex');
    expect(classes).not.toContain('flex');
    expect(classes).not.toContain('md:block');
  });

  it('keeps <option value>, writes <textarea> text as defaultValue and drops a non-numeric tabindex', async () => {
    const dna = fixtureDocument();
    editNode(dna, '2/0/0', (node) => ({ ...node, tag: 'option', attrs: { value: 'lumen' } }));
    editNode(dna, '2/0/2', (node) => ({ ...node, tag: 'textarea' }));
    editNode(dna, FIXTURE_PATHS.brand, (node) => ({ ...node, attrs: { ...node.attrs, tabindex: 'abc' } }));
    editNode(dna, FIXTURE_PATHS.toggle, (node) => ({ ...node, attrs: { ...node.attrs, tabindex: '-1' } }));
    const outDir = join(root, 'form-controls');
    await generate(dna, outDir);
    const footer = await read(outDir, 'src/sections/Footer.tsx');
    expect(footer).toMatch(/<option [^>]*value="lumen" data-uidna-path="2\/0\/0">Lumen<\/option>/);
    expect(footer).not.toContain('defaultValue="lumen"');
    expect(footer).toMatch(/<textarea [^>]*defaultValue="Fixture A for UI DNA\. No real product\." data-uidna-path="2\/0\/2" \/>/);
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(header).toContain('tabIndex={-1}');
    expect(header).not.toContain('tabIndex={0}');
  });

  it('keeps component file names unique on case-folding file systems', async () => {
    const dna = fixtureDocument();
    dna.components.definitions = dna.components.definitions.map((def) => ({ ...def, name: inferred(def.id === 'cmp_01' ? 'navitem' : 'nav item', { capturedAt: FIXTURE_CAPTURED_AT }, 0.8) }));
    const outDir = join(root, 'names');
    const record = await generate(dna, outDir);
    expect(record.components.map((c) => c.name)).toEqual(['Navitem', 'NavItem2']);
    expect(record.files.filter((f) => f.startsWith('src/components/'))).toEqual(['src/components/NavItem2.tsx', 'src/components/Navitem.tsx']);
  });
});
