import { UI_DNA_VERSION } from 'uidna-schema';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatIssues, inferred, validateUiDna, type UiDnaDocument, type UiNode } from 'uidna-schema';
import type { GenerateRecord } from '../application/records.js';
import { fixedClock } from '../domain/clock.js';
import { unwrap } from '../domain/result.js';
import type { BehaviorReport, TestStep, TransitionTest } from './behavior.js';
import { generateProject, MANIFEST_FILE } from './index.js';
import { redactJson } from './mocks.js';
import { breakpointNames, buildModel } from './model.js';
import { renderBehaviorSpec } from './tests.js';
import { FIXTURE_CAPTURED_AT, FIXTURE_FORM_URL, FIXTURE_MULTI_SCAN_ID, FIXTURE_PATHS, FIXTURE_SCAN_ID, fixtureDocument, MULTI_PATHS, multiPageFormDocument } from './testing.js';

const ROOT = join(process.cwd(), 'tests', '.tmp', 'generate-unit');
const SCAN_DIR = join(ROOT, 'scan');

async function generate(dna: UiDnaDocument, outDir: string, options: { router?: 'none' | 'react-router'; behaviorTests?: boolean } = {}): Promise<GenerateRecord> {
  return unwrap(await generateProject({ dna, scanDir: SCAN_DIR, outDir, install: false, build: false, clock: fixedClock('2026-10-13T17:30:00.000Z'), evidenceId: 'ev_000000000010', ...options }), 'generateProject');
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
      'playwright.config.ts',
      'src/App.tsx',
      'src/components/Component01.tsx',
      'src/components/NavItem.tsx',
      'src/index.css',
      'src/main.tsx',
      'src/sections/Footer.tsx',
      'src/sections/Header.tsx',
      'src/sections/Main.tsx',
      'src/styles/tokens.css',
      'tests/behavior.spec.ts',
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
    expect(manifest.dnaVersion).toBe(UI_DNA_VERSION);
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
    expect(pkg.scripts['test:behavior']).toBe('playwright test');
    expect(pkg.devDependencies['@playwright/test']).toMatch(/^\^1\.64/);
    expect(pkg.dependencies['react-router-dom']).toBeUndefined();
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

  it('writes Playwright behavior tests for the single page: one test per implemented transition, Escape reverts, skips with reasons', async () => {
    const config = await read(outDir, 'playwright.config.ts');
    expect(config).toContain("testDir: 'tests'");
    expect(config).toContain('process.env.PORT ?? 4173');
    expect(config).toContain('npm run preview -- --host 127.0.0.1 --port ${port} --strictPort');
    expect(config).toContain('reuseExistingServer: true');
    const spec = await read(outDir, 'tests/behavior.spec.ts');
    expect(spec).toContain("import { expect, test, type Locator, type Page } from '@playwright/test';");
    expect(spec).toContain('test("tr_01: click button \\"Open menu\\" at 0/0/1 (390×844)", async ({ page }) => {');
    expect(spec).toContain('await page.setViewportSize({ width: 390, height: 844 });');
    expect(spec).toContain('await page.goto("/");');
    expect(spec).toContain('const target = await locate(page, "button", "Open menu", 0, "0/0/1");');
    expect(spec).toContain('await target.click();');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"0/0/1\\"]")).toHaveAttribute("aria-expanded", "true");');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"0/0/2\\"]")).toBeVisible();');
    expect(spec).toContain('const reverted = page.locator("[data-uidna-path=\\"0/0/1\\"]");\n    await reverted.press("Escape");');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"0/0/2\\"]")).toBeHidden();');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"1/2/1/0\\"]")).toHaveAttribute("open", "");');
    expect(spec).toContain('await target.hover();');
    expect(spec).not.toContain('test.skip(');
    const tsconfig = JSON.parse(await read(outDir, 'tsconfig.json')) as { include: string[]; compilerOptions: { types: string[] } };
    expect(tsconfig.include).toEqual(['src', 'tests', 'vite.config.ts', 'playwright.config.ts']);
    expect(tsconfig.compilerOptions.types).toEqual(['vite/client', 'node']);
    const manifest = JSON.parse(await read(outDir, MANIFEST_FILE)) as { router: string; pages: unknown[]; behaviorTests: { tests: number; skipped: number; deduplicated: string[] } };
    expect(manifest.router).toBe('none');
    expect(manifest.pages).toEqual([{ pageId: 'pg_01', name: 'Main', file: 'src/sections/Main.tsx', route: '/' }]);
    expect(manifest.behaviorTests).toEqual({ tests: 3, skipped: 0, deduplicated: [], notReplayed: [] });
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
    expect(readme).toContain('No submit transition was recorded');
    expect(readme).toContain('`tests/behavior.spec.ts` replays 3 implemented transitions');
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

