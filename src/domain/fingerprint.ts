/**
 * Structural fingerprints for component discovery. Two nodes share a
 * fingerprint when their tag/role structure (to a bounded depth) and the coarse
 * style class of their root agree. Text content, attribute values and class
 * names are deliberately excluded so that three cards with different copy
 * match, while a card and a hero section do not.
 */
import type { UiNode } from '@uidna/schema';
import type { CapturedState } from '../browser/types.js';
import { parsePx } from './clustering.js';
import { parseCssColor, isTransparent } from './color.js';
import { digestValue } from './digest.js';
import { uidnaError } from './errors.js';
import { err, ok, type Result } from './result.js';

/** The part of a capture that fingerprinting reads. */
export type FingerprintSource = Pick<CapturedState, 'nodes' | 'styles'>;

/** Fingerprint of one node. */
export interface NodeFingerprint {
  /** Digest of the normalized structure plus the root's coarse style class. */
  readonly fingerprint: string;
  /** Human-readable structure: root tag, then direct children tags, e.g. `article>div+h3+p`. */
  readonly signature: string;
  /** Height of the subtree below the node (0 for a leaf). */
  readonly depth: number;
  /** Number of direct element children. */
  readonly childCount: number;
}

/** How many levels of descendants take part in the fingerprint. */
export const FINGERPRINT_DEPTH = 3;

/** Tags that render an image. */
const IMAGE_TAGS = new Set(['img', 'picture', 'svg', 'video', 'canvas']);

/** Normalized descendant entry: what the node is, not what it says. */
interface NormalizedNode {
  readonly tag: string;
  readonly role: string | null;
  /** `text` for a text leaf, `img` for an image, otherwise absent. */
  readonly leaf?: 'text' | 'img';
  readonly children?: NormalizedNode[];
}

/** Coarse style class of a root node: enough to separate a button from a link, not enough to split variants. */
export interface StyleClass {
  readonly display: string;
  readonly flexDirection: string;
  readonly hasBackground: boolean;
  readonly hasRadius: boolean;
  readonly fontSizeBucket: string;
}

/** Bucket a font size (px) into a coarse size class. */
export function fontSizeBucket(px: number | null): string {
  if (px === null) return 'unknown';
  if (px <= 12) return 'xs';
  if (px <= 14) return 'sm';
  if (px <= 18) return 'md';
  if (px <= 24) return 'lg';
  if (px <= 36) return 'xl';
  return 'xxl';
}

/** Coarse style class of a style object (missing properties mean the UA default, see `STYLE_DEFAULTS`). */
export function styleClassOf(style: Readonly<Record<string, string>> | undefined): StyleClass {
  const bg = style?.['background-color'];
  const parsedBg = bg === undefined ? null : parseCssColor(bg);
  const radius = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'].some(
    (prop) => {
      const px = parsePx(style?.[prop]?.split(/\s+/)[0]);
      return px !== null && px > 0;
    },
  );
  return {
    display: style?.display ?? 'unknown',
    flexDirection: style?.['flex-direction'] ?? 'row',
    hasBackground: parsedBg !== null && !isTransparent(parsedBg),
    hasRadius: radius,
    fontSizeBucket: fontSizeBucket(parsePx(style?.['font-size'])),
  };
}

/** Index of a capture's nodes by id, built once per capture. */
export class NodeIndex {
  private readonly byId = new Map<string, UiNode>();
  private readonly heights = new Map<string, number>();

  constructor(readonly source: FingerprintSource) {
    for (const node of source.nodes) this.byId.set(node.id, node);
  }

  /** Node by id. */
  get(id: string): UiNode | undefined {
    return this.byId.get(id);
  }

  /** Direct element children of a node, in document order. */
  children(node: UiNode): UiNode[] {
    const out: UiNode[] = [];
    for (const id of node.childIds) {
      const child = this.byId.get(id);
      if (child) out.push(child);
    }
    return out;
  }

  /** Style object of a node, or undefined when the style table lacks it. */
  style(node: UiNode): Readonly<Record<string, string>> | undefined {
    return this.source.styles[node.styleId];
  }

  /**
   * Height of the subtree below a node (memoized; the index is built once per
   * capture). A `childIds` cycle in a corrupt capture is cut rather than
   * followed, so a bad file never turns into an unbounded recursion.
   */
  height(node: UiNode, visiting = new Set<string>()): number {
    const known = this.heights.get(node.id);
    if (known !== undefined) return known;
    if (visiting.has(node.id)) return 0;
    visiting.add(node.id);
    let max = -1;
    for (const child of this.children(node)) max = Math.max(max, this.height(child, visiting));
    visiting.delete(node.id);
    const height = max + 1;
    this.heights.set(node.id, height);
    return height;
  }
}

function normalize(index: NodeIndex, node: UiNode, remaining: number): NormalizedNode {
  const children = index.children(node);
  const entry: { tag: string; role: string | null; leaf?: 'text' | 'img'; children?: NormalizedNode[] } = {
    tag: node.tag.toLowerCase(),
    role: node.role,
  };
  if (IMAGE_TAGS.has(entry.tag) || node.role === 'img') entry.leaf = 'img';
  else if (children.length === 0 && node.text !== null && node.text.length > 0) entry.leaf = 'text';
  if (remaining > 0 && children.length > 0) entry.children = children.map((child) => normalize(index, child, remaining - 1));
  return entry;
}

/** Fingerprint a node given a prebuilt index. */
export function fingerprintWithIndex(index: NodeIndex, node: UiNode): NodeFingerprint {
  const structure = normalize(index, node, FINGERPRINT_DEPTH);
  const styleClass = styleClassOf(index.style(node));
  const children = index.children(node);
  const signature = children.length === 0 ? node.tag.toLowerCase() : `${node.tag.toLowerCase()}>${children.map((c) => c.tag.toLowerCase()).join('+')}`;
  return {
    fingerprint: digestValue({ structure, styleClass }),
    signature,
    depth: index.height(node),
    childCount: children.length,
  };
}

/**
 * Fingerprint one node of a capture. Fails with `not-found` when the node id
 * is not part of the capture.
 */
export function fingerprintNode(state: FingerprintSource, nodeId: string): Result<NodeFingerprint> {
  const index = new NodeIndex(state);
  const node = index.get(nodeId);
  if (!node) return err(uidnaError('not-found', `node ${nodeId} is not in the capture`));
  return ok(fingerprintWithIndex(index, node));
}
