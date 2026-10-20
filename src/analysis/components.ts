/**
 * Component discovery by fingerprint matching. Every visible node that has
 * element children or is interactive is fingerprinted (tag/role structure to
 * a bounded depth plus the root's coarse style class) and nodes sharing a
 * fingerprint across states become a candidate. Naming is left to the agent;
 * the instrument only reports what matched, where, and how the instances
 * differ (props) and how their root styles differ (variants).
 */
import type { Box, ComponentDefinition, ComponentInstance, ComponentProp, ComponentVariant, Components, UiNode } from 'uidna-schema';
import { measured, unknown } from 'uidna-schema';
import type { CapturedState } from '../browser/types.js';
import { digestValue } from '../domain/digest.js';
import { fingerprintWithIndex, NodeIndex, type NodeFingerprint } from '../domain/fingerprint.js';
import { componentId, instanceId } from '../domain/ids.js';
import { comparePaths, distinct, isAncestorPath, latestCapturedAt, relativePath, stateContext, type CaptureMap, type EvidenceIndex } from './common.js';

/** Options for component discovery. */
export interface ComponentOptions {
  /** Minimum number of distinct node paths a fingerprint must match. Default 2. */
  readonly minInstances?: number;
  /** Timestamp for definition provenance; defaults to the latest capture time. */
  readonly capturedAt?: string;
  readonly evidenceIdByState?: EvidenceIndex;
}

/** Tags that are not component candidates on their own when they are leaves without interaction. */
const TRIVIAL_TAGS = new Set(['li', 'span', 'p', 'div']);

/**
 * Style properties left out of variant comparison because they follow content
 * and layout (used pixel values) rather than design intent.
 */
export const VARIANT_IGNORED_PROPERTIES: readonly string[] = [
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'top',
  'right',
  'bottom',
  'left',
  'margin-left',
  'margin-right',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'transform-origin',
  'background-position',
  'background-size',
];

interface Occurrence {
  readonly stateId: string;
  readonly capture: CapturedState;
  readonly index: NodeIndex;
  readonly node: UiNode;
  readonly fingerprint: NodeFingerprint;
}

interface Group {
  readonly fingerprint: string;
  readonly occurrences: Occurrence[];
}

function collectGroups(captures: CaptureMap): Group[] {
  const groups = new Map<string, Group>();
  for (const [stateId, capture] of captures) {
    const index = new NodeIndex(capture);
    for (const node of capture.nodes) {
      if (!node.visible) continue;
      if (node.childIds.length === 0 && !node.interactive) continue;
      const fingerprint = fingerprintWithIndex(index, node);
      const group = groups.get(fingerprint.fingerprint) ?? { fingerprint: fingerprint.fingerprint, occurrences: [] };
      group.occurrences.push({ stateId, capture, index, node, fingerprint });
      groups.set(fingerprint.fingerprint, group);
    }
  }
  return [...groups.values()];
}

function distinctPaths(group: Group): string[] {
  return distinct(group.occurrences.map((o) => o.node.path));
}

/** True when every pair of distinct paths is in an ancestor/descendant relation (nested copies of one structure). */
function allNested(paths: readonly string[]): boolean {
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const a = paths[i] ?? '';
      const b = paths[j] ?? '';
      if (!isAncestorPath(a, b) && !isAncestorPath(b, a)) return false;
    }
  }
  return true;
}

function isTrivial(group: Group): boolean {
  return group.occurrences.every((o) => TRIVIAL_TAGS.has(o.node.tag.toLowerCase()) && !o.node.interactive && o.fingerprint.childCount === 0);
}

/* ------------------------------------------------------------------ props */

interface Slot {
  readonly relativePath: string;
  readonly tag: string;
  readonly kind: ComponentProp['kind'];
  /** Value per occurrence index; `undefined` when the occurrence lacks the node or the value. */
  readonly values: (string | undefined)[];
}

function slotKey(path: string, kind: string): string {
  return `${kind}\u0000${path}`;
}

