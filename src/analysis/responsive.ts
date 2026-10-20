/**
 * Assemble `visual.responsive` from the responsive record of a scan.
 *
 * Breakpoints come from two kinds of evidence:
 * - probing located a change in the layout signature (rendered, display,
 *   position, flex direction, float, grid tracks) between two widths; a
 *   stylesheet threshold inside that bracket explains it (`css`), otherwise
 *   the narrowest width with the wider layout is the breakpoint (`probe`);
 * - a stylesheet threshold lies between two scanned widths, and a node its
 *   rules match shows a different computed value of a property those rules
 *   declare in the two captures (font size, padding, colors: properties the
 *   signature leaves out). The threshold is then a `css` breakpoint whose
 *   bracket is the pair of captures.
 *
 * Conditions are deduplicated across pages by text and stylesheet.
 */
import type { Limitation, MediaCondition, Responsive, ResponsiveBreakpoint, ResponsiveRule } from 'uidna-schema';
import type { CapturedState } from '../browser/types.js';
import type { PageResponsiveRecord, ResponsiveRecord } from '../application/records.js';
import { reconcileBreakpoints } from '../domain/responsive.js';

/** A page with its base captures, ascending by width. */
export interface ResponsivePage {
  readonly id: string;
  readonly bases: readonly { readonly stateId: string; readonly width: number; readonly capture: CapturedState }[];
}

export interface ResponsiveAssembly {
  readonly responsive: Responsive;
  readonly limitations: readonly Limitation[];
}

