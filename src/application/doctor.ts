/**
 * `uidna doctor`: a read-only report of everything that has to be in place
 * for a scan to work: the Node version, Playwright and its Chromium build,
 * CDP reachability when an endpoint was given, where the MCP server is
 * registered, and whether the scan directory can be written. Each problem
 * is a plain-language sentence that says what to run.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserAvailability } from '../browser/types.js';
import { toError } from '../domain/errors.js';
import { isScanId } from '../domain/ids.js';
import { err, ok, type Result } from '../domain/result.js';
import { TARGET_LABELS, registrationStatus, type RegistrationStatus } from './setup.js';

/** Oldest supported Node release (matches `engines.node` in package.json). */
export const MIN_NODE_VERSION = { major: 20, minor: 19 } as const;

/** The full report. */
export interface DoctorReport {
  readonly node: { readonly version: string; readonly ok: boolean };
  readonly playwright: { readonly version: string | null };
  readonly chromium: BrowserAvailability['chromium'];
  /** Null when no CDP endpoint was given. */
  readonly cdp: BrowserAvailability['cdp'];
  /** True when the CDP endpoint was asked for (flag or config): an unreachable one is then a problem, not just information. */
  readonly cdpRequired: boolean;
  readonly registrations: readonly RegistrationStatus[];
  readonly outRoot: { readonly path: string; readonly writable: boolean };
  /** Number of scan directories under `outRoot`. */
  readonly scans: number;
  /** Actionable problems; empty when everything is in place. */
  readonly problems: readonly string[];
}

/** Dependencies of `runDoctor`. */
export interface DoctorDeps {
  /** Browser availability probe (`BrowserProvider.probe`). */
  readonly probe: (cdpEndpoint?: string) => Promise<BrowserAvailability>;
  readonly home: string;
  readonly cwd: string;
  /** Scan root; relative paths resolve against `cwd`. */
  readonly outRoot: string;
  /** When set, CDP reachability is checked and reported. */
  readonly cdpEndpoint?: string;
  /**
   * Whether an unreachable `cdpEndpoint` is a problem. Default true. The CLI passes false when it
   * probes the default endpoint on its own: attaching to Chrome is optional, so a Chrome that is not
   * running then is reported, not counted as a failure.
   */
  readonly cdpRequired?: boolean;
  /** Defaults to `process.version`. */
  readonly nodeVersion?: string;
  /** Registration name; defaults to `uidna`. */
  readonly serverName?: string;
  /** Codex configuration directory override (see `ConfigPaths`). */
  readonly codexHome?: string;
}

/** True when `version` (with or without a leading `v`) is at least `MIN_NODE_VERSION`. */
export function nodeVersionOk(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const [, majorText = '', minorText = ''] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  return major > MIN_NODE_VERSION.major || (major === MIN_NODE_VERSION.major && minor >= MIN_NODE_VERSION.minor);
}

/** Exit code the CLI should use for a report: 0 when there are no problems, 1 otherwise. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.problems.length === 0 ? 0 : 1;
}

/** Run every check and assemble the report. Never throws; a failing probe is a `browser` error. */
export async function runDoctor(deps: DoctorDeps): Promise<Result<DoctorReport>> {
  const nodeVersion = deps.nodeVersion ?? process.version;
  let availability: BrowserAvailability;
  try {
    availability = await deps.probe(deps.cdpEndpoint);
  } catch (cause) {
    return err(toError(cause, 'browser', 'probe browser availability'));
  }
  const registrations = await registrationStatus({
    home: deps.home,
    cwd: deps.cwd,
    ...(deps.serverName === undefined ? {} : { serverName: deps.serverName }),
    ...(deps.codexHome === undefined ? {} : { codexHome: deps.codexHome }),
  });
  if (!registrations.ok) return registrations;
  const outRootPath = resolve(deps.cwd, deps.outRoot);
  const writable = await probeWritable(outRootPath);
  const scans = await countScans(outRootPath);

  const report: DoctorReport = {
    node: { version: nodeVersion, ok: nodeVersionOk(nodeVersion) },
    playwright: { version: availability.playwrightVersion },
    chromium: availability.chromium,
    cdp: availability.cdp,
    cdpRequired: deps.cdpEndpoint !== undefined && deps.cdpRequired !== false,
    registrations: registrations.value,
    outRoot: { path: outRootPath, writable },
    scans,
    problems: [],
  };
  return ok({ ...report, problems: collectProblems(report, deps) });
}

