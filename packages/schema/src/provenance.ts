/**
 * Provenance envelope. Every measured or inferred value in a UI DNA document
 * is wrapped with how it was obtained. Missing evidence is `unknown` with a
 * reason; it is never an empty string, zero or `false`.
 */
import { z } from 'zod';

/** The four provenance kinds. Measured beats observed, observed beats inferred. */
export const PROVENANCE_KINDS = ['measured', 'observed', 'inferred', 'unknown'] as const;

/** Where a value came from. `agent` is the only source allowed for `inferred`. */
export const PROVENANCE_SOURCES = [
  'computed-style',
  'bounding-box',
  'a11y-tree',
  'screenshot',
  'interaction',
  'network',
  'stylesheet',
  'agent',
] as const;

/** Instrument sources: everything except `agent`. */
export const INSTRUMENT_SOURCES = [
  'computed-style',
  'bounding-box',
  'a11y-tree',
  'screenshot',
  'interaction',
  'network',
  'stylesheet',
] as const;

/** Viewport size in CSS pixels. */
export const ViewportSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

const IsoDateTime = z.iso.datetime({ offset: true });
const Confidence = z.number().min(0).max(1);

/** Provenance of a value measured directly by the instrument. */
export const MeasuredProvenanceSchema = z.strictObject({
  kind: z.literal('measured'),
  source: z.enum(INSTRUMENT_SOURCES),
  stateId: z.string().optional(),
  viewport: ViewportSchema.optional(),
  evidenceId: z.string().optional(),
  capturedAt: IsoDateTime,
  confidence: Confidence,
});
export type MeasuredProvenance = z.infer<typeof MeasuredProvenanceSchema>;

/** Provenance of a value observed by the instrument (an interaction outcome, a visual change) rather than measured as a number. */
export const ObservedProvenanceSchema = z.strictObject({
  kind: z.literal('observed'),
  source: z.enum(INSTRUMENT_SOURCES),
  stateId: z.string().optional(),
  viewport: ViewportSchema.optional(),
  evidenceId: z.string().optional(),
  capturedAt: IsoDateTime,
  confidence: Confidence,
});
export type ObservedProvenance = z.infer<typeof ObservedProvenanceSchema>;

/** Provenance of a value written by the host agent through `annotate_dna`. Only `agent` may infer. */
export const InferredProvenanceSchema = z.strictObject({
  kind: z.literal('inferred'),
  source: z.literal('agent'),
  stateId: z.string().optional(),
  viewport: ViewportSchema.optional(),
  evidenceId: z.string().optional(),
  capturedAt: IsoDateTime,
  confidence: Confidence,
  /** Why the agent believes this. */
  rationale: z.string().optional(),
  /** Evidence ids the inference rests on. */
  basedOn: z.array(z.string()).optional(),
});
export type InferredProvenance = z.infer<typeof InferredProvenanceSchema>;

/** Provenance of a value that could not be obtained. Carries the reason instead of a value. */
export const UnknownProvenanceSchema = z.strictObject({
  kind: z.literal('unknown'),
  reason: z.string().min(1),
  source: z.enum(INSTRUMENT_SOURCES).optional(),
  stateId: z.string().optional(),
  viewport: ViewportSchema.optional(),
  evidenceId: z.string().optional(),
  capturedAt: IsoDateTime.optional(),
});
export type UnknownProvenance = z.infer<typeof UnknownProvenanceSchema>;

/** Provenance for values that exist (measured, observed or inferred). */
export const KnownProvenanceSchema = z.discriminatedUnion('kind', [
  MeasuredProvenanceSchema,
  ObservedProvenanceSchema,
  InferredProvenanceSchema,
]);
export type KnownProvenance = z.infer<typeof KnownProvenanceSchema>;