/** Value a signature key takes when its node or property is absent on one side. */
function absentValue(property: string): string {
  switch (property) {
    case 'position':
      return 'static';
    case 'float':
      return 'none';
    case 'grid-columns':
      return '0';
    case 'flex-direction':
      return 'none';
    case 'rendered':
      return 'false';
    default:
      return 'absent';
  }
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

interface PendingBreakpoint {
  minWidth: number;
  source: 'css' | 'probe';
  lower: number;
  upper: number;
  /** True when probing located it to its bracket; false for a stylesheet threshold seen only between two captures. */
  probed: boolean;
  conditionKeys: Set<string>;
  pageIds: Set<string>;
  rules: { pageId: string; path: string; property: string; below: string; above: string; source: 'probe' | 'stylesheet' }[];
}

/** Computed value of `property` on the node at `path`, or null when the node is absent. Missing properties are defaults. */
function styleAt(capture: CapturedState, path: string, property: string): string | null {
  const node = capture.nodes.find((n) => n.path === path);
  if (node === undefined) return null;
  return capture.styles[node.styleId]?.[property] ?? '(default)';
}

/** Assemble the responsive facet. `capturedAt` and `evidenceId` stamp provenance. */
export function assembleResponsive(record: ResponsiveRecord, pages: readonly ResponsivePage[], capturedAt: string): ResponsiveAssembly {
  const limitations: Limitation[] = [];
  const conditionKey = (text: string, url: string | null): string => `${url ?? 'inline'}\u0000${text}`;
  const conditionOrder: string[] = [];
  const conditionInfo = new Map<string, { text: string; kind: MediaCondition['kind']; url: string | null; origin: MediaCondition['stylesheet']['origin']; thresholds: number[]; never: boolean; unsupported: string[]; ruleCount: number; pageIds: Set<string>; effect: boolean | null }>();
  const breakpoints = new Map<string, PendingBreakpoint>();
  const probes: Responsive['probes'] = [];

  const addBreakpoint = (pageId: string, minWidth: number, source: 'css' | 'probe', lower: number, upper: number, probed: boolean, keys: readonly string[]): PendingBreakpoint => {
    const id = `${minWidth}\u0000${source}`;
    let entry = breakpoints.get(id);
    if (entry === undefined) {
      entry = { minWidth, source, lower, upper, probed, conditionKeys: new Set(), pageIds: new Set(), rules: [] };
      breakpoints.set(id, entry);
    } else {
      // The tightest bracket any page observed.
      if (upper - lower < entry.upper - entry.lower) {
        entry.lower = lower;
        entry.upper = upper;
      }
      entry.probed = entry.probed || probed;
    }
    entry.pageIds.add(pageId);
    for (const key of keys) entry.conditionKeys.add(key);
    return entry;
  };

  for (const page of pages) {
    const pageRecord: PageResponsiveRecord | undefined = record.pages[page.id];
    if (pageRecord === undefined) continue;
    for (const reason of pageRecord.limitations) limitations.push({ kind: 'not-observed', subject: `responsive ${page.id}`, reason });

    const keyed = pageRecord.conditions.map((condition) => {
      const key = conditionKey(condition.text, condition.sheet.url);
      const known = conditionInfo.get(key);
      if (known === undefined) {
        conditionOrder.push(key);
        conditionInfo.set(key, {
          text: condition.text,
          kind: condition.kind,
          url: condition.sheet.url,
          origin: condition.sheet.origin,
          thresholds: [...condition.thresholds],
          never: condition.never,
          unsupported: [...condition.unsupported],
          ruleCount: condition.ruleCount,
          pageIds: new Set([page.id]),
          effect: null,
        });
      } else {
        known.pageIds.add(page.id);
      }
      return { key, condition };
    });

    const located = new Set<number>();
    const probe = pageRecord.probe;
    if (probe !== null) {
      const reconciled = reconcileBreakpoints(
        probe.changePoints,
        keyed.map(({ key, condition }) => ({ id: key, thresholds: condition.thresholds, never: condition.never })),
        probe.widths,
      );
      for (const bp of reconciled.breakpoints) {
        located.add(bp.minWidth);
        const entry = addBreakpoint(page.id, bp.minWidth, bp.source, bp.bracket.lower, bp.bracket.upper, true, bp.conditionIds);
        for (const change of bp.changes) {
          entry.rules.push({
            pageId: page.id,
            path: change.path,
            property: change.property,
            below: change.below ?? absentValue(change.property),
            above: change.above ?? absentValue(change.property),
            source: 'probe',
          });
        }
      }
      for (const [key, effect] of reconciled.observedEffect) {
        const info = conditionInfo.get(key);
        if (info === undefined || effect === null) continue;
        info.effect = info.effect === true ? true : effect;
      }
      const min = probe.widths[0];
      const max = probe.widths[probe.widths.length - 1];
      for (const threshold of reconciled.unprobed) {
        limitations.push({
          kind: 'not-observed',
          subject: `breakpoint ${threshold}px on ${page.id}`,
          reason: `a stylesheet condition flips at ${threshold}px, outside the probed widths (${min ?? '?'}–${max ?? '?'}px); its effect was read from the stylesheet, not seen`,
        });
      }
      probes.push({
        pageId: page.id,
        height: probe.height,
        widths: [...probe.widths],
        maxProbes: probe.maxProbes,
        exhausted: probe.exhausted,
        blockedRequests: probe.blockedRequests,
        evidenceId: record.evidenceId,
      });
    }

    // Stylesheet evidence between captures: properties the signature leaves out (font size, spacing, colors).
    for (let i = 1; i < page.bases.length; i += 1) {
      const lo = page.bases[i - 1];
      const hi = page.bases[i];
      if (lo === undefined || hi === undefined) continue;
      for (const { key, condition } of keyed) {
        if (condition.never) continue;
        for (const threshold of condition.thresholds) {
          if (threshold <= lo.width || threshold > hi.width) continue;
          const rules: PendingBreakpoint['rules'] = [];
          for (const target of condition.targets) {
            for (const property of target.properties) {
              const below = styleAt(lo.capture, target.path, property);
              const above = styleAt(hi.capture, target.path, property);
              if (below === null || above === null || below === above) continue;
              rules.push({ pageId: page.id, path: target.path, property, below, above, source: 'stylesheet' });
            }
          }
          if (rules.length === 0) continue;
          // A probe may have located this threshold already: its rules then gain the declared properties the signature leaves out (sizes, fonts, colors).
          const entry = addBreakpoint(page.id, threshold, 'css', lo.width, hi.width, located.has(threshold), [key]);
          const seen = new Set(entry.rules.filter((r) => r.pageId === page.id).map((r) => `${r.path}|${r.property}`));
          entry.rules.push(...rules.filter((r) => !seen.has(`${r.path}|${r.property}`)));
          const info = conditionInfo.get(key);
          if (info !== undefined) info.effect = true;
        }
      }
    }
  }

  const conditionIds = new Map<string, string>(conditionOrder.map((key, i) => [key, `mq_${pad(i + 1, 2)}`]));
  const conditions: MediaCondition[] = conditionOrder.flatMap((key) => {
    const info = conditionInfo.get(key);
    const id = conditionIds.get(key);
    if (info === undefined || id === undefined) return [];
    return [
      {
        id,
        text: info.text,
        kind: info.kind,
        thresholds: info.thresholds,
        never: info.never,
        unsupported: info.unsupported,
        stylesheet: { url: info.url, origin: info.origin },
        ruleCount: info.ruleCount,
        pageIds: [...info.pageIds].sort(),
        observedEffect: info.effect,
        provenance: { kind: 'measured', source: 'stylesheet', capturedAt, evidenceId: record.evidenceId, confidence: 1 },
      },
    ];
  });

  const ordered = [...breakpoints.values()].sort((a, b) => a.minWidth - b.minWidth || a.source.localeCompare(b.source, 'en'));
  const outBreakpoints: ResponsiveBreakpoint[] = [];
  const rules: ResponsiveRule[] = [];
  ordered.forEach((bp, i) => {
    const id = `bp_${pad(i + 1, 2)}`;
    // A bracket must contain minWidth: lower < minWidth <= upper.
    const lower = Math.min(bp.lower, bp.minWidth - 1);
    const upper = Math.max(bp.upper, bp.minWidth);
    outBreakpoints.push({
      id,
      minWidth: bp.minWidth,
      source: bp.source,
      bracket: { lower, upper },
      observed: true,
      conditionIds: [...bp.conditionKeys].map((key) => conditionIds.get(key)).filter((cid): cid is string => cid !== undefined).sort(),
      pageIds: [...bp.pageIds].sort(),
      provenance:
        bp.source === 'css'
          ? { kind: 'measured', source: 'stylesheet', capturedAt, evidenceId: record.evidenceId, confidence: 1 }
          : { kind: 'observed', source: 'computed-style', capturedAt, evidenceId: record.evidenceId, confidence: bp.upper - bp.lower <= 1 ? 1 : 0.5 },
    });
    for (const rule of bp.rules) {
      rules.push({
        id: `rr_${pad(rules.length + 1, 3)}`,
        breakpointId: id,
        pageId: rule.pageId,
        nodePath: rule.path,
        property: rule.property,
        below: rule.below,
        above: rule.above,
        // Probe values are read while resizing; stylesheet-attributed values come from the two captures: both are computed styles.
        provenance: { kind: 'observed', source: 'computed-style', capturedAt, evidenceId: record.evidenceId, confidence: 1 },
      });
    }
  });

  return { responsive: { breakpoints: outBreakpoints, conditions, rules, probes }, limitations };
}
