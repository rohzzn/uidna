/**
 * Read-only workflows over a stored UI DNA document: `inspect_dna`,
 * `inspect_element`, `search_components`, `extract_tokens`. They never touch
 * a browser; everything comes from `dna.json` and the scan record.
 */
import type { Token, TokenCluster, UiDnaDocument, UiNode, UiState } from '@rohzzn/uidna-schema';
import { DNA_FACETS } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import type { extractTokens as extractTokensContract, inspectDna as inspectDnaContract, inspectElement as inspectElementContract, searchComponents as searchComponentsContract, StateSummary } from '../contracts/tools.js';
import { uidnaError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { getAtPath } from './json-path.js';
import type { ScanRecord } from './records.js';

/** Load the scan record and its document together. */
export async function loadScanAndDna(ctx: WorkflowContext, scanId: string): Promise<Result<{ scan: ScanRecord; dna: UiDnaDocument; dnaPath: string }>> {
  const scan = await ctx.store.loadScan(scanId);
  if (!scan.ok) return scan;
  if (!(await ctx.store.hasDna(scanId))) {
    return err(uidnaError('not-found', `scan ${scanId} has no dna.json yet; run scan_interface first`));
  }
  const dna = await ctx.store.loadDna(scanId);
  if (!dna.ok) return dna;
  return ok({ scan: scan.value, dna: dna.value, dnaPath: ctx.store.resolvePath(scanId, 'dna.json') });
}

/** Summaries of states for tool results. */
export function stateSummaries(dna: UiDnaDocument): StateSummary[] {
  return dna.states.items.map((s) => ({
    stateId: s.id,
    pageId: s.pageId,
    kind: s.kind,
    parentStateId: s.parentStateId,
    viewport: s.viewport,
    url: s.url,
    title: s.title,
    screenshot: s.screenshot ? s.screenshot.path : null,
    nodeCount: s.nodeCount,
    roleTreeDigest: s.roleTreeDigest,
  }));
}

/** Count attributed values whose provenance is `unknown`, anywhere in the document. */
export function countUnknownValues(value: unknown): number {
  let count = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>;
      const provenance = record.provenance;
      if (provenance !== null && typeof provenance === 'object' && (provenance as { kind?: unknown }).kind === 'unknown') count += 1;
      for (const inner of Object.values(record)) walk(inner);
    }
  };
  walk(value);
  return count;
}

function facetValue(dna: UiDnaDocument, facet: (typeof DNA_FACETS)[number]): { value: unknown; count: number } {
  switch (facet) {
    case 'app':
      return { value: dna.app, count: dna.app.pages.length + dna.app.navigation.length + dna.app.layouts.length };
    case 'states':
      return { value: dna.states.items.map(({ nodes, styles, roleTree, ...rest }) => ({ ...rest, nodeCount: nodes.length, styleCount: Object.keys(styles).length, roleTreeCount: roleTree.length })), count: dna.states.items.length };
    case 'transitions':
      return { value: dna.states.transitions, count: dna.states.transitions.length };
    case 'components':
      return { value: dna.components, count: dna.components.definitions.length };
    case 'tokens':
      return { value: dna.visual.tokens, count: Object.values(dna.visual.tokens).reduce((n, arr) => n + arr.length, 0) };
    case 'layout':
      return { value: dna.visual.layout, count: dna.visual.layout.length };
    case 'behavior':
      return { value: dna.behavior, count: dna.behavior.length };
    case 'assets':
      return { value: dna.assets, count: dna.assets.length };
    case 'limitations':
      return { value: dna.limitations, count: dna.limitations.length };
    case 'annotations':
      return { value: dna.annotations, count: dna.annotations.length };
  }
}

/** `inspect_dna`. */
export async function inspectDna(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof inspectDnaContract>,
): Promise<Result<Envelope<ToolOutput<typeof inspectDnaContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { dna, dnaPath } = loaded.value;

  const tokens: Record<string, number> = {};
  for (const [kind, list] of Object.entries(dna.visual.tokens)) tokens[kind] = list.length;

  const facets: Record<string, { available: boolean; count: number }> = {};
  for (const facet of DNA_FACETS) {
    const { count } = facetValue(dna, facet);
    facets[facet] = { available: count > 0, count };
  }

  let value: unknown;
  const limitations: string[] = [];
  if (input.path !== undefined) {
    const found = getAtPath(dna, input.path);
    if (!found.ok) return found;
    value = found.value;
  } else if (input.facet !== undefined) {
    value = facetValue(dna, input.facet).value;
    if (input.facet === 'states') limitations.push('states facet omits nodes, styles and roleTree; use inspect_element or full=true for node-level data');
  }

  const record = await ctx.ledger.record({
    kind: 'inspect',
    inputs: { scanId: input.scanId, path: input.path, facet: input.facet, full: input.full },
    artifacts: ['dna.json'],
    scanId: input.scanId,
  });

  const result: ToolOutput<typeof inspectDnaContract> = {
    scanId: input.scanId,
    dnaVersion: dna.dnaVersion,
    dnaPath,
    target: { kind: dna.target.kind, url: dna.target.url, scannedAt: dna.target.scannedAt },
    summary: {
      pages: dna.app.pages.length,
      states: dna.states.items.length,
      baseStates: dna.states.items.filter((s) => s.kind === 'base').length,
      transitions: dna.states.transitions.length,
      components: dna.components.definitions.length,
      componentInstances: dna.components.instances.length,
      tokens,
      layoutConstraints: dna.visual.layout.length,
      behaviorRules: dna.behavior.length,
      assets: dna.assets.length,
      limitations: dna.limitations.length,
      annotations: dna.annotations.length,
      unknownValues: countUnknownValues(dna),
    },
    facets,
    states: stateSummaries(dna),
    ...(value === undefined ? {} : { value }),
    ...(input.full ? { document: dna } : {}),
  };
  if (!input.full && input.path === undefined && input.facet === undefined) {
    limitations.push('summary only; pass full=true for the whole document, facet=<name> for one section, or path=<dot path> for one value');
  }
  return ok(envelope(record, result, { limitations, unknowns: dna.limitations.filter((l) => l.kind === 'not-observed').map((l) => `${l.subject}: ${l.reason}`) }));
}

