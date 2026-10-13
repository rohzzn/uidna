/**
 * `uidna setup`: register the MCP server with coding agents by editing their
 * on-disk MCP configuration. Everything here is planning, merging and file
 * I/O; prompting and printing live in the CLI. A plan is computed first
 * (`planSetup`), shown to the user (`formatPlan`) and only then written
 * (`applySetup`), with a backup of every file that already existed.
 *
 * Registration formats (checked against the vendor docs on 2026-10-13):
 *
 * - Claude Code. User scope is the top-level `mcpServers` object of
 *   `~/.claude.json`; project scope is `<project>/.mcp.json` with the same
 *   `mcpServers` object (shared through version control, approved on first
 *   use). A stdio entry is `{"type":"stdio","command":"npx","args":["-y","uidna","serve"]}`
 *   and may carry `env`. CLI equivalent:
 *   `claude mcp add --scope user --transport stdio uidna -- npx -y uidna serve`
 *   (`--scope project` writes `.mcp.json`). https://code.claude.com/docs/en/mcp
 *
 * - OpenAI Codex CLI. `~/.codex/config.toml` holds one `[mcp_servers.<name>]`
 *   table per server with `command`, `args` and optional `env`/`cwd`/`env_vars`.
 *   CLI equivalent: `codex mcp add uidna -- npx -y uidna serve`. Codex only
 *   loads a project-scoped `.codex/config.toml` for projects the user has
 *   marked trusted, so uidna always registers Codex at user scope and says so
 *   on the change. https://developers.openai.com/codex/mcp and
 *   https://developers.openai.com/codex/config-reference
 *
 * - Cursor. `~/.cursor/mcp.json` (global) and `<project>/.cursor/mcp.json`
 *   (project), both a `mcpServers` object whose stdio entries carry `type`
 *   (`"stdio"`), `command`, `args` and optional `env`/`envFile`.
 *   https://cursor.com/docs/context/mcp
 *
 * The TOML support is deliberately minimal: it replaces or appends one
 * `[mcp_servers.<name>]` table and never rewrites any other line of the file.
 *
 * Native Windows note: `npx` is a `.cmd` shim there and several client bug
 * trackers report that stdio entries need `cmd /c npx ...` to spawn (not
 * confirmed on the vendor pages above, so this module does not add the
 * wrapper). The integrator can pass `{ command: 'cmd', args: ['/c', 'npx', '-y', 'uidna', 'serve'] }`
 * or the `localServerCommand` form, which runs `node` directly and needs no shim.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type Clock, systemClock } from '../domain/clock.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** Agents that `uidna setup` can register the MCP server with. */
export type SetupTarget = 'claude-code' | 'codex' | 'cursor';

/** Where a registration lives: the user's home configuration or the current project. */
export type SetupScope = 'user' | 'project';

/** Every supported target, in display order. */
export const SETUP_TARGETS: readonly SetupTarget[] = ['claude-code', 'codex', 'cursor'];

/** Human-readable names of the targets. */
export const TARGET_LABELS: Readonly<Record<SetupTarget, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  cursor: 'Cursor',
};

/** Name under which the server is registered unless the caller overrides it. */
export const DEFAULT_SERVER_NAME = 'uidna';

/** The command an agent runs to start the MCP server over stdio. */
export interface ServerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Registration through npm: works wherever `npx` is on the PATH. */
export const DEFAULT_SERVER_COMMAND: ServerCommand = { command: 'npx', args: ['-y', 'uidna', 'serve'] };

/**
 * Registration that runs a local checkout or install directly with `node`.
 * `cliPath` is the path to `dist/cli.js`; it is made absolute so the entry
 * works from any working directory.
 */
export function localServerCommand(cliPath: string): ServerCommand {
  return { command: 'node', args: [resolve(cliPath), 'serve'] };
}

/** One-line rendering of a server command, e.g. `npx -y uidna serve`. */
export function formatCommand(server: ServerCommand): string {
  return [server.command, ...server.args].join(' ');
}

/** On-disk format of a configuration file. */
export type ConfigFormat = 'json' | 'toml';

