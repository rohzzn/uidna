/**
 * Finding helpers: stable keys, regression/resolution diffing between
 * attempts, summary counts, and the lookups that attribute a finding to a
 * component instance or a token of the UI DNA document.
 */
import type { Token, UiDnaDocument, UiNode } from '@rohzzn/uidna-schema';
import { FINDING_CATEGORIES, FINDING_SEVERITIES, type DiffReport, type Finding, type FindingCategory, type FindingSeverity } from '../contracts/diff-report.js';
import { COLOR_PROPERTIES } from './styles.js';

/**
 * Stable key of a finding: category, state, transition (or node path when the
 * finding is not about a transition), property. A behavior finding is keyed by
 * its transition, not by the target node, so two transitions on the same node
 * (a click and a hover on one button) never share a key. Used to match
 * findings across attempts.
 */
export function findingKey(finding: Pick<Finding, 'category' | 'stateId' | 'nodePath' | 'transitionId' | 'property'>): string {
  return `${finding.category}|${finding.stateId}|${finding.transitionId ?? finding.nodePath ?? '-'}|${finding.property}`;
}

/** Every finding of a report (visual and behavioral), in report order. */
export function allFindings(report: Pick<DiffReport, 'visual' | 'behavioral'>): Finding[] {
  return [...report.visual.flatMap((v) => v.findings), ...report.behavioral.flatMap((b) => b.findings)];
}

/** Findings new since the previous attempt and findings that disappeared. */
export interface AttemptDiff {
  readonly regressions: Finding[];
  readonly resolved: Finding[];
}

/** Regressions are current findings whose key the previous attempt lacked; resolved are previous findings whose key is gone. */
export function diffAttempts(previous: Pick<DiffReport, 'visual' | 'behavioral'> | null, current: readonly Finding[]): AttemptDiff {
  if (previous === null) return { regressions: [], resolved: [] };
  const previousFindings = allFindings(previous);
  const previousKeys = new Set(previousFindings.map((f) => f.key));
  const currentKeys = new Set(current.map((f) => f.key));
  return {
    regressions: current.filter((f) => !previousKeys.has(f.key)),
    resolved: previousFindings.filter((f) => !currentKeys.has(f.key)),
  };
}

/** Sequential finding ids `f_1`, `f_2`, … within one report. */
export class FindingCounter {
  private count = 0;

  next(): string {
    this.count += 1;
    return `f_${this.count}`;
  }
}

/** Counts per category and severity, every key present. */
export function countFindings(findings: readonly Finding[]): { byCategory: Record<FindingCategory, number>; bySeverity: Record<FindingSeverity, number> } {
  const byCategory = Object.fromEntries(FINDING_CATEGORIES.map((c) => [c, 0])) as Record<FindingCategory, number>;
  const bySeverity = Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as Record<FindingSeverity, number>;
  for (const finding of findings) {
    byCategory[finding.category] += 1;
    bySeverity[finding.severity] += 1;
  }
  return { byCategory, bySeverity };
}

/** Rank for sorting findings most severe first. */
export function severityRank(severity: FindingSeverity): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

const SPACING_PROPERTY = /^(padding|margin)-|^(gap|row-gap|column-gap)$/;
const RADIUS_PROPERTY = /^border-.*-radius$/;

/** Token lists of the document that may hold values of `property`. */
function tokenListsFor(dna: UiDnaDocument, property: string): readonly (readonly Token[])[] {
  const tokens = dna.visual.tokens;
  if (COLOR_PROPERTIES.includes(property)) return [tokens.colors];
  if (property === 'font-family') return [tokens.fontFamilies];
  if (property === 'font-size') return [tokens.fontSizes];
  if (SPACING_PROPERTY.test(property)) return [tokens.spacing];
  if (RADIUS_PROPERTY.test(property)) return [tokens.radii];
  if (property === 'box-shadow') return [tokens.shadows];
  return [tokens.colors, tokens.fontFamilies, tokens.fontSizes, tokens.spacing, tokens.radii, tokens.shadows, tokens.breakpoints];
}

/** The token whose cluster members include `value` (as measured), for `property`; null when none. */
export function findTokenId(dna: UiDnaDocument, property: string, value: string): string | null {
  const needle = value.trim();
  for (const list of tokenListsFor(dna, property)) {
    for (const token of list) {
      if (token.cluster.members.some((member) => member.value.trim() === needle)) return token.id;
    }
  }
  return null;
}

/** The component definition whose instance is `node` or its nearest ancestor in `stateId`; null when none. */
export function findComponentId(dna: UiDnaDocument, stateId: string, node: Pick<UiNode, 'id' | 'path'>): string | null {
  const instances = dna.components.instances.filter((instance) => instance.stateId === stateId);
  const direct = instances.find((instance) => instance.nodeId === node.id);
  if (direct !== undefined) return direct.definitionId;
  let best: { readonly definitionId: string; readonly depth: number } | null = null;
  for (const instance of instances) {
    const root = instance.nodePath;
    const contains = root === '' || node.path.startsWith(`${root}/`);
    if (!contains) continue;
    const depth = root === '' ? 0 : root.split('/').length;
    if (best === null || depth > best.depth) best = { definitionId: instance.definitionId, depth };
  }
  return best === null ? null : best.definitionId;
}
