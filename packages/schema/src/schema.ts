/**
 * The UI DNA document schema. Framework neutral: it describes what an
 * interface is made of and how it behaves, never how to render it.
 */
import { z } from 'zod';
import {
  attributed,
  MeasuredProvenanceSchema,
  ObservedProvenanceSchema,
  InferredProvenanceSchema,
  ProvenanceSchema,
  ViewportSchema,
} from './provenance.js';

/** Current schema version. Documents carry it as `dnaVersion`. */
export const UI_DNA_VERSION = '0.1.0';

const Id = z.string().min(1);
const IsoDateTime = z.iso.datetime({ offset: true });
const NonNegativeInt = z.number().int().min(0);

/** Structural path of a node from `<body>`: element-child indices joined by `/`, e.g. `0/2/1`. `<body>` itself is the empty string. */
export const NodePathSchema = z.string().regex(/^(\d+(\/\d+)*)?$/, 'node path: element-child indices joined by "/"');
export type NodePath = z.infer<typeof NodePathSchema>;

/** Axis-aligned box in CSS pixels, relative to the page (not the viewport). */
export const BoxSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0),
  height: z.number().min(0),
});
export type Box = z.infer<typeof BoxSchema>;

/** Budget limits (null = unlimited) and what was used. */
export const BudgetSchema = z.strictObject({
  limits: z.strictObject({
    timeMs: z.number().int().positive().nullable(),
    pages: z.number().int().positive().nullable(),
    actions: z.number().int().positive().nullable(),
    resources: z.number().int().positive().nullable(),
  }),
  used: z.strictObject({
    timeMs: NonNegativeInt,
    pages: NonNegativeInt,
    actions: NonNegativeInt,
    resources: NonNegativeInt,
  }),
});
export type Budget = z.infer<typeof BudgetSchema>;

/* ------------------------------------------------------------------ target */

/** What was scanned, when, with which budget and which tool version. */
export const TargetSchema = z.strictObject({
  kind: z.enum(['url', 'cdp']),
  /** Page URL for `url` targets; the page URL seen through CDP for `cdp` targets. */
  url: z.string().min(1),
  /** CDP endpoint and target id for `cdp` targets. Never contains credentials. */
  cdp: z.strictObject({ endpoint: z.string().min(1), targetId: z.string().optional() }).optional(),
  scanId: Id,
  scannedAt: IsoDateTime,
  viewports: z.array(ViewportSchema).min(1),
  budget: BudgetSchema,
  tool: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
});
export type Target = z.infer<typeof TargetSchema>;

/* --------------------------------------------------------------------- app */

/** A page of the application. Phase 1 scans observe one page. */
export const PageSchema = z.strictObject({
  id: Id,
  url: z.string().min(1),
  title: attributed(z.string()),
  stateIds: z.array(Id),
});
export type Page = z.infer<typeof PageSchema>;

/** A route pattern that maps to a page. */
export const RouteSchema = z.strictObject({
  id: Id,
  pattern: z.string().min(1),
  pageId: Id,
  provenance: ProvenanceSchema,
});
export type Route = z.infer<typeof RouteSchema>;

/** A landmark region shared by pages (header, nav, main, footer). */
export const LayoutRegionSchema = z.strictObject({
  role: z.string().min(1),
  name: z.string().nullable(),
  nodePath: NodePathSchema,
  nodeId: Id,
});

/** A layout shared across pages, described by its landmark regions. */
export const SharedLayoutSchema = z.strictObject({
  id: Id,
  pageIds: z.array(Id).min(1),
  regions: z.array(LayoutRegionSchema),
  provenance: ProvenanceSchema,
});
export type SharedLayout = z.infer<typeof SharedLayoutSchema>;

/** A navigation edge discovered from links. Edges to other origins are recorded, never followed. */
export const NavigationEdgeSchema = z.strictObject({
  id: Id,
  fromPageId: Id,
  to: z.strictObject({
    url: z.string().min(1),
    pageId: Id.nullable(),
    sameOrigin: z.boolean(),
    fragment: z.boolean(),
  }),
  via: z.strictObject({
    nodeId: Id,
    nodePath: NodePathSchema,
    role: z.string().nullable(),
    name: z.string().nullable(),
  }),
  followed: z.boolean(),
  provenance: ProvenanceSchema,
});
export type NavigationEdge = z.infer<typeof NavigationEdgeSchema>;

