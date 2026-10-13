/**
 * Install and build a generated project with npm. Output goes to
 * `<outDir>/.uidna/install.log` and `build.log`; nothing is thrown.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runNpm } from '../application/process.js';
import { toError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** Default timeouts. */
export const INSTALL_TIMEOUT_MS = 240_000;
export const BUILD_TIMEOUT_MS = 180_000;

/** Options shared by install and build. */
export interface BuildOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Outcome of `installProject`. */
export interface InstallOutcome {
  readonly ok: boolean;
  readonly logPath: string;
  readonly durationMs: number;
}

/** Outcome of `buildProject`. */
export interface BuildOutcome {
  readonly ok: boolean;
  readonly logPath: string;
  readonly durationMs: number;
  /** Absolute `dist` directory when the build produced `dist/index.html`, else null. */
  readonly distDir: string | null;
}

/** Run `npm install` in `outDir` (240 s timeout by default). */
export async function installProject(outDir: string, options: BuildOptions = {}): Promise<Result<InstallOutcome>> {
  const logPath = join(outDir, '.uidna', 'install.log');
  const run = await runNpm(['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: outDir,
    timeoutMs: options.timeoutMs ?? INSTALL_TIMEOUT_MS,
    logPath,
    signal: options.signal,
    env: { CI: 'true', npm_config_update_notifier: 'false' },
  });
  if (!run.ok) return run;
  const outcome = run.value;
  return ok({ ok: outcome.code === 0 && !outcome.timedOut, logPath: outcome.logPath ?? logPath, durationMs: outcome.durationMs });
}

/** Run `npm run build` in `outDir` (180 s timeout by default) and check for `dist/index.html`. */
export async function buildProject(outDir: string, options: BuildOptions = {}): Promise<Result<BuildOutcome>> {
  const logPath = join(outDir, '.uidna', 'build.log');
  const run = await runNpm(['run', 'build'], {
    cwd: outDir,
    timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS,
    logPath,
    signal: options.signal,
    env: { CI: 'true', npm_config_update_notifier: 'false' },
  });
  if (!run.ok) return run;
  const outcome = run.value;
  const distDir = join(outDir, 'dist');
  let built = false;
  try {
    built = (await stat(join(distDir, 'index.html'))).isFile();
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code !== 'ENOENT') return err(toError(cause, 'io', `stat ${distDir}`));
    built = false;
  }
  const success = outcome.code === 0 && !outcome.timedOut && built;
  return ok({ ok: success, logPath: outcome.logPath ?? logPath, durationMs: outcome.durationMs, distDir: success ? distDir : null });
}
