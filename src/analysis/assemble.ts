/**
 * Assemble a UI DNA document from a scan record, its captures and any
 * observed transitions. Everything measured comes from the captures; agent
 * work from a previous version of the document (names, asset authorizations,
 * inferred behavior rules, agent limitations, the annotation log) is carried
 * over so re-assembly after `explore` never loses it. The result is validated
 * before it is returned.
 *
 * A scan may hold several crawled pages (`scan.pages`). Each becomes an
 * `app.pages[]` entry with its own route, its navigation edges are resolved
 * against its own URL and matched to the crawled pages, pages whose header
 * and footer agree structurally share one layout, component candidates list
 * the pages they appear on, and breakpoints are detected per page (viewports
 * of different pages are never compared). Scans written before crawls carry
 * no page list and assemble as one page, exactly as before.
 */
import type {
  AnnotationRecord,
  Asset,
  BehaviorRule,
  ComponentDefinition,
  Components,
  EvidenceRef,
  Limitation,
  NavigationEdge,
  Page,
  ProvenanceContext,
  Route,
  SharedLayout,
  Token,
  Transition,
  TypographyStyle,
  UiDnaDocument,
  UiNode,
  UiState,
} from '@rohzzn/uidna-schema';
import { formatIssues, LimitationSchema, measured, UI_DNA_VERSION, unknown, validateUiDna } from '@rohzzn/uidna-schema';
import type { CapturedAsset, CapturedState } from '../browser/types.js';
import type { ExploreRecord, ResponsiveRecord, ScanRecord, StateRecord } from '../application/records.js';
import { assembleResponsive } from './responsive.js';
import { isoNow, systemClock, type Clock } from '../domain/clock.js';
import { stableStringify } from '../domain/digest.js';
import { uidnaError } from '../domain/errors.js';
import { fingerprintWithIndex, NodeIndex } from '../domain/fingerprint.js';
import { sequentialId } from '../domain/ids.js';
import { err, ok, type Result } from '../domain/result.js';
import { deriveBehavior } from './behavior.js';
import { distinct, latestCapturedAt, pageKey, stateContext, type EvidenceIndex } from './common.js';
import { findComponents } from './components.js';
import { computeLayout } from './layout.js';
import { extractBreakpoints, extractTokens } from './tokens.js';

/** Input of `assembleDna`. */
export interface AssembleInput {
  readonly scan: ScanRecord;
  /** Captures keyed by state id; states listed in the scan without a capture are reported as limitations. */
  readonly captures: ReadonlyMap<string, CapturedState>;
  readonly transitions?: readonly Transition[];
  /** The explore record of the scan, when one exists; its per-page coverage is copied onto the pages. */
  readonly explore?: ExploreRecord | null;
  /** The previous version of the document, whose agent work is carried over. */
  readonly previous?: UiDnaDocument | null;
  /** Stylesheet conditions and probe results (`responsive.json`); absent for scans without responsive measurement. */
  readonly responsive?: ResponsiveRecord | null;
  readonly toolVersion: string;
  /** Only used to timestamp `scannedAt` when the scan record carries no usable time. */
  readonly clock?: Clock;
}

/** Landmark roles that make up a shared layout. */
export const LANDMARK_ROLES: readonly string[] = ['banner', 'navigation', 'main', 'contentinfo', 'complementary'];

/** Landmark roles whose structural agreement makes two pages share a layout (header and footer). */
export const SHARED_LAYOUT_ROLES: readonly string[] = ['banner', 'contentinfo'];

const posix = (path: string): string => path.replace(/\\/g, '/');

interface OrderedState {
  readonly record: StateRecord;
  readonly capture: CapturedState;
}

