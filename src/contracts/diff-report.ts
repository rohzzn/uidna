/**
 * The DiffReport: the structured output of `verify_reconstruction`. Every
 * finding carries a category, the measured original and generated values,
 * the attributed component or token and evidence references. There is no
 * single opaque score.
 */
import { z } from 'zod';
import { ActionSchema, BoxSchema, ViewportSchema } from '@rohzzn/uidna-schema';

export const FINDING_CATEGORIES = ['layout', 'typography', 'color', 'missing', 'asset', 'responsive', 'behavior'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

const MeasuredValue = z.union([z.string(), z.number(), z.null()]);

/** One concrete difference between the original and the reconstruction. */
export const FindingSchema = z.strictObject({
  id: z.string().min(1),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  stateId: z.string().min(1),
  viewport: ViewportSchema,
  /** What was compared: a CSS property, `box.width`, `role-tree`, `pixels`, etc. */
  property: z.string().min(1),
  /** Node of the original the finding is about, when applicable. */
  nodeId: z.string().nullable(),
  nodePath: z.string().nullable(),
  /** Role and name of the original node for locating it in the generated app. */
  role: z.string().nullable(),
  name: z.string().nullable(),
  componentId: z.string().nullable(),
  tokenId: z.string().nullable(),
  transitionId: z.string().nullable(),
  original: MeasuredValue,
  generated: MeasuredValue,
  /** Numeric difference when both values are numeric (pixels, ratio). */
  delta: z.number().nullable(),
  message: z.string().min(1),
  /** Evidence ids and artifact paths relative to the scan directory. */
  evidence: z.array(z.string()),
  /** Stable key used to match findings across attempts (regression detection). */
  key: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Pixel comparison of two screenshots. */
export const PixelComparisonSchema = z.strictObject({
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  comparedPixels: z.number().int().min(0),
  diffPixels: z.number().int().min(0),
  /** `diffPixels / comparedPixels`, or null when nothing could be compared. */
  diffRatio: z.number().min(0).max(1).nullable(),
  /** Structural similarity in [0, 1], or null when it could not be computed. */
  ssim: z.number().min(0).max(1).nullable(),
  /** True when the two screenshots had different sizes and were compared on the overlap. */
  sizeMismatch: z.boolean(),
  diffImagePath: z.string().nullable(),
});
export type PixelComparison = z.infer<typeof PixelComparisonSchema>;

/** Visual comparison of one state at one viewport. */
export const VisualComparisonSchema = z.strictObject({
  stateId: z.string().min(1),
  viewport: ViewportSchema,
  originalScreenshot: z.string(),
  generatedScreenshot: z.string().nullable(),
  pixels: PixelComparisonSchema.nullable(),
  /** Geometry: how many original nodes were matched in the generated app and the max box drift. */
  geometry: z.strictObject({
    comparedNodes: z.number().int().min(0),
    matchedNodes: z.number().int().min(0),
    missingNodes: z.number().int().min(0),
    extraNodes: z.number().int().min(0),
    maxDriftPx: z.number().min(0),
  }),
  /** Computed-style comparison over matched nodes. */
  styles: z.strictObject({
    comparedProperties: z.number().int().min(0),
    differingProperties: z.number().int().min(0),
  }),
  findings: z.array(FindingSchema),
  /** Why the comparison is partial, if it is. */
  limitations: z.array(z.string()),
});
export type VisualComparison = z.infer<typeof VisualComparisonSchema>;

/** Replay of one recorded transition against the generated app. */
export const BehaviorComparisonSchema = z.strictObject({
  transitionId: z.string().min(1),
  fromStateId: z.string().min(1),
  toStateId: z.string().min(1),
  viewport: ViewportSchema,
  action: ActionSchema,
  /** Locator used in the generated app. */
  locator: z.strictObject({ role: z.string().nullable(), name: z.string().nullable(), nth: z.number().int().min(0) }),
  replayed: z.boolean(),
  reason: z.string().nullable(),
  roleTreeMatch: z.boolean().nullable(),
  /** Role tree entries present in the original target state but missing after replay, and vice versa. */
  roleTreeDiff: z.strictObject({
    missing: z.array(z.string()),
    extra: z.array(z.string()),
  }),
  pixels: PixelComparisonSchema.nullable(),
  generatedScreenshot: z.string().nullable(),
  findings: z.array(FindingSchema),
});
export type BehaviorComparison = z.infer<typeof BehaviorComparisonSchema>;

/** Which original box matched which generated box (used by the HTML report overlays). */
export const BoxMatchSchema = z.strictObject({
  nodeId: z.string().min(1),
  original: BoxSchema,
  generated: BoxSchema.nullable(),
});

/** The complete verification result for one attempt. */
export const DiffReportSchema = z.strictObject({
  id: z.string().min(1),
  scanId: z.string().min(1),
  outDir: z.string().min(1),
  /** 1-based attempt number within the scan. */
  attempt: z.number().int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  thresholds: z.strictObject({
    /** Pixel diff ratio above which a `layout` finding of severity high is raised. */
    pixelRatioHigh: z.number().min(0).max(1),
    pixelRatioMedium: z.number().min(0).max(1),
    /** Box drift in CSS pixels above which a geometry finding is raised. */
    boxDriftPx: z.number().min(0),
    /** Color distance (0-441, Euclidean RGB) above which a color finding is raised. */
    colorDistance: z.number().min(0),
  }),
  summary: z.strictObject({
    states: z.number().int().min(0),
    transitions: z.number().int().min(0),
    findings: z.number().int().min(0),
    byCategory: z.record(z.enum(FINDING_CATEGORIES), z.number().int().min(0)),
    bySeverity: z.record(z.enum(FINDING_SEVERITIES), z.number().int().min(0)),
    transitionsReplayed: z.number().int().min(0),
    transitionsMatched: z.number().int().min(0),
  }),
  visual: z.array(VisualComparisonSchema),
  behavioral: z.array(BehaviorComparisonSchema),
  /** Findings present now that were absent in the previous attempt. Empty on the first attempt. */
  regressions: z.array(FindingSchema),
  /** Findings present in the previous attempt that are gone now. */
  resolved: z.array(FindingSchema),
  previousAttempt: z.number().int().min(1).nullable(),
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
  /** Artifact paths relative to the scan directory. */
  artifacts: z.array(z.string()),
});
export type DiffReport = z.infer<typeof DiffReportSchema>;

/** Default thresholds. */
export const DEFAULT_THRESHOLDS: DiffReport['thresholds'] = {
  pixelRatioHigh: 0.1,
  pixelRatioMedium: 0.02,
  boxDriftPx: 4,
  colorDistance: 12,
};