/** Resolve a node by id, role+name or a simple selector. Returns all matches in document order. */
export function locateNodes(state: UiState, query: { nodeId?: string; role?: string; name?: string; selector?: string }): UiNode[] {
  if (query.nodeId !== undefined) {
    const node = state.nodes.find((n) => n.id === query.nodeId);
    return node ? [node] : [];
  }
  if (query.role !== undefined) {
    const name = query.name?.trim().toLowerCase();
    return state.nodes.filter((n) => n.role === query.role && (name === undefined || (n.name ?? '').trim().toLowerCase() === name));
  }
  if (query.selector !== undefined) {
    const selector = query.selector.trim();
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return state.nodes.filter((n) => n.attrs.id === id);
    }
    const match = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(selector);
    if (!match) return [];
    const tag = match[1]?.toLowerCase();
    const classes = (match[2] ?? '')
      .split('.')
      .filter((c) => c.length > 0);
    return state.nodes.filter((n) => {
      if (tag !== undefined && n.tag !== tag) return false;
      if (classes.length === 0) return true;
      const own = new Set((n.attrs.class ?? '').split(/\s+/).filter(Boolean));
      return classes.every((c) => own.has(c));
    });
  }
  return [];
}

/** Map a node's style values to the tokens whose cluster contains them. */
export function tokensForStyle(dna: UiDnaDocument, style: Readonly<Record<string, string>>): { property: string; value: string; tokenId: string; kind: string; generatedName: string }[] {
  const allTokens: Token[] = [
    ...dna.visual.tokens.colors,
    ...dna.visual.tokens.fontFamilies,
    ...dna.visual.tokens.fontSizes,
    ...dna.visual.tokens.spacing,
    ...dna.visual.tokens.radii,
    ...dna.visual.tokens.shadows,
  ];
  const byMember = new Map<string, Token[]>();
  for (const token of allTokens) {
    const cluster: TokenCluster = token.cluster;
    for (const member of cluster.members) {
      const list = byMember.get(member.value) ?? [];
      list.push(token);
      byMember.set(member.value, list);
    }
  }
  const out: { property: string; value: string; tokenId: string; kind: string; generatedName: string }[] = [];
  for (const [property, value] of Object.entries(style)) {
    const matches = byMember.get(value) ?? [];
    for (const token of matches) {
      if (!token.cluster.properties.includes(property)) continue;
      out.push({ property, value, tokenId: token.id, kind: token.kind, generatedName: token.generatedName });
    }
  }
  return out;
}

/** `inspect_element`. */
export async function inspectElement(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof inspectElementContract>,
): Promise<Result<Envelope<ToolOutput<typeof inspectElementContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { dna } = loaded.value;
  const state = dna.states.items.find((s) => s.id === input.stateId);
  if (!state) return err(uidnaError('not-found', `state ${input.stateId} not found in scan ${input.scanId}`));
  if (input.nodeId === undefined && input.role === undefined && input.selector === undefined) {
    return err(uidnaError('validation', 'provide nodeId, role (with optional name) or selector'));
  }
  const matches = locateNodes(state, input);
  const nth = input.nth ?? 0;
  const node = matches[nth];
  if (!node) {
    return err(uidnaError('not-found', `no node matches in ${input.stateId} (matches: ${matches.length}, requested nth ${nth})`));
  }
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const ancestors: { id: string; tag: string; role: string | null; name: string | null; path: string }[] = [];
  let cursor = node.parentId;
  while (cursor !== null) {
    const parent = byId.get(cursor);
    if (!parent) break;
    ancestors.unshift({ id: parent.id, tag: parent.tag, role: parent.role, name: parent.name, path: parent.path });
    cursor = parent.parentId;
  }
  const children = node.childIds
    .map((id) => byId.get(id))
    .filter((c): c is UiNode => c !== undefined)
    .map((c) => ({ id: c.id, tag: c.tag, role: c.role, name: c.name, text: c.text, box: c.box }));
  const style = state.styles[node.styleId] ?? {};
  const instance = dna.components.instances.find((i) => i.stateId === state.id && i.nodeId === node.id);
  const definition = instance ? dna.components.definitions.find((d) => d.id === instance.definitionId) : undefined;
  const evidenceRefs = dna.evidence.filter((e) => e.id === state.evidenceId).flatMap((e) => e.artifacts);

  const record = await ctx.ledger.record({
    kind: 'inspect',
    inputs: { scanId: input.scanId, stateId: input.stateId, nodeId: input.nodeId, role: input.role, name: input.name, selector: input.selector, nth },
    artifacts: [`states/${state.id}/capture.json`],
    scanId: input.scanId,
  });

  const result: ToolOutput<typeof inspectElementContract> = {
    scanId: input.scanId,
    stateId: state.id,
    matches: matches.length,
    node,
    style,
    tokens: tokensForStyle(dna, style),
    ancestors,
    children,
    componentInstance: instance && definition ? { instanceId: instance.id, definitionId: definition.id, generatedName: definition.generatedName } : null,
    evidence: [state.evidenceId, ...evidenceRefs],
  };
  const limitations = node.box === null ? ['node is not rendered in this state (box is null)'] : [];
  return ok(envelope(record, result, { limitations }));
}

