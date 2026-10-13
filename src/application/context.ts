/**
 * The context every workflow receives. CLI and MCP build one each and share
 * the same workflow functions, so both adapters behave identically.
 */
import type { BrowserProvider } from '../browser/types.js';
import type { ProgressReporter } from '../domain/budget.js';
import { silentProgress } from '../domain/budget.js';
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import type { Config } from './config.js';
import { EvidenceLedger } from './ledger.js';
import type { Logger } from './log.js';
import { silentLogger } from './log.js';
import { DEFAULT_OUT_ROOT, ScanStore } from './scan-store.js';

/** Version of the tool, read from package.json at startup by the adapters. */
export const TOOL_NAME = 'uidna';

/** Everything a workflow needs. */
export interface WorkflowContext {
  readonly store: ScanStore;
  readonly ledger: EvidenceLedger;
  readonly provider: BrowserProvider;
  readonly clock: Clock;
  readonly progress: ProgressReporter;
  readonly logger: Logger;
  readonly config: Config;
  readonly toolVersion: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/** Options for `createContext`. */
export interface ContextOptions {
  readonly provider: BrowserProvider;
  readonly toolVersion: string;
  readonly cwd?: string;
  readonly config?: Config;
  readonly outRoot?: string;
  readonly clock?: Clock;
  readonly progress?: ProgressReporter;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/** Build a context. `outRoot` overrides the config's `outRoot`, which overrides `.uidna`. */
export function createContext(options: ContextOptions): WorkflowContext {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config ?? {};
  const clock = options.clock ?? systemClock;
  const root = options.outRoot ?? config.outRoot ?? DEFAULT_OUT_ROOT;
  const store = new ScanStore(root.startsWith('/') || /^[A-Za-z]:/.test(root) ? root : `${cwd}/${root}`, clock);
  return {
    store,
    ledger: new EvidenceLedger(store, clock),
    provider: options.provider,
    clock,
    progress: options.progress ?? silentProgress,
    logger: options.logger ?? silentLogger,
    config,
    toolVersion: options.toolVersion,
    cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/** Derive a context with a different scan root (tools accept `outRoot` per call). */
export function withOutRoot(ctx: WorkflowContext, outRoot: string | undefined): WorkflowContext {
  if (!outRoot) return ctx;
  const root = outRoot.startsWith('/') || /^[A-Za-z]:/.test(outRoot) ? outRoot : `${ctx.cwd}/${outRoot}`;
  if (root === ctx.store.root) return ctx;
  const store = new ScanStore(root, ctx.clock);
  return { ...ctx, store, ledger: new EvidenceLedger(store, ctx.clock) };
}
