/**
 * The scan store: validated reads and writes under `.uidna/<scan-id>/`.
 * Nothing invalid is ever stored, and nothing stored is trusted on read.
 */
import { mkdir, readFile, readdir, stat, writeFile, appendFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import { parseUiDna, formatIssues, isCompatibleVersion, validateUiDna, type UiDnaDocument } from '@rohzzn/uidna-schema';
import { CapturedStateSchema } from '../browser/schemas.js';
import type { CapturedState } from '../browser/types.js';
import { DiffReportSchema, type DiffReport } from '../contracts/diff-report.js';
import { type Clock, systemClock, isoNow } from '../domain/clock.js';
import { uidnaError, toError } from '../domain/errors.js';
import type { EvidenceRecord } from '../domain/evidence.js';
import { isScanId } from '../domain/ids.js';
import { err, ok, type Result } from '../domain/result.js';
import {
  EvidenceRecordSchema,
  ExploreRecordSchema,
  GenerateRecordSchema,
  ResponsiveRecordSchema,
  ScanRecordSchema,
  type ExploreRecord,
  type GenerateRecord,
  type ResponsiveRecord,
  type ScanRecord,
} from './records.js';

/** Default root directory for scans. */
export const DEFAULT_OUT_ROOT = '.uidna';

/** Read, validate and write artifacts of one scan root. */
export class ScanStore {
  readonly root: string;

  constructor(
    root: string = DEFAULT_OUT_ROOT,
    private readonly clock: Clock = systemClock,
  ) {
    this.root = resolve(root);
  }

  /** Absolute directory of a scan. Rejects ids that are not scan ids (path safety). */
  scanDir(scanId: string): string {
    if (!isScanId(scanId)) throw new Error(`not a scan id: ${scanId}`);
    return join(this.root, scanId);
  }

  /** Absolute path of a file inside a scan directory. The relative path must stay inside it. */
  resolvePath(scanId: string, relativePath: string): string {
    const dir = this.scanDir(scanId);
    const full = resolve(dir, relativePath);
    if (full !== dir && !full.startsWith(dir + sep)) throw new Error(`path escapes scan directory: ${relativePath}`);
    return full;
  }

  /** Path relative to the scan directory, with forward slashes. */
  relativePath(scanId: string, absolutePath: string): string {
    const dir = this.scanDir(scanId);
    const rel = isAbsolute(absolutePath) ? relative(dir, absolutePath) : absolutePath;
    return rel.split(sep).join('/');
  }

  /** Directory of a state inside a scan. */
  stateDir(scanId: string, stateId: string): string {
    if (!/^st_\d{2,}$/.test(stateId)) throw new Error(`not a state id: ${stateId}`);
    return join(this.scanDir(scanId), 'states', stateId);
  }

  /** Directory for a verification attempt. */
  attemptDir(scanId: string, attempt: number): string {
    return join(this.scanDir(scanId), 'verify', `attempt-${attempt}`);
  }

  /** List scan ids under the root, newest first. */
  async list(): Promise<Result<string[]>> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      const ids = entries.filter((e) => e.isDirectory() && isScanId(e.name)).map((e) => e.name);
      return ok(ids.sort().reverse());
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') return ok([]);
      return err(toError(cause, 'io', `list scans in ${this.root}`));
    }
  }

  /** True when the scan directory exists. */
  async exists(scanId: string): Promise<boolean> {
    if (!isScanId(scanId)) return false;
    try {
      const s = await stat(this.scanDir(scanId));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /** Create the scan directory tree. */
  async createScan(record: ScanRecord): Promise<Result<string>> {
    const dir = this.scanDir(record.scanId);
    try {
      await mkdir(join(dir, 'states'), { recursive: true });
      await mkdir(join(dir, 'evidence'), { recursive: true });
      await mkdir(join(dir, 'assets'), { recursive: true });
    } catch (cause) {
      return err(toError(cause, 'io', `create scan directory ${dir}`));
    }
    const saved = await this.saveScan(record);
    return saved.ok ? ok(dir) : saved;
  }

  /** Validate and write `scan.json`, bumping `updatedAt`. */
  async saveScan(record: ScanRecord): Promise<Result<void>> {
    const stamped: ScanRecord = { ...record, updatedAt: isoNow(this.clock) };
    return this.writeJson(record.scanId, 'scan.json', ScanRecordSchema, stamped);
  }

  /** Read and validate `scan.json`. */
  async loadScan(scanId: string): Promise<Result<ScanRecord>> {
    if (!isScanId(scanId)) return err(uidnaError('validation', `not a scan id: ${scanId}`));
    if (!(await this.exists(scanId))) return err(uidnaError('not-found', `scan ${scanId} not found under ${this.root}`));
    return this.readJson(scanId, 'scan.json', ScanRecordSchema);
  }

  /** Validate and write the UI DNA document. Invalid documents are never written. */
  async saveDna(scanId: string, document: UiDnaDocument): Promise<Result<string>> {
    const validation = validateUiDna(document);
    if (!validation.success) {
      return err(
        uidnaError('validation', `UI DNA document for ${scanId} is invalid: ${formatIssues(validation).slice(0, 5).join('; ')}`, {
          details: { issues: formatIssues(validation) },
        }),
      );
    }
    const written = await this.writeRaw(scanId, 'dna.json', JSON.stringify(validation.data, null, 2));
    return written.ok ? ok(this.resolvePath(scanId, 'dna.json')) : written;
  }

  /** Read and validate the UI DNA document. */
  async loadDna(scanId: string): Promise<Result<UiDnaDocument>> {
    const raw = await this.readRaw(scanId, 'dna.json');
    if (!raw.ok) return raw;
    let json: unknown;
    try {
      json = JSON.parse(raw.value);
    } catch (cause) {
      return err(toError(cause, 'validation', `dna.json of ${scanId} is not JSON`));
    }
    const version = (json as { dnaVersion?: unknown }).dnaVersion;
    if (typeof version === 'string' && !isCompatibleVersion(version)) {
      return err(uidnaError('unsupported', `dna.json of ${scanId} has dnaVersion ${version}, which this version of uidna cannot read`));
    }
    try {
      return ok(parseUiDna(json));
    } catch (cause) {
      return err(toError(cause, 'validation', `dna.json of ${scanId} is invalid`));
    }
  }

  /** True when `dna.json` exists. */
  async hasDna(scanId: string): Promise<boolean> {
    return this.fileExists(scanId, 'dna.json');
  }

  /** Write a captured state to `states/<stateId>/capture.json`. Returns the relative path. */
  async saveCapture(scanId: string, stateId: string, capture: CapturedState): Promise<Result<string>> {
    const rel = `states/${stateId}/capture.json`;
    const written = await this.writeJson(scanId, rel, CapturedStateSchema, capture);
    return written.ok ? ok(rel) : written;
  }

  /** Read and validate a captured state. */
  async loadCapture(scanId: string, stateId: string): Promise<Result<CapturedState>> {
    return this.readJson(scanId, `states/${stateId}/capture.json`, CapturedStateSchema);
  }

  /** Load every capture listed in the scan record. */
  async loadAllCaptures(scanId: string, record: ScanRecord): Promise<Result<Map<string, CapturedState>>> {
    const captures = new Map<string, CapturedState>();
    for (const state of record.states) {
      const loaded = await this.loadCapture(scanId, state.stateId);
      if (!loaded.ok) return loaded;
      captures.set(state.stateId, loaded.value);
    }
    return ok(captures);
  }

  async saveExplore(scanId: string, record: ExploreRecord): Promise<Result<string>> {
    const written = await this.writeJson(scanId, 'explore.json', ExploreRecordSchema, record);
    return written.ok ? ok('explore.json') : written;
  }

  async loadExplore(scanId: string): Promise<Result<ExploreRecord | null>> {
    if (!(await this.fileExists(scanId, 'explore.json'))) return ok(null);
    return this.readJson(scanId, 'explore.json', ExploreRecordSchema);
  }

  async saveResponsive(scanId: string, record: ResponsiveRecord): Promise<Result<string>> {
    const written = await this.writeJson(scanId, 'responsive.json', ResponsiveRecordSchema, record);
    return written.ok ? ok('responsive.json') : written;
  }

  async loadResponsive(scanId: string): Promise<Result<ResponsiveRecord | null>> {
    if (!(await this.fileExists(scanId, 'responsive.json'))) return ok(null);
    return this.readJson(scanId, 'responsive.json', ResponsiveRecordSchema);
  }

  async saveGenerate(scanId: string, record: GenerateRecord): Promise<Result<string>> {
    const written = await this.writeJson(scanId, 'generate.json', GenerateRecordSchema, record);
    return written.ok ? ok('generate.json') : written;
  }

  async loadGenerate(scanId: string): Promise<Result<GenerateRecord | null>> {
    if (!(await this.fileExists(scanId, 'generate.json'))) return ok(null);
    return this.readJson(scanId, 'generate.json', GenerateRecordSchema);
  }

  /** Write a diff report for an attempt. Returns the relative path. */
  async saveDiffReport(scanId: string, report: DiffReport): Promise<Result<string>> {
    const rel = `verify/attempt-${report.attempt}/diff-report.json`;
    const written = await this.writeJson(scanId, rel, DiffReportSchema, report);
    return written.ok ? ok(rel) : written;
  }

  async loadDiffReport(scanId: string, attempt: number): Promise<Result<DiffReport>> {
    return this.readJson(scanId, `verify/attempt-${attempt}/diff-report.json`, DiffReportSchema);
  }

  /** Attempt numbers that have a diff report, ascending. */
  async listAttempts(scanId: string): Promise<number[]> {
    try {
      const entries = await readdir(join(this.scanDir(scanId), 'verify'), { withFileTypes: true });
      const attempts: number[] = [];
      for (const entry of entries) {
        const match = /^attempt-(\d+)$/.exec(entry.name);
        if (entry.isDirectory() && match && (await this.fileExists(scanId, `verify/${entry.name}/diff-report.json`))) {
          attempts.push(Number(match[1]));
        }
      }
      return attempts.sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** Append an evidence record to the ledger. */
  async appendEvidence(scanId: string, record: EvidenceRecord): Promise<Result<void>> {
    const parsed = EvidenceRecordSchema.safeParse(record);
    if (!parsed.success) return err(uidnaError('validation', `invalid evidence record: ${parsed.error.message}`));
    try {
      const path = this.resolvePath(scanId, 'evidence/ledger.jsonl');
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(parsed.data) + '\n', 'utf8');
      return ok(undefined);
    } catch (cause) {
      return err(toError(cause, 'io', 'append evidence'));
    }
  }

  /** Read the evidence ledger. Malformed lines are reported, not silently dropped. */
  async readEvidence(scanId: string): Promise<Result<{ records: EvidenceRecord[]; malformed: number }>> {
    if (!(await this.fileExists(scanId, 'evidence/ledger.jsonl'))) return ok({ records: [], malformed: 0 });
    const raw = await this.readRaw(scanId, 'evidence/ledger.jsonl');
    if (!raw.ok) return raw;
    const byId = new Map<string, EvidenceRecord>();
    let malformed = 0;
    for (const line of raw.value.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = EvidenceRecordSchema.safeParse(JSON.parse(line));
        // A record may be appended again with more artifacts; the last line per id wins.
        if (parsed.success) byId.set(parsed.data.id, parsed.data as EvidenceRecord);
        else malformed += 1;
      } catch {
        malformed += 1;
      }
    }
    return ok({ records: [...byId.values()], malformed });
  }

  /** Write any JSON file after validating it with `schema`. */
  async writeJson<T>(scanId: string, relativePath: string, schema: z.ZodType<T>, value: T): Promise<Result<void>> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
      return err(uidnaError('validation', `refusing to write invalid ${relativePath}: ${issues.join('; ')}`, { details: { issues } }));
    }
    return this.writeRaw(scanId, relativePath, JSON.stringify(parsed.data, null, 2));
  }

  /** Read any JSON file and validate it with `schema`. */
  async readJson<T>(scanId: string, relativePath: string, schema: z.ZodType<T>): Promise<Result<T>> {
    const raw = await this.readRaw(scanId, relativePath);
    if (!raw.ok) return raw;
    let json: unknown;
    try {
      json = JSON.parse(raw.value);
    } catch (cause) {
      return err(toError(cause, 'validation', `${relativePath} of ${scanId} is not JSON`));
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
      return err(uidnaError('validation', `${relativePath} of ${scanId} is invalid: ${issues.join('; ')}`, { details: { issues } }));
    }
    return ok(parsed.data);
  }

  /** Write a text file inside the scan directory. */
  async writeRaw(scanId: string, relativePath: string, content: string | Buffer): Promise<Result<void>> {
    try {
      const path = this.resolvePath(scanId, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      return ok(undefined);
    } catch (cause) {
      return err(toError(cause, 'io', `write ${relativePath}`));
    }
  }

  /** Read a text file inside the scan directory. */
  async readRaw(scanId: string, relativePath: string): Promise<Result<string>> {
    try {
      return ok(await readFile(this.resolvePath(scanId, relativePath), 'utf8'));
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === 'ENOENT') return err(uidnaError('not-found', `${relativePath} not found in scan ${scanId}`));
      return err(toError(cause, 'io', `read ${relativePath}`));
    }
  }

  /** Read a binary file inside the scan directory. */
  async readBinary(scanId: string, relativePath: string): Promise<Result<Buffer>> {
    try {
      return ok(await readFile(this.resolvePath(scanId, relativePath)));
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === 'ENOENT') return err(uidnaError('not-found', `${relativePath} not found in scan ${scanId}`));
      return err(toError(cause, 'io', `read ${relativePath}`));
    }
  }

  /** True when a file exists inside the scan directory. */
  async fileExists(scanId: string, relativePath: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(scanId, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  /** Remove a file or directory inside the scan directory. Used by cleanup; callers report what was removed. */
  async remove(scanId: string, relativePath: string): Promise<Result<void>> {
    try {
      await rm(this.resolvePath(scanId, relativePath), { recursive: true, force: true });
      return ok(undefined);
    } catch (cause) {
      return err(toError(cause, 'io', `remove ${relativePath}`));
    }
  }

  /** Walk every file of a scan directory; returns relative paths with forward slashes. */
  async listFiles(scanId: string, subdir = ''): Promise<Result<string[]>> {
    const dir = this.resolvePath(scanId, subdir || '.');
    const out: string[] = [];
    const walk = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out.push(this.relativePath(scanId, full));
      }
    };
    try {
      await walk(dir);
      return ok(out.sort());
    } catch (cause) {
      return err(toError(cause, 'io', `list files of ${scanId}`));
    }
  }
}