/** Where one target keeps its MCP registrations for one scope. */
export interface ConfigLocation {
  readonly target: SetupTarget;
  /** Effective scope: Codex is always `user`, whatever was requested. */
  readonly scope: SetupScope;
  /** Absolute path of the configuration file. */
  readonly file: string;
  readonly format: ConfigFormat;
  /** Explanation when the effective scope differs from the requested one. */
  readonly note: string | null;
}

/** Paths that locate configuration files. */
export interface ConfigPaths {
  /** The user's home directory. */
  readonly home: string;
  /** The project directory (current working directory of the CLI). */
  readonly cwd: string;
  /** Codex configuration directory; defaults to `<home>/.codex` (Codex honors `CODEX_HOME`). */
  readonly codexHome?: string;
}

const CODEX_SCOPE_NOTE =
  'Codex loads a project-scoped .codex/config.toml only for projects marked trusted, so uidna registers it in the user configuration (~/.codex/config.toml) instead.';

/** Resolve the configuration file of a target for the requested scope. */
export function configLocation(target: SetupTarget, scope: SetupScope, paths: ConfigPaths): ConfigLocation {
  const home = resolve(paths.home);
  const cwd = resolve(paths.cwd);
  switch (target) {
    case 'claude-code':
      return scope === 'user'
        ? { target, scope, file: join(home, '.claude.json'), format: 'json', note: null }
        : { target, scope, file: join(cwd, '.mcp.json'), format: 'json', note: null };
    case 'codex':
      return {
        target,
        scope: 'user',
        file: join(paths.codexHome ? resolve(paths.codexHome) : join(home, '.codex'), 'config.toml'),
        format: 'toml',
        note: scope === 'project' ? CODEX_SCOPE_NOTE : null,
      };
    case 'cursor':
      return scope === 'user'
        ? { target, scope, file: join(home, '.cursor', 'mcp.json'), format: 'json', note: null }
        : { target, scope, file: join(cwd, '.cursor', 'mcp.json'), format: 'json', note: null };
  }
}

/** Scopes a target supports on disk. */
export function scopesOf(target: SetupTarget): readonly SetupScope[] {
  return target === 'codex' ? ['user'] : ['user', 'project'];
}

/** A planned edit of one configuration file. */
export interface SetupChange {
  readonly target: SetupTarget;
  /** Effective scope (see `ConfigLocation.scope`). */
  readonly scope: SetupScope;
  /** Absolute path of the file. */
  readonly file: string;
  /** True when the file existed when the plan was made. */
  readonly exists: boolean;
  /** Current content, or null when the file does not exist. */
  readonly before: string | null;
  /** Content after the change. Equal to `before` when `noop`. */
  readonly after: string;
  /** One sentence describing the change. */
  readonly description: string;
  /** True when the registration is already in place and nothing will be written. */
  readonly noop: boolean;
  /** Registration name inside the file. */
  readonly serverName: string;
  /** The command being registered. */
  readonly command: ServerCommand;
  /** Explanation attached to the change (e.g. why Codex ignores the project scope). */
  readonly note: string | null;
}