/** One page of the scan with the states that belong to it. */
interface PageEntry {
  readonly id: string;
  /** Page URL as the scan recorded it (the final URL after redirects, redacted). */
  readonly url: string;
  /** Crawl depth; `undefined` for a page the scan record does not list. */
  readonly depth: number | undefined;
  /** `<fromPageId>:<nodePath>` of the link the crawl followed, null for the seed or an unlisted page. */
  readonly discoveredVia: string | null;
  readonly states: OrderedState[];
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

/* ----------------------------------------------------------------- pages */

/** The widest base state of a page (any state when it has no base state), or null when it has none. */
function widestOf(states: readonly OrderedState[]): OrderedState | null {
  const bases = states.filter((s) => s.record.kind === 'base');
  const pool = bases.length > 0 ? bases : states;
  let best: OrderedState | null = null;
  for (const state of pool) {
    if (best === null || state.capture.viewport.width > best.capture.viewport.width) best = state;
  }
  return best;
}

/**
 * Group the captured states by page. Pages come from `scan.pages` (seed first);
 * a scan written before crawls has none and assembles as its single seed page.
 * A record that names a page id is trusted. A base state without one belongs
 * to the seed; a derived state without one belongs to the page of the state it
 * was derived from (the explorer records derived states without a page id, and
 * a derived state is by definition a state of its parent's page). A state whose
 * page the record does not list still gets a page, reconstructed from the state
 * and reported.
 */
function buildPages(scan: ScanRecord, ordered: readonly OrderedState[], limitations: Limitation[]): PageEntry[] {
  const seedId = scan.pageId.length > 0 ? scan.pageId : 'pg_01';
  const listed = scan.pages ?? [];
  const pages: PageEntry[] = listed.map((page) => ({ id: page.pageId, url: page.url, depth: page.depth, discoveredVia: page.discoveredVia, states: [] }));
  const byId = new Map(pages.map((page) => [page.id, page]));
  const unlisted: PageEntry[] = [];
  const recordById = new Map(scan.states.map((record) => [record.stateId, record]));
  const resolved = new Map<string, string>();
  // `chain` cuts a parent cycle in a corrupt scan record rather than following it.
  const pageOf = (record: StateRecord, chain: Set<string>): string => {
    const known = resolved.get(record.stateId);
    if (known !== undefined) return known;
    let pageId = record.pageId;
    if (pageId === undefined && record.kind === 'derived' && record.parentStateId !== null && !chain.has(record.stateId)) {
      const parent = recordById.get(record.parentStateId);
      if (parent !== undefined) {
        chain.add(record.stateId);
        pageId = pageOf(parent, chain);
      }
    }
    const result = pageId ?? seedId;
    resolved.set(record.stateId, result);
    return result;
  };
  for (const state of ordered) {
    const pageId = pageOf(state.record, new Set());
    let page = byId.get(pageId);
    if (page === undefined) {
      const seed = pageId === seedId;
      page = { id: pageId, url: state.capture.url, depth: seed ? 0 : undefined, discoveredVia: null, states: [] };
      byId.set(pageId, page);
      if (seed && listed.length === 0) pages.push(page);
      else {
        unlisted.push(page);
        limitations.push({
          kind: 'not-observed',
          subject: `page ${pageId}`,
          reason: `state ${state.record.stateId} belongs to page ${pageId}, which the scan record does not list; the page was reconstructed from its states without crawl depth`,
          stateId: state.record.stateId,
        });
      }
    }
    page.states.push(state);
  }
  return [...pages, ...unlisted];
}

/** Path of a page URL as its route pattern, or null when the URL cannot be parsed (no default stands in for it). */
function routePattern(url: string): string | null {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ navigation */

interface NavigationBuild {
  readonly edges: NavigationEdge[];
  /** Edge id by `<fromPageId>:<nodePath>`, the key the crawler records in `discoveredVia`. */
  readonly byVia: Map<string, string>;
}

/**
 * Navigation edges from the links of every page's widest base state, resolved
 * against that page's URL. An edge's `pageId` is the crawled page whose key
 * (URL without fragment) matches the link target; `followed` is true when
 * that page was crawled and the link is not a same-document fragment.
 */
function buildNavigation(pages: readonly PageEntry[], evidence: EvidenceIndex, limitations: Limitation[]): NavigationBuild {
  const edges: NavigationEdge[] = [];
  const byVia = new Map<string, string>();
  const pageByKey = new Map<string, string>();
  for (const page of pages) {
    const key = pageKey(widestOf(page.states)?.capture.url ?? page.url);
    if (!pageByKey.has(key)) pageByKey.set(key, page.id);
  }
  for (const page of pages) {
    const widest = widestOf(page.states);
    if (widest === null) continue;
    const context = stateContext(widest.record.stateId, widest.capture, evidence);
    const pageUrl = widest.capture.url;
    let parsed: URL | null = null;
    try {
      parsed = new URL(pageUrl);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      limitations.push({ kind: 'not-observed', subject: 'navigation', reason: `page URL ${pageUrl} could not be parsed; links of ${page.id} were not resolved`, stateId: widest.record.stateId });
      continue;
    }
    const pageWithoutHash = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    let unresolved = 0;
    for (const node of widest.capture.nodes) {
      if (node.tag.toLowerCase() !== 'a') continue;
      const href = node.attrs.href;
      if (href === undefined || href.trim().length === 0) continue;
      let resolved: URL;
      try {
        resolved = new URL(href, parsed);
      } catch {
        unresolved += 1;
        continue;
      }
      const sameDocument = `${resolved.origin}${resolved.pathname}${resolved.search}` === pageWithoutHash;
      const fragment = href.trim().startsWith('#') || (sameDocument && resolved.hash.length > 0);
      const sameOrigin = resolved.origin === parsed.origin;
      const toPageId = sameDocument ? page.id : sameOrigin ? (pageByKey.get(pageKey(resolved.href)) ?? null) : null;
      const id = sequentialId('nav', edges.length + 1);
      edges.push({
        id,
        fromPageId: page.id,
        to: { url: resolved.toString(), pageId: toPageId, sameOrigin, fragment },
        via: { nodeId: node.id, nodePath: node.path, role: node.role, name: node.name },
        followed: toPageId !== null && !fragment,
        provenance: measured(null, 'a11y-tree', context, 1).provenance,
      });
      const via = `${page.id}:${node.path}`;
      if (!byVia.has(via)) byVia.set(via, id);
    }
    if (unresolved > 0) {
      limitations.push({
        kind: 'not-observed',
        subject: 'navigation',
        reason: `${unresolved} link href value(s) on ${page.id} could not be resolved against the page URL`,
        stateId: widest.record.stateId,
      });
    }
  }
  return { edges, byVia };
}

/* --------------------------------------------------------------- layouts */

interface PageLandmarks {
  readonly page: PageEntry;
  readonly widest: OrderedState;
  readonly regions: SharedLayout['regions'];
  /** Structural fingerprints of the header and footer regions; null when the page has neither. */
  readonly key: string | null;
}

function landmarksOf(page: PageEntry, widest: OrderedState): PageLandmarks {
  const index = new NodeIndex(widest.capture);
  const regions: SharedLayout['regions'] = [];
  const shared: string[] = [];
  for (const node of widest.capture.nodes) {
    if (node.role === null || !LANDMARK_ROLES.includes(node.role)) continue;
    regions.push({ role: node.role, name: node.name, nodePath: node.path, nodeId: node.id });
    if (SHARED_LAYOUT_ROLES.includes(node.role)) shared.push(`${node.role}=${fingerprintWithIndex(index, node).fingerprint}`);
  }
  return { page, widest, regions, key: shared.length === 0 ? null : shared.join('|') };
}

/**
 * One shared layout per group of pages whose header and footer regions have
 * the same structural fingerprint (tag/role structure and coarse style class;
 * text and attribute values do not take part). The regions come from the first
 * page of the group. A page without header or footer has a layout of its own.
 */
function buildLayouts(pages: readonly PageEntry[], evidence: EvidenceIndex): SharedLayout[] {
  const groups: { key: string | null; first: PageLandmarks; pageIds: string[] }[] = [];
  for (const page of pages) {
    const widest = widestOf(page.states);
    if (widest === null) continue;
    const landmarks = landmarksOf(page, widest);
    const group = landmarks.key === null ? undefined : groups.find((g) => g.key === landmarks.key);
    if (group) group.pageIds.push(page.id);
    else groups.push({ key: landmarks.key, first: landmarks, pageIds: [page.id] });
  }
  return groups.map((group, i) => {
    const context = stateContext(group.first.widest.record.stateId, group.first.widest.capture, evidence);
    return {
      id: sequentialId('lay', i + 1),
      pageIds: group.pageIds,
      regions: group.first.regions,
      provenance: measured(null, 'a11y-tree', context, 1).provenance,
    };
  });
}

/* ------------------------------------------------------------ components */

/** Add `pageIds` to every candidate: the pages (in scan order) whose states hold one of its instances. */
function withPageIds(components: Components, pages: readonly PageEntry[]): Components {
  const pageByState = new Map<string, string>();
  for (const page of pages) for (const state of page.states) pageByState.set(state.record.stateId, page.id);
  const order = new Map(pages.map((page, i) => [page.id, i]));
  const statesByDefinition = new Map<string, Set<string>>();
  for (const instance of components.instances) {
    const set = statesByDefinition.get(instance.definitionId) ?? new Set<string>();
    set.add(instance.stateId);
    statesByDefinition.set(instance.definitionId, set);
  }
  const definitions = components.definitions.map((definition) => {
    const pageIds = distinct([...(statesByDefinition.get(definition.id) ?? [])].map((stateId) => pageByState.get(stateId)).filter((id): id is string => id !== undefined));
    pageIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    return { ...definition, pageIds };
  });
  return { definitions, instances: components.instances };
}

/* ----------------------------------------------------------- breakpoints */

/**
 * Breakpoints detected on each page separately, then merged by width: the
 * sample counts, members, properties and state ids of equal widths add up.
 */
function pageBreakpoints(pages: readonly PageEntry[], capturedAt: string, evidence: EvidenceIndex): Token[] {
  const merged = new Map<string, Token>();
  for (const page of pages) {
    const bases = page.states.filter((s) => s.record.kind === 'base');
    if (bases.length < 2) continue;
    const captures = new Map(bases.map((s) => [s.record.stateId, s.capture]));
    const tokens = extractBreakpoints(captures, { capturedAt, evidenceIdByState: evidence, baseStateIds: bases.map((s) => s.record.stateId) });
    for (const token of tokens) {
      const key = token.value.value ?? '';
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, token);
        continue;
      }
      const members = existing.cluster.members.map((m) => ({ ...m }));
      for (const member of token.cluster.members) {
        const found = members.find((m) => m.value === member.value);
        if (found) found.count += member.count;
        else members.push({ ...member });
      }
      merged.set(key, {
        ...existing,
        cluster: {
          ...existing.cluster,
          sampleCount: existing.cluster.sampleCount + token.cluster.sampleCount,
          members,
          properties: distinct([...existing.cluster.properties, ...token.cluster.properties]).sort(),
        },
        usage: { ...existing.usage, count: existing.usage.count + token.usage.count, stateIds: distinct([...existing.usage.stateIds, ...token.usage.stateIds]) },
      });
    }
  }
  return [...merged.values()].map((token, i) => ({ ...token, id: sequentialId('tok_bp', i + 1), generatedName: `bp-${(i + 1).toString().padStart(2, '0')}` }));
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
 * Identity of an asset across states. URLs identify fetched assets. Data
 * assets (captured JSON responses) are identified by request method, URL and
 * body digest, so two different responses of one endpoint stay two assets and
 * different URLs are never merged. Inline assets are named after node ids
 * (`inline:n12`), which are positional per capture, so they are keyed by the
 * page and the structural path of the node that holds them instead (the same
 * path on another page is another element); when that node is not in the
 * capture, the asset stays private to its state.
 */
function assetKey(asset: CapturedAsset, stateId: string, pageId: string, nodesById: ReadonlyMap<string, UiNode>): string {
  if (asset.kind === 'data') return dataAssetKey(asset.request?.method, asset.url, asset.digest);
  if (asset.origin !== 'inline') return asset.url;
  for (const nodeId of asset.usedBy) {
    const node = nodesById.get(nodeId);
    if (node) return `inline\u0000page:${pageId}\u0000path:${node.path}`;
  }
  return `inline\u0000state:${stateId}:${asset.url}`;
}

function dataAssetKey(method: string | undefined, url: string, digest: string | undefined): string {
  return `data\u0000${method ?? ''}\u0000${url}\u0000${digest ?? ''}`;
}

/**
 * Identity of a document asset for carrying the agent's authorization over to
 * the re-assembled document: the same rule as `assetKey`, so an authorization
 * given to one response body of an endpoint never reaches another body of it.
 */
function documentAssetKey(asset: Asset): string {
  if (asset.kind === 'data') return dataAssetKey(asset.request?.method, asset.url, asset.digest);
  return asset.url;
}

function buildAssets(states: readonly OrderedState[], pageByState: ReadonlyMap<string, string>, previous: UiDnaDocument | null | undefined, evidence: EvidenceIndex, fallbackCapturedAt: string): Asset[] {
  const merged = new Map<string, MergedAsset>();
  for (const { record, capture } of states) {
    const nodesById = new Map(capture.nodes.map((node) => [node.id, node]));
    const networkUrls = new Set(capture.network.map((entry) => entry.url));
    const pageId = pageByState.get(record.stateId) ?? '';
    for (const asset of capture.assets) {
      const key = assetKey(asset, record.stateId, pageId, nodesById);
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

  const previousByKey = new Map((previous?.assets ?? []).map((asset) => [documentAssetKey(asset), asset]));
  const previousByDigest = new Map((previous?.assets ?? []).filter((a) => a.digest !== undefined).map((asset) => [asset.digest ?? '', asset]));
  const captureById = new Map(states.map((s) => [s.record.stateId, s.capture]));

  return [...merged.values()].map((entry, i) => {
    const identity = entry.first.kind === 'data' ? dataAssetKey(entry.first.request?.method, entry.first.url, entry.fields.digest) : entry.first.url;
    const prior = previousByKey.get(identity) ?? (entry.fields.digest === undefined ? undefined : previousByDigest.get(entry.fields.digest));
    const capture = captureById.get(entry.firstStateId);
    const context: ProvenanceContext = capture ? stateContext(entry.firstStateId, capture, evidence) : { capturedAt: fallbackCapturedAt };
    // A captured response body always comes from the network; other assets do when a request for them was recorded.
    const source = entry.first.kind === 'data' || entry.seenOnNetwork ? 'network' : 'a11y-tree';
    const request = entry.first.request;
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
      ...(request === undefined ? {} : { request: { method: request.method, status: request.status, mime: request.mime } }),
      authorization: prior?.authorization ?? 'unknown',
      usage: entry.usage,
      provenance: measured(null, source, context, 1).provenance,
    };
  });
}

/* ----------------------------------------------------------- limitations */

function captureLimitations(states: readonly OrderedState[], pageByState: ReadonlyMap<string, string>, evidence: EvidenceIndex): Limitation[] {
  const out: Limitation[] = [];
  const seenPaths = new Set<string>();
  for (const { record, capture } of states) {
    const stateId = record.stateId;
    const pageId = pageByState.get(stateId) ?? '';
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
      const key = `${pageId}\u0000${tag}:${node.path}`;
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

/** Coverage of one page from the explore record: per page when recorded, else the run's total for a single-page scan. */
function pageCoverage(explore: ExploreRecord | null, pageId: string, pageCount: number): Page['coverage'] | undefined {
  if (explore === null) return undefined;
  const perPage = explore.coverageByPage?.[pageId];
  if (perPage !== undefined) return { ...perPage };
  if (explore.coverageByPage === undefined && pageCount === 1) return { ...explore.coverage };
  return undefined;
}

/** Assemble and validate the UI DNA document of a scan. */
export function assembleDna(input: AssembleInput): Result<UiDnaDocument> {
  const { scan, captures, toolVersion } = input;
  const previous = input.previous ?? null;
  const explore = input.explore ?? null;
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
  const evidence: EvidenceIndex = Object.fromEntries(ordered.map((s) => [s.record.stateId, s.record.evidenceId]));
  const orderedCaptures = new Map(ordered.map((s) => [s.record.stateId, s.capture]));
  const capturedAt = latestCapturedAt(orderedCaptures, isoNow(clock));

  const pages = buildPages(scan, ordered, limitations);
  const pageByState = new Map<string, string>();
  for (const page of pages) for (const state of page.states) pageByState.set(state.record.stateId, page.id);

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
    return toUiState(entry, pageByState.get(entry.record.stateId) ?? pages[0]?.id ?? 'pg_01', parent !== null && stateIds.has(parent) ? parent : null);
  });

  const navigation = buildNavigation(pages, evidence, limitations);
  const layouts = buildLayouts(pages, evidence);

  const appPages: Page[] = pages.map((page) => {
    const widest = widestOf(page.states);
    let discoveredVia: string | null = null;
    if (page.discoveredVia !== null) {
      const edgeId = navigation.byVia.get(page.discoveredVia);
      if (edgeId === undefined) {
        limitations.push({
          kind: 'not-observed',
          subject: `page ${page.id}`,
          reason: `the crawl reached this page through link ${page.discoveredVia}, but no navigation edge matches that link in the captured states; discoveredVia is null`,
        });
      } else {
        discoveredVia = edgeId;
      }
    }
    if (widest === null) {
      limitations.push({ kind: 'not-observed', subject: `page ${page.id}`, reason: 'no state of this page was captured' });
    }
    const coverage = pageCoverage(explore, page.id, pages.length);
    return {
      id: page.id,
      url: widest?.capture.url ?? page.url,
      title: widest === null ? unknown<string>('no state of this page was captured') : measured(widest.capture.title, 'a11y-tree', stateContext(widest.record.stateId, widest.capture, evidence), 1),
      stateIds: page.states.map((s) => s.record.stateId),
      ...(page.depth === undefined ? {} : { depth: page.depth }),
      ...(page.depth === undefined && page.discoveredVia === null ? {} : { discoveredVia }),
      ...(coverage === undefined ? {} : { coverage }),
    };
  });

  const routes: Route[] = pages.map((page, i) => {
    const widest = widestOf(page.states);
    const context: ProvenanceContext = widest === null ? { capturedAt } : stateContext(widest.record.stateId, widest.capture, evidence);
    const url = widest?.capture.url ?? page.url;
    const pattern = routePattern(url);
    // An unparseable page URL yields no pattern: the URL is recorded as is with `unknown` provenance rather than a made-up `/`.
    return {
      id: sequentialId('rt', i + 1),
      pattern: pattern ?? url,
      pageId: page.id,
      provenance:
        pattern === null
          ? unknown<string>(`page URL ${url} could not be parsed; the pattern is the URL as recorded, not a route`, { ...context, source: 'network' }).provenance
          : measured(null, 'network', context, 1).provenance,
    };
  });

  // Tokens see every state (hover and focus colors are tokens too); components and layout
  // constraints are measured on base states only, since derived states repeat the same
  // structure and would multiply the document by the number of recorded interactions.
  // Breakpoints compare the base states of one page at a time.
  const bases = ordered.filter((s) => s.record.kind === 'base');
  const baseCaptures = new Map(bases.map((s) => [s.record.stateId, s.capture]));
  const tokens = {
    ...extractTokens(orderedCaptures, { capturedAt, evidenceIdByState: evidence, baseStateIds: bases.map((s) => s.record.stateId) }),
    breakpoints: pageBreakpoints(pages, capturedAt, evidence),
  };
  const components = withPageIds(findComponents(baseCaptures.size > 0 ? baseCaptures : orderedCaptures, { minInstances: 2, capturedAt, evidenceIdByState: evidence }), pages);
  const layoutConstraints = computeLayout(baseCaptures.size > 0 ? baseCaptures : orderedCaptures, { evidenceIdByState: evidence });
  const behavior = carryInferredBehavior(deriveBehavior(states, transitions), previous, new Set(transitions.map((t) => t.id)));
  const responsive =
    input.responsive === undefined || input.responsive === null
      ? null
      : assembleResponsive(
          input.responsive,
          pages.map((page) => ({
            id: page.id,
            bases: page.states
              .filter((s) => s.record.kind === 'base')
              .map((s) => ({ stateId: s.record.stateId, width: s.record.viewport.width, capture: s.capture }))
              .sort((a, b) => a.width - b.width),
          })),
          capturedAt,
        );
  const assets = buildAssets(ordered, pageByState, previous, evidence, capturedAt);

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
      pages: appPages,
      routes,
      layouts,
      navigation: navigation.edges,
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
      ...(responsive === null ? {} : { responsive: responsive.responsive }),
    },
    behavior,
    assets,
    limitations: dedupeLimitations([...limitations, ...(responsive?.limitations ?? []), ...captureLimitations(ordered, pageByState, evidence), ...assetLimitations(assets), ...agentLimitations(previous)]),
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
