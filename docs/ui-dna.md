# The UI DNA document

A UI DNA document describes a user interface the way an engineer needs it described to
rebuild it: what is on the page, how it is laid out, which values repeat, how it reacts
to interaction, and what could not be observed. It is produced by `uidna scan` and
`uidna explore`, refined by the host agent through `annotate_dna`, and consumed by the
generator, the verifier and any other tool that wants it.

The schema is published as [`@rohzzn/uidna-schema`](../packages/schema) (Zod, JSON Schema and
TypeScript types) and versioned with `dnaVersion`. It is framework neutral: nothing in
it mentions React, Tailwind or any other output framework.

A complete, validated example produced from Fixture A lives in
[`docs/examples/fixture-a.dna.json`](examples/fixture-a.dna.json): one viewport
(390 px) and four safe clicks (the hamburger and the three accordion items), five states
and five transitions. The snippets below are abbreviated illustrations of the same
shapes, not verbatim copies.

## Provenance

Every measured or inferred value is wrapped:

```json
{
  "value": "248px",
  "provenance": {
    "kind": "measured",
    "source": "computed-style",
    "stateId": "st_01",
    "viewport": { "width": 1280, "height": 800 },
    "evidenceId": "ev_3f9a1c7b2d4e",
    "capturedAt": "2026-10-13T17:29:00.000Z",
    "confidence": 0.98
  }
}
```

| kind       | meaning                                                                  | allowed sources                                                          |
| ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `measured` | read directly from the browser (a computed style, a box, an AX node)     | `computed-style`, `bounding-box`, `a11y-tree`, `screenshot`, `network`   |
| `observed` | seen to happen (a transition after a click, a layout change at a width)  | same as measured, mostly `interaction`                                   |
| `inferred` | written by the host agent through `annotate_dna`                         | `agent` only, and `agent` is only ever `inferred`                        |
| `unknown`  | not obtained; carries a `reason` and `value` is `null`                   | optional source hint                                                     |

Measured wins over observed, observed over inferred. The instrument never writes
`inferred`. An agent annotation never replaces a measured value: it is stored next to it
under `annotation`, so both readings survive.

```json
{
  "value": "#2f5bea",
  "provenance": { "kind": "measured", "source": "computed-style", "capturedAt": "…", "confidence": 1 },
  "annotation": {
    "value": "brand-primary",
    "provenance": { "kind": "inferred", "source": "agent", "capturedAt": "…", "confidence": 0.8, "rationale": "matches the logo" }
  }
}
```

## Top-level shape

| section       | what it holds                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `dnaVersion`  | semver of the schema the document follows                                                                      |
| `target`      | URL or CDP target, scan id, time, viewports, budget limits and usage, tool version                              |
| `app`         | pages, routes, shared layouts (landmark regions), navigation edges discovered from links (recorded, not followed) |
| `states`      | captured states (one per page × viewport × moment) and the transitions between them                            |
| `components`  | fingerprinted component candidates and their instances                                                         |
| `visual`      | token clusters with evidence, and layout constraints per container node                                        |
| `behavior`    | event → transition rules, observed by the explorer or inferred by the agent                                    |
| `assets`      | fonts, images, SVGs with origin and authorization status                                                       |
| `limitations` | what was not observed, not accessible or not reconstructable, each with a reason                               |
| `evidence`    | index of evidence ids to artifact paths                                                                        |
| `annotations` | log of agent patches applied through `annotate_dna`                                                            |

Documents are validated on every read and write. Cross-references (state ids in
transitions, definition ids in instances, style ids in nodes) must resolve; an invalid
document is never stored.

## States and nodes

A state is one page at one viewport at one moment. Base states are the page as loaded;
derived states follow a transition and point at their parent.

Each state carries its normalized node tree. Nodes are elements only, in document order,
with a structural `path` (element-child indices from `<body>`, e.g. `1/2/0`), the tag,
allowlisted attributes, own text, the bounding box in page coordinates (or `null` when not
rendered), a `styleId` into the state's deduplicated style table, the computed
accessibility role and name, and accessibility properties. Styles are filtered to the
rendering properties listed in `src/browser/style-properties.ts`, with user-agent
defaults dropped.

Because every node of a state was captured together, nodes share the state's single
`provenance` instead of carrying one each. Values derived from nodes (tokens, layout
constraints, component boxes) are wrapped individually.

