/**
 * Evidence envelope. Every MCP tool and CLI command returns its result inside
 * the same envelope so that provenance, limitations and unknowns are never
 * lost between the instrument and the agent.
 */

/** What kind of evidence a record describes. */
export type EvidenceKind =
  | 'scan'
  | 'explore'
  | 'inspect'
  | 'search'
  | 'tokens'
  | 'annotate'
  | 'generate'
  | 'verify'
  | 'report'
  | 'export'
  | 'reconstruct'
  | 'setup'
  | 'doctor';

/** A persisted evidence record in the per-session ledger. */
export interface EvidenceRecord {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly string[];
  readonly capturedAt: string;
  readonly scanId?: string;
  readonly notes?: readonly string[];
}

/** The envelope returned by every tool and command. */
export interface Envelope<T> {
  readonly result: T;
  readonly evidence_id: string;
  readonly evidence: {
    readonly kind: EvidenceKind;
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly artifacts: readonly string[];
    readonly capturedAt: string;
  };
  readonly limitations: readonly string[];
  readonly unknowns: readonly string[];
}

/** Cleanup performed after an interrupted operation; always reported, never hidden. */
export interface CleanupReport {
  readonly cleanup_incomplete: boolean;
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly reason?: string;
}

/** Build an envelope from a record and a result. */
export function envelope<T>(
  record: EvidenceRecord,
  result: T,
  extras: { limitations?: readonly string[]; unknowns?: readonly string[] } = {},
): Envelope<T> {
  return {
    result,
    evidence_id: record.id,
    evidence: {
      kind: record.kind,
      inputs: record.inputs,
      artifacts: record.artifacts,
      capturedAt: record.capturedAt,
    },
    limitations: extras.limitations ?? [],
    unknowns: extras.unknowns ?? [],
  };
}
