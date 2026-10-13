/**
 * Generates `dist/ui-dna.schema.json` from the Zod schema. Run after `tsc`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { UiDnaDocumentStructureSchema, UI_DNA_VERSION } from '../src/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
// When run from dist/scripts/, the package root is two levels up; from scripts/ it is one.
const packageRoot = here.endsWith(join('dist', 'scripts')) ? join(here, '..', '..') : join(here, '..');
const outDir = join(packageRoot, 'dist');

const jsonSchema = z.toJSONSchema(UiDnaDocumentStructureSchema, {
  target: 'draft-2020-12',
  unrepresentable: 'any',
  io: 'input',
});

const withMeta = {
  $id: `https://uidna.dev/schema/ui-dna/${UI_DNA_VERSION}/ui-dna.schema.json`,
  title: 'UI DNA document',
  description:
    'Describes a user interface down to the token, the component and the state transition, with provenance on every value. Cross-reference rules (state, page and component ids must resolve) are enforced by the Zod schema and are not expressible here.',
  ...jsonSchema,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'ui-dna.schema.json'), JSON.stringify(withMeta, null, 2) + '\n', 'utf8');
console.log(`wrote ${join(outDir, 'ui-dna.schema.json')}`);