export const AppSchema = z.strictObject({
  pages: z.array(PageSchema),
  routes: z.array(RouteSchema),
  layouts: z.array(SharedLayoutSchema),
  navigation: z.array(NavigationEdgeSchema),
});
export type App = z.infer<typeof AppSchema>;

/* ------------------------------------------------------------------ states */

/** Reference to a stored screenshot. Paths are relative to the scan directory. */
export const ScreenshotRefSchema = z.strictObject({
  path: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  digest: z.string().min(1),
  /** True when the page was taller than the captured height. */
  truncated: z.boolean(),
});
export type ScreenshotRef = z.infer<typeof ScreenshotRefSchema>;

/** Accessibility properties of a node beyond role and name. */
export const A11yPropsSchema = z.strictObject({
  description: z.string().optional(),
  expanded: z.boolean().optional(),
  pressed: z.union([z.boolean(), z.literal('mixed')]).optional(),
  selected: z.boolean().optional(),
  checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
  disabled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  focusable: z.boolean().optional(),
  focused: z.boolean().optional(),
  level: z.number().int().optional(),
  haspopup: z.string().optional(),
  modal: z.boolean().optional(),
  controls: z.array(z.string()).optional(),
  /** Role tree position for replay locators: nth element with this role and name in the state. */
  nth: z.number().int().min(0).optional(),
});
export type A11yProps = z.infer<typeof A11yPropsSchema>;

/** Generated pseudo-element content that renders visibly (e.g. an accordion marker). */
export const PseudoElementSchema = z.strictObject({
  content: z.string(),
  styleId: z.string(),
});

/** A normalized element of a captured state. Values inherit the state's `provenance`. */
export const UiNodeSchema = z.strictObject({
  id: Id,
  parentId: Id.nullable(),
  path: NodePathSchema,
  depth: NonNegativeInt,
  tag: z.string().min(1),
  /** Computed accessibility role, or null when the node is ignored by the accessibility tree. */
  role: z.string().nullable(),
  /** Computed accessible name, or null when none. */
  name: z.string().nullable(),
  /** Allowlisted attributes, values truncated. */
  attrs: z.record(z.string(), z.string()),
  /** Own text content (direct text children, whitespace collapsed), or null. */
  text: z.string().nullable(),
  /** Bounding box, or null when the node is not rendered. */
  box: BoxSchema.nullable(),
  /** Key into the state's deduplicated style table. */
  styleId: z.string().min(1),
  a11y: A11yPropsSchema,
  visible: z.boolean(),
  interactive: z.boolean(),
  inForm: z.boolean(),
  childIds: z.array(Id),
  pseudo: z
    .strictObject({
      before: PseudoElementSchema.optional(),
      after: PseudoElementSchema.optional(),
    })
    .optional(),
});
export type UiNode = z.infer<typeof UiNodeSchema>;

/** One node of the flattened role tree used for digests and replay. */
export const RoleTreeNodeSchema = z.strictObject({
  nodeId: Id.nullable(),
  role: z.string().min(1),
  name: z.string(),
  depth: NonNegativeInt,
  states: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])),
});
export type RoleTreeNode = z.infer<typeof RoleTreeNodeSchema>;

/** A captured UI state: one page, one viewport, one moment. */
export const UiStateSchema = z.strictObject({
  id: Id,
  pageId: Id,
  /** `base` states are the page as loaded; `derived` states follow a transition. */
  kind: z.enum(['base', 'derived']),
  parentStateId: Id.nullable(),
  url: z.string().min(1),
  title: z.string(),
  viewport: ViewportSchema,
  capturedAt: IsoDateTime,
  evidenceId: Id,
  screenshot: ScreenshotRefSchema.nullable(),
  roleTreeDigest: z.string().min(1),
  domDigest: z.string().min(1),
  document: z.strictObject({
    width: NonNegativeInt,
    height: NonNegativeInt,
    scrollHeight: NonNegativeInt,
  }),
  nodeCount: NonNegativeInt,
  nodes: z.array(UiNodeSchema),
  /** Deduplicated computed styles, filtered to rendering properties. */
  styles: z.record(z.string(), z.record(z.string(), z.string())),
  roleTree: z.array(RoleTreeNodeSchema),
  /** Provenance of every node, style and role-tree entry in this state. */
  provenance: MeasuredProvenanceSchema,
});
export type UiState = z.infer<typeof UiStateSchema>;

