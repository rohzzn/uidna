/**
 * Assemble a UI DNA document from a scan record, its captures and any
 * observed transitions. Everything measured comes from the captures; agent
 * work from a previous version of the document (names, asset authorizations,
 * inferred behavior rules, agent limitations, the annotation log) is carried
 * over so re-assembly after `explore` never loses it. The result is validated
 * before it is returned.
 */
import type {
  AnnotationRecord,
  Asset,
  BehaviorRule,
  ComponentDefinition,
  EvidenceRef,
  Limitation,
  NavigationEdge,
  ProvenanceContext,
  SharedLayout,
  Token,
  Transition,
  TypographyStyle,
  UiDnaDocument,
  UiNode,
  UiState,
} from '@rohzzn/uidna-schema';
import { formatIssues, LimitationSchema, measured, UI_DNA_VERSION, validateUiDna } from '@rohzzn/uidna-schema';
import type { CapturedAsset, CapturedState } from '../browser/types.js';
import type { ScanRecord, StateRecord } from '../application/records.js';
import { isoNow, systemClock, type Clock } from '../domain/clock.js';
import { stableStringify } from '../domain/digest.js';
import { uidnaError } from '../domain/errors.js';
import { sequentialId } from '../domain/ids.js';
import { err, ok, type Result } from '../domain/result.js';
import { deriveBehavior } from './behavior.js';
import { distinct, latestCapturedAt, stateContext, type EvidenceIndex } from './common.js';
import { findComponents } from './components.js';
import { computeLayout } from './layout.js';
import { extractTokens } from './tokens.js';

/** Input of `assembleDna`. */
export interface AssembleInput {
  readonly scan: ScanRecord;
  /** Captures keyed by state id; states listed in the scan without a capture are reported as limitations. */
  readonly captures: ReadonlyMap<string, CapturedState>;
  readonly transitions?: readonly Transition[];
  /** The previous version of the document, whose agent work is carried over. */
  readonly previous?: UiDnaDocument | null;
  readonly toolVersion: string;
  /** Only used to timestamp `scannedAt` when the scan record carries no usable time. */
  readonly clock?: Clock;
}

/** Landmark roles that make up a shared layout. */
export const LANDMARK_ROLES: readonly string[] = ['banner', 'navigation', 'main', 'contentinfo', 'complementary'];

const posix = (path: string): string => path.replace(/\\/g, '/');

interface OrderedState {
  readonly record: StateRecord;
  readonly capture: CapturedState;
}

function toUiState(entry: OrderedState, pageId: string, parentStateId: string | null): UiState {
  const { record, capture } = entry;
  const screenshot =
    capture.screenshot === null
      ? null
      : {
          path: posix(record.screenshotPath ?? capture.screenshot.path),
          width: capture.screenshot.width,
          height: capture.screenshot.height,
          digest: capture.screenshot.digest,
          truncated: capture.screenshot.truncated,
        };
  return {
    id: record.stateId,
    pageId,
    kind: record.kind,
    parentStateId,
    url: capture.url,
    title: capture.title,
    viewport: capture.viewport,
    capturedAt: capture.capturedAt,
    evidenceId: record.evidenceId,
    screenshot,
    roleTreeDigest: capture.roleTreeDigest,
    domDigest: capture.domDigest,
    document: { ...capture.document },
    nodeCount: capture.nodes.length,
    nodes: capture.nodes.map((node) => ({ ...node, attrs: { ...node.attrs }, childIds: [...node.childIds] })),
    styles: Object.fromEntries(Object.entries(capture.styles).map(([id, style]) => [id, { ...style }])),
    roleTree: capture.roleTree.map((entry) => ({ ...entry, states: { ...entry.states } })),
    provenance: {
      kind: 'measured',
      source: 'computed-style',
      stateId: record.stateId,
      viewport: capture.viewport,
      evidenceId: record.evidenceId,
      capturedAt: capture.capturedAt,
      confidence: 1,
    },
  };
}

/* ------------------------------------------------------------------- app */