describe('multi-page document with a validated form, a data asset and behavior tests', () => {
  const outDir = join(ROOT, 'multi');
  let record: GenerateRecord;

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(join(SCAN_DIR, 'assets'), { recursive: true });
    await writeFile(
      join(SCAN_DIR, 'assets', 'items.json'),
      JSON.stringify({ items: [{ id: 1, title: 'Reading list', updated: 'Today', links: 4, token: '[redacted]' }, { id: 2, title: 'Interview notes', updated: 'Yesterday', links: 7, tags: ['work'] }], total: 2 }),
      'utf8',
    );
    record = await generate(multiPageFormDocument(), outDir);
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('validates against the schema', () => {
    const validation = validateUiDna(multiPageFormDocument());
    expect(formatIssues(validation)).toEqual([]);
  });

  it('writes one component per page, a router App and a Layout with Header and Footer around an Outlet', async () => {
    expect(record.files).toEqual([
      '.gitignore',
      'README.md',
      'index.html',
      'package.json',
      'playwright.config.ts',
      'src/App.tsx',
      'src/components/Component01.tsx',
      'src/index.css',
      'src/layouts/Layout.tsx',
      'src/lib/validity.ts',
      'src/main.tsx',
      'src/mocks/itemsJson.ts',
      'src/pages/Features.tsx',
      'src/pages/Home.tsx',
      'src/sections/Footer.tsx',
      'src/sections/Header.tsx',
      'src/styles/tokens.css',
      'tests/behavior.spec.ts',
      'tsconfig.json',
      MANIFEST_FILE,
      'vite.config.ts',
    ]);
    const app = await read(outDir, 'src/App.tsx');
    expect(app).toContain("import { BrowserRouter, Route, Routes } from 'react-router-dom';");
    expect(app).toContain('<BrowserRouter>');
    expect(app).toContain('<Route element={<Layout />}>');
    expect(app).toContain('<Route path="/" element={<Home />} />');
    expect(app).toContain('<Route path="/features.html" element={<Features />} />');
    expect(app).toContain('<Route path="/features" element={<Features />} />');
    const layout = await read(outDir, 'src/layouts/Layout.tsx');
    expect(layout).toContain("import { Outlet } from 'react-router-dom';");
    expect(layout).toContain('<Header />');
    expect(layout).toContain('<Outlet />');
    expect(layout).toContain('<Footer />');
    const home = await read(outDir, 'src/pages/Home.tsx');
    expect(home).toContain('export function Home()');
    expect(home).toContain('document.title = "Lumen — Home";');
    expect(home).toContain('<main data-uidna-path="1">');
    expect(home).not.toContain('<header');
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(header).toContain('<header className="bg-[#ffffff] border-b border-b-[#dfe3ec]" data-uidna-path="0">');
    const pkg = JSON.parse(await read(outDir, 'package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['react-router-dom']).toBe('^7.0.0');
    expect(await read(outDir, 'index.html')).toContain('<title>Lumen — Home</title>');
  });

  it('renders same-origin page links as <Link> (sections, pages and components) and keeps other links as <a>', async () => {
    const home = await read(outDir, 'src/pages/Home.tsx');
    expect(home).toContain("import { Link } from 'react-router-dom';");
    expect(home).toContain('to="/features.html" data-uidna-path="1/0/3/0">');
    expect(home).not.toContain('href="/features.html"');
    const header = await read(outDir, 'src/sections/Header.tsx');
    expect(header).toContain('to="/" data-uidna-path="0/0/0">Lumen</Link>');
    expect(header).toContain('<Component01 uidnaPath="0/0/1/1" link={{ href: "/features.html", label: "Features" }} />');
    const component = await read(outDir, 'src/components/Component01.tsx');
    expect(component).toContain('to={link.href}');
    expect(component).not.toContain('href={link.href}');
    const footer = await read(outDir, 'src/sections/Footer.tsx');
    expect(footer).toMatch(/<Link className="[^"]*" to="\/" data-uidna-path="2\/0\/1\/0">\s*Home\s*<\/Link>/);
    expect(footer).toContain('href="https://example.com/" rel="noopener" data-uidna-path="2/0/1/2">');
    expect(footer).toMatch(/<a [^>]*href="https:\/\/example\.com\/"/);
  });

  it('generates a noValidate form whose onSubmit checks validity per control and toggles the observed messages without a request', async () => {
    const features = await read(outDir, 'src/pages/Features.tsx');
    expect(features).toContain("import { useEffect, useState, type FormEvent } from 'react';");
    expect(features).toContain("import { controlValidity } from '../lib/validity';");
    expect(features).toContain('<form id="signup" noValidate data-uidna-path="1/0/2" onSubmit={onSubmit01}>');
    expect(features).toContain('const onSubmit01 = (event: FormEvent<HTMLFormElement>): void => {');
    expect(features).toContain('event.preventDefault();');
    expect(features).toContain('const valid01 = controlValidity(form, "name", "1/0/2/0/1");');
    expect(features).toContain('setError01(!valid01);');
    expect(features).toContain('const valid02 = controlValidity(form, "email", "1/0/2/1/1");');
    expect(features).toContain('const valid = valid01 && valid02 && form.checkValidity();');
    expect(features).toContain('setSubmitted01(valid);');
    expect(features).toContain('aria-invalid={error01 ? "true" : undefined}');
    expect(features).toContain('aria-errormessage={error02 ? "email-error" : undefined}');
    expect(features).toContain('autoComplete="name" id="name" name="name" required type="text"');
    expect(features).toContain('hidden={error01 ? false : true} id="name-error" role="alert" data-uidna-path="1/0/2/0/2">');
    expect(features).toContain('{error01 ? "Enter your full name." : ""}');
    expect(features).toContain('{error02 ? "Enter a valid email address." : ""}');
    expect(features).toContain('{submitted01 ? "Could not reach the server." : ""}');
    expect(features).toContain('backend call not reproduced; wire your API here');
    expect(features).not.toMatch(/fetch\(/);
    const validity = await read(outDir, 'src/lib/validity.ts');
    expect(validity).toContain('export function controlValidity(form: HTMLFormElement, key: string | null, path: string): boolean {');
  });

  it('writes a typed mock per data asset, inferring optional fields and keeping the redacted literal', async () => {
    expect(record.mocks).toEqual([{ name: 'itemsJson', file: 'src/mocks/itemsJson.ts', reason: 'JSON response observed during the scan (GET http://127.0.0.1:4173/api/items.json)' }]);
    const mock = await read(outDir, 'src/mocks/itemsJson.ts');
    expect(mock).toContain('export interface ItemsJson {\n  items: ItemsJsonItem[];\n  total: number;\n}');
    expect(mock).toContain('export interface ItemsJsonItem {\n  id: number;\n  links: number;\n  tags?: string[];\n  title: string;\n  token?: string;\n  updated: string;\n}');
    expect(mock).toContain('export const itemsJson: ItemsJson = {');
    expect(mock).toContain('"token": "[redacted]"');
    expect(mock).toContain('"title": "Reading list"');
    expect(mock).toContain('nothing imports it');
    for (const file of ['src/pages/Home.tsx', 'src/pages/Features.tsx', 'src/App.tsx']) expect(await read(outDir, file)).not.toContain('itemsJson');
  });

  it('writes a behavior test per implemented transition with the observed delta and a skip for the rest', async () => {
    const spec = await read(outDir, 'tests/behavior.spec.ts');
    expect(spec).toContain('test("tr_01: click link \\"Features\\" at 0/0/1/1/0 (390×844)", async ({ page }) => {');
    expect(spec).toContain('const target = await locate(page, "link", "Features", 0, "0/0/1/1/0");');
    expect(spec).toContain('await expect(page).toHaveURL("/features.html");');
    expect(spec).toContain('await page.goto("/features.html");');
    expect(spec).toContain('await target.fill("Ada Lovelace");');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"1/0/2/0/1\\"]")).toHaveValue("Ada Lovelace");');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"1/0/2/0/1\\"]")).toHaveAttribute("aria-invalid", "true");');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"1/0/2/0/2\\"]")).toBeVisible();');
    expect(spec).toContain('await expect(page.locator("[data-uidna-path=\\"1/0/2/0/2\\"]")).toHaveText("Enter your full name.");');
    // The filled submit sent a (blocked) POST when it was observed: like the verifier, the suite never replays it.
    expect(spec).toContain('test.skip("tr_05: submit button \\"Create account\\" at 1/0/2/2/0: not replayed", async () => {');
    expect(spec).toContain('// Reason: the action caused a side effect when it was observed (a non-GET request); UI DNA never repeats it.');
    expect(spec).not.toContain('Could not reach the server.');
    expect(spec).toContain('test.skip("tr_06: key Tab link \\"Lumen\\" at 0/0/0: not reproduced", async () => {');
    expect(spec).toContain('// key transitions are only reproduced as Escape reverts of an implemented click');
    expect(spec.match(/\n {2}test\(/g)).toHaveLength(4);
    const manifest = JSON.parse(await read(outDir, MANIFEST_FILE)) as { router: string; pages: unknown[]; behaviorTests: unknown };
    expect(manifest.router).toBe('react-router');
    expect(manifest.pages).toEqual([
      { pageId: 'pg_01', name: 'Home', file: 'src/pages/Home.tsx', route: '/' },
      { pageId: 'pg_02', name: 'Features', file: 'src/pages/Features.tsx', route: '/features.html' },
    ]);
    expect(manifest.behaviorTests).toEqual({ tests: 4, skipped: 2, deduplicated: [], notReplayed: ['tr_05'] });
  });

  it('documents pages, routes, the shared layout, forms, mocks and the tests in the README', async () => {
    const readme = await read(outDir, 'README.md');
    expect(readme).toContain('## Pages and routes');
    expect(readme).toContain('| `pg_02` | http://127.0.0.1:4173/features.html | `/features.html` (also `/features` for hosts that drop the extension) | `src/pages/Features.tsx` | `Layout` | `st_03` (390px), `st_04` (1280px) |');
    expect(readme).toContain('### Shared layout');
    expect(readme).toContain('renders the header (`src/sections/Header.tsx`) and the footer (`src/sections/Footer.tsx`) of page `pg_01` around an `<Outlet />` for pages `pg_01`, `pg_02`');
    expect(readme).toContain('## Forms');
    expect(readme).toContain('- form #signup at 1/0/2 (`tr_02`, `tr_05`): `onSubmit01`, noValidate as captured.');
    expect(readme).toContain('- `error01`: input "name" at 1/0/2/0/1 → "Enter your full name."');
    expect(readme).toContain('- `submitted01`: changes observed after a valid submit (status message); backend call not reproduced');
    expect(readme).toContain('- `itemsJson` in `src/mocks/itemsJson.ts`: JSON response observed during the scan (GET http://127.0.0.1:4173/api/items.json)');
    expect(readme).toContain('`tests/behavior.spec.ts` replays 4 implemented transitions with Playwright (one test per target, action and viewport) and skips 1 that the generator did not reproduce and `tr_05`, which caused a side effect when it was observed and is never replayed, each with its reason.');
    expect(readme).toContain('`tr_06` key Tab on link "Lumen" at 0/0/0: key transitions are only reproduced as Escape reverts');
    expect(readme).toContain('npm run test:behavior');
  });

  it('is byte-identical across two runs', async () => {
    const second = join(ROOT, 'multi-2');
    await generate(multiPageFormDocument(), second);
    for (const file of record.files) expect(await read(second, file), file).toBe(await read(outDir, file));
    expect(record.scanId).toBe(FIXTURE_MULTI_SCAN_ID);
  });

  it('router "none" keeps the single-page layout of the first page and says so in the README', async () => {
    const single = join(ROOT, 'multi-none');
    const none = await generate(multiPageFormDocument(), single, { router: 'none' });
    expect(none.files).toContain('src/sections/Main.tsx');
    expect(none.files.some((f) => f.startsWith('src/pages/') || f.startsWith('src/layouts/'))).toBe(false);
    const app = await read(single, 'src/App.tsx');
    expect(app).not.toContain('BrowserRouter');
    expect(app).toContain('<Main />');
    const header = await read(single, 'src/sections/Header.tsx');
    expect(header).toContain('href="/" data-uidna-path="0/0/0">Lumen</a>');
    expect(header).toContain('<Component01 uidnaPath="0/0/1/1" link={{ href: "/features.html", label: "Features" }} />');
    expect(header).not.toContain('<Link');
    expect(await read(single, 'src/components/Component01.tsx')).toContain('href={link.href}');
    const readme = await read(single, 'README.md');
    expect(readme).toContain('router "none": only the first page pg_01');
    expect(readme).toContain('`tr_01` click on link "Features" at 0/0/1/1/0: the action led to page pg_02, which is not generated');
  });

  it('behaviorTests: false writes neither the tests nor the Playwright dependency', async () => {
    const dir = join(ROOT, 'multi-no-tests');
    const none = await generate(multiPageFormDocument(), dir, { behaviorTests: false });
    expect(none.files).not.toContain('tests/behavior.spec.ts');
    expect(none.files).not.toContain('playwright.config.ts');
    const pkg = JSON.parse(await read(dir, 'package.json')) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.devDependencies['@playwright/test']).toBeUndefined();
    expect(pkg.scripts['test:behavior']).toBeUndefined();
    const tsconfig = JSON.parse(await read(dir, 'tsconfig.json')) as { include: string[] };
    expect(tsconfig.include).toEqual(['src', 'vite.config.ts']);
    expect(await read(dir, 'README.md')).toContain('Behavior tests were not requested');
  });
});

