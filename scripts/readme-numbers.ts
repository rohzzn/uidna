/**
 * Renders the "sample investigation" section of README.md from a real scan:
 * counts from dna.json and the findings of every verification attempt.
 * Usage: tsx scripts/readme-numbers.ts <scanId> [outRoot]
 * The numbers are measured, never typed by hand; re-run after changing the
 * pipeline so the README keeps matching what the tool produces.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScanStore } from '../src/application/scan-store.js';
import type { DiffReport } from '../src/contracts/diff-report.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const [scanId, outRoot = '.uidna'] = process.argv.slice(2);
if (!scanId) {
  console.error('usage: tsx scripts/readme-numbers.ts <scanId> [outRoot]');
  process.exit(2);
}

const store = new ScanStore(outRoot);
const scan = await store.loadScan(scanId);
if (!scan.ok) {
  console.error(scan.error.message);
  process.exit(1);
}
const dna = await store.loadDna(scanId);
if (!dna.ok) {
  console.error(dna.error.message);
  process.exit(1);
}
const explore = await store.loadExplore(scanId);
const attempts: DiffReport[] = [];
for (const n of await store.listAttempts(scanId)) {
  const report = await store.loadDiffReport(scanId, n);
  if (report.ok) attempts.push(report.value);
}

const doc = dna.value;
const base = doc.states.items.filter((s) => s.kind === 'base');
const derived = doc.states.items.filter((s) => s.kind === 'derived');
const tokens = doc.visual.tokens;
const lines: string[] = [];
lines.push(`Measured on Fixture A (\`${doc.target.url}\`) by scan \`${scanId}\` with tool version ${doc.target.tool.version}:`);
lines.push('');
lines.push('| Step | Result |');
lines.push('| --- | --- |');
lines.push(`| scan | ${base.length} base states at ${base.map((s) => s.viewport.width).join(', ')} px; ${base.map((s) => s.nodeCount).join(' / ')} nodes; ${doc.assets.length} asset${doc.assets.length === 1 ? '' : 's'}; ${(doc.target.budget.used.timeMs / 1000).toFixed(1)} s of browser time for scan and explore together |`);
if (explore.ok && explore.value) {
  const c = explore.value.coverage;
  lines.push(`| explore (safe) | ${c.discovered} interactive elements discovered, ${c.explored} interactions performed, ${c.changed} produced a new state, ${c.skipped} skipped with a reason; ${doc.states.transitions.length} transitions, ${derived.length} derived states |`);
}
lines.push(`| tokens | ${tokens.colors.length} colors, ${tokens.typography.length} typography styles, ${tokens.fontSizes.length} font sizes, ${tokens.spacing.length} spacing values, ${tokens.radii.length} radii, ${tokens.shadows.length} shadow${tokens.shadows.length === 1 ? '' : 's'}, ${tokens.breakpoints.length} breakpoints |`);
lines.push(`| components | ${doc.components.definitions.length} candidates, ${doc.components.instances.length} instances (largest: ${doc.components.definitions[0]?.generatedName ?? '-'} with ${doc.components.definitions[0]?.instanceCount ?? 0}) |`);
lines.push(`| behavior | ${doc.behavior.length} observed rules; ${doc.limitations.length} limitations recorded |`);
for (const report of attempts) {
  const byCat = Object.entries(report.summary.byCategory)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const pixels = report.visual.map((v) => `${v.viewport.width}px ${v.pixels?.diffRatio === null || v.pixels?.diffRatio === undefined ? 'n/a' : (v.pixels.diffRatio * 100).toFixed(2) + '%'}`).join(', ');
  lines.push(`| verify attempt ${report.attempt} | ${report.summary.findings} findings (${byCat || 'none'}); pixel diff ${pixels}; ${report.summary.transitionsMatched}/${report.summary.transitionsReplayed} replayed transitions matched; ${report.regressions.length} regressions, ${report.resolved.length} resolved |`);
}
lines.push('');
lines.push('Pixel ratios depend on the fonts of the machine that rendered them; the counts do not.');

const readmePath = join(repoRoot, 'README.md');
const readme = await readFile(readmePath, 'utf8');
const begin = '<!-- numbers:begin -->';
const end = '<!-- numbers:end -->';
const start = readme.indexOf(begin);
const stop = readme.indexOf(end);
if (start < 0 || stop < 0) {
  console.error('README.md is missing the numbers markers');
  process.exit(1);
}
const updated = readme.slice(0, start + begin.length) + '\n' + lines.join('\n') + '\n' + readme.slice(stop);
await writeFile(readmePath, updated, 'utf8');
console.log(`updated README.md from ${scanId} (${attempts.length} attempts)`);