function buildNavigation(pageId: string, pageUrl: string, widest: OrderedState, context: ProvenanceContext, limitations: Limitation[]): NavigationEdge[] {
  const edges: NavigationEdge[] = [];
  let page: URL | null = null;
  try {
    page = new URL(pageUrl);
  } catch {
    page = null;
  }
  if (page === null) {
    limitations.push({ kind: 'not-observed', subject: 'navigation', reason: `page URL ${pageUrl} could not be parsed; links were not resolved`, stateId: widest.record.stateId });
    return edges;
  }
  const pageWithoutHash = `${page.origin}${page.pathname}${page.search}`;
  let unresolved = 0;
  for (const node of widest.capture.nodes) {
    if (node.tag.toLowerCase() !== 'a') continue;
    const href = node.attrs.href;
    if (href === undefined || href.trim().length === 0) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, page);
    } catch {
      unresolved += 1;
      continue;
    }
    const sameDocument = `${resolved.origin}${resolved.pathname}${resolved.search}` === pageWithoutHash;
    const fragment = href.trim().startsWith('#') || (sameDocument && resolved.hash.length > 0);
    edges.push({
      id: sequentialId('nav', edges.length + 1),
      fromPageId: pageId,
      to: { url: resolved.toString(), pageId: sameDocument ? pageId : null, sameOrigin: resolved.origin === page.origin, fragment },
      via: { nodeId: node.id, nodePath: node.path, role: node.role, name: node.name },
      followed: false,
      provenance: measured(null, 'a11y-tree', context, 1).provenance,
    });
  }
  if (unresolved > 0) {
    limitations.push({
      kind: 'not-observed',
      subject: 'navigation',
      reason: `${unresolved} link href value(s) could not be resolved against the page URL`,
      stateId: widest.record.stateId,
    });
  }
  return edges;
}

function buildLayout(pageId: string, widest: OrderedState, context: ProvenanceContext): SharedLayout {
  const regions = widest.capture.nodes
    .filter((node) => node.role !== null && LANDMARK_ROLES.includes(node.role))
    .map((node) => ({ role: node.role ?? '', name: node.name, nodePath: node.path, nodeId: node.id }));
  return { id: 'lay_01', pageIds: [pageId], regions, provenance: measured(null, 'a11y-tree', context, 1).provenance };
}

/* ---------------------------------------------------------------- assets */

interface MergedAsset {
  readonly first: CapturedAsset;
  readonly firstStateId: string;
  readonly fields: { mime?: string; bytes?: number; digest?: string; width?: number; height?: number; localPath?: string };
  readonly usage: { stateId: string; nodeId: string; nodePath: string }[];
  seenOnNetwork: boolean;
}

/**
 * Identity of an asset across states. URLs identify fetched and data assets.
 * Inline assets are named after node ids (`inline:n12`), which are positional
 * per capture, so they are keyed by the structural path of the node that
 * holds them instead; when that node is not in the capture, the asset stays
 * private to its state.
 */
function assetKey(asset: CapturedAsset, stateId: string, nodesById: ReadonlyMap<string, UiNode>): string {
  if (asset.origin !== 'inline') return asset.url;
  for (const nodeId of asset.usedBy) {
    const node = nodesById.get(nodeId);
    if (node) return `inline\u0000path:${node.path}`;
  }
  return `inline\u0000state:${stateId}:${asset.url}`;
}

