/**
 * Node matching between an original capture and a capture of the generated
 * app. Strategies, in order: the `data-uidna-path` attribute when the
 * capture carries it; the structural path the generator is known to produce
 * for each original node (checked against the rendered tag); role, accessible
 * name and position; tag and own text for text nodes. Missing nodes are
 * collapsed to subtree roots so one finding covers one lost subtree.
 */
import type { Box, UiNode } from '@rohzzn/uidna-schema';
import { renderKindOf } from '../generate/model.js';

/** Anything that carries captured nodes (`CapturedState`, `UiState`). */
export interface NodeSource {
  readonly nodes: readonly UiNode[];
}

/** How a pair was matched. */
export type MatchStrategy = 'data-path' | 'derived-path' | 'role-name' | 'tag-text';

/** An original node matched to a generated node. */
export interface NodeMatch {
  readonly original: UiNode;
  readonly generated: UiNode;
  readonly strategy: MatchStrategy;
}

/** An original node whose generated counterpart exists but whose visibility differs. */
export interface Counterpart {
  readonly original: UiNode;
  readonly generated: UiNode;
}

/** Result of `matchNodes`. */
export interface MatchResult {
  /** Visible original nodes matched to visible generated nodes. */
  readonly matches: readonly NodeMatch[];
  readonly byOriginalId: ReadonlyMap<string, NodeMatch>;
  /** Visible original nodes considered for matching. */
  readonly comparedNodes: number;
  /** Visible original nodes without a visible counterpart, collapsed to subtree roots. */
  readonly missing: readonly UiNode[];
  /** Every visible original node without a visible counterpart (before collapsing), in document order. */
  readonly unmatched: readonly UiNode[];
  /** `unmatched.length`. */
  readonly missingCount: number;
  /** Visible original nodes whose counterpart exists in the generated app but is not visible. */
  readonly hiddenInGenerated: readonly Counterpart[];
  /** Hidden original nodes whose counterpart is visible in the generated app. */
  readonly hiddenInOriginal: readonly Counterpart[];
  /** Visible generated nodes with no counterpart, excluding placeholder content and the React mount node. */
  readonly extra: readonly UiNode[];
  /** Largest box drift over matched nodes (max of |dx|, |dy|, |dw|, |dh|). */
  readonly maxDriftPx: number;
  /** True when the generated capture carried `data-uidna-path`; false when paths were derived structurally. */
  readonly pathAttribute: boolean;
}

/** Attribute the generator writes on every element. */
export const PATH_ATTRIBUTE = 'data-uidna-path';
/** Attribute the generator writes on asset placeholders (`asset:<id>`). */
export const PLACEHOLDER_ATTRIBUTE = 'data-placeholder';

/** Text the generator renders inside a placeholder box. */
const PLACEHOLDER_TEXT = /^Placeholder: (\S+) (?:not authorized|not reproduced) \(([^)]+)\)$/;
/** A trailing single marker character preceded by a space (e.g. the accordion `+`). */
const TRAILING_MARKER = /\s[+−\-▾▸›]$/;

/** Trim, collapse whitespace and strip a trailing single marker character such as `+`, `−`, `-`, `▾`, `▸`, `›`. */
export function normalizeName(name: string | null | undefined): string {
  if (name === null || name === undefined) return '';
  return name.replace(/\s+/g, ' ').trim().replace(TRAILING_MARKER, '').trim();
}

/** Collapse whitespace in own text for comparison. */
export function normalizeText(text: string | null): string {
  return text === null ? '' : text.replace(/\s+/g, ' ').trim();
}

/**
 * The asset placeholder a generated node is, if it is one: by the
 * `data-placeholder` attribute when captured, otherwise by the generator's
 * labeled box (`<div role="img">Placeholder: <kind> … (<asset id>)</div>`).
 */
export function placeholderOf(node: UiNode): { readonly assetId: string; readonly kind: string | null } | null {
  const attribute = node.attrs[PLACEHOLDER_ATTRIBUTE];
  if (attribute !== undefined) return { assetId: attribute.startsWith('asset:') ? attribute.slice('asset:'.length) : attribute, kind: null };
  if (node.tag.toLowerCase() !== 'div' || node.attrs.role !== 'img' || node.text === null) return null;
  const match = PLACEHOLDER_TEXT.exec(normalizeText(node.text));
  if (!match) return null;
  return { assetId: match[2] ?? '', kind: match[1] ?? null };
}

