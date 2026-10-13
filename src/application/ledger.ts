/**
 * Per-session evidence ledger. Every tool call records what it did, with
 * which inputs and which artifacts. Records belonging to a scan are also
 * appended to that scan's `evidence/ledger.jsonl`.
 */
import { type Clock, systemClock, isoNow } from '../domain/clock.js';
import type { EvidenceKind, EvidenceRecord } from '../domain/evidence.js';
import { newEvidenceId } from '../domain/ids.js';
import type { ScanStore } from './scan-store.js';

/** Inputs to `EvidenceLedger.record`. */
export interface RecordInput {
  readonly kind: EvidenceKind;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly string[];
  readonly scanId?: string;
  readonly notes?: readonly string[];
}

/** Keeps the session's evidence records and persists scan-bound ones. */
export class EvidenceLedger {
  private readonly records: EvidenceRecord[] = [];

  constructor(
    private readonly store: ScanStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Create a record with a fresh id. Persisted when it belongs to an existing scan. */
  async record(input: RecordInput): Promise<EvidenceRecord> {
    const record: EvidenceRecord = {
      id: newEvidenceId(),
      kind: input.kind,
      inputs: redactInputs(input.inputs),
      artifacts: [...(input.artifacts ?? [])],
      capturedAt: isoNow(this.clock),
      ...(input.scanId === undefined ? {} : { scanId: input.scanId }),
      ...(input.notes === undefined ? {} : { notes: [...input.notes] }),
    };
    this.records.push(record);
    if (input.scanId && (await this.store.exists(input.scanId))) {
      // A failure to persist evidence must not fail the tool; it is reported through `session()` notes instead.
      const appended = await this.store.appendEvidence(input.scanId, record);
      if (!appended.ok) {
        this.records[this.records.length - 1] = { ...record, notes: [...(record.notes ?? []), `ledger not persisted: ${appended.error.message}`] };
      }
    }
    return record;
  }

  /** Records created during this session, oldest first. */
  session(): readonly EvidenceRecord[] {
    return this.records;
  }

  /** Attach artifacts to an existing record (used when artifacts are produced after the record was created). */
  withArtifacts(record: EvidenceRecord, artifacts: readonly string[]): EvidenceRecord {
    const updated: EvidenceRecord = { ...record, artifacts: [...record.artifacts, ...artifacts] };
    const index = this.records.findIndex((r) => r.id === record.id);
    if (index >= 0) this.records[index] = updated;
    return updated;
  }
}

const SECRET_KEY = /token|secret|password|authorization|cookie|api[-_]?key/i;

/** Drop secret-looking input fields before they are written anywhere. */
export function redactInputs(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined) continue;
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}