function buildAssets(states: readonly OrderedState[], previous: UiDnaDocument | null | undefined, evidence: EvidenceIndex, fallbackCapturedAt: string): Asset[] {
  const merged = new Map<string, MergedAsset>();
  for (const { record, capture } of states) {
    const nodesById = new Map(capture.nodes.map((node) => [node.id, node]));
    const networkUrls = new Set(capture.network.map((entry) => entry.url));
    for (const asset of capture.assets) {
      const key = assetKey(asset, record.stateId, nodesById);
      const entry = merged.get(key) ?? { first: asset, firstStateId: record.stateId, fields: {}, usage: [], seenOnNetwork: false };
      const fields = entry.fields;
      if (fields.mime === undefined && asset.mime !== undefined) fields.mime = asset.mime;
      if (fields.bytes === undefined && asset.bytes !== undefined) fields.bytes = asset.bytes;
      if (fields.digest === undefined && asset.digest !== undefined) fields.digest = asset.digest;
      if (fields.width === undefined && asset.width !== undefined) fields.width = asset.width;
      if (fields.height === undefined && asset.height !== undefined) fields.height = asset.height;
      if (fields.localPath === undefined && asset.localPath !== undefined) fields.localPath = posix(asset.localPath);
      if (networkUrls.has(asset.url)) entry.seenOnNetwork = true;
      for (const nodeId of asset.usedBy) {
        const node = nodesById.get(nodeId);
        if (!node) continue;
        if (!entry.usage.some((u) => u.stateId === record.stateId && u.nodeId === nodeId)) {
          entry.usage.push({ stateId: record.stateId, nodeId, nodePath: node.path });
        }
      }
      merged.set(key, entry);
    }
  }

  const previousByUrl = new Map((previous?.assets ?? []).map((asset) => [asset.url, asset]));
  const previousByDigest = new Map((previous?.assets ?? []).filter((a) => a.digest !== undefined).map((asset) => [asset.digest ?? '', asset]));
  const captureById = new Map(states.map((s) => [s.record.stateId, s.capture]));

  return [...merged.values()].map((entry, i) => {
    const prior = previousByUrl.get(entry.first.url) ?? (entry.fields.digest === undefined ? undefined : previousByDigest.get(entry.fields.digest));
    const capture = captureById.get(entry.firstStateId);
    const context: ProvenanceContext = capture ? stateContext(entry.firstStateId, capture, evidence) : { capturedAt: fallbackCapturedAt };
    const source = entry.seenOnNetwork ? 'network' : 'a11y-tree';
    return {
      id: sequentialId('ast', i + 1),
      kind: entry.first.kind,
      url: entry.first.url,
      origin: entry.first.origin,
      ...(entry.fields.mime === undefined ? {} : { mime: entry.fields.mime }),
      ...(entry.fields.bytes === undefined ? {} : { bytes: entry.fields.bytes }),
      ...(entry.fields.digest === undefined ? {} : { digest: entry.fields.digest }),
      ...(entry.fields.width === undefined ? {} : { width: entry.fields.width }),
      ...(entry.fields.height === undefined ? {} : { height: entry.fields.height }),
      ...(entry.fields.localPath === undefined ? {} : { localPath: entry.fields.localPath }),
      authorization: prior?.authorization ?? 'unknown',
      usage: entry.usage,
      provenance: measured(null, source, context, 1).provenance,
    };
  });
}

/* ----------------------------------------------------------- limitations */

function captureLimitations(states: readonly OrderedState[], evidence: EvidenceIndex): Limitation[] {
  const out: Limitation[] = [];
  const seenPaths = new Set<string>();
  for (const { record, capture } of states) {
    const stateId = record.stateId;
    const evidenceId = evidence[stateId];
    const withEvidence = evidenceId === undefined ? {} : { evidenceId };
    for (const reason of capture.limitations) {
      out.push({ kind: 'not-observed', subject: `state ${stateId}`, reason, stateId, ...withEvidence });
    }
    if (capture.screenshot?.truncated) {
      out.push({
        kind: 'not-observed',
        subject: `screenshot of ${stateId}`,
        reason: `page height ${capture.document.scrollHeight}px exceeds the captured ${capture.screenshot.height}px; the screenshot is truncated`,
        stateId,
        ...withEvidence,
      });
    }
    for (const node of capture.nodes) {
      const tag = node.tag.toLowerCase();
      if (tag !== 'iframe' && tag !== 'svg') continue;
      const key = `${tag}:${node.path}`;
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      if (tag === 'iframe') {
        out.push({
          kind: 'not-accessible',
          subject: `iframe ${node.attrs.src ?? '(no src)'}`,
          reason: 'iframe content is isolated from the page and was not captured',
          stateId,
          nodeId: node.id,
          nodePath: node.path,
          ...withEvidence,
        });
      } else {
        out.push({
          kind: 'not-reconstructable',
          subject: `inline svg at ${node.path || 'body'}`,
          reason: 'inline SVG markup is not captured; only its box and computed style are, so it cannot be rebuilt faithfully',
          stateId,
          nodeId: node.id,
          nodePath: node.path,
          ...withEvidence,
        });
      }
    }
  }
  return out;
}

function assetLimitations(assets: readonly Asset[]): Limitation[] {
  return assets
    .filter((asset) => asset.origin === 'cross-origin' && asset.authorization !== 'authorized')
    .map((asset) => ({
      kind: 'not-reconstructable' as const,
      subject: `asset ${asset.url}`,
      reason: 'cross-origin asset; it is not reused until the user or agent authorizes it',
      ...(asset.usage[0] === undefined ? {} : { stateId: asset.usage[0].stateId, nodeId: asset.usage[0].nodeId, nodePath: asset.usage[0].nodePath }),
    }));
}