/** Any provenance. */
export const ProvenanceSchema = z.discriminatedUnion('kind', [
  MeasuredProvenanceSchema,
  ObservedProvenanceSchema,
  InferredProvenanceSchema,
  UnknownProvenanceSchema,
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ProvenanceKind = Provenance['kind'];
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

/**
 * Wrap a value schema in the provenance envelope. A known value carries a
 * known provenance; an unknown value is `null` with an `unknown` provenance
 * that explains why. An `annotation` lets the agent attach its own reading
 * next to the measured one without overwriting it.
 */
export function attributed<T extends z.ZodType>(value: T) {
  const annotation = z.strictObject({ value, provenance: InferredProvenanceSchema });
  return z.union([
    z.strictObject({ value, provenance: KnownProvenanceSchema, annotation: annotation.optional() }),
    z.strictObject({ value: z.null(), provenance: UnknownProvenanceSchema, annotation: annotation.optional() }),
  ]);
}

/** TypeScript shape of an attributed value. */
export type Attributed<T> =
  | { value: T; provenance: KnownProvenance; annotation?: { value: T; provenance: InferredProvenance } }
  | { value: null; provenance: UnknownProvenance; annotation?: { value: T; provenance: InferredProvenance } };

/** Context shared by many measured values of one capture. */
export interface ProvenanceContext {
  stateId?: string;
  viewport?: Viewport;
  evidenceId?: string;
  capturedAt: string;
}

function withContext<K extends 'measured' | 'observed'>(
  kind: K,
  source: (typeof INSTRUMENT_SOURCES)[number],
  context: ProvenanceContext,
  confidence: number,
): K extends 'measured' ? MeasuredProvenance : ObservedProvenance {
  const provenance: MeasuredProvenance | ObservedProvenance = {
    kind,
    source,
    capturedAt: context.capturedAt,
    confidence,
    ...(context.stateId === undefined ? {} : { stateId: context.stateId }),
    ...(context.viewport === undefined ? {} : { viewport: context.viewport }),
    ...(context.evidenceId === undefined ? {} : { evidenceId: context.evidenceId }),
  };
  return provenance as K extends 'measured' ? MeasuredProvenance : ObservedProvenance;
}

/** Build a measured value. */
export function measured<T>(
  value: T,
  source: (typeof INSTRUMENT_SOURCES)[number],
  context: ProvenanceContext,
  confidence = 1,
): Attributed<T> {
  return { value, provenance: withContext('measured', source, context, confidence) };
}

/** Build an observed value. */
export function observed<T>(
  value: T,
  source: (typeof INSTRUMENT_SOURCES)[number],
  context: ProvenanceContext,
  confidence = 1,
): Attributed<T> {
  return { value, provenance: withContext('observed', source, context, confidence) };
}

/** Build an inferred (agent-written) value. */
export function inferred<T>(
  value: T,
  context: ProvenanceContext & { rationale?: string; basedOn?: string[] },
  confidence: number,
): Attributed<T> {
  const provenance: InferredProvenance = {
    kind: 'inferred',
    source: 'agent',
    capturedAt: context.capturedAt,
    confidence,
    ...(context.stateId === undefined ? {} : { stateId: context.stateId }),
    ...(context.viewport === undefined ? {} : { viewport: context.viewport }),
    ...(context.evidenceId === undefined ? {} : { evidenceId: context.evidenceId }),
    ...(context.rationale === undefined ? {} : { rationale: context.rationale }),
    ...(context.basedOn === undefined ? {} : { basedOn: context.basedOn }),
  };
  return { value, provenance };
}

/** Build an unknown value with a reason. */
export function unknown<T = never>(reason: string, context: Partial<ProvenanceContext> & { source?: (typeof INSTRUMENT_SOURCES)[number] } = {}): Attributed<T> {
  const provenance: UnknownProvenance = {
    kind: 'unknown',
    reason,
    ...(context.source === undefined ? {} : { source: context.source }),
    ...(context.stateId === undefined ? {} : { stateId: context.stateId }),
    ...(context.viewport === undefined ? {} : { viewport: context.viewport }),
    ...(context.evidenceId === undefined ? {} : { evidenceId: context.evidenceId }),
    ...(context.capturedAt === undefined ? {} : { capturedAt: context.capturedAt }),
  };
  return { value: null, provenance };
}

/** True when the attributed value is known (not `unknown`). */
export function isKnown<T>(attr: Attributed<T>): attr is Extract<Attributed<T>, { value: T }> {
  return attr.provenance.kind !== 'unknown';
}

/** The agent's annotation when present, otherwise the instrument's value. */
export function effectiveValue<T>(attr: Attributed<T>): T | null {
  if (attr.annotation) return attr.annotation.value;
  return attr.value;
}