/** Reference to the element an action targeted. */
export const ActionTargetSchema = z.strictObject({
  nodeId: Id,
  nodePath: NodePathSchema,
  role: z.string().nullable(),
  name: z.string().nullable(),
  tag: z.string().min(1),
  /** Position among elements with the same role and name in the originating state. */
  nth: NonNegativeInt,
});
export type ActionTarget = z.infer<typeof ActionTargetSchema>;

/** An interaction performed by the explorer. */
export const ActionSchema = z.strictObject({
  type: z.enum(['click', 'hover', 'focus', 'key']),
  target: ActionTargetSchema.nullable(),
  key: z.string().optional(),
});
export type Action = z.infer<typeof ActionSchema>;

/** An observed transition between two states. */
export const TransitionSchema = z.strictObject({
  id: Id,
  from: Id,
  action: ActionSchema,
  to: Id,
  /** True when the action triggered a non-GET request or a navigation. Never repeated. */
  sideEffects: z.boolean(),
  network: z.strictObject({ requests: NonNegativeInt, nonGet: NonNegativeInt }),
  revert: z.strictObject({
    method: z.enum(['escape', 'toggle', 'reload', 'none']),
    succeeded: z.boolean(),
  }),
  /** What changed: counts from the DOM diff and the screenshot diff. */
  change: z.strictObject({
    domChanged: z.boolean(),
    roleTreeChanged: z.boolean(),
    screenshotChanged: z.boolean(),
    changedNodeIds: z.array(Id),
  }),
  provenance: ObservedProvenanceSchema,
});
export type Transition = z.infer<typeof TransitionSchema>;

export const StatesSchema = z.strictObject({
  items: z.array(UiStateSchema),
  transitions: z.array(TransitionSchema),
});
export type States = z.infer<typeof StatesSchema>;

/* -------------------------------------------------------------- components */

/** A slot of a component that varies between instances. */
export const ComponentPropSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(['text', 'image', 'link', 'boolean', 'enum', 'number']),
  /** Path of the varying node relative to the component root. */
  relativePath: NodePathSchema,
  /** Distinct values seen across instances. */
  values: z.array(z.string()),
});
export type ComponentProp = z.infer<typeof ComponentPropSchema>;

/** A visual variant of a component. */
export const ComponentVariantSchema = z.strictObject({
  id: Id,
  instanceIds: z.array(Id).min(1),
  differences: z.array(
    z.strictObject({
      property: z.string().min(1),
      values: z.array(z.string()).min(1),
    }),
  ),
});
export type ComponentVariant = z.infer<typeof ComponentVariantSchema>;

/** A component candidate found by fingerprint matching. Naming is left to the agent. */
export const ComponentDefinitionSchema = z.strictObject({
  id: Id,
  fingerprint: z.string().min(1),
  /** Deterministic placeholder name such as `Component03`. */
  generatedName: z.string().min(1),
  /** Agent-given name, when annotated. */
  name: attributed(z.string()).optional(),
  structure: z.strictObject({
    tag: z.string().min(1),
    role: z.string().nullable(),
    /** Human-readable structure signature, e.g. `article>div+h3+p`. */
    signature: z.string().min(1),
    depth: NonNegativeInt,
    childCount: NonNegativeInt,
  }),
  props: z.array(ComponentPropSchema),
  variants: z.array(ComponentVariantSchema),
  instanceCount: NonNegativeInt,
  /** Instances per state id. */
  matchesByState: z.record(z.string(), NonNegativeInt),
  confidence: z.number().min(0).max(1),
  provenance: ProvenanceSchema,
});
export type ComponentDefinition = z.infer<typeof ComponentDefinitionSchema>;