/** Limitations the agent added through `annotate_dna` (recorded in the annotation log). */
function agentLimitations(previous: UiDnaDocument | null | undefined): Limitation[] {
  if (!previous) return [];
  const out: Limitation[] = [];
  for (const annotation of previous.annotations) {
    if (annotation.op !== 'limitation') continue;
    const parsed = LimitationSchema.safeParse(annotation.value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function dedupeLimitations(limitations: readonly Limitation[]): Limitation[] {
  const seen = new Set<string>();
  const out: Limitation[] = [];
  for (const limitation of limitations) {
    const key = stableStringify(limitation);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(limitation);
  }
  return out;
}

/** Walk a JSON value along pointer segments; numeric segments index arrays. */
function valueAt(root: unknown, segments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (current !== null && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

function isAttributedValue(value: unknown): value is { value: unknown; provenance: unknown; annotation?: unknown } {
  return value !== null && typeof value === 'object' && 'value' in value && 'provenance' in value;
}

/**
 * Re-attach the agent's `annotate` readings from the previous document where the measured
 * value at the same path is unchanged. A reading whose value changed or moved is not guessed
 * back into place: it stays in the annotation log and a limitation says so.
 */
function reattachAnnotations(document: UiDnaDocument, previous: UiDnaDocument | null | undefined): void {
  if (!previous) return;
  for (const record of previous.annotations) {
    if (record.op !== 'annotate') continue;
    const segments = record.path.split('/').filter((segment) => segment.length > 0);
    if (segments[segments.length - 1] !== 'annotation') continue;
    const valuePath = segments.slice(0, -1);
    const before = valueAt(previous, valuePath);
    const after = valueAt(document, valuePath);
    if (isAttributedValue(before) && isAttributedValue(after) && before.annotation !== undefined && stableStringify(before.value) === stableStringify(after.value)) {
      (after as { annotation?: unknown }).annotation = structuredClone(before.annotation);
      continue;
    }
    document.limitations.push({
      kind: 'not-observed',
      subject: `annotation ${record.id}`,
      reason: `the agent reading at ${record.path} was not re-attached after re-assembly because the measured value at that path changed or moved; the annotation log keeps it`,
    });
  }
}

/* -------------------------------------------------------------- evidence */

function buildEvidence(states: readonly OrderedState[]): EvidenceRef[] {
  const byId = new Map<string, { kind: string; artifacts: string[]; capturedAt: string; stateIds: string[] }>();
  for (const { record } of states) {
    const entry = byId.get(record.evidenceId) ?? { kind: record.kind === 'base' ? 'scan' : 'explore', artifacts: [], capturedAt: record.capturedAt, stateIds: [] };
    if (record.kind === 'base') entry.kind = 'scan';
    entry.artifacts.push(posix(record.capturePath));
    if (record.screenshotPath !== null) entry.artifacts.push(posix(record.screenshotPath));
    if (record.capturedAt < entry.capturedAt) entry.capturedAt = record.capturedAt;
    entry.stateIds.push(record.stateId);
    byId.set(record.evidenceId, entry);
  }
  return [...byId.entries()].map(([id, entry]) => ({
    id,
    kind: entry.kind,
    artifacts: distinct(entry.artifacts),
    capturedAt: entry.capturedAt,
    inputs: { stateIds: entry.stateIds },
  }));
}

/* ------------------------------------------------------------ carry-over */

function carryTokenNames(tokens: Token[], previous: readonly Token[]): Token[] {
  const names = new Map<string, Token['name']>();
  for (const token of previous) {
    if (token.name !== undefined && token.value.value !== null) names.set(`${token.kind}\u0000${token.value.value}`, token.name);
  }
  return tokens.map((token) => {
    const name = token.value.value === null ? undefined : names.get(`${token.kind}\u0000${token.value.value}`);
    return name === undefined ? token : { ...token, name };
  });
}

function typographyKey(style: TypographyStyle): string {
  return [style.fontFamily.value, style.fontSize.value, style.fontWeight.value, style.lineHeight.value, style.letterSpacing?.value ?? '', style.textTransform?.value ?? ''].join('\u0000');
}

function carryTypographyNames(styles: TypographyStyle[], previous: readonly TypographyStyle[]): TypographyStyle[] {
  const names = new Map<string, TypographyStyle['name']>();
  for (const style of previous) if (style.name !== undefined) names.set(typographyKey(style), style.name);
  return styles.map((style) => {
    const name = names.get(typographyKey(style));
    return name === undefined ? style : { ...style, name };
  });
}

function carryComponentNames(definitions: ComponentDefinition[], previous: readonly ComponentDefinition[]): ComponentDefinition[] {
  const names = new Map<string, ComponentDefinition['name']>();
  for (const definition of previous) if (definition.name !== undefined) names.set(definition.fingerprint, definition.name);
  return definitions.map((definition) => {
    const name = names.get(definition.fingerprint);
    return name === undefined ? definition : { ...definition, name };
  });
}

function carryInferredBehavior(derived: BehaviorRule[], previous: UiDnaDocument | null | undefined, transitionIds: ReadonlySet<string>): BehaviorRule[] {
  if (!previous) return derived;
  const used = new Set(derived.map((rule) => rule.id));
  const carried: BehaviorRule[] = [];
  for (const rule of previous.behavior) {
    if (rule.provenance.kind !== 'inferred') continue;
    let id = rule.id;
    let n = 1;
    while (used.has(id)) {
      n += 1;
      id = `${rule.id}_${n}`;
    }
    used.add(id);
    carried.push({ ...rule, id, transitionId: rule.transitionId !== null && transitionIds.has(rule.transitionId) ? rule.transitionId : null });
  }
  return [...derived, ...carried];
}

/* ----------------------------------------------------------------- main */

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && value.includes('T');
}

/** Assemble and validate the UI DNA document of a scan. */
export function assembleDna(input: AssembleInput): Result<UiDnaDocument> {
  const { scan, captures, toolVersion } = input;
  const previous = input.previous ?? null;
  const clock = input.clock ?? systemClock;
  const limitations: Limitation[] = [];

  // States in scan order, keeping only those with a capture.
  const ordered: OrderedState[] = [];
  for (const record of scan.states) {
    const capture = captures.get(record.stateId);
    if (!capture) {
      limitations.push({ kind: 'not-observed', subject: `state ${record.stateId}`, reason: 'the scan lists this state but no capture is available for it', stateId: record.stateId });
      continue;
    }
    ordered.push({ record, capture });
  }
  for (const stateId of captures.keys()) {
    if (!scan.states.some((record) => record.stateId === stateId)) {
      return err(uidnaError('validation', `capture ${stateId} is not listed in scan ${scan.scanId}`));
    }
  }
  if (ordered.length === 0) return err(uidnaError('validation', `scan ${scan.scanId} has no captured states to assemble`));

  const stateIds = new Set(ordered.map((s) => s.record.stateId));
  const pageId = scan.pageId.length > 0 ? scan.pageId : 'pg_01';
  const evidence: EvidenceIndex = Object.fromEntries(ordered.map((s) => [s.record.stateId, s.record.evidenceId]));
  const orderedCaptures = new Map(ordered.map((s) => [s.record.stateId, s.capture]));
  const capturedAt = latestCapturedAt(orderedCaptures, isoNow(clock));

  const bases = ordered.filter((s) => s.record.kind === 'base');
  const widest = (bases.length > 0 ? bases : ordered).reduce((best, s) => (s.capture.viewport.width > best.capture.viewport.width ? s : best));
  const widestContext = stateContext(widest.record.stateId, widest.capture, evidence);

  // Transitions whose endpoints are both present.
  const transitions: Transition[] = [];
  for (const transition of input.transitions ?? []) {
    if (stateIds.has(transition.from) && stateIds.has(transition.to)) {
      transitions.push(transition);
    } else {
      limitations.push({ kind: 'not-observed', subject: `transition ${transition.id}`, reason: 'the transition references a state without a capture and was left out' });
    }
  }

  const states: UiState[] = ordered.map((entry) => {
    const parent = entry.record.parentStateId;
    if (parent !== null && !stateIds.has(parent)) {
      limitations.push({ kind: 'not-observed', subject: `state ${entry.record.stateId}`, reason: `parent state ${parent} has no capture; the state is recorded without a parent`, stateId: entry.record.stateId });
    }
    return toUiState(entry, pageId, parent !== null && stateIds.has(parent) ? parent : null);
  });

  const pageUrl = widest.capture.url;
  let routePattern = '/';
  try {
    routePattern = new URL(pageUrl).pathname || '/';
  } catch {
    routePattern = '/';
  }

  const navigation = buildNavigation(pageId, pageUrl, widest, widestContext, limitations);
  const layout = buildLayout(pageId, widest, widestContext);

  // Tokens see every state (hover and focus colors are tokens too); components and layout
  // constraints are measured on base states only, since derived states repeat the same
  // structure and would multiply the document by the number of recorded interactions.
  const baseCaptures = new Map(bases.map((s) => [s.record.stateId, s.capture]));
  const tokens = extractTokens(orderedCaptures, { capturedAt, evidenceIdByState: evidence, baseStateIds: bases.map((s) => s.record.stateId) });
  const components = findComponents(baseCaptures.size > 0 ? baseCaptures : orderedCaptures, { minInstances: 2, capturedAt, evidenceIdByState: evidence });
  const layoutConstraints = computeLayout(baseCaptures.size > 0 ? baseCaptures : orderedCaptures, { evidenceIdByState: evidence });
  const behavior = carryInferredBehavior(deriveBehavior(states, transitions), previous, new Set(transitions.map((t) => t.id)));
  const assets = buildAssets(ordered, previous, evidence, capturedAt);

  const scannedAt = scan.steps.scan?.at ?? (isIsoDateTime(scan.createdAt) ? scan.createdAt : isoNow(clock));
  const annotations: AnnotationRecord[] = previous ? previous.annotations.map((a) => ({ ...a })) : [];

  const document: UiDnaDocument = {
    dnaVersion: UI_DNA_VERSION,
    target: {
      kind: scan.target.kind,
      url: scan.target.url,
      ...(scan.target.cdp === undefined ? {} : { cdp: { ...scan.target.cdp } }),
      scanId: scan.scanId,
      scannedAt,
      viewports: scan.viewports.map((v) => ({ ...v })),
      budget: { limits: { ...scan.budget.limits }, used: { ...scan.budget.used } },
      tool: { name: 'uidna', version: toolVersion },
    },
    app: {
      pages: [{ id: pageId, url: pageUrl, title: measured(widest.capture.title, 'a11y-tree', widestContext, 1), stateIds: states.map((s) => s.id) }],
      routes: [{ id: 'rt_01', pattern: routePattern, pageId, provenance: measured(null, 'network', widestContext, 1).provenance }],
      layouts: [layout],
      navigation,
    },
    states: { items: states, transitions },
    components: {
      definitions: previous ? carryComponentNames(components.definitions, previous.components.definitions) : components.definitions,
      instances: components.instances,
    },
    visual: {
      tokens: previous
        ? {
            colors: carryTokenNames(tokens.colors, previous.visual.tokens.colors),
            typography: carryTypographyNames(tokens.typography, previous.visual.tokens.typography),
            fontFamilies: carryTokenNames(tokens.fontFamilies, previous.visual.tokens.fontFamilies),
            fontSizes: carryTokenNames(tokens.fontSizes, previous.visual.tokens.fontSizes),
            spacing: carryTokenNames(tokens.spacing, previous.visual.tokens.spacing),
            radii: carryTokenNames(tokens.radii, previous.visual.tokens.radii),
            shadows: carryTokenNames(tokens.shadows, previous.visual.tokens.shadows),
            breakpoints: carryTokenNames(tokens.breakpoints, previous.visual.tokens.breakpoints),
          }
        : tokens,
      layout: layoutConstraints,
    },
    behavior,
    assets,
    limitations: dedupeLimitations([...limitations, ...captureLimitations(ordered, evidence), ...assetLimitations(assets), ...agentLimitations(previous)]),
    evidence: buildEvidence(ordered),
    annotations,
  };

  reattachAnnotations(document, previous);
  const validation = validateUiDna(document);
  if (!validation.success) {
    const issues = formatIssues(validation);
    return err(uidnaError('validation', `assembled UI DNA document is invalid: ${issues.slice(0, 5).join('; ')}`, { details: { issues } }));
  }
  return ok(validation.data);
}
