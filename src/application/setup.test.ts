import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../domain/clock.js';
import { unwrap } from '../domain/result.js';
import {
  DEFAULT_SERVER_COMMAND,
  applySetup,
  configLocation,
  formatPlan,
  localServerCommand,
  planSetup,
  registrationStatus,
  tomlTableLines,
  type SetupChange,
} from './setup.js';

const TMP_ROOT = fileURLToPath(new URL('../../tests/.tmp/', import.meta.url));
const AT = '2026-10-13T17:29:00.000Z';
const STAMP = '2026-10-13T17-29-00.000Z';

let tmp: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  tmp = await mkdtemp(join(TMP_ROOT, 'setup-'));
  home = join(tmp, 'home');
  cwd = join(tmp, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

function byTarget(changes: SetupChange[], target: SetupChange['target']): SetupChange {
  const found = changes.find((c) => c.target === target);
  if (!found) throw new Error(`no change for ${target}`);
  return found;
}

const EXPECTED_ENTRY = { type: 'stdio', command: 'npx', args: ['-y', '@rohzzn/uidna@latest', 'serve'] };
const EXPECTED_TOML = '[mcp_servers.uidna]\ncommand = "npx"\nargs = ["-y", "@rohzzn/uidna@latest", "serve"]\n';

describe('planSetup', () => {
  it('creates all three user-scope files when none exist', async () => {
    const changes = unwrap(await planSetup({ targets: ['claude-code', 'codex', 'cursor'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    expect(changes.map((c) => c.file)).toEqual([join(home, '.claude.json'), join(home, '.codex', 'config.toml'), join(home, '.cursor', 'mcp.json')]);
    for (const change of changes) {
      expect(change.exists).toBe(false);
      expect(change.before).toBeNull();
      expect(change.noop).toBe(false);
      expect(change.description).toMatch(/^Create /);
    }
    expect(JSON.parse(byTarget(changes, 'claude-code').after)).toEqual({ mcpServers: { uidna: EXPECTED_ENTRY } });
    expect(JSON.parse(byTarget(changes, 'cursor').after)).toEqual({ mcpServers: { uidna: EXPECTED_ENTRY } });
    expect(byTarget(changes, 'codex').after).toBe(EXPECTED_TOML);

    const outcome = unwrap(await applySetup(changes, { backup: true }));
    expect(outcome.written).toEqual(changes.map((c) => c.file));
    expect(outcome.backups).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(await readJson(join(home, '.claude.json'))).toEqual({ mcpServers: { uidna: EXPECTED_ENTRY } });
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(EXPECTED_TOML);
  });

  it('merges into an existing ~/.claude.json, preserving other servers and unrelated keys', async () => {
    const file = join(home, '.claude.json');
    const original = {
      numStartups: 12,
      mcpServers: {
        github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        local: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' } },
      },
      projects: { '/work/app': { allowedTools: ['Bash'], mcpServers: {} } },
    };
    await write(file, JSON.stringify(original, null, 2) + '\n');

    const changes = unwrap(await planSetup({ targets: ['claude-code'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    expect(change.exists).toBe(true);
    expect(change.noop).toBe(false);
    expect(change.description).toMatch(/^Update /);

    const outcome = unwrap(await applySetup(changes, { backup: true, clock: fixedClock(AT) }));
    expect(outcome.written).toEqual([file]);
    expect(outcome.backups).toEqual([`${file}.bak-${STAMP}`]);

    const after = await readJson(file);
    expect(after.numStartups).toBe(12);
    expect(after.projects).toEqual(original.projects);
    const servers = after.mcpServers as Record<string, unknown>;
    expect(servers.github).toEqual(original.mcpServers.github);
    expect(servers.local).toEqual(original.mcpServers.local);
    expect(servers.uidna).toEqual(EXPECTED_ENTRY);
    expect(Object.keys(after)).toEqual(['numStartups', 'mcpServers', 'projects']);
    expect(Object.keys(servers)).toEqual(['github', 'local', 'uidna']);
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('writes .mcp.json and .cursor/mcp.json at project scope and keeps Codex at user scope with a note', async () => {
    const changes = unwrap(await planSetup({ targets: ['claude-code', 'codex', 'cursor'], scope: 'project', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    expect(byTarget(changes, 'claude-code').file).toBe(join(cwd, '.mcp.json'));
    expect(byTarget(changes, 'claude-code').scope).toBe('project');
    expect(byTarget(changes, 'cursor').file).toBe(join(cwd, '.cursor', 'mcp.json'));
    expect(byTarget(changes, 'cursor').scope).toBe('project');
    const codex = byTarget(changes, 'codex');
    expect(codex.file).toBe(join(home, '.codex', 'config.toml'));
    expect(codex.scope).toBe('user');
    expect(codex.note).toMatch(/trusted/);
    expect(byTarget(changes, 'claude-code').note).toBeNull();

    unwrap(await applySetup(changes, { backup: true }));
    expect(await readJson(join(cwd, '.mcp.json'))).toEqual({ mcpServers: { uidna: EXPECTED_ENTRY } });
    expect(await readJson(join(cwd, '.cursor', 'mcp.json'))).toEqual({ mcpServers: { uidna: EXPECTED_ENTRY } });
    expect(await readFile(codex.file, 'utf8')).toBe(EXPECTED_TOML);
  });

  it('yields noop changes the second time and writes nothing', async () => {
    const options = { targets: ['claude-code', 'codex', 'cursor'] as const, scope: 'user' as const, server: DEFAULT_SERVER_COMMAND, home, cwd };
    unwrap(await applySetup(unwrap(await planSetup(options)), { backup: true }));
    const again = unwrap(await planSetup(options));
    expect(again).toHaveLength(3);
    for (const change of again) {
      expect(change.noop).toBe(true);
      expect(change.exists).toBe(true);
      expect(change.after).toBe(change.before);
      expect(change.description).toMatch(/already registered/);
    }
    const outcome = unwrap(await applySetup(again, { backup: true, clock: fixedClock(AT) }));
    expect(outcome.written).toEqual([]);
    expect(outcome.backups).toEqual([]);
    expect(outcome.skipped).toEqual(again.map((c) => c.file));
    expect(formatPlan(again)).toContain('[unchanged]');
    expect(formatPlan(again)).toContain('nothing will be written');
  });

  it('treats a differently formatted but equal entry as noop without reformatting the file', async () => {
    const file = join(home, '.cursor', 'mcp.json');
    const minified = '{"mcpServers":{"uidna":{"type":"stdio","command":"npx","args":["-y","@rohzzn/uidna@latest","serve"]},"other":{"command":"x","args":[]}}}';
    await write(file, minified);
    const changes = unwrap(await planSetup({ targets: ['cursor'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    expect(changes[0]!.noop).toBe(true);
    expect(changes[0]!.after).toBe(minified);
  });

  it('creates backups whose content is identical to the original', async () => {
    const claude = join(home, '.claude.json');
    const codex = join(home, '.codex', 'config.toml');
    const claudeOriginal = '{\n  "mcpServers": {\n    "other": { "type": "stdio", "command": "x", "args": [] }\n  }\n}\n';
    const codexOriginal = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n';
    await write(claude, claudeOriginal);
    await write(codex, codexOriginal);

    const changes = unwrap(await planSetup({ targets: ['claude-code', 'codex'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    const outcome = unwrap(await applySetup(changes, { backup: true, clock: fixedClock(AT) }));
    expect(outcome.backups).toEqual([`${claude}.bak-${STAMP}`, `${codex}.bak-${STAMP}`]);
    expect(await readFile(`${claude}.bak-${STAMP}`, 'utf8')).toBe(claudeOriginal);
    expect(await readFile(`${codex}.bak-${STAMP}`, 'utf8')).toBe(codexOriginal);
    expect(await readFile(claude, 'utf8')).not.toBe(claudeOriginal);
    expect(await readFile(codex, 'utf8')).not.toBe(codexOriginal);
  });

  it('skips backups when backup is false', async () => {
    const file = join(home, '.claude.json');
    await write(file, '{}');
    const changes = unwrap(await planSetup({ targets: ['claude-code'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    const outcome = unwrap(await applySetup(changes, { backup: false, clock: fixedClock(AT) }));
    expect(outcome.backups).toEqual([]);
    expect(outcome.written).toEqual([file]);
  });

  it('reports invalid JSON as a config error naming the file and writes nothing', async () => {
    const file = join(home, '.claude.json');
    const broken = '{ "mcpServers": { "x": }';
    await write(file, broken);
    const result = await planSetup({ targets: ['claude-code', 'cursor'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe('config');
    expect(result.error.message).toContain(file);
    expect(await readFile(file, 'utf8')).toBe(broken);
  });

  it('rejects a top-level JSON array and a non-object mcpServers', async () => {
    await write(join(home, '.claude.json'), '[]');
    const array = await planSetup({ targets: ['claude-code'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd });
    expect(array.ok).toBe(false);
    if (!array.ok) expect(array.error._tag).toBe('config');

    await write(join(home, '.cursor', 'mcp.json'), '{ "mcpServers": "nope" }');
    const servers = await planSetup({ targets: ['cursor'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd });
    expect(servers.ok).toBe(false);
    if (!servers.ok) expect(servers.error.message).toContain('mcpServers');
  });

  it('refuses to apply when a file changed after the plan was made', async () => {
    const file = join(home, '.claude.json');
    await write(file, '{}');
    const changes = unwrap(await planSetup({ targets: ['claude-code'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    await write(file, '{ "numStartups": 1 }');
    const result = await applySetup(changes, { backup: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe('config');
    expect(result.error.message).toContain('changed since the plan');
    expect(await readFile(file, 'utf8')).toBe('{ "numStartups": 1 }');
  });

  it('supports the local node form and a custom server name', async () => {
    const server = localServerCommand(join(cwd, 'dist', 'cli.js'));
    expect(server.command).toBe('node');
    expect(server.args[1]).toBe('serve');
    const changes = unwrap(await planSetup({ targets: ['claude-code', 'codex'], scope: 'user', server, home, cwd, serverName: 'uidna-dev' }));
    expect(JSON.parse(byTarget(changes, 'claude-code').after)).toEqual({ mcpServers: { 'uidna-dev': { type: 'stdio', command: 'node', args: server.args } } });
    expect(byTarget(changes, 'codex').after).toContain('[mcp_servers.uidna-dev]');
    const bad = await planSetup({ targets: ['codex'], scope: 'user', server, home, cwd, serverName: 'a.b' });
    expect(bad.ok).toBe(false);
  });

  it('formats a plan with tags, commands and entry excerpts', async () => {
    await write(join(home, '.claude.json'), JSON.stringify({ mcpServers: { uidna: { type: 'stdio', command: 'node', args: ['old.js'] } } }));
    const changes = unwrap(await planSetup({ targets: ['claude-code', 'codex'], scope: 'project', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    const text = formatPlan(changes);
    expect(text).toContain(`[create] ${join(cwd, '.mcp.json')}`);
    expect(text).toContain(`[create] ${join(home, '.codex', 'config.toml')}`);
    expect(text).toContain('Claude Code, project scope: npx -y @rohzzn/uidna@latest serve');
    expect(text).toContain('note: Codex loads a project-scoped');
    expect(text).toContain('+ "uidna": {"type":"stdio","command":"npx","args":["-y","@rohzzn/uidna@latest","serve"]}');
    expect(text).toContain('+ [mcp_servers.uidna]');
    expect(text).toContain('2 file(s) to write (2 new, 0 updated)');

    const update = unwrap(await planSetup({ targets: ['claude-code'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    const updateText = formatPlan(update);
    expect(updateText).toContain(`[update] ${join(home, '.claude.json')}`);
    expect(updateText).toContain('- "uidna": {"type":"stdio","command":"node","args":["old.js"]}');
    expect(updateText).toContain('+ "uidna": {"type":"stdio","command":"npx","args":["-y","@rohzzn/uidna@latest","serve"]}');
    expect(formatPlan([])).toContain('Nothing to do');
  });
});

describe('Codex TOML', () => {
  const codexFile = (): string => join(home, '.codex', 'config.toml');
  const plan = async (): Promise<SetupChange> => {
    const changes = unwrap(await planSetup({ targets: ['codex'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd }));
    return changes[0]!;
  };

  it('appends a table to a config with existing tables', async () => {
    const original = 'model = "o3"\napproval_policy = "never"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\n\n[mcp_servers.context7.env]\nMY_ENV_VAR = "x"\n';
    await write(codexFile(), original);
    const change = await plan();
    expect(change.after).toBe(original + '\n' + EXPECTED_TOML);
    unwrap(await applySetup([change], { backup: false }));
    expect(await readFile(codexFile(), 'utf8')).toBe(original + '\n' + EXPECTED_TOML);
  });

  it('appends after a config that lacks a trailing newline or has trailing blank lines', async () => {
    await write(codexFile(), 'model = "o3"');
    expect((await plan()).after).toBe('model = "o3"\n\n' + EXPECTED_TOML);
    await write(codexFile(), '[a]\nx = 1\n\n\n\n');
    expect((await plan()).after).toBe('[a]\nx = 1\n\n' + EXPECTED_TOML);
  });

  it('replaces an existing [mcp_servers.uidna] table and preserves tables before and after it', async () => {
    const before = '[a]\nx = 1\n';
    const old = '[mcp_servers.uidna]\n# stale registration\ncommand = "node"\nargs = ["C:\\\\old\\\\cli.js", "serve"]\nstartup_timeout_sec = 20\n\n';
    const after = '[mcp_servers.other]\ncommand = "other"\n\n[[profiles]]\nname = "x"\n';
    await write(codexFile(), before + old + after);
    const change = await plan();
    expect(change.exists).toBe(true);
    expect(change.noop).toBe(false);
    expect(change.after).toBe(before + EXPECTED_TOML + '\n' + after);
    unwrap(await applySetup([change], { backup: false }));
    expect((await plan()).noop).toBe(true);
  });

  it('replaces a table at the end of the file and one whose name is quoted', async () => {
    await write(codexFile(), '[a]\nx = 1\n\n[mcp_servers.uidna]\ncommand = "x"\n');
    expect((await plan()).after).toBe('[a]\nx = 1\n\n' + EXPECTED_TOML);
    await write(codexFile(), '[mcp_servers."uidna"]\ncommand = "x"\n\n[b]\ny = 2\n');
    expect((await plan()).after).toBe(EXPECTED_TOML + '\n[b]\ny = 2\n');
  });

  it('handles a missing file and an empty file', async () => {
    const created = await plan();
    expect(created.exists).toBe(false);
    expect(created.after).toBe(EXPECTED_TOML);
    await write(codexFile(), '');
    const empty = await plan();
    expect(empty.exists).toBe(true);
    expect(empty.after).toBe(EXPECTED_TOML);
  });

  it('preserves CRLF line endings', async () => {
    await write(codexFile(), '[a]\r\nx = 1\r\n');
    expect((await plan()).after).toBe('[a]\r\nx = 1\r\n\r\n' + EXPECTED_TOML.replace(/\n/g, '\r\n'));
  });

  it('refuses inline definitions it cannot rewrite', async () => {
    await write(codexFile(), '[mcp_servers]\nuidna = { command = "x", args = [] }\n');
    const underTable = await planSetup({ targets: ['codex'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd });
    expect(underTable.ok).toBe(false);
    if (!underTable.ok) {
      expect(underTable.error._tag).toBe('config');
      expect(underTable.error.message).toContain('line 2');
    }
    await write(codexFile(), 'mcp_servers.uidna = { command = "x" }\n');
    const topLevel = await planSetup({ targets: ['codex'], scope: 'user', server: DEFAULT_SERVER_COMMAND, home, cwd });
    expect(topLevel.ok).toBe(false);
  });

  it('escapes Windows paths and quotes in TOML strings', () => {
    const lines = tomlTableLines('uidna', { command: 'node', args: ['C:\\tools\\dist\\cli.js', 'se"rve'] });
    expect(lines).toEqual(['[mcp_servers.uidna]', 'command = "node"', 'args = ["C:\\\\tools\\\\dist\\\\cli.js", "se\\"rve"]']);
  });
});

describe('registrationStatus', () => {
  it('detects registered and unregistered targets', async () => {
    await write(join(home, '.claude.json'), JSON.stringify({ mcpServers: { uidna: EXPECTED_ENTRY } }));
    await write(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://x' } } }));
    await write(join(home, '.codex', 'config.toml'), '[mcp_servers.uidna]\ncommand = "node"\nargs = ["C:\\\\u\\\\cli.js", "serve"]\n');
    await write(join(cwd, '.cursor', 'mcp.json'), '{ not json');

    const rows = unwrap(await registrationStatus({ home, cwd }));
    const find = (target: string, scope: string) => rows.find((r) => r.target === target && r.scope === scope)!;
    expect(rows).toHaveLength(5);
    expect(find('claude-code', 'user')).toMatchObject({ exists: true, registered: true, command: 'npx -y @rohzzn/uidna@latest serve' });
    expect(find('claude-code', 'project')).toMatchObject({ exists: true, registered: false, command: null });
    expect(find('codex', 'user')).toMatchObject({ exists: true, registered: true, command: 'node C:\\u\\cli.js serve' });
    expect(find('cursor', 'user')).toMatchObject({ exists: false, registered: false, command: null });
    expect(find('cursor', 'project')).toMatchObject({ exists: true, registered: false });
    expect(find('cursor', 'project').problem).toContain('not valid JSON');
    expect(find('codex', 'user').file).toBe(configLocation('codex', 'user', { home, cwd }).file);
  });

  it('honors a custom server name and codexHome', async () => {
    const codexHome = join(tmp, 'codex-home');
    await write(join(codexHome, 'config.toml'), '[mcp_servers.custom]\ncommand = "npx"\nargs = ["-y", "@rohzzn/uidna@latest", "serve"]\n');
    const rows = unwrap(await registrationStatus({ home, cwd, codexHome, serverName: 'custom' }));
    const codex = rows.find((r) => r.target === 'codex')!;
    expect(codex.file).toBe(join(codexHome, 'config.toml'));
    expect(codex.registered).toBe(true);
    expect(codex.command).toBe('npx -y @rohzzn/uidna@latest serve');
  });
});