describe('multi-page regressions', () => {
  const root = join(ROOT, 'multi-regressions');

  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(join(SCAN_DIR, 'assets'), { recursive: true });
    await writeFile(join(SCAN_DIR, 'assets', 'items.json'), JSON.stringify({ items: [{ id: 1 }], total: 1 }), 'utf8');
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  function editNodeOnPage(dna: UiDnaDocument, pageId: string, path: string, edit: (node: UiNode) => UiNode): void {
    for (const state of dna.states.items) {
      if (state.pageId !== pageId) continue;
      state.nodes = state.nodes.map((node) => (node.path === path ? edit(node) : node));
    }
  }

  it('does not hoist a header the source page lacks as a top-level landmark, so the Layout never imports a missing section', async () => {
    const dna = multiPageFormDocument();
    // The home page's header sits in a wrapper: no banner/navigation landmark is a direct child of <body>.
    editNodeOnPage(dna, 'pg_01', MULTI_PATHS.header, (node) => ({ ...node, tag: 'div', role: null, attrs: {} }));
    const outDir = join(root, 'nested-header');
    const record = await generate(dna, outDir);
    expect(record.files).not.toContain('src/sections/Header.tsx');
    expect(record.files).toContain('src/sections/Footer.tsx');
    const layout = await read(outDir, 'src/layouts/Layout.tsx');
    expect(layout).not.toContain('import { Header }');
    expect(layout).not.toContain('<Header />');
    expect(layout).toContain('/** Footer rendered once from page pg_01 around the routed page. */');
    expect(layout).toContain('<Footer />');
    expect(await read(outDir, 'src/pages/Home.tsx')).toContain('data-uidna-path="0"');
    const readme = await read(outDir, 'README.md');
    expect(readme).toContain('page pg_01 has no banner or navigation landmark as a direct child of &lt;body&gt;, so the header was not hoisted');
    expect(readme).toContain('renders the footer (`src/sections/Footer.tsx`) of page `pg_01`');
  });

  it('declares in tokens.css every breakpoint a generated page uses, not only the seed page\'s', async () => {
    const dna = multiPageFormDocument();
    // The seed page was captured at 390px only; the features page also at 1280px.
    dna.states.items = dna.states.items.filter((s) => s.id !== 'st_02');
    dna.app.pages = dna.app.pages.map((page) => ({ ...page, stateIds: page.stateIds.filter((id) => id !== 'st_02') }));
    dna.components.instances = dna.components.instances.filter((inst) => inst.stateId !== 'st_02');
    const outDir = join(root, 'breakpoints');
    await generate(dna, outDir);
    const css = await read(outDir, 'src/styles/tokens.css');
    expect(css).toContain('--breakpoint-md: 1280px;');
    const features = await read(outDir, 'src/pages/Features.tsx');
    expect(features).toContain('md:');
    expect(await read(outDir, 'src/pages/Home.tsx')).not.toContain('md:');
  });

  it('asserts the fragment of a page link in the navigation test, since the Link navigates to route plus fragment', async () => {
    const dna = multiPageFormDocument();
    const target = `${FIXTURE_FORM_URL}#signup`;
    for (const pageId of ['pg_01', 'pg_02']) editNodeOnPage(dna, pageId, MULTI_PATHS.featuresLink, (node) => ({ ...node, attrs: { ...node.attrs, href: '/features.html#signup' } }));
    dna.app.navigation = dna.app.navigation.map((edge) => (edge.id === 'nav_01' ? { ...edge, to: { ...edge.to, url: target } } : edge));
    dna.states.transitions = dna.states.transitions.map((t) => (t.id === 'tr_01' ? { ...t, navigation: { toPageId: 'pg_02', url: target } } : t));
    const outDir = join(root, 'fragment-link');
    await generate(dna, outDir);
    expect(await read(outDir, 'src/sections/Header.tsx')).toContain('link={{ href: "/features.html#signup", label: "Features" }}');
    const spec = await read(outDir, 'tests/behavior.spec.ts');
    expect(spec).toContain('await expect(page).toHaveURL("/features.html#signup");');
    expect(spec).not.toContain('toHaveURL("/features.html")');
  });

  it('wires a change on a valid control after a valid submit to the submitted state, never to an error state', async () => {
    const dna = multiPageFormDocument();
    // After the valid submit the page points the (valid) name input at the status message.
    const st08 = dna.states.items.find((s) => s.id === 'st_08');
    if (st08 === undefined) throw new Error('fixture has no st_08');
    st08.nodes = st08.nodes.map((node) => (node.path === MULTI_PATHS.nameInput ? { ...node, attrs: { ...node.attrs, 'aria-describedby': 'status' } } : node));
    const outDir = join(root, 'valid-submit');
    await generate(dna, outDir);
    const features = await read(outDir, 'src/pages/Features.tsx');
    expect(features).toContain('aria-describedby={submitted01 ? "status" : undefined}');
    expect(features).not.toContain('aria-describedby={error01');
    expect(features).toContain('{error01 ? "Enter your full name." : ""}');
  });

  it('never sets a test up through a side effect: transitions whose from-state only a blocked submit reaches are reported and skipped', async () => {
    const dna = multiPageFormDocument();
    // A form without client-side validation: the empty submit sent a (blocked) POST and the fills start from the state it produced.
    dna.states.transitions = dna.states.transitions.map((t) => {
      if (t.id === 'tr_02') return { ...t, sideEffects: true, network: { requests: 1, nonGet: 1 } };
      if (t.id === 'tr_03') return { ...t, from: 'st_05' };
      return t;
    });
    dna.states.items = dna.states.items.map((s) => (s.id === 'st_06' ? { ...s, parentStateId: 'st_05' } : s));
    expect(formatIssues(validateUiDna(dna))).toEqual([]);
    const outDir = join(root, 'side-effect-setup');
    await generate(dna, outDir);
    const spec = await read(outDir, 'tests/behavior.spec.ts');
    const reason = (from: string): string => `from-state ${from} is reachable only through tr_02: tr_02 caused side effects when it was observed (a non-GET request) and is never repeated; this transition is not reproduced from that state and not tested, because its test would have to repeat tr_02`;
    expect(spec).toContain(`  // ${reason('st_05')}\n  test.skip("tr_03: fill textbox \\"Full name\\" at 1/0/2/0/1: not reproduced", async () => {`);
    expect(spec).toContain(`  // ${reason('st_06')}\n  test.skip("tr_04: fill textbox \\"Email\\" at 1/0/2/1/1: not reproduced", async () => {`);
    expect(spec).toContain('test.skip("tr_02: submit button \\"Create account\\" at 1/0/2/2/0: not replayed", async () => {');
    // No test replays the submit, as a step or as setup: the only test left is the navigation from a base state.
    expect(spec).not.toContain('submitForm(');
    expect(spec).not.toContain('setup01');
    expect(spec.match(/\n {2}test\(/g)).toHaveLength(1);
    expect(spec).toContain('test("tr_01: click link \\"Features\\" at 0/0/1/1/0 (390×844)", async ({ page }) => {');
    const manifest = JSON.parse(await read(outDir, MANIFEST_FILE)) as { behaviorTests: unknown };
    expect(manifest.behaviorTests).toEqual({ tests: 1, skipped: 5, deduplicated: [], notReplayed: ['tr_02', 'tr_05'] });
    const readme = await read(outDir, 'README.md');
    expect(readme).toContain(`- \`tr_03\` fill on textbox "Full name" at 1/0/2/0/1: ${reason('st_05')}`);
    expect(readme).toContain(`- \`tr_05\` submit on button "Create account" at 1/0/2/2/0: ${reason('st_07')}`);
  });

  it('replays submits through a helper that blocks the native request, for clicked submit buttons too', async () => {
    const outDir = join(root, 'submit-guard');
    await generate(multiPageFormDocument(), outDir);
    const spec = await read(outDir, 'tests/behavior.spec.ts');
    expect(spec).toContain('async function submitForm(target: Locator, click: boolean): Promise<void> {');
    expect(spec).toContain("form?.addEventListener('submit', (event) => { event.preventDefault(); }, { once: true });");
    expect(spec).toContain('await submitForm(target, true);');
    expect(spec).not.toMatch(/await target\.click\(\);\n\s+await expect\(page\.locator\("\[data-uidna-path=\\"1\/0\/2\/0\/1\\"\]"\)\)\.toHaveAttribute\("aria-invalid"/);
  });
});

describe('renderBehaviorSpec', () => {
  const step: TestStep = { action: 'click', locator: { path: '0/1', role: 'link', name: 'Help', nth: 0 }, key: null, value: null, control: 'text', click: false };
  const report = (transitionId: string, extra: Partial<BehaviorReport> = {}): BehaviorReport => ({
    transitionId,
    action: 'click',
    target: 'link "Help" at 0/1',
    status: 'implemented',
    detail: 'navigates',
    file: 'src/pages/Home.tsx',
    test: null,
    neverReplayed: false,
    network: { requests: 0, nonGet: 0 },
    ...extra,
  });
  const urlTest = (transitionId: string, pattern: string): TransitionTest => ({ transitionId, pageId: 'pg_01', route: '/', viewport: { width: 1280, height: 800 }, setup: [], step, expectations: [{ kind: 'url', pattern }], revert: null, dedupeKey: transitionId });

  it('names the side effect of a never-replayed transition from its network counts', () => {
    const { code, summary } = renderBehaviorSpec('scan_x', [
      report('tr_01', { neverReplayed: true, network: { requests: 1, nonGet: 1 } }),
      report('tr_02', { neverReplayed: true, network: { requests: 4, nonGet: 3 } }),
      report('tr_03', { neverReplayed: true, network: { requests: 0, nonGet: 0 } }),
    ]);
    expect(code).toContain('test.skip("tr_01: click link \\"Help\\" at 0/1: not replayed", async () => {\n    // Reason: the action caused a side effect when it was observed (a non-GET request); UI DNA never repeats it.');
    expect(code).toContain('test.skip("tr_02: click link \\"Help\\" at 0/1: not replayed", async () => {\n    // Reason: the action caused a side effect when it was observed (3 non-GET requests); UI DNA never repeats it.');
    expect(code).toContain('test.skip("tr_03: click link \\"Help\\" at 0/1: not replayed", async () => {\n    // Reason: the action caused a side effect when it was observed (a navigation); UI DNA never repeats it.');
    expect(summary).toEqual({ tests: 0, skipped: 3, deduplicated: [], notReplayed: ['tr_01', 'tr_02', 'tr_03'] });
  });

  it('asserts a URL with a colon inside a segment literally and matches only parameter and splat segments', () => {
    const { code } = renderBehaviorSpec('scan_x', [
      report('tr_01', { test: urlTest('tr_01', '/wiki/Help:Contents') }),
      report('tr_02', { test: urlTest('tr_02', '/wiki/Help:Contents/:id') }),
      report('tr_03', { test: urlTest('tr_03', '/docs/*') }),
    ]);
    expect(code).toContain('await expect(page).toHaveURL("/wiki/Help:Contents");');
    expect(code).toContain('await expect(page).toHaveURL(new RegExp("/wiki/Help:Contents/[^/]+$"));');
    expect(code).toContain('await expect(page).toHaveURL(new RegExp("/docs/.*$"));');
  });
});

describe('mocks', () => {
  it('keeps a __proto__ field of a captured response as data while redacting secret-looking keys', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"token":"x","n":1},"a":1}');
    const redacted = redactJson(parsed);
    expect(JSON.stringify(redacted)).toBe('{"__proto__":{"token":"[redacted]","n":1},"a":1}');
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
  });
});
