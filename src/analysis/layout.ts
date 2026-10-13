/**
 * Layout constraints: for every visible container node in every state, its
 * box, display, position, flex or grid flow, sizing and spacing, each value
 * attributed to the computed style or bounding box it was read from.
 * Properties the instrument dropped as UA defaults are reported with that
 * default (the capture contract defines a missing property as the default).
 */
import type { Attributed, Box, LayoutConstraint, ProvenanceContext } from '@uidna/schema';
import { measured, unknown } from '@uidna/schema';
import { STYLE_DEFAULTS } from '../browser/style-properties.js';
import { stateContext, styleValue, type CaptureMap, type EvidenceIndex } from './common.js';

/** Context for layout extraction. */
export interface LayoutContext {
  readonly evidenceIdByState?: EvidenceIndex;
}

const FLEX_DISPLAYS = new Set(['flex', 'inline-flex']);
const GRID_DISPLAYS = new Set(['grid', 'inline-grid']);

function shorthand(style: Readonly<Record<string, string>> | undefined, prefix: 'margin' | 'padding'): string | null {
  const sides = ['top', 'right', 'bottom', 'left'].map((side) => styleValue(style, `${prefix}-${side}`));
  if (sides.some((v) => v === undefined)) return null;
  return sides.join(' ');
}

/** The effective gap: `gap` when captured, otherwise `row-gap`/`column-gap`, otherwise the UA default. */
function gapValue(style: Readonly<Record<string, string>> | undefined): string | undefined {
  const gap = style?.gap;
  if (gap !== undefined) return gap;
  const row = style?.['row-gap'];
  const column = style?.['column-gap'];
  if (row === undefined && column === undefined) return STYLE_DEFAULTS.gap;
  if (row !== undefined && column !== undefined) return row === column ? row : `${row} ${column}`;
  return row ?? column;
}

/** Compute layout constraints for every visible node with element children. */
export function computeLayout(captures: CaptureMap, ctx: LayoutContext = {}): LayoutConstraint[] {
  const constraints: LayoutConstraint[] = [];
  for (const [stateId, capture] of captures) {
    const context: ProvenanceContext = stateContext(stateId, capture, ctx.evidenceIdByState);
    for (const node of capture.nodes) {
      if (!node.visible || node.childIds.length === 0) continue;
      const style = capture.styles[node.styleId];
      const missingStyle = style === undefined;

      const prop = (name: string): Attributed<string> => {
        if (missingStyle) return unknown(`style ${node.styleId} is missing from the state style table`, { ...context, source: 'computed-style' });
        const value = styleValue(style, name);
        return value === undefined ? unknown(`${name} not captured`, { ...context, source: 'computed-style' }) : measured(value, 'computed-style', context, 1);
      };
      const optional = (name: string): Attributed<string> | undefined => {
        const own = style?.[name];
        return own === undefined ? undefined : measured(own, 'computed-style', context, 1);
      };

      const display = prop('display');
      const displayValue = display.value ?? '';
      const flow = FLEX_DISPLAYS.has(displayValue)
        ? {
            direction: prop('flex-direction'),
            wrap: prop('flex-wrap'),
            justify: prop('justify-content'),
            align: prop('align-items'),
            gap: gapAttr(style, context, missingStyle),
          }
        : undefined;
      const grid = GRID_DISPLAYS.has(displayValue)
        ? {
            templateColumns: prop('grid-template-columns'),
            templateRows: prop('grid-template-rows'),
            autoFlow: prop('grid-auto-flow'),
            gap: gapAttr(style, context, missingStyle),
          }
        : undefined;

      const margin = shorthand(style, 'margin');
      const padding = shorthand(style, 'padding');
      const minWidth = optional('min-width');
      const maxWidth = optional('max-width');
      const minHeight = optional('min-height');
      const maxHeight = optional('max-height');

      constraints.push({
        stateId,
        nodeId: node.id,
        nodePath: node.path,
        box: node.box === null ? unknown<Box>('node has no bounding box', { ...context, source: 'bounding-box' }) : measured(node.box, 'bounding-box', context, 1),
        display,
        position: prop('position'),
        ...(flow ? { flow } : {}),
        ...(grid ? { grid } : {}),
        sizing: {
          width: prop('width'),
          height: prop('height'),
          ...(minWidth ? { minWidth } : {}),
          ...(maxWidth ? { maxWidth } : {}),
          ...(minHeight ? { minHeight } : {}),
          ...(maxHeight ? { maxHeight } : {}),
        },
        spacing: {
          margin: margin === null ? unknown<string>('margin not captured', { ...context, source: 'computed-style' }) : measured(margin, 'computed-style', context, 1),
          padding: padding === null ? unknown<string>('padding not captured', { ...context, source: 'computed-style' }) : measured(padding, 'computed-style', context, 1),
        },
      });
    }
  }
  return constraints;
}

function gapAttr(style: Readonly<Record<string, string>> | undefined, context: ProvenanceContext, missingStyle: boolean): Attributed<string> {
  if (missingStyle) return unknown('style missing from the state style table', { ...context, source: 'computed-style' });
  const value = gapValue(style);
  return value === undefined ? unknown('gap not captured', { ...context, source: 'computed-style' }) : measured(value, 'computed-style', context, 1);
}
