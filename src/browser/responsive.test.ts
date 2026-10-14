/**
 * The responsive instruments against a real Chromium: stylesheet conditions
 * from plain `@media`, `@media` nested in `@supports` and `@layer`, an
 * `@import` with a media list and a `<link media>`, each with the node paths
 * its rules match; and a layout signature that changes exactly at a width no
 * scan uses (960px).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unwrap } from '../domain/result.js';
import type { StaticServer } from '../application/static-server.js';
import { createPlaywrightProvider } from './playwright-provider.js';
import { DESKTOP, makeTempDir, serveDir, writeSite, type TempDir } from './test-helpers.js';
import type { BrowserSession } from './types.js';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Responsive</title>
<link rel="stylesheet" href="styles.css">
<link rel="stylesheet" href="print.css" media="print">
</head><body>
<header class="top"><button class="menu" type="button">Menu</button></header>
<div class="layout"><aside class="sidebar">Sidebar</aside><main class="main"><div class="grid"><p>a</p><p>b</p><p>c</p><p>d</p></div></main></div>
<script>window.loaded = true;</script>
</body></html>`;

const CSS = `@import url(wide.css) screen and (min-width: 1440px);
.sidebar { display: none; }
@media (min-width: 60em) {
  .sidebar { display: block; }
  .layout { display: grid; grid-template-columns: 240px 1fr; }
  .menu { display: none; }
}
@supports (display: grid) {
  @media (max-width: 599px) { .grid { grid-template-columns: 1fr; } }
}
@layer base {
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); }
  @media (600px <= width < 1100px) { .grid { grid-template-columns: repeat(2, 1fr); } }
}
.menu:hover { color: red; }
`;

describe('responsive instruments', () => {
  let dir: TempDir;
  let server: StaticServer;
  let session: BrowserSession;

  beforeAll(async () => {
    dir = await makeTempDir('uidna-responsive-');
    await writeSite(dir.path, { 'index.html': HTML, 'styles.css': CSS, 'wide.css': '.main { max-width: 1200px; }', 'print.css': '.menu { display: none; }' });
    server = await serveDir(dir.path);
    session = unwrap(await createPlaywrightProvider().launch({ viewport: { ...DESKTOP } }), 'launch');
    unwrap(await session.navigate(server.url), 'navigate');
  }, 60_000);

  afterAll(async () => {
    await session.close();
    await server.close();
    await dir.cleanup();
  });

  it('reads every width condition with the node paths its rules match', async () => {
    const reading = unwrap(await session.readStyleConditions(), 'conditions');
    expect(reading.unreadable).toEqual([]);
    expect(reading.emPx).toBe(16);
    const byText = new Map(reading.conditions.map((c) => [c.text, c] as const));
    expect([...byText.keys()].sort()).toEqual(['(600px <= width < 1100px)', '(max-width: 599px)', '(min-width: 60em)', 'print', 'screen and (min-width: 1440px)'].sort());
    const sixty = byText.get('(min-width: 60em)');
    expect(sixty?.kind).toBe('media');
    expect(sixty?.ruleCount).toBe(3);
    // body > div.layout (index 1) > aside.sidebar (index 0); header (index 0) > button (index 0)
    expect(sixty?.targets).toEqual(
      expect.arrayContaining([
        { path: '1/0', properties: ['display'] },
        { path: '1', properties: ['display', 'grid-template-columns'] },
        { path: '0/0', properties: ['display'] },
      ]),
    );
    expect(byText.get('screen and (min-width: 1440px)')?.kind).toBe('import');
    expect(byText.get('screen and (min-width: 1440px)')?.targets).toEqual([{ path: '1/1', properties: ['max-width'] }]);
    expect(byText.get('print')?.kind).toBe('link-media');
    expect(byText.get('(max-width: 599px)')?.targets).toEqual([{ path: '1/1/0', properties: ['grid-template-columns'] }]);
  });

  it('records a layout signature that changes at 960px and nowhere between 768 and 959', async () => {
    const at = async (width: number): Promise<Record<string, string>> => {
      unwrap(await session.setViewport({ width, height: 800 }), 'resize');
      return unwrap(await session.layoutSignature(), 'signature').entries;
    };
    const narrow = await at(959);
    const wide = await at(960);
    const tablet = await at(768);
    expect(narrow).toEqual(tablet);
    expect(narrow['1/0|display']).toBe('none');
    expect(wide['1/0|display']).toBe('block');
    expect(narrow['1/0|rendered']).toBe('false');
    expect(wide['1/0|rendered']).toBe('true');
    expect(wide['1|grid-columns']).toBe('2');
    expect(narrow['1|grid-columns']).toBeUndefined();
    expect(narrow['1/1/0|grid-columns']).toBe('2');
    expect((await at(599))['1/1/0|grid-columns']).toBe('1');
    expect((await at(1100))['1/1/0|grid-columns']).toBe('4');
    expect(Object.keys(narrow).some((key) => key.startsWith('2|'))).toBe(false);
  });

  it('keys the signature by an attribute when asked', async () => {
    unwrap(await session.setViewport({ width: 959, height: 800 }), 'resize');
    const reading = unwrap(await session.layoutSignature({ keyAttribute: 'class' }), 'signature');
    expect(reading.entries['sidebar|display']).toBe('none');
    expect(reading.truncated).toBe(false);
  });
});
