/**
 * Subprocess seam. Used to run `npm install` and `npm run build` in generated
 * projects with a timeout, captured output and an optional log file.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** Outcome of a finished (or killed) command. */
export interface CommandOutcome {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly logPath: string | null;
}

/** Options for `runCommand`. */
export interface RunCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** When set, stdout and stderr are appended to this file. */
  readonly logPath?: string;
  readonly signal?: AbortSignal;
  /** Maximum bytes of each stream kept in memory (the log file keeps everything). */
  readonly maxBufferBytes?: number;
}

/** The npm executable for this platform (only used when `npm-cli.js` cannot be located). */
export function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * Locate npm's JavaScript entry point so npm can be spawned through the
 * current Node binary without a shell. Checks `npm_execpath` (set when
 * running under npm) and the npm bundled next to the Node binary.
 */
export function npmCliPath(): string | null {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && fromEnv.endsWith("npm-cli.js") && existsSync(fromEnv)) return fromEnv;
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Run a command to completion. Never throws: spawn failures, timeouts and
 * non-zero exits are all reported in the outcome or the error.
 */
export async function runCommand(command: string, args: readonly string[], options: RunCommandOptions): Promise<Result<CommandOutcome>> {
  const started = Date.now();
  const maxBuffer = options.maxBufferBytes ?? 512 * 1024;
  const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  const log: string[] = [`$ ${command} ${args.join(' ')}`, `cwd: ${options.cwd}`, ''];

  const keep = (stream: 'stdout' | 'stderr', text: string): void => {
    log.push(text);
    if (sizes[stream] < maxBuffer) {
      chunks[stream].push(text);
      sizes[stream] += text.length;
    }
  };

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        // .cmd shims on Windows need a shell; everywhere else a direct spawn is safer.
        shell: process.platform === 'win32' && command.endsWith('.cmd'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      resolve(err(toError(cause, 'io', `spawn ${command}`)));
      return;
    }

    let timedOut = false;
    let settled = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill();
            setTimeout(() => child.kill('SIGKILL'), 2000).unref();
          }, options.timeoutMs);

    const onAbort = (): void => {
      child.kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (data: Buffer) => keep('stdout', data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => keep('stderr', data.toString('utf8')));

    const finish = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): Promise<void> => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - started;
      let logPath: string | null = null;
      if (options.logPath) {
        try {
          await mkdir(dirname(options.logPath), { recursive: true });
          await writeFile(options.logPath, log.join('') + `\n[exit code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''} after ${durationMs}ms]\n`, 'utf8');
          logPath = options.logPath;
        } catch {
          logPath = null;
        }
      }
      if (spawnError) {
        resolve(err(uidnaError('io', `${command} could not be started: ${spawnError.message}`, { cause: spawnError })));
        return;
      }
      resolve(
        ok({
          command,
          args,
          cwd: options.cwd,
          code,
          signal,
          stdout: chunks.stdout.join(''),
          stderr: chunks.stderr.join(''),
          durationMs,
          timedOut,
          logPath,
        }),
      );
    };

    child.on('error', (error) => {
      void finish(null, null, error);
    });
    child.on('close', (code, signal) => {
      void finish(code, signal);
    });
  });
}

/** Run an npm script or command in `cwd`. Prefers `node npm-cli.js` (no shell); falls back to the platform executable. */
export async function runNpm(args: readonly string[], options: RunCommandOptions): Promise<Result<CommandOutcome>> {
  const cli = npmCliPath();
  if (cli) return runCommand(process.execPath, [cli, ...args], options);
  return runCommand(npmExecutable(), args, options);
}
