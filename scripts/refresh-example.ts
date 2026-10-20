/**
 * Copies a scan's validated UI DNA document into docs/examples/ as the
 * reference example for the schema docs. Usage:
 *   tsx scripts/refresh-example.ts <scanId> [outRoot] [name]
 * The copy is validated before it is written; an invalid document is refused.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatIssues, validateUiDna } from 'uidna-schema';
import { ScanStore } from '../src/application/scan-store.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const [scanId, outRoot = '.uidna', name = 'fixture-a'] = process.argv.slice(2);
if (!scanId) {
  console.error('usage: tsx scripts/refresh-example.ts <scanId> [outRoot] [name]');
  process.exit(2);
}

const store = new ScanStore(outRoot);
const dna = await store.loadDna(scanId);
if (!dna.ok) {
  console.error(dna.error.message);
  process.exit(1);
}
const validation = validateUiDna(dna.value);
if (!validation.success) {
  console.error(formatIssues(validation).join('\n'));
  process.exit(1);
}
const target = join(repoRoot, 'docs', 'examples', `${name}.dna.json`);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(validation.data, null, 2) + '\n', 'utf8');
console.log(`wrote ${target} (${validation.data.states.items.length} states, ${validation.data.states.transitions.length} transitions)`);
