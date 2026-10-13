# @uidna/schema

The UI DNA document schema. A UI DNA document describes a user interface the
way an engineer would need it described to rebuild it: pages and navigation,
observed states and the transitions between them, component candidates with
their instances, visual tokens with the measurements that support them, layout
constraints per node, observed behavior, assets and, just as importantly, what
could not be observed.

Every measured or inferred value is wrapped in a provenance envelope that says
how it was obtained, from which state and viewport, with which evidence and
with what confidence. Values that are not known are marked `unknown` with a
reason. They are never empty strings, zeros or `false`.

The schema is framework neutral. It contains no React, Tailwind or other
output-framework terms, so any generator or tool can consume it.

```ts
import { parseUiDna, validateUiDna, UI_DNA_VERSION } from '@uidna/schema';

const result = validateUiDna(JSON.parse(text));
if (!result.success) console.error(result.error.issues);
```

The JSON Schema is published at `@uidna/schema/ui-dna.schema.json`. The full
reference lives in `docs/ui-dna.md` in the UI DNA repository.
