import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserAvailability } from '../browser/types.js';
import { unwrap } from '../domain/result.js';
import { doctorExitCode, formatDoctor, nodeVersionOk, runDoctor } from './doctor.js';

const TMP_ROOT = fileURLToPath(new URL('../../tests/.tmp/', import.meta.url));

let tmp: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  tmp = await mkdtemp(join(TMP_ROOT, 'doctor-'));
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

const REGISTERED = JSON.stringify({ mcpServers: { uidna: { type: 'stdio', command: 'npx', args: ['-y', '@rohzzn/uidna', 'serve'] } } });

function fakeProbe(overrides: Partial<BrowserAvailability> = {}): (cdpEndpoint?: string) => Promise<BrowserAvailability> {
  return (cdpEndpoint) =>
    Promise.resolve({
      playwrightVersion: '1.64.0',
      chromium: { available: true, executablePath: 'C:\\pw\\chrome.exe', detail: 'found' },
      cdp: cdpEndpoint === undefined ? null : { endpoint: cdpEndpoint, reachable: false, detail: 'ECONNREFUSED' },
      ...overrides,
    });
}

describe('nodeVersionOk', () => {
  it('accepts 20.19 and newer, rejects older and garbage', () => {
    expect(nodeVersionOk('v20.19.0')).toBe(true);
    expect(nodeVersionOk('v24.1.0')).toBe(true);
    expect(nodeVersionOk('22.0.0')).toBe(true);
    expect(nodeVersionOk('v20.18.3')).toBe(false);
    expect(nodeVersionOk('v18.20.0')).toBe(false);
    expect(nodeVersionOk('nope')).toBe(false);
  });
});

describe('runDoctor', () => {
  it('reports missing Chromium as a problem, a registered Claude Code entry as ok, and counts scans', async () => {
    await write(join(home, '.claude.json'), REGISTERED);
    const outRoot = join(cwd, '.uidna');
    await mkdir(join(outRoot, 'scan_20261013_abcdef'), { recursive: true });
    await mkdir(join(outRoot, 'scan_20261012_123456'), { recursive: true });
    await mkdir(join(outRoot, 'not-a-scan'), { recursive: true });
    await write(join(outRoot, 'scan_20261011_aaaaaa'), 'a file, not a scan directory');

    const report = unwrap(
      await runDoctor({
        probe: fakeProbe({ chromium: { available: false, executablePath: null, detail: 'no chromium build in the Playwright cache' } }),
        home,
        cwd,
        outRoot: '.uidna',
        nodeVersion: 'v24.1.0',
      }),
    );
    expect(report.node).toEqual({ version: 'v24.1.0', ok: true });
    expect(report.playwright.version).toBe('1.64.0');
    expect(report.chromium.available).toBe(false);
    expect(report.cdp).toBeNull();
    expect(report.scans).toBe(2);
    expect(report.outRoot).toEqual({ path: outRoot, writable: true });

    const claude = report.registrations.find((r) => r.target === 'claude-code' && r.scope === 'user')!;
    expect(claude).toMatchObject({ exists: true, registered: true, command: 'npx -y @rohzzn/uidna serve' });
    expect(report.registrations).toHaveLength(5);

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('Chromium is not installed: run npx playwright install chromium');
    expect(report.problems[0]).toContain('no chromium build');
    expect(doctorExitCode(report)).toBe(1);

    const text = formatDoctor(report);
    expect(text).toContain('Claude Code (user)');
    expect(text).toContain('registered  npx -y @rohzzn/uidna serve');
    expect(text).toContain('  ! Chromium is not installed');
    expect(text).toContain('scans        2');
    expect(text).toContain('Exit code 1');
    expect(text).toContain('not checked (pass --cdp');
  });

  it('reports an unwritable outRoot as a problem and counts zero scans', async () => {
    await write(join(home, '.claude.json'), REGISTERED);
    const outRoot = join(cwd, 'a-file');
    await write(outRoot, 'occupied');
    const report = unwrap(await runDoctor({ probe: fakeProbe(), home, cwd, outRoot, nodeVersion: 'v24.1.0' }));
    expect(report.outRoot).toEqual({ path: outRoot, writable: false });
    expect(report.scans).toBe(0);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain(`Scan directory ${outRoot} is not writable`);
    expect(formatDoctor(report)).toContain('not writable');
  });

  it('reports no problems and exit code 0 when everything is in place', async () => {
    await write(join(cwd, '.mcp.json'), REGISTERED);
    const probe = fakeProbe({ cdp: { endpoint: 'http://localhost:9222', reachable: true, detail: 'ok', browser: 'Chrome/130.0' } });
    const report = unwrap(await runDoctor({ probe, home, cwd, outRoot: join(cwd, 'out', 'nested'), cdpEndpoint: 'http://localhost:9222', nodeVersion: 'v22.12.0' }));
    expect(report.problems).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
    expect(report.outRoot.writable).toBe(true);
    expect(report.cdp?.reachable).toBe(true);
    const text = formatDoctor(report);
    expect(text).toContain('No problems found. Exit code 0.');
    expect(text).toContain('reachable  Chrome/130.0');
    expect(text).toContain('Claude Code (project)');
  });

  it('flags an old Node, an unreachable CDP endpoint, a missing registration and unreadable config', async () => {
    await write(join(home, '.cursor', 'mcp.json'), '{ broken');
    const report = unwrap(await runDoctor({ probe: fakeProbe(), home, cwd, outRoot: join(cwd, '.uidna'), cdpEndpoint: 'http://localhost:9222', nodeVersion: 'v18.20.0' }));
    expect(report.node.ok).toBe(false);
    expect(report.problems.some((p) => p.startsWith('Node v18.20.0 is too old'))).toBe(true);
    expect(report.problems.some((p) => p.startsWith('Chrome is not reachable at http://localhost:9222') && p.includes('ECONNREFUSED'))).toBe(true);
    expect(report.problems.some((p) => p === 'uidna is not registered with any agent: run npx @rohzzn/uidna setup')).toBe(true);
    expect(report.problems.some((p) => p.includes(join(home, '.cursor', 'mcp.json')) && p.includes('could not be read'))).toBe(true);
    expect(formatDoctor(report)).toContain('4 problem(s) found. Exit code 1.');
  });

  it('turns a throwing probe into a browser error', async () => {
    const result = await runDoctor({ probe: () => Promise.reject(new Error('boom')), home, cwd, outRoot: join(cwd, '.uidna') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe('browser');
      expect(result.error.message).toContain('boom');
    }
  });
});