function collectProblems(report: DoctorReport, deps: DoctorDeps): string[] {
  const problems: string[] = [];
  if (!report.node.ok) {
    problems.push(
      `Node ${report.node.version} is too old: UI DNA needs Node ${MIN_NODE_VERSION.major}.${MIN_NODE_VERSION.minor} or newer (https://nodejs.org)`,
    );
  }
  if (report.playwright.version === null) {
    problems.push('Playwright could not be loaded: reinstall uidna (npm install -g uidna-mcp) or run npm install in its directory');
  }
  if (!report.chromium.available) {
    problems.push(`Chromium is not installed: run npx playwright install chromium (${report.chromium.detail})`);
  }
  if (deps.cdpEndpoint !== undefined && report.cdpRequired) {
    if (!report.cdp?.reachable) {
      const detail = report.cdp ? ` (${report.cdp.detail})` : '';
      problems.push(
        `Chrome is not reachable at ${deps.cdpEndpoint}: start Chrome with --remote-debugging-port=9222 and check the port${detail}`,
      );
    }
  }
  for (const row of report.registrations) {
    if (row.problem !== undefined) {
      problems.push(
        `${row.file} (${TARGET_LABELS[row.target]}, ${row.scope} scope) could not be read as MCP configuration: ${row.problem}. Fix it by hand or restore the latest .bak- copy next to it`,
      );
    }
  }
  if (!report.registrations.some((row) => row.registered)) {
    problems.push('uidna is not registered with any agent: run npx uidna-mcp setup');
  }
  if (!report.outRoot.writable) {
    problems.push(`Scan directory ${report.outRoot.path} is not writable: pass another directory with --out <dir> or fix its permissions`);
  }
  return problems;
}

/** Create the directory if needed, then write and delete a probe file. */
async function probeWritable(dir: string): Promise<boolean> {
  const probe = join(dir, `.doctor-probe-${randomBytes(4).toString('hex')}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, 'ok', 'utf8');
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
  return true;
}

/** Number of scan directories under `dir`; 0 when it is missing or not a directory. */
async function countScans(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isScanId(entry.name)).length;
  } catch {
    return 0;
  }
}

/** Readable report: one section per area, problems last with the exit code the CLI will use. */
export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = ['uidna doctor', ''];

  lines.push('Node');
  lines.push(`  version      ${report.node.version}  ${report.node.ok ? 'ok' : `too old, needs >= ${MIN_NODE_VERSION.major}.${MIN_NODE_VERSION.minor}`}`);
  lines.push('');

  lines.push('Browser');
  lines.push(`  playwright   ${report.playwright.version ?? 'not loaded'}`);
  lines.push(
    `  chromium     ${report.chromium.available ? `available  ${report.chromium.executablePath ?? ''}`.trimEnd() : `missing  (${report.chromium.detail})`}`,
  );
  if (report.cdp === null) {
    lines.push('  cdp          not checked (pass --cdp <endpoint> to test a running Chrome)');
  } else {
    const browser = report.cdp.browser ? `  ${report.cdp.browser}` : '';
    const optional = report.cdpRequired ? '' : '; optional, only needed to attach to your own Chrome (pass --cdp to require it)';
    lines.push(`  cdp          ${report.cdp.endpoint}  ${report.cdp.reachable ? `reachable${browser}` : `unreachable  (${report.cdp.detail}${optional})`}`);
  }
  lines.push('');

  lines.push('Registrations');
  const label = (row: RegistrationStatus): string => `${TARGET_LABELS[row.target]} (${row.scope})`;
  const width = Math.max(...report.registrations.map((row) => label(row).length), 0);
  for (const row of report.registrations) {
    const state = row.problem !== undefined ? `unreadable  (${row.problem})` : row.registered ? `registered  ${row.command ?? ''}`.trimEnd() : row.exists ? 'not registered' : 'no config file';
    lines.push(`  ${label(row).padEnd(width)}  ${state}`);
    lines.push(`  ${''.padEnd(width)}  ${row.file}`);
  }
  lines.push('');

  lines.push('Scans');
  lines.push(`  directory    ${report.outRoot.path}  ${report.outRoot.writable ? 'writable' : 'not writable'}`);
  lines.push(`  scans        ${report.scans}`);
  lines.push('');

  if (report.problems.length === 0) {
    lines.push('No problems found. Exit code 0.');
  } else {
    lines.push('Problems');
    for (const problem of report.problems) lines.push(`  ! ${problem}`);
    lines.push('');
    lines.push(`${report.problems.length} problem(s) found. Exit code 1.`);
  }
  return lines.join('\n');
}