/** A concrete occurrence of a component in a state. */
export const ComponentInstanceSchema = z.strictObject({
  id: Id,
  definitionId: Id,
  stateId: Id,
  nodeId: Id,
  nodePath: NodePathSchema,
  box: attributed(BoxSchema),
  variantId: Id.nullable(),
  props: z.record(z.string(), z.string()),
});
export type ComponentInstance = z.infer<typeof ComponentInstanceSchema>;

export const ComponentsSchema = z.strictObject({
  definitions: z.array(ComponentDefinitionSchema),
  instances: z.array(ComponentInstanceSchema),
});
export type Components = z.infer<typeof ComponentsSchema>;

/* ------------------------------------------------------------------ visual */

/** Evidence behind a token: which measured values were clustered and how often each occurred. */
export const TokenClusterSchema = z.strictObject({
  sampleCount: z.number().int().min(1),
  members: z.array(z.strictObject({ value: z.string(), count: z.number().int().min(1) })).min(1),
  /** CSS properties the samples came from. */
  properties: z.array(z.string()),
  /** Largest distance between members in the clustering metric, when more than one member. */
  spread: z.number().min(0).optional(),
});
export type TokenCluster = z.infer<typeof TokenClusterSchema>;

export const TOKEN_KINDS = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'spacing',
  'radius',
  'shadow',
  'breakpoint',
] as const;

/** A design token backed by cluster evidence. */
export const TokenSchema = z.strictObject({
  id: Id,
  kind: z.enum(TOKEN_KINDS),
  generatedName: z.string().min(1),
  name: attributed(z.string()).optional(),
  value: attributed(z.string()),
  cluster: TokenClusterSchema,
  usage: z.strictObject({
    count: NonNegativeInt,
    stateIds: z.array(Id),
    nodeIds: z.array(Id).optional(),
  }),
});
export type Token = z.infer<typeof TokenSchema>;

/** A composite typography style (family, size, weight, line height) seen on text nodes. */
export const TypographyStyleSchema = z.strictObject({
  id: Id,
  generatedName: z.string().min(1),
  name: attributed(z.string()).optional(),
  fontFamily: attributed(z.string()),
  fontSize: attributed(z.string()),
  fontWeight: attributed(z.string()),
  lineHeight: attributed(z.string()),
  letterSpacing: attributed(z.string()).optional(),
  textTransform: attributed(z.string()).optional(),
  sampleCount: z.number().int().min(1),
  nodeIds: z.array(Id).optional(),
  stateIds: z.array(Id),
});
export type TypographyStyle = z.infer<typeof TypographyStyleSchema>;

export const TokensSchema = z.strictObject({
  colors: z.array(TokenSchema),
  typography: z.array(TypographyStyleSchema),
  fontFamilies: z.array(TokenSchema),
  fontSizes: z.array(TokenSchema),
  spacing: z.array(TokenSchema),
  radii: z.array(TokenSchema),
  shadows: z.array(TokenSchema),
  breakpoints: z.array(TokenSchema),
});
export type Tokens = z.infer<typeof TokensSchema>;

const AttrString = attributed(z.string());

/** Layout constraints of a container node in one state. */
export const LayoutConstraintSchema = z.strictObject({
  stateId: Id,
  nodeId: Id,
  nodePath: NodePathSchema,
  box: attributed(BoxSchema),
  display: AttrString,
  position: AttrString,
  flow: z
    .strictObject({
      direction: AttrString.optional(),
      wrap: AttrString.optional(),
      justify: AttrString.optional(),
      align: AttrString.optional(),
      gap: AttrString.optional(),
    })
    .optional(),
  grid: z
    .strictObject({
      templateColumns: AttrString.optional(),
      templateRows: AttrString.optional(),
      autoFlow: AttrString.optional(),
      gap: AttrString.optional(),
    })
    .optional(),
  sizing: z.strictObject({
    width: AttrString,
    height: AttrString,
    minWidth: AttrString.optional(),
    maxWidth: AttrString.optional(),
    minHeight: AttrString.optional(),
    maxHeight: AttrString.optional(),
  }),
  spacing: z.strictObject({
    margin: AttrString,
    padding: AttrString,
  }),
});
export type LayoutConstraint = z.infer<typeof LayoutConstraintSchema>;