/** Largest axis difference between two boxes. */
export function boxDrift(a: Box, b: Box): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

/** Expected position and tag of an original node in the generated DOM. */
export interface DerivedPath {
  readonly path: string;
  /** Tags the generated element may carry (an image or placeholder may become a `div`). */
  readonly tags: readonly string[];
}

/**
 * The structural path each original node gets in the generated DOM: the
 * generator renders the body's children under the React mount node
 * (`mountPath`, `0` for `<div id="root">`), skips script/style/metadata/svg
 * internals, and renders no children for placeholders. Keyed by original
 * node id.
 */
export function derivedGeneratedPaths(original: NodeSource, mountPath = '0'): Map<string, DerivedPath> {
  const byId = new Map(original.nodes.map((node) => [node.id, node] as const));
  const body = original.nodes.find((node) => node.path === '') ?? original.nodes[0];
  const out = new Map<string, DerivedPath>();
  if (body === undefined) return out;
  out.set(body.id, { path: '', tags: ['body'] });
  const visit = (node: UiNode, generatedPath: string, depth: number): void => {
    if (depth > 512) return;
    let index = 0;
    for (const childId of node.childIds) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      const kind = renderKindOf(child);
      if (kind.kind === 'skipped') continue;
      const path = generatedPath === '' ? `${index}` : `${generatedPath}/${index}`;
      index += 1;
      const isImage = child.tag.toLowerCase() === 'img';
      const tags = kind.kind === 'placeholder' || isImage ? [kind.renderedTag, 'div'] : [kind.renderedTag];
      out.set(child.id, { path, tags });
      if (kind.kind !== 'placeholder') visit(child, path, depth + 1);
    }
  };
  visit(body, mountPath, 0);
  return out;
}

/** True when `node` is the React mount node the generated `index.html` declares (`<div id="root">` directly under body). */
export function isMountNode(node: UiNode, parent: UiNode | undefined): boolean {
  return node.tag.toLowerCase() === 'div' && node.attrs.id === 'root' && parent?.path === '';
}