Content of a closed `<details>` element (everything but its summary) is recorded with
`box: null` and `visible: false` even when Chromium keeps a retained layout box for it,
so a derived state that opens the panel shows the panel's nodes becoming visible.

Tokens are measured over every state, including hover and focus states. Layout
constraints and component instances are measured over base states only; derived states
repeat the same structure and would multiply the document by the number of recorded
interactions.

```json
{
  "id": "n7",
  "parentId": "n3",
  "path": "0/0/1",
  "depth": 3,
  "tag": "button",
  "role": "button",
  "name": "Open menu",
  "attrs": { "class": "nav-toggle", "type": "button", "aria-expanded": "false", "aria-controls": "primary-menu", "aria-label": "Open menu" },
  "text": null,
  "box": { "x": 326, "y": 16, "width": 40, "height": 40 },
  "styleId": "a1b2c3d4e5f6",
  "a11y": { "expanded": false, "focusable": true, "nth": 0 },
  "visible": true,
  "interactive": true,
  "inForm": false,
  "childIds": ["n8", "n9", "n10"]
}
```

The role tree is the flattened list of nodes with a role; its digest identifies a state's
accessible structure, and the DOM digest identifies its markup. Two captures with equal
digests are the same state.

## Transitions

A transition records an action on a node of one state and the state it led to:

```json
{
  "id": "tr_01",
  "from": "st_03",
  "action": { "type": "click", "target": { "nodeId": "n7", "nodePath": "0/0/1", "role": "button", "name": "Open menu", "tag": "button", "nth": 0 } },
  "to": "st_04",
  "sideEffects": false,
  "network": { "requests": 0, "nonGet": 0 },
  "revert": { "method": "toggle", "succeeded": true },
  "change": { "domChanged": true, "roleTreeChanged": true, "screenshotChanged": true, "changedNodeIds": ["n7", "n11"] },
  "provenance": { "kind": "observed", "source": "interaction", "stateId": "st_03", "capturedAt": "…", "confidence": 1 }
}
```

`sideEffects` is true when the action caused a non-GET request or a navigation; such
actions are never repeated. Skipped interactions are not transitions: they are reported
as unknowns with their reason by `explore_interactions`.

## Components

Component candidates come from fingerprints: the normalized structure (tags and roles to
a limited depth, text and images abstracted), a coarse style class and the root role.
Class names and text are not part of the fingerprint, so three cards with different copy
match. A definition lists its instances per state, the props that vary between instances
(text, image, link), style variants and a confidence derived from structural and style
agreement. Naming is left to the agent; `generatedName` is a placeholder.

## Tokens

Tokens are clusters of measured values. A cluster lists every member value with its
sample count, the properties it came from and the spread of the cluster. Values are only
merged when the clustering evidence supports it; the token's `confidence` is the share of
the representative member. Breakpoints are observed, not measured: a viewport width is a
breakpoint token when the layout at that width differs from the next wider one.

```json
{
  "id": "tok_color_01",
  "kind": "color",
  "generatedName": "color-01",
  "value": { "value": "#1b1f2a", "provenance": { "kind": "measured", "source": "computed-style", "capturedAt": "…", "confidence": 1 } },
  "cluster": { "sampleCount": 23, "members": [{ "value": "rgb(27, 31, 42)", "count": 23 }], "properties": ["color"] },
  "usage": { "count": 23, "stateIds": ["st_01", "st_02", "st_03"] }
}
```

## Behavior, assets, limitations

A behavior rule pairs an event on a target with the transition it produced and the
effects seen in the DOM (an attribute toggled, a node shown or hidden, a class toggled,
a style change). Rules derived from recorded transitions are `observed`; rules written by
the agent are `inferred`.

Assets carry their origin (`same-origin`, `cross-origin`, `inline`, `data`) and an
`authorization` that starts as `unknown`. Only the user or the agent can set
`authorized`; unauthorized assets become labeled placeholders in generated projects.

Limitations are first-class: `not-observed` (a lazy-loaded region below the capture
height, an interaction skipped by policy), `not-accessible` (an iframe that was not
entered), `not-reconstructable` (inline SVG markup, a cross-origin asset). Each has a
reason and, when it applies, the state and node it concerns.