export const VisualSchema = z.strictObject({
  tokens: TokensSchema,
  layout: z.array(LayoutConstraintSchema),
});
export type Visual = z.infer<typeof VisualSchema>;

/* ---------------------------------------------------------------- behavior */

/** What a transition did to the page, as far as it could be determined. */
export const BehaviorEffectSchema = z.strictObject({
  kind: z.enum([
    'toggle-attribute',
    'set-attribute',
    'show',
    'hide',
    'toggle-class',
    'style-change',
    'navigate',
    'unknown',
  ]),
  attribute: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /** Node whose attribute, class or visibility changed. */
  targetNodeId: Id.optional(),
  targetNodePath: NodePathSchema.optional(),
  details: z.string().optional(),
});
export type BehaviorEffect = z.infer<typeof BehaviorEffectSchema>;

/** An event → transition pair, observed by the explorer or inferred by the agent. */
export const BehaviorRuleSchema = z.strictObject({
  id: Id,
  event: z.strictObject({
    type: z.enum(['click', 'hover', 'focus', 'key']),
    target: ActionTargetSchema,
    key: z.string().optional(),
  }),
  transitionId: Id.nullable(),
  effects: z.array(BehaviorEffectSchema),
  provenance: z.discriminatedUnion('kind', [ObservedProvenanceSchema, InferredProvenanceSchema]),
});
export type BehaviorRule = z.infer<typeof BehaviorRuleSchema>;

/* ------------------------------------------------------------------ assets */

export const AssetSchema = z.strictObject({
  id: Id,
  kind: z.enum(['font', 'image', 'svg', 'video', 'icon', 'other']),
  url: z.string().min(1),
  origin: z.enum(['same-origin', 'cross-origin', 'inline', 'data']),
  mime: z.string().optional(),
  bytes: NonNegativeInt.optional(),
  digest: z.string().optional(),
  width: NonNegativeInt.optional(),
  height: NonNegativeInt.optional(),
  /** Local copy relative to the scan directory, when one was stored. */
  localPath: z.string().optional(),
  /** Authorization to reuse the asset. `unknown` by default; only the user or agent may set `authorized`. */
  authorization: z.enum(['unknown', 'authorized', 'unauthorized']),
  usage: z.array(z.strictObject({ stateId: Id, nodeId: Id, nodePath: NodePathSchema })),
  provenance: ProvenanceSchema,
});
export type Asset = z.infer<typeof AssetSchema>;

/* ------------------------------------------------------------- limitations */

export const LimitationSchema = z.strictObject({
  kind: z.enum(['not-observed', 'not-accessible', 'not-reconstructable']),
  subject: z.string().min(1),
  reason: z.string().min(1),
  stateId: Id.optional(),
  nodeId: Id.optional(),
  nodePath: NodePathSchema.optional(),
  evidenceId: Id.optional(),
});
export type Limitation = z.infer<typeof LimitationSchema>;

/* ---------------------------------------------------------------- evidence */

