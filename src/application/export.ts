/**
 * `export_evidence`: copy a scan directory into a portable bundle with a
 * manifest of file digests. Secrets were redacted at capture time, so the
 * bundle contains exactly what the scan directory contains.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { exportEvidence as exportEvidenceContract } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { isoNow } from '../domain/clock.js';
import { sha256 } from '../domain/digest.js';
import { toError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';

/** Manifest written at the root of a bundle. */
export interface BundleManifest {
  readonly scanId: string;
  readonly exportedAt: string;
  readonly toolVersion: string;
  readonly files: { path: string; bytes: number; sha256: string }[];
  readonly ledgerRecords: number;
  readonly malformedLedgerLines: number;
}

/** `export_evidence`. */
export async function exportEvidence(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof exportEvidenceContract>,
): Promise<Result<Envelope<ToolOutput<typeof exportEvidenceContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const scan = await ctx.store.loadScan(input.scanId);
  if (!scan.ok) return scan;
  const scanDir = ctx.store.scanDir(input.scanId);
  const bundlePath = input.outPath ? (isAbsolute(input.outPath) ? input.outPath : resolve(ctx.cwd, input.outPath)) : join(scanDir, 'export');

  const files = await ctx.store.listFiles(input.scanId);
  if (!files.ok) return files;
  const ledger = await ctx.store.readEvidence(input.scanId);
  if (!ledger.ok) return ledger;

  const manifestFiles: BundleManifest['files'] = [];
  let bytes = 0;
  const limitations: string[] = [];
  try {
    await mkdir(bundlePath, { recursive: true });
    for (const rel of files.value) {
      // Never recurse into a previous export that lives inside the scan directory.
      if (rel.startsWith('export/')) continue;
      const source = ctx.store.resolvePath(input.scanId, rel);
      const target = join(bundlePath, ...rel.split('/'));
      if (resolve(source) === resolve(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      const content = await readFile(source);
      const size = (await stat(source)).size;
      bytes += size;
      manifestFiles.push({ path: rel, bytes: size, sha256: sha256(content) });
    }
    const manifest: BundleManifest = {
      scanId: input.scanId,
      exportedAt: isoNow(ctx.clock),
      toolVersion: ctx.toolVersion,
      files: manifestFiles,
      ledgerRecords: ledger.value.records.length,
      malformedLedgerLines: ledger.value.malformed,
    };
    await writeFile(join(bundlePath, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  } catch (cause) {
    return err(toError(cause, 'io', `export ${input.scanId}`));
  }
  if (ledger.value.malformed > 0) limitations.push(`${ledger.value.malformed} malformed ledger lines were copied verbatim but not counted as records`);

  const record = await ctx.ledger.record({
    kind: 'export',
    inputs: { scanId: input.scanId, outPath: input.outPath },
    artifacts: [bundlePath],
    scanId: input.scanId,
  });
  return ok(
    envelope(
      record,
      { scanId: input.scanId, bundlePath, manifestPath: join(bundlePath, 'manifest.json'), files: manifestFiles.length, bytes },
      { limitations },
    ),
  );
}
