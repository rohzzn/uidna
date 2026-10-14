#!/usr/bin/env node
/**
 * The `uidna` CLI. Every tool in the catalog is a command with the same
 * input and the same evidence envelope as the MCP tool; `serve` runs the MCP
 * server on stdio; `setup` and `doctor` are CLI-only.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { loadConfig } from './application/config.js';
import { createContext, type WorkflowContext } from './application/context.js';
import { createHandlers, dispatch, type HandlerMap } from './application/handlers.js';
import { createLogger } from './application/log.js';
import { createPlaywrightProvider } from './browser/index.js';
import { applyContract, collectInput } from './cli/options.js';
import { renderEnvelope } from './cli/render.js';
import { registerSetupCommands } from './cli/setup-commands.js';
import { CLI_ONLY_COMMANDS, TOOL_CATALOG } from './contracts/catalog.js';
import type { ToolContract } from './contracts/types.js';
import { describeError } from './domain/errors.js';
import { serveStdio } from './server/mcp.js';
import { registerWorkflowHandlers } from './application/workflows.js';

/** Read the package version at runtime (works from src via tsx and from dist). */
export async function readToolVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(await readFile(candidate, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === '@rohzzn/uidna' && pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  // The version is written into every document; a missing manifest is an installation error, not a value to invent.
  throw new Error('uidna package.json not found next to the CLI; reinstall the package');
}

interface GlobalOptions {
  json?: boolean;
  debug?: boolean;
  outRoot?: string;
  cwd?: string;
}

async function buildContext(globals: GlobalOptions, signal: AbortSignal): Promise<WorkflowContext> {
  const cwd = globals.cwd ? resolve(globals.cwd) : process.cwd();
  const config = await loadConfig(cwd);
  if (!config.ok) {
    process.stderr.write(`${describeError(config.error)}\n`);
    process.exit(2);
  }
  const verbose = Boolean(globals.debug || config.value.debug);
  const version = await readToolVersion();
  return createContext({
    provider: createPlaywrightProvider(),
    toolVersion: version,
    cwd,
    config: config.value,
    ...(globals.outRoot ? { outRoot: globals.outRoot } : {}),
    logger: createLogger(verbose),
    progress: {
      report: (event) => {
        if (globals.json) return;
        const counter = event.total !== undefined && event.current !== undefined ? ` [${event.current}/${event.total}]` : '';
        process.stderr.write(`… ${event.message}${counter}\n`);
      },
    },
    signal,
  });
}

function registerTool(program: Command, contract: ToolContract, handlers: HandlerMap, controller: AbortController): void {
  const command = program.command(contract.cli.command).description(contract.cli.summary + ` (${contract.name})`);
  const fields = applyContract(command, contract);
  command.action(async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    const options = args[args.length - 2] as Record<string, unknown>;
    const positionals = args.slice(0, -2) as (string | undefined)[];
    const globals = program.opts<GlobalOptions>();
    const ctx = await buildContext(globals, controller.signal);
    let input: Record<string, unknown>;
    try {
      input = collectInput(contract, fields, positionals, options);
      if (contract.name === 'annotate_dna' && typeof input.patchesFile === 'string') {
        const text = await readFile(resolve(ctx.cwd, input.patchesFile), 'utf8');
        input.patches = JSON.parse(text) as unknown;
        delete input.patchesFile;
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.stderr.write(cmd.helpInformation());
      process.exit(2);
    }
    const result = await dispatch(handlers, ctx, contract.name, input);
    if (!result.ok) {
      if (globals.json) {
        process.stdout.write(JSON.stringify({ error: { tag: result.error._tag, message: result.error.message, details: result.error.details ?? null } }, null, 2) + '\n');
      } else {
        process.stderr.write(`${describeError(result.error)}\n`);
      }
      process.exit(1);
    }
    if (globals.json) process.stdout.write(JSON.stringify(result.value, null, 2) + '\n');
    else process.stdout.write(renderEnvelope(contract.name, result.value) + '\n');
  });
}

/** Build the commander program. Exported for tests. */
export async function createProgram(): Promise<Command> {
  const version = await readToolVersion();
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
    process.stderr.write('\ncancelling… partial artifacts are kept and reported\n');
  });

  const program = new Command('uidna')
    .description('Reverse-engineer any user interface into a UI DNA document, rebuild it as code you own, and prove it with a DiffReport.')
    .version(version)
    .option('--json', 'print the evidence envelope as JSON')
    .option('--debug', 'verbose diagnostics on stderr')
    .option('--out-root <dir>', 'directory that holds scans (default ./.uidna)')
    .option('--cwd <dir>', 'working directory for config and relative paths')
    .showHelpAfterError();

  const handlers = createHandlers(registerWorkflowHandlers());
  for (const contract of TOOL_CATALOG) registerTool(program, contract, handlers, controller);

  const serveSummary = CLI_ONLY_COMMANDS.find((c) => c.command === 'serve')?.summary ?? 'Start the MCP server on stdio';
  program
    .command('serve')
    .description(serveSummary)
    .action(async () => {
      const globals = program.opts<GlobalOptions>();
      const ctx = await buildContext({ ...globals, json: true }, controller.signal);
      await serveStdio(ctx, handlers);
    });

  registerSetupCommands(program, { readToolVersion, controller, buildContext: (globals) => buildContext(globals, controller.signal) });
  return program;
}

const invokedDirectly = process.argv[1] !== undefined && /cli\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  const program = await createProgram();
  await program.parseAsync(process.argv);
}
