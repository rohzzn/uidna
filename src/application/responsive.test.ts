/**
 * Responsive measurement during a real scan of Fixture B: the three
 * breakpoints between the scanned widths are located to the pixel and
 * explained by their stylesheet conditions; the 1440px condition is read but
 * not seen; print and reduced-motion conditions never become breakpoints; the
 * probe stays within its budget and sends nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlaywrightProvider } from '../browser/index.js';
import { makeTempDir, serveFixtureB, type TempDir } from '../browser/test-helpers.js';
import { unwrap } from '../domain/result.js';
import { createContext } from './context.js';
import { scanInterface } from './scan.js';
import type { StaticServer } from './static-server.js';

describe('responsive measurement on Fixture B', () => {
  let server: StaticServer;
  let dir: TempDir;
  let result: Awaited<ReturnType<typeof scanInterface>>;

  beforeAll(async () => {
    server = await serveFixtureB();
    dir = await makeTempDir('uidna-responsive-scan-');
    const ctx = createContext({ provider: createPlaywrightProvider(), toolVersion: '0.3.0', cwd: dir.path, outRoot: dir.path });
    result = await scanInterface(ctx, { url: server.url, viewports: [1280, 768, 390] });
  }, 180_000);

  afterAll(async () => {
    await server.close();
    await dir.cleanup();
  });

  it('locates 600, 960 and 1100 to the pixel and names the stylesheet conditions', () => {
    const scanned = unwrap(result, 'scan').result;
    expect(scanned.breakpoints.map((b) => [b.minWidth, b.source, b.bracket.lower, b.bracket.upper, b.conditions.join(',')])).toEqual([
      [600, 'css', 599, 600, '(max-width: 599px)'],
      [960, 'css', 959, 960, '(min-width: 960px)'],
      [1100, 'css', 1099, 1100, '(max-width: 1099px)'],
    ]);
    expect(scanned.breakpoints.every((b) => b.rules > 0)).toBe(true);
  });

  it('records what the probe did and what only the stylesheet shows', async () => {
    const scanned = unwrap(result, 'scan').result;
    const { readFile } = await import('node:fs/promises');
    const dna = JSON.parse(await readFile(scanned.dnaPath, 'utf8')) as {
      dnaVersion: string;
      visual: { responsive: { conditions: { text: string; never: boolean; observedEffect: boolean | null }[]; probes: { widths: number[]; blockedRequests: number; exhausted: boolean }[]; rules: { nodePath: string; property: string; below: string; above: string; breakpointId: string }[] }; tokens: { breakpoints: { value: { value: string } }[] } };
      limitations: { subject: string; reason: string }[];
    };
    expect(dna.dnaVersion).toBe('0.3.0');
    const effect = Object.fromEntries(dna.visual.responsive.conditions.map((c) => [c.text, [c.never, c.observedEffect]]));
    expect(effect).toMatchObject({ '(min-width: 1440px)': [false, null], print: [true, null], '(prefers-reduced-motion: reduce)': [false, null], '(min-width: 960px)': [false, true] });
    const [probe] = dna.visual.responsive.probes;
    expect(probe?.widths).toEqual([390, 599, 600, 768, 959, 960, 1099, 1100, 1280]);
    expect(probe?.blockedRequests).toBe(0);
    expect(probe?.exhausted).toBe(false);
    expect(dna.limitations.some((l) => l.subject === 'breakpoint 1440px on pg_01' && l.reason.includes('outside the probed widths'))).toBe(true);
    // The sidebar toggle disappears at 960; the stat grid goes from 2 to 4 tracks at 1100.
    expect(dna.visual.responsive.rules.some((r) => r.nodePath === '0/0' && r.property === 'display' && r.below === 'flex' && r.above === 'none')).toBe(true);
    expect(dna.visual.responsive.rules.some((r) => r.property === 'grid-columns' && r.below === '2' && r.above === '4')).toBe(true);
    // Breakpoint tokens keep their 0.2.0 meaning: observed differences between scanned widths.
    expect(dna.visual.tokens.breakpoints.map((t) => t.value.value)).toEqual(['390px', '768px']);
  });
});