/** `search_components`. */
export async function searchComponents(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof searchComponentsContract>,
): Promise<Result<Envelope<ToolOutput<typeof searchComponentsContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { dna } = loaded.value;
  const minInstances = input.minInstances ?? 2;
  const instancesByDefinition = new Map<string, typeof dna.components.instances>();
  for (const instance of dna.components.instances) {
    if (input.stateId !== undefined && instance.stateId !== input.stateId) continue;
    const list = instancesByDefinition.get(instance.definitionId) ?? [];
    list.push(instance);
    instancesByDefinition.set(instance.definitionId, list);
  }
  const candidates = dna.components.definitions
    .map((d) => ({ definition: d, instances: instancesByDefinition.get(d.id) ?? [] }))
    .filter(({ instances }) => instances.length >= minInstances)
    .sort((a, b) => b.instances.length - a.instances.length || a.definition.fingerprint.localeCompare(b.definition.fingerprint))
    .map(({ definition, instances }) => ({
      id: definition.id,
      generatedName: definition.generatedName,
      name: definition.name && definition.name.value !== null ? definition.name.value : null,
      fingerprint: definition.fingerprint,
      signature: definition.structure.signature,
      tag: definition.structure.tag,
      role: definition.structure.role,
      instanceCount: instances.length,
      matchesByState: definition.matchesByState,
      confidence: definition.confidence,
      props: definition.props,
      variants: definition.variants.length,
      instances: instances.map((i) => ({ id: i.id, stateId: i.stateId, nodeId: i.nodeId, nodePath: i.nodePath, box: i.box.value, variantId: i.variantId })),
    }));

  const record = await ctx.ledger.record({
    kind: 'search',
    inputs: { scanId: input.scanId, minInstances, stateId: input.stateId },
    artifacts: ['dna.json'],
    scanId: input.scanId,
  });
  return ok(
    envelope(record, { scanId: input.scanId, candidates, total: candidates.length }, {
      limitations: ['confidence reflects structural and style agreement between instances, not semantic correctness; naming is yours'],
    }),
  );
}

/** `extract_tokens`. */
export async function extractTokens(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof extractTokensContract>,
): Promise<Result<Envelope<ToolOutput<typeof extractTokensContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { dna } = loaded.value;
  const kinds = input.kinds ? new Set<string>(input.kinds) : null;
  const all = dna.visual.tokens;
  const keep = (kind: string): boolean => kinds === null || kinds.has(kind);
  const tokens = {
    colors: keep('color') ? all.colors : [],
    typography: kinds === null ? all.typography : [],
    fontFamilies: keep('font-family') ? all.fontFamilies : [],
    fontSizes: keep('font-size') ? all.fontSizes : [],
    spacing: keep('spacing') ? all.spacing : [],
    radii: keep('radius') ? all.radii : [],
    shadows: keep('shadow') ? all.shadows : [],
    breakpoints: keep('breakpoint') ? all.breakpoints : [],
  };
  const counts: Record<string, number> = {};
  for (const [kind, list] of Object.entries(tokens)) counts[kind] = list.length;
  const record = await ctx.ledger.record({ kind: 'tokens', inputs: { scanId: input.scanId, kinds: input.kinds }, artifacts: ['dna.json'], scanId: input.scanId });
  const limitations: string[] = [];
  if (kinds !== null) limitations.push('typography styles are composite and are only returned when no kinds filter is given');
  const unproduced = [...(kinds ?? [])].filter((kind) => ['font-weight', 'line-height', 'letter-spacing'].includes(kind));
  if (unproduced.length > 0) limitations.push(`${unproduced.join(', ')}: no standalone tokens are produced for these kinds; they appear inside typography styles`);
  return ok(envelope(record, { scanId: input.scanId, tokens, counts }, { limitations }));
}