/** Options of `planSetup`. */
export interface PlanSetupOptions extends ConfigPaths {
  readonly targets: readonly SetupTarget[];
  readonly scope: SetupScope;
  readonly server: ServerCommand;
  /** Registration name; defaults to `uidna`. */
  readonly serverName?: string;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function validateServerName(name: string): Result<string> {
  if (!SERVER_NAME_PATTERN.test(name)) {
    return err(uidnaError('validation', `server name "${name}" must contain only letters, digits, "_" and "-"`));
  }
  return ok(name);
}

/**
 * Compute the edits that register the server with each target. Nothing is
 * written. Existing files are merged: other servers and unrelated keys are
 * preserved, and a file that cannot be parsed yields a `config` error naming
 * it rather than a plan that would overwrite it.
 */
export async function planSetup(options: PlanSetupOptions): Promise<Result<SetupChange[]>> {
  const name = validateServerName(options.serverName ?? DEFAULT_SERVER_NAME);
  if (!name.ok) return name;
  const serverName = name.value;
  const changes: SetupChange[] = [];
  const seen = new Set<string>();
  for (const target of options.targets) {
    const location = configLocation(target, options.scope, options);
    if (seen.has(location.file)) continue;
    seen.add(location.file);
    const current = await readOptional(location.file);
    if (!current.ok) return current;
    const merged =
      location.format === 'json'
        ? mergeJsonConfig(current.value, serverName, jsonEntry(options.server), location.file)
        : mergeTomlConfig(current.value, serverName, options.server, location.file);
    if (!merged.ok) return merged;
    const exists = current.value !== null;
    const label = `${TARGET_LABELS[target]} (${location.scope} scope)`;
    const command = formatCommand(options.server);
    const description = merged.value.noop
      ? `${location.file}: "${serverName}" is already registered in ${label} as: ${command}`
      : exists
        ? `Update ${location.file}: register "${serverName}" in ${label} as: ${command}`
        : `Create ${location.file} and register "${serverName}" in ${label} as: ${command}`;
    changes.push({
      target,
      scope: location.scope,
      file: location.file,
      exists,
      before: current.value,
      after: merged.value.after,
      description,
      noop: merged.value.noop,
      serverName,
      command: options.server,
      note: location.note,
    });
  }
  return ok(changes);
}

/** Options of `applySetup`. */
export interface ApplySetupOptions {
  /** Copy every existing file to `<file>.bak-<timestamp>` before writing it. */
  readonly backup: boolean;
  readonly clock?: Clock;
}

/** What `applySetup` did. */
export interface ApplySetupOutcome {
  /** Files written, in plan order. */
  readonly written: string[];
  /** Backup copies created. */
  readonly backups: string[];
  /** Files skipped because their change was a no-op. */
  readonly skipped: string[];
}

/**
 * Write the planned changes. Each file is re-read first and the write is
 * refused with a `config` error when the file no longer matches the plan, so
 * a plan the user approved is never applied over content they did not see.
 * On failure the error's `details` list what had been written so far.
 */
export async function applySetup(changes: readonly SetupChange[], options: ApplySetupOptions): Promise<Result<ApplySetupOutcome>> {
  const clock = options.clock ?? systemClock;
  const stamp = clock.now().toISOString().replace(/:/g, '-');
  const written: string[] = [];
  const backups: string[] = [];
  const skipped: string[] = [];
  const progress = (): Record<string, unknown> => ({ written: [...written], backups: [...backups], skipped: [...skipped] });
  for (const change of changes) {
    if (change.noop) {
      skipped.push(change.file);
      continue;
    }
    const current = await readOptional(change.file);
    if (!current.ok) return err(uidnaError(current.error._tag, current.error.message, { cause: current.error, details: progress() }));
    if (current.value !== change.before) {
      return err(
        uidnaError('config', `${change.file} changed since the plan was made; run setup again to see the new plan`, {
          details: { file: change.file, ...progress() },
        }),
      );
    }
    if (current.value !== null && options.backup) {
      const backup = `${change.file}.bak-${stamp}`;
      try {
        await copyFile(change.file, backup);
      } catch (cause) {
        return err(toError(cause, 'io', `back up ${change.file} to ${backup}`));
      }
      backups.push(backup);
    }
    try {
      await mkdir(dirname(change.file), { recursive: true });
      await writeFile(change.file, change.after, 'utf8');
    } catch (cause) {
      const error = toError(cause, 'io', `write ${change.file}`);
      return err(uidnaError(error._tag, error.message, { cause, details: progress() }));
    }
    written.push(change.file);
  }
  return ok({ written, backups, skipped });
}

/** Registration state of one target at one scope, for `uidna doctor`. */
export interface RegistrationStatus {
  readonly target: SetupTarget;
  readonly scope: SetupScope;
  /** Absolute path of the configuration file. */
  readonly file: string;
  readonly exists: boolean;
  /** True when the file contains a registration under the server name. */
  readonly registered: boolean;
  /** The registered command (or URL) when known. */
  readonly command: string | null;
  /** Why the file could not be inspected, when it could not. */
  readonly problem?: string;
}

/** Options of `registrationStatus`. */
export interface RegistrationStatusOptions extends ConfigPaths {
  readonly serverName?: string;
}

/**
 * Inspect every target and scope and report whether the server is registered.
 * Unreadable or unparsable files are reported in `problem` rather than failing
 * the whole report, so doctor can still print the other rows.
 */
export async function registrationStatus(options: RegistrationStatusOptions): Promise<Result<RegistrationStatus[]>> {
  const name = validateServerName(options.serverName ?? DEFAULT_SERVER_NAME);
  if (!name.ok) return name;
  const serverName = name.value;
  const rows: RegistrationStatus[] = [];
  for (const target of SETUP_TARGETS) {
    for (const scope of scopesOf(target)) {
      const location = configLocation(target, scope, options);
      const base = { target, scope: location.scope, file: location.file };
      const current = await readOptional(location.file);
      if (!current.ok) {
        rows.push({ ...base, exists: true, registered: false, command: null, problem: current.error.message });
        continue;
      }
      if (current.value === null) {
        rows.push({ ...base, exists: false, registered: false, command: null });
        continue;
      }
      const found =
        location.format === 'json'
          ? findJsonRegistration(current.value, serverName, location.file)
          : findTomlRegistration(current.value, serverName, location.file);
      if (!found.ok) {
        rows.push({ ...base, exists: true, registered: false, command: null, problem: found.error.message });
        continue;
      }
      rows.push({ ...base, exists: true, ...found.value });
    }
  }
  return ok(rows);
}

/**
 * Human-readable plan: one line per file tagged `[create]`, `[update]` or
 * `[unchanged]` with the registered command, followed by a short before/after
 * excerpt limited to the server's own entry.
 */
export function formatPlan(changes: readonly SetupChange[]): string {
  if (changes.length === 0) return 'Nothing to do: no targets selected.';
  const lines: string[] = [];
  for (const change of changes) {
    const tag = change.noop ? '[unchanged]' : change.exists ? '[update]' : '[create]';
    lines.push(`${tag} ${change.file}`);
    lines.push(`  ${TARGET_LABELS[change.target]}, ${change.scope} scope: ${formatCommand(change.command)}`);
    if (change.note) lines.push(`  note: ${change.note}`);
    if (!change.noop) {
      for (const line of entryExcerpt(change, change.before)) lines.push(`  - ${line}`);
      for (const line of entryExcerpt(change, change.after)) lines.push(`  + ${line}`);
    }
    lines.push('');
  }
  const pending = changes.filter((c) => !c.noop);
  const creates = pending.filter((c) => !c.exists).length;
  const updates = pending.length - creates;
  lines.push(
    pending.length === 0
      ? 'Everything is already registered; nothing will be written.'
      : `${pending.length} file(s) to write (${creates} new, ${updates} updated); existing files are backed up first.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON configuration (Claude Code, Cursor)
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** The JSON entry written for Claude Code and Cursor. */
export function jsonEntry(server: ServerCommand): JsonRecord {
  return { type: 'stdio', command: server.command, args: [...server.args] };
}

function parseJsonConfig(text: string, file: string): Result<JsonRecord> {
  if (text.trim() === '') return ok({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(
      uidnaError('config', `${file} is not valid JSON (${detail}); fix or move it before running setup`, { cause, details: { file } }),
    );
  }
  if (!isRecord(parsed)) return err(uidnaError('config', `${file} must contain a JSON object at the top level`, { details: { file } }));
  return ok(parsed);
}

function mcpServersOf(root: JsonRecord, file: string): Result<JsonRecord> {
  const servers = root.mcpServers;
  if (servers === undefined) return ok({});
  if (!isRecord(servers)) return err(uidnaError('config', `"mcpServers" in ${file} is not an object`, { details: { file } }));
  return ok(servers);
}

interface Merged {
  readonly after: string;
  readonly noop: boolean;
}

function mergeJsonConfig(text: string | null, serverName: string, entry: JsonRecord, file: string): Result<Merged> {
  const fresh = text === null || text.trim() === '';
  const root = text === null ? ok<JsonRecord>({}) : parseJsonConfig(text, file);
  if (!root.ok) return root;
  const servers = mcpServersOf(root.value, file);
  if (!servers.ok) return servers;
  if (text !== null && Object.hasOwn(servers.value, serverName) && deepEqual(servers.value[serverName], entry)) {
    return ok({ after: text, noop: true });
  }
  const next: JsonRecord = { ...root.value, mcpServers: { ...servers.value, [serverName]: entry } };
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const trailing = fresh || text?.endsWith('\n') ? eol : '';
  const body = JSON.stringify(next, null, 2);
  return ok({ after: (eol === '\n' ? body : body.replace(/\n/g, eol)) + trailing, noop: false });
}

function findJsonRegistration(text: string, serverName: string, file: string): Result<{ registered: boolean; command: string | null }> {
  const root = parseJsonConfig(text, file);
  if (!root.ok) return root;
  const servers = mcpServersOf(root.value, file);
  if (!servers.ok) return servers;
  const entry = servers.value[serverName];
  if (!isRecord(entry)) return ok({ registered: false, command: null });
  if (typeof entry.command === 'string') {
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
    return ok({ registered: true, command: formatCommand({ command: entry.command, args }) });
  }
  return ok({ registered: true, command: typeof entry.url === 'string' ? entry.url : null });
}

// ---------------------------------------------------------------------------
// TOML configuration (Codex)
// ---------------------------------------------------------------------------

/** Normalized dotted key of a `[table]` or `[[array]]` header line, or null for any other line. */
function tomlHeaderKey(line: string): string | null {
  const match = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  if (!match) return null;
  return (match[1] ?? '')
    .split('.')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .join('.');
}

function tomlTableKey(serverName: string): string {
  return `mcp_servers.${serverName}`;
}

interface TomlTableRange {
  /** Index of the header line. */
  readonly start: number;
  /** Index of the next header line (exclusive end of the table). */
  readonly end: number;
}

function findTomlTable(lines: readonly string[], serverName: string): TomlTableRange | null {
  const key = tomlTableKey(serverName);
  const start = lines.findIndex((line) => tomlHeaderKey(line) === key);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (tomlHeaderKey(lines[index] ?? '') !== null) {
      end = index;
      break;
    }
  }
  return { start, end };
}

/**
 * Line index of an inline definition of the server (`mcp_servers.<name> = {...}`
 * at top level or `<name> = {...}` under `[mcp_servers]`), which the table
 * replacer cannot rewrite. Null when there is none.
 */
function findTomlInlineDefinition(lines: readonly string[], serverName: string): number | null {
  const target = tomlTableKey(serverName);
  let table: string | null = null;
  for (const [index, line] of lines.entries()) {
    const header = tomlHeaderKey(line);
    if (header !== null) {
      table = header;
      continue;
    }
    const assignment = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.\-"']+)\s*=/.exec(line);
    if (!assignment) continue;
    const key = (assignment[1] ?? '')
      .split('.')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .join('.');
    const full = table === null ? key : `${table}.${key}`;
    if (full === target) return index;
  }
  return null;
}

/** Render a TOML basic string with escapes for quotes, backslashes and control characters. */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** The TOML table written for Codex, as lines without line terminators. */
export function tomlTableLines(serverName: string, server: ServerCommand): string[] {
  return [
    `[${tomlTableKey(serverName)}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(', ')}]`,
  ];
}

function trimTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(0, end);
}

function mergeTomlConfig(text: string | null, serverName: string, server: ServerCommand, file: string): Result<Merged> {
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === null ? [] : text.split(/\r?\n/);
  const inline = findTomlInlineDefinition(lines, serverName);
  if (inline !== null) {
    return err(
      uidnaError(
        'config',
        `${file} defines mcp_servers.${serverName} inline on line ${inline + 1}; uidna only rewrites [mcp_servers.${serverName}] tables, so remove or convert that entry first`,
        { details: { file, line: inline + 1 } },
      ),
    );
  }
  const rendered = tomlTableLines(serverName, server);
  const table = findTomlTable(lines, serverName);
  let next: string[];
  if (table) {
    const block = lines.slice(table.start, table.end);
    const trailingBlank = block.length - trimTrailingBlank(block).length;
    next = [...lines.slice(0, table.start), ...rendered, ...Array.from({ length: trailingBlank }, () => ''), ...lines.slice(table.end)];
  } else {
    const body = trimTrailingBlank(lines);
    next = body.length === 0 ? [...rendered, ''] : [...body, '', ...rendered, ''];
  }
  const after = next.join(eol);
  return ok({ after, noop: text !== null && after === text });
}

/** Scan one TOML string (basic or literal) starting at `index`; returns the value and the index after the closing quote. */
function scanTomlString(text: string, index: number): { value: string; end: number } | null {
  const quote = text[index];
  if (quote !== '"' && quote !== "'") return null;
  const simple: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
  let value = '';
  let i = index + 1;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === quote) return { value, end: i + 1 };
    if (quote === '"' && ch === '\\') {
      const next = text[i + 1] ?? '';
      if (next === 'u' || next === 'U') {
        const length = next === 'u' ? 4 : 8;
        const code = Number.parseInt(text.slice(i + 2, i + 2 + length), 16);
        if (Number.isNaN(code) || code > 0x10ffff) return null;
        value += String.fromCodePoint(code);
        i += 2 + length;
        continue;
      }
      value += simple[next] ?? next;
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  return null;
}

function parseTomlStringArray(raw: string): string[] | null {
  const text = raw.trim();
  if (!text.startsWith('[')) return null;
  const out: string[] = [];
  let i = 1;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === ']') return out;
    if (ch === ',' || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    const item = scanTomlString(text, i);
    if (!item) return null;
    out.push(item.value);
    i = item.end;
  }
  return null;
}

function findTomlRegistration(text: string, serverName: string, file: string): Result<{ registered: boolean; command: string | null }> {
  const lines = text.split(/\r?\n/);
  const inline = findTomlInlineDefinition(lines, serverName);
  if (inline !== null) {
    return err(uidnaError('config', `${file} defines mcp_servers.${serverName} inline on line ${inline + 1}, which uidna cannot inspect`, { details: { file } }));
  }
  const table = findTomlTable(lines, serverName);
  if (!table) return ok({ registered: false, command: null });
  let command: string | null = null;
  let args: string[] = [];
  for (const line of lines.slice(table.start + 1, table.end)) {
    const match = /^\s*(command|args)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = '', raw = ''] = match;
    if (key === 'command') command = scanTomlString(raw.trim(), 0)?.value ?? null;
    else args = parseTomlStringArray(raw) ?? [];
  }
  return ok({ registered: true, command: command === null ? null : formatCommand({ command, args }) });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Read a text file, returning null when it does not exist. */
async function readOptional(file: string): Promise<Result<string | null>> {
  try {
    return ok(await readFile(file, 'utf8'));
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return ok(null);
    return err(toError(cause, 'io', `read ${file}`));
  }
}

/** Lines describing the server's own entry inside `text`, for the plan excerpt. */
function entryExcerpt(change: SetupChange, text: string | null): string[] {
  if (text === null) return [];
  if (configLocation(change.target, change.scope, { home: '', cwd: '' }).format === 'toml') {
    const lines = text.split(/\r?\n/);
    const table = findTomlTable(lines, change.serverName);
    return table ? trimTrailingBlank(lines.slice(table.start, table.end)) : [];
  }
  const root = parseJsonConfig(text, change.file);
  if (!root.ok) return [];
  const servers = mcpServersOf(root.value, change.file);
  if (!servers.ok || !Object.hasOwn(servers.value, change.serverName)) return [];
  return [`"${change.serverName}": ${JSON.stringify(servers.value[change.serverName])}`];
}