/** Index entry pointing at artifacts that back values in the document. */
export const EvidenceRefSchema = z.strictObject({
  id: Id,
  kind: z.string().min(1),
  artifacts: z.array(z.string()),
  capturedAt: IsoDateTime,
  inputs: z.record(z.string(), z.unknown()).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Record of an agent annotation applied through `annotate_dna`. */
export const AnnotationRecordSchema = z.strictObject({
  id: Id,
  appliedAt: IsoDateTime,
  /** JSON pointer to the annotated location. */
  path: z.string().min(1),
  op: z.enum(['annotate', 'name', 'authorize', 'limitation', 'behavior']),
  value: z.unknown(),
  provenance: InferredProvenanceSchema,
});
export type AnnotationRecord = z.infer<typeof AnnotationRecordSchema>;

/* ---------------------------------------------------------------- document */

const SemverPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const UiDnaDocumentBase = z.strictObject({
  dnaVersion: z.string().regex(SemverPattern, 'dnaVersion must be semver'),
  target: TargetSchema,
  app: AppSchema,
  states: StatesSchema,
  components: ComponentsSchema,
  visual: VisualSchema,
  behavior: z.array(BehaviorRuleSchema),
  assets: z.array(AssetSchema),
  limitations: z.array(LimitationSchema),
  evidence: z.array(EvidenceRefSchema),
  annotations: z.array(AnnotationRecordSchema),
});

/** Cross-reference checks that the structural schema cannot express. */
function checkReferences(doc: z.infer<typeof UiDnaDocumentBase>, ctx: z.RefinementCtx): void {
  const stateIds = new Set(doc.states.items.map((s) => s.id));
  const pageIds = new Set(doc.app.pages.map((p) => p.id));
  const definitionIds = new Set(doc.components.definitions.map((d) => d.id));
  const transitionIds = new Set(doc.states.transitions.map((t) => t.id));

  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path, message });
  };

  if (stateIds.size !== doc.states.items.length) issue(['states', 'items'], 'duplicate state ids');

  doc.states.items.forEach((state, i) => {
    if (!pageIds.has(state.pageId)) issue(['states', 'items', i, 'pageId'], `unknown page ${state.pageId}`);
    if (state.parentStateId !== null && !stateIds.has(state.parentStateId)) {
      issue(['states', 'items', i, 'parentStateId'], `unknown state ${state.parentStateId}`);
    }
    if (state.nodeCount !== state.nodes.length) issue(['states', 'items', i, 'nodeCount'], 'nodeCount must equal nodes.length');
    const nodeIds = new Set(state.nodes.map((n) => n.id));
    state.nodes.forEach((node, j) => {
      if (!(node.styleId in state.styles)) issue(['states', 'items', i, 'nodes', j, 'styleId'], `unknown style ${node.styleId}`);
      if (node.parentId !== null && !nodeIds.has(node.parentId)) {
        issue(['states', 'items', i, 'nodes', j, 'parentId'], `unknown parent ${node.parentId}`);
      }
    });
    if (state.provenance.stateId !== undefined && state.provenance.stateId !== state.id) {
      issue(['states', 'items', i, 'provenance', 'stateId'], 'state provenance must point at the state itself');
    }
  });

  doc.app.pages.forEach((page, i) => {
    page.stateIds.forEach((id, j) => {
      if (!stateIds.has(id)) issue(['app', 'pages', i, 'stateIds', j], `unknown state ${id}`);
    });
  });

  doc.states.transitions.forEach((t, i) => {
    if (!stateIds.has(t.from)) issue(['states', 'transitions', i, 'from'], `unknown state ${t.from}`);
    if (!stateIds.has(t.to)) issue(['states', 'transitions', i, 'to'], `unknown state ${t.to}`);
  });

  doc.components.instances.forEach((inst, i) => {
    if (!definitionIds.has(inst.definitionId)) {
      issue(['components', 'instances', i, 'definitionId'], `unknown component ${inst.definitionId}`);
    }
    if (!stateIds.has(inst.stateId)) issue(['components', 'instances', i, 'stateId'], `unknown state ${inst.stateId}`);
  });

  doc.visual.layout.forEach((c, i) => {
    if (!stateIds.has(c.stateId)) issue(['visual', 'layout', i, 'stateId'], `unknown state ${c.stateId}`);
  });

  doc.behavior.forEach((rule, i) => {
    if (rule.transitionId !== null && !transitionIds.has(rule.transitionId)) {
      issue(['behavior', i, 'transitionId'], `unknown transition ${rule.transitionId}`);
    }
  });

  doc.assets.forEach((asset, i) => {
    asset.usage.forEach((u, j) => {
      if (!stateIds.has(u.stateId)) issue(['assets', i, 'usage', j, 'stateId'], `unknown state ${u.stateId}`);
    });
  });
}

/** The UI DNA document, structurally and referentially validated. */
export const UiDnaDocumentSchema = UiDnaDocumentBase.superRefine(checkReferences);
export type UiDnaDocument = z.infer<typeof UiDnaDocumentBase>;

/** The structural schema without cross-reference checks (used for JSON Schema generation). */
export const UiDnaDocumentStructureSchema = UiDnaDocumentBase;