## Pages, crawls and navigation (0.2.0)

A scan may crawl same-origin links breadth-first. Each crawled page is an `app.pages[]`
entry with its `depth` from the seed and `discoveredVia`, the navigation edge that led
there; its base states carry the page's `pageId`. Navigation edges to crawled pages have
`followed: true` and a `pageId`; cross-origin edges are recorded with `sameOrigin: false`
and never followed. A transition whose click led to another crawled page carries
`navigation: { toPageId, url }` and points at a base state of that page. Pages share a
`SharedLayout` when their landmark regions agree structurally, and a component
candidate that appears on several pages lists them in `pageIds`. Per-page
`coverage` records how many interactive elements were discovered, how many
interactions were attempted, how many changed the page and how many were skipped.

## Forms (0.2.0)

Form controls carry `form` facts: native validity, the browser's validation message when
invalid, `required`, the control type and whether a value was present. Values of
sensitive controls are never stored, and the explorer only ever types synthetic values.
With the `forms` exploration policy, `fill` actions (with the synthetic `value`) and
`submit` actions produce derived states that show client-side validation; the submission
request itself is blocked and the transition is marked `sideEffects: true`.
`A11yProps.invalid` and `errorMessage` expose the accessibility view of the same facts.

## Data assets (0.2.0)

When a scan opts into `captureBodies: "json"`, JSON responses of XHR and fetch requests
become assets of kind `data`: a redacted copy under `localPath`, the `request` that
produced them and `measured` / `network` provenance. Generators turn them into typed,
labeled mocks; no backend is ever implied.

## Breakpoints and responsive rules (0.3.0)

`visual.responsive` says where the layout changes, which the scanned widths alone cannot
tell. The scan reads the width conditions of the page's readable stylesheets (`@media`,
an `@import` media list, a `<link media>`) into `conditions`, each with its `thresholds`:
the smallest viewport width of the wider side, so `(max-width: 599px)` and
`(min-width: 600px)` both flip at 600. A `print` condition is `never`; parts the parser
could not convert to pixels are listed as `unsupported`. Cross-origin stylesheets cannot
be read and are reported as limitations.

Probing then resizes the page between the scanned widths, with no other interaction and
every non-GET request blocked, and compares a layout signature (rendered or not,
`display`, `position`, `flex-direction`, `float`, grid track count). A stylesheet
threshold inside a changing interval is confirmed one pixel apart; any remaining change is
bisected within a budget. Each located change is a `breakpoint` with `minWidth`, the
`bracket` that located it (`lower < minWidth <= upper`), and `source: "css"` when a
condition explains it or `"probe"` when none does. `rules` list the layout properties of
each node that change there, with their values `below` and `above`; properties the
signature leaves out (sizes, fonts, colors) are added from the two captures around a
stylesheet threshold when the condition's rules declare them. `observedEffect` on a
condition is `false` when probing saw no change at its threshold and `null` when no probe
reached it (a threshold above the widest scanned width). `probes` record the widths
measured per page.

Breakpoint tokens in `visual.tokens.breakpoints` keep their 0.2.0 meaning: observed
differences between scanned widths.

## Collections (0.3.0)

`collections.definitions` lists repeated items measured in each page's widest base
state: table rows, list items, card grids. A collection names its container, the item
`identity` (an identity attribute such as `data-id`, else a digest of the item's text,
never a node path), its `fields` (table columns with their header text, or text-bearing
parts present in most items) with a `valueKind` (`number`, `date`, `text`), and the items
in base order with their displayed values.

`collections.rules` classify observed transitions by item identity against the base
items: `search` (a fill on a search control left a subset, with the `match` and the
fields that explain both the kept and the removed items), `filter` (a control left a
subset; the predicate is a field `equals` or `contains` the control's label, else the
observed membership `in-keys`), `sort` (same items, new order; the field, direction and
comparator that explain it, and the `aria-sort` the page showed) and `reset` (back to the
base view). Each rule keeps the views before and after, and the empty-state message
shown when no item remained. Rules are `observed`; an agent's reading of them belongs in
annotations.

## Versioning

`dnaVersion` follows semver. Readers accept documents of the same major version.
Additions within a major are backwards compatible; removals or meaning changes bump the
major. See [`packages/schema/CHANGELOG.md`](../packages/schema/CHANGELOG.md).