/** Match the visible nodes of an original state to the nodes of a generated capture. */
export function matchNodes(original: NodeSource, generated: NodeSource): MatchResult {
  const generatedById = new Map(generated.nodes.map((node) => [node.id, node] as const));
  const generatedByPath = new Map<string, UiNode>();
  const generatedByDataPath = new Map<string, UiNode>();
  for (const node of generated.nodes) {
    if (!generatedByPath.has(node.path)) generatedByPath.set(node.path, node);
    const dataPath = node.attrs[PATH_ATTRIBUTE];
    if (dataPath !== undefined && !generatedByDataPath.has(dataPath)) generatedByDataPath.set(dataPath, node);
  }
  const pathAttribute = generatedByDataPath.size > 0;
  const mount = generated.nodes.find((node) => isMountNode(node, node.parentId === null ? undefined : generatedById.get(node.parentId)));
  const derived = pathAttribute ? null : derivedGeneratedPaths(original, mount === undefined ? '' : mount.path);

  const counterpart = (node: UiNode): { readonly generated: UiNode; readonly strategy: MatchStrategy } | null => {
    if (pathAttribute) {
      const byAttribute = generatedByDataPath.get(node.path);
      return byAttribute === undefined ? null : { generated: byAttribute, strategy: 'data-path' };
    }
    const expected = derived?.get(node.id);
    if (expected === undefined) return null;
    const candidate = generatedByPath.get(expected.path);
    if (candidate === undefined || !expected.tags.includes(candidate.tag.toLowerCase())) return null;
    return { generated: candidate, strategy: 'derived-path' };
  };

  // Generated nodes that are placeholder content (the placeholder itself and everything under it).
  const placeholderContent = new Set<string>();
  const markPlaceholder = (node: UiNode): void => {
    placeholderContent.add(node.id);
    for (const childId of node.childIds) {
      const child = generatedById.get(childId);
      if (child !== undefined) markPlaceholder(child);
    }
  };
  for (const node of generated.nodes) if (placeholderOf(node) !== null) markPlaceholder(node);

  const used = new Set<string>();
  const matches: NodeMatch[] = [];
  const byOriginalId = new Map<string, NodeMatch>();
  const hiddenInGenerated: Counterpart[] = [];
  const hiddenInOriginal: Counterpart[] = [];
  const unmatched: UiNode[] = [];
  const take = (originalNode: UiNode, generatedNode: UiNode, strategy: MatchStrategy): void => {
    const match: NodeMatch = { original: originalNode, generated: generatedNode, strategy };
    matches.push(match);
    byOriginalId.set(originalNode.id, match);
    used.add(generatedNode.id);
  };

  let comparedNodes = 0;
  for (const node of original.nodes) {
    const found = counterpart(node);
    if (!node.visible) {
      if (found !== null && found.generated.visible && !used.has(found.generated.id)) {
        hiddenInOriginal.push({ original: node, generated: found.generated });
        used.add(found.generated.id);
      }
      continue;
    }
    comparedNodes += 1;
    if (found === null) {
      unmatched.push(node);
      continue;
    }
    if (found.generated.visible && !used.has(found.generated.id)) {
      take(node, found.generated, found.strategy);
    } else {
      if (!found.generated.visible) hiddenInGenerated.push({ original: node, generated: found.generated });
      unmatched.push(node);
    }
  }

  // Fallbacks over the generated nodes nothing claimed yet.
  const byRoleName = new Map<string, UiNode[]>();
  const byTagText = new Map<string, UiNode[]>();
  for (const node of generated.nodes) {
    if (!node.visible) continue;
    if (node.role !== null) {
      const key = `${node.role}\u0000${normalizeName(node.name)}`;
      byRoleName.set(key, [...(byRoleName.get(key) ?? []), node]);
    }
    const text = normalizeText(node.text);
    if (text.length > 0) {
      const key = `${node.tag.toLowerCase()}\u0000${text}`;
      byTagText.set(key, [...(byTagText.get(key) ?? []), node]);
    }
  }
  const still: UiNode[] = [];
  for (const node of unmatched) {
    let taken = false;
    if (node.role !== null) {
      const candidates = (byRoleName.get(`${node.role}\u0000${normalizeName(node.name)}`) ?? []).filter((candidate) => !used.has(candidate.id));
      const exact = candidates.find((candidate) => (candidate.a11y.nth ?? 0) === (node.a11y.nth ?? 0));
      const chosen = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (chosen !== undefined) {
        take(node, chosen, 'role-name');
        taken = true;
      }
    }
    if (!taken) {
      const text = normalizeText(node.text);
      if (text.length > 0) {
        const tag = renderKindOf(node).renderedTag;
        const candidates = (byTagText.get(`${tag}\u0000${text}`) ?? []).filter((candidate) => !used.has(candidate.id));
        if (candidates.length === 1 && candidates[0] !== undefined) {
          take(node, candidates[0], 'tag-text');
          taken = true;
        }
      }
    }
    if (!taken) still.push(node);
  }

  // Collapse missing nodes to subtree roots.
  const missingIds = new Set(still.map((node) => node.id));
  const originalById = new Map(original.nodes.map((node) => [node.id, node] as const));
  const missing = still.filter((node) => {
    let parentId = node.parentId;
    let depth = 0;
    while (parentId !== null && depth < 512) {
      if (missingIds.has(parentId)) return false;
      parentId = originalById.get(parentId)?.parentId ?? null;
      depth += 1;
    }
    return true;
  });

  const extra = generated.nodes.filter((node) => {
    if (!node.visible || used.has(node.id) || placeholderContent.has(node.id)) return false;
    if (node.path === '') return false;
    const parent = node.parentId === null ? undefined : generatedById.get(node.parentId);
    return !isMountNode(node, parent);
  });

  let maxDriftPx = 0;
  for (const match of matches) {
    if (match.original.box !== null && match.generated.box !== null) {
      maxDriftPx = Math.max(maxDriftPx, boxDrift(match.original.box, match.generated.box));
    }
  }

  return {
    matches,
    byOriginalId,
    comparedNodes,
    missing,
    unmatched: still,
    missingCount: still.length,
    hiddenInGenerated,
    hiddenInOriginal,
    extra,
    maxDriftPx: Math.round(maxDriftPx * 1000) / 1000,
    pathAttribute,
  };
}
