/**
 * CLI-only commands: `setup` (register the MCP server in Claude Code, Codex
 * and Cursor) and `doctor` (browser availability, CDP reachability and
 * registration state). Both print their plan or report; `setup` asks before
 * writing and backs up every file it changes.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { WorkflowContext } from '../application/context.js';
import { doctorExitCode, formatDoctor, runDoctor } from '../application/doctor.js';
import {
  applySetup,
  DEFAULT_SERVER_COMMAND,
  formatPlan,
  localServerCommand,
  planSetup,
  SETUP_TARGETS,
  type ServerCommand,
  type SetupScope,
  type SetupTarget,
} from '../application/setup.js';
import { describeError } from '../domain/errors.js';

/** Hooks the main CLI passes in. */
export interface SetupCommandDeps {
  readonly readToolVersion: () => Promise<string>;
  readonly controller: AbortController;
  readonly buildContext: (globals: { json?: boolean; debug?: boolean; outRoot?: string; cwd?: string }) => Promise<WorkflowContext>;
}

/** The server command to register: `npx -y @rohzzn/uidna@latest serve`, wrapped in `cmd /c` on native Windows, or a local `node dist/cli.js serve`. */
export function defaultServerCommand(options: { local: boolean; platform?: NodeJS.Platform }): ServerCommand {
  const platform = options.platform ?? process.platform;
  if (options.local) {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/cli/ when running from source, dist/cli/ when built; both resolve to <package>/dist/cli.js.
    const packageRoot = resolve(here, '..', '..');
    return localServerCommand(join(packageRoot, 'dist', 'cli.js'));
  }
  if (platform === 'win32') {
    // Native Windows needs the cmd wrapper for npx-based stdio servers (see Claude Code MCP docs, "Windows users").
    return { command: 'cmd', args: ['/c', ...[DEFAULT_SERVER_COMMAND.command, ...DEFAULT_SERVER_COMMAND.args]] };
  }
  return DEFAULT_SERVER_COMMAND;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Register `setup` and `doctor` on the program. */
export function registerSetupCommands(program: Command, deps: SetupCommandDeps): void {
  program
    .command('setup')
    .description('Register the MCP server in Claude Code, Codex and Cursor (prints the plan, asks, backs up)')
    .option('--targets <list>', 'comma-separated: claude-code,codex,cursor (default all)')
    .option('--scope <scope>', 'user (default) or project')
    .option('--local', 'register this checkout (node dist/cli.js serve) instead of npx -y @rohzzn/uidna@latest serve')
    .option('--yes', 'apply without asking')
    .option('--no-backup', 'do not back up existing config files')
    .option('--home <dir>', 'home directory to write into (tests)')
    .action(async (options: { targets?: string; scope?: string; local?: boolean; yes?: boolean; backup: boolean; home?: string }) => {
      const globals = program.opts<{ json?: boolean; cwd?: string }>();
      const cwd = globals.cwd ? resolve(globals.cwd) : process.cwd();
      const targets = (options.targets ? options.targets.split(',').map((t) => t.trim()) : [...SETUP_TARGETS]).filter((t): t is SetupTarget =>
        (SETUP_TARGETS as readonly string[]).includes(t),
      );
      if (targets.length === 0) {
        process.stderr.write(`no valid targets; choose from ${SETUP_TARGETS.join(', ')}\n`);
        process.exit(2);
      }
      const scope: SetupScope = options.scope === 'project' ? 'project' : 'user';
      const server = defaultServerCommand({ local: Boolean(options.local) });
      const plan = await planSetup({ targets, scope, server, home: options.home ?? homedir(), cwd });
      if (!plan.ok) {
        process.stderr.write(`${describeError(plan.error)}\n`);
        process.exit(1);
      }
      const pending = plan.value.filter((c) => !c.noop);
      if (globals.json) {
        process.stdout.write(JSON.stringify({ plan: plan.value }, null, 2) + '\n');
      } else {
        process.stderr.write(formatPlan(plan.value) + '\n');
      }
      if (pending.length === 0) {
        process.stderr.write('nothing to change; uidna is already registered\n');
        return;
      }
      let proceed = Boolean(options.yes);
      if (!proceed) {
        proceed = await confirm(`Write ${pending.length} file${pending.length === 1 ? '' : 's'}?`);
        if (!proceed) {
          process.stderr.write('not applied. Re-run with --yes to apply without asking.\n');
          process.exit(1);
        }
      }
      const applied = await applySetup(plan.value, { backup: options.backup });
      if (!applied.ok) {
        process.stderr.write(`${describeError(applied.error)}\n`);
        process.exit(1);
      }
      const summary = {
        written: applied.value.written,
        backups: applied.value.backups,
        skipped: applied.value.skipped,
        command: [server.command, ...server.args].join(' '),
      };
      if (globals.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      else {
        for (const file of summary.written) process.stderr.write(`wrote ${file}\n`);
        for (const file of summary.backups) process.stderr.write(`backup ${file}\n`);
        process.stderr.write(`registered "uidna" as: ${summary.command}\nRestart your agent to pick it up, then run: uidna doctor\n`);
      }
    });

  program
    .command('doctor')
    .description('Report browser availability, CDP reachability and registration state')
    .option('--cdp <endpoint>', 'CDP endpoint to probe (default from config or http://localhost:9222)')
    .option('--home <dir>', 'home directory to inspect (tests)')
    .action(async (options: { cdp?: string; home?: string }) => {
      const globals = program.opts<{ json?: boolean; debug?: boolean; outRoot?: string; cwd?: string }>();
      const ctx = await deps.buildContext(globals);
      const report = await runDoctor({
        probe: (endpoint) => ctx.provider.probe(endpoint),
        home: options.home ?? homedir(),
        cwd: ctx.cwd,
        outRoot: ctx.store.root,
        cdpEndpoint: options.cdp ?? ctx.config.cdpEndpoint ?? 'http://localhost:9222',
        // Only an endpoint the user named makes an unreachable Chrome a problem; the default probe is informational.
        cdpRequired: options.cdp !== undefined || ctx.config.cdpEndpoint !== undefined,
      });
      if (!report.ok) {
        process.stderr.write(`${describeError(report.error)}\n`);
        process.exit(1);
      }
      if (globals.json) process.stdout.write(JSON.stringify(report.value, null, 2) + '\n');
      else process.stdout.write(formatDoctor(report.value) + '\n');
      process.exitCode = doctorExitCode(report.value);
    });
}