function collectSlots(group: Group): Slot[] {
  const slots = new Map<string, { relativePath: string; tag: string; kind: ComponentProp['kind']; values: (string | undefined)[] }>();
  const n = group.occurrences.length;
  const record = (path: string, tag: string, kind: ComponentProp['kind'], occurrence: number, value: string): void => {
    const key = slotKey(path, kind);
    const slot = slots.get(key) ?? { relativePath: path, tag, kind, values: new Array<string | undefined>(n).fill(undefined) };
    slot.values[occurrence] = value;
    slots.set(key, slot);
  };
  group.occurrences.forEach((occurrence, i) => {
    const rootPath = occurrence.node.path;
    // A corrupt capture with a `childIds` cycle is cut here rather than followed.
    const seen = new Set<string>();
    const visit = (node: UiNode): void => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      const rel = relativePath(rootPath, node.path);
      const tag = node.tag.toLowerCase();
      if (node.text !== null && node.text.trim().length > 0) record(rel, tag, 'text', i, node.text);
      if (tag === 'img' && node.attrs.src !== undefined) record(rel, tag, 'image', i, node.attrs.src);
      if (tag === 'a' && node.attrs.href !== undefined) record(rel, tag, 'link', i, node.attrs.href);
      for (const child of occurrence.index.children(node)) visit(child);
    };
    visit(occurrence.node);
  });
  return [...slots.values()].sort((a, b) => comparePaths(a.relativePath, b.relativePath) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

const PROP_SUFFIX: Record<ComponentProp['kind'], string> = { text: 'text', image: 'src', link: 'href', boolean: 'flag', enum: 'variant', number: 'value' };

function buildProps(group: Group): { props: ComponentProp[]; valuesByOccurrence: Record<string, string>[] } {
  const slots = collectSlots(group).filter((slot) => distinct(slot.values.filter((v): v is string => v !== undefined)).length > 1);
  const names = new Map<string, number>();
  const valuesByOccurrence: Record<string, string>[] = group.occurrences.map(() => ({}));
  const props: ComponentProp[] = slots.map((slot) => {
    const base = `${slot.tag}-${PROP_SUFFIX[slot.kind]}`;
    const seen = names.get(base) ?? 0;
    names.set(base, seen + 1);
    const name = seen === 0 ? base : `${base}-${seen + 1}`;
    slot.values.forEach((value, i) => {
      const bag = valuesByOccurrence[i];
      if (bag && value !== undefined) bag[name] = value;
    });
    return { name, kind: slot.kind, relativePath: slot.relativePath, values: distinct(slot.values.filter((v): v is string => v !== undefined)) };
  });
  return { props, valuesByOccurrence };
}

/* --------------------------------------------------------------- variants */

function designStyle(style: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const key of Object.keys(style).sort()) {
    if (VARIANT_IGNORED_PROPERTIES.includes(key)) continue;
    const value = style[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface VariantBuild {
  readonly variants: ComponentVariant[];
  readonly variantByOccurrence: string[];
  readonly agreement: number;
}

function buildVariants(group: Group, id: string, instanceIds: readonly string[]): VariantBuild {
  const styles = group.occurrences.map((o) => designStyle(o.capture.styles[o.node.styleId]));
  const keys = new Map<string, number>();
  const variantByOccurrence: string[] = [];
  const members = new Map<string, string[]>();
  styles.forEach((style, i) => {
    const digest = digestValue(style);
    let index = keys.get(digest);
    if (index === undefined) {
      index = keys.size + 1;
      keys.set(digest, index);
    }
    const variantId = `${id}_v${index.toString().padStart(2, '0')}`;
    variantByOccurrence.push(variantId);
    const list = members.get(variantId) ?? [];
    const instance = instanceIds[i];
    if (instance !== undefined) list.push(instance);
    members.set(variantId, list);
  });

  // Property differences across the distinct variant styles.
  const representative = new Map<string, Record<string, string>>();
  styles.forEach((style, i) => {
    const variantId = variantByOccurrence[i];
    if (variantId !== undefined && !representative.has(variantId)) representative.set(variantId, style);
  });
  const variantStyles = [...representative.values()];
  const allKeys = distinct(variantStyles.flatMap((s) => Object.keys(s))).sort();
  const differences: ComponentVariant['differences'] = [];
  for (const property of allKeys) {
    const values = distinct(variantStyles.map((s) => s[property] ?? '(unset)'));
    if (values.length > 1) differences.push({ property, values });
  }
  const compared = allKeys.length;
  const agreement = compared === 0 ? 1 : 1 - differences.length / compared;

  const variants: ComponentVariant[] = [...members.entries()].map(([variantId, instanceList]) => ({
    id: variantId,
    instanceIds: instanceList,
    differences: variantStyles.length > 1 ? differences : [],
  }));
  return { variants, variantByOccurrence, agreement };
}

/* ------------------------------------------------------------------ build */

/**
 * Share of occurrences whose full structure (direct-children signature,
 * subtree height and child count) equals the first occurrence's. The
 * fingerprint only covers `FINGERPRINT_DEPTH` levels, so deeper differences
 * show up here.
 */
function structuralAgreement(group: Group): number {
  const first = group.occurrences[0];
  if (!first) return 0;
  const same = group.occurrences.filter(
    (o) => o.fingerprint.signature === first.fingerprint.signature && o.fingerprint.depth === first.fingerprint.depth && o.fingerprint.childCount === first.fingerprint.childCount,
  ).length;
  return same / group.occurrences.length;
}

/**
 * Find component candidates across all captures. A definition's `confidence`
 * is the product of structural agreement (see `structuralAgreement`) and
 * style agreement (the share of root style properties that do not differ
 * between variants); both are ratios of what was measured, nothing is added.
 */
export function findComponents(captures: CaptureMap, opts: ComponentOptions = {}): Components {
  const minInstances = Math.max(1, Math.floor(opts.minInstances ?? 2));
  const capturedAt = opts.capturedAt ?? latestCapturedAt(captures, '1970-01-01T00:00:00.000Z');

  const groups = collectGroups(captures).filter((group) => {
    const paths = distinctPaths(group);
    if (paths.length < minInstances) return false;
    if (paths.length >= 2 && allNested(paths)) return false;
    if (isTrivial(group)) return false;
    return true;
  });

  groups.sort((a, b) => {
    const byCount = b.occurrences.length - a.occurrences.length;
    if (byCount !== 0) return byCount;
    const sa = a.occurrences[0]?.fingerprint.signature ?? '';
    const sb = b.occurrences[0]?.fingerprint.signature ?? '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });

  const definitions: ComponentDefinition[] = [];
  const instances: ComponentInstance[] = [];
  let instanceCounter = 0;

  groups.forEach((group, groupIndex) => {
    const id = componentId(groupIndex + 1);
    const first = group.occurrences[0];
    if (!first) return;
    const instanceIds = group.occurrences.map(() => {
      instanceCounter += 1;
      return instanceId(instanceCounter);
    });
    const { props, valuesByOccurrence } = buildProps(group);
    const { variants, variantByOccurrence, agreement } = buildVariants(group, id, instanceIds);
    const instanceCount = group.occurrences.length;
    const confidence = Math.round(structuralAgreement(group) * agreement * 1000) / 1000;

    const matchesByState: Record<string, number> = {};
    for (const stateId of captures.keys()) {
      const count = group.occurrences.filter((o) => o.stateId === stateId).length;
      if (count > 0) matchesByState[stateId] = count;
    }

    definitions.push({
      id,
      fingerprint: group.fingerprint,
      generatedName: `Component${(groupIndex + 1).toString().padStart(2, '0')}`,
      structure: {
        tag: first.node.tag.toLowerCase(),
        role: first.node.role,
        signature: first.fingerprint.signature,
        depth: first.fingerprint.depth,
        childCount: first.fingerprint.childCount,
      },
      props,
      variants,
      instanceCount,
      matchesByState,
      confidence,
      provenance: measured(null, 'a11y-tree', { capturedAt }, confidence).provenance,
    });

    group.occurrences.forEach((occurrence, i) => {
      const context = stateContext(occurrence.stateId, occurrence.capture, opts.evidenceIdByState);
      const box = occurrence.node.box;
      instances.push({
        id: instanceIds[i] ?? instanceId(i + 1),
        definitionId: id,
        stateId: occurrence.stateId,
        nodeId: occurrence.node.id,
        nodePath: occurrence.node.path,
        box: box === null ? unknown<Box>('node has no bounding box in this state', { ...context, source: 'bounding-box' }) : measured(box, 'bounding-box', context, 1),
        variantId: variantByOccurrence[i] ?? null,
        props: valuesByOccurrence[i] ?? {},
      });
    });
  });

  return { definitions, instances };
}
