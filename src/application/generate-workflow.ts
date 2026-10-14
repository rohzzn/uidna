/**
 * `generate_project`: write the deterministic React baseline for a scan,
 * install it and build it, and record the outcome in the scan.
 */
import { isAbsolute, resolve } from 'node:path';
import type { generateProject as generateProjectContract } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { isoNow } from '../domain/clock.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import { uidnaError } from '../domain/errors.js';
import { generateProject as runGenerator } from '../generate/index.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { loadScanAndDna } from './inspect.js';

/** Resolve a user-supplied directory against the working directory. */
export function resolveOutDir(ctx: WorkflowContext, outDir: string): string {
  return isAbsolute(outDir) ? outDir : resolve(ctx.cwd, outDir);
}

/** `generate_project`. */
export async function generateProject(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof generateProjectContract>,
): Promise<Result<Envelope<ToolOutput<typeof generateProjectContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { scan, dna } = loaded.value;
  const outDir = resolveOutDir(ctx, input.outDir);
  const scanDir = ctx.store.scanDir(input.scanId);
  if (outDir === scanDir || outDir.startsWith(scanDir + '/') || outDir.startsWith(scanDir + '\\')) {
    return err(uidnaError('validation', 'outDir must not be inside the scan directory'));
  }
  const evidence = await ctx.ledger.record({
    kind: 'generate',
    inputs: { scanId: input.scanId, outDir, install: input.install ?? true, build: input.build ?? true, router: input.router, behaviorTests: input.behaviorTests },
    scanId: input.scanId,
  });
  ctx.progress.report({ message: `generating project in ${outDir}`, current: 0, total: 3 });
  const generated = await runGenerator({
    dna,
    scanDir,
    outDir,
    install: input.install ?? true,
    build: input.build ?? true,
    ...(input.router === undefined ? {} : { router: input.router }),
    ...(input.behaviorTests === undefined ? {} : { behaviorTests: input.behaviorTests }),
    clock: ctx.clock,
    progress: ctx.progress,
    evidenceId: evidence.id,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  if (!generated.ok) return generated;
  const record = generated.value;
  const savedRecord = await ctx.store.saveGenerate(input.scanId, record);
  if (!savedRecord.ok) return savedRecord;
  scan.steps.generate = { at: isoNow(ctx.clock), evidenceId: evidence.id, outDir, recordPath: savedRecord.value };
  const savedScan = await ctx.store.saveScan(scan);
  if (!savedScan.ok) return savedScan;

  const limitations: string[] = [];
  if (record.placeholders.length > 0) {
    limitations.push(`${record.placeholders.length} asset${record.placeholders.length === 1 ? '' : 's'} rendered as labeled placeholders (not authorized); use annotate_dna op "authorize" to include assets you own`);
  }
  if (record.mocks.length > 0) limitations.push(`${record.mocks.length} backend-dependent data source${record.mocks.length === 1 ? '' : 's'} mocked behind typed interfaces`);
  if (record.install.attempted && record.install.ok === false) limitations.push(`npm install failed; see ${record.install.logPath ?? 'install log'}`);
  if (record.build.attempted && record.build.ok === false) limitations.push(`build failed; see ${record.build.logPath ?? 'build log'}`);
  if (!record.build.attempted) limitations.push('project was not built (build=false); verify_reconstruction will build it');

  const finalEvidence = ctx.ledger.withArtifacts(evidence, [savedRecord.value, ...(record.build.logPath ? [record.build.logPath] : []), ...(record.install.logPath ? [record.install.logPath] : [])]);
  const result: ToolOutput<typeof generateProjectContract> = {
    scanId: input.scanId,
    projectPath: outDir,
    files: record.files,
    components: record.components,
    placeholders: record.placeholders,
    mocks: record.mocks,
    install: record.install,
    build: record.build,
  };
  return ok(envelope(finalEvidence, result, { limitations }));
}
