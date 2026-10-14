/**
 * The generated Playwright behavior tests as evidence. `runGeneratedTests`
 * runs `npm run test:behavior` of a generated project against the static
 * server the verifier already serves (the generated `playwright.config.ts`
 * reads `PORT` and `BASE_URL` and reuses a reachable server, so no second
 * preview server starts), asks Playwright for its JSON reporter, and turns
 * the report into one record per test with its status and an error excerpt.
 * A failing run never throws: failures are results; a run that could not
 * start says why. `parsePlaywrightReport` is pure.
 */
import { readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { runNpm } from '../application/process.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** Default timeout of one generated test run. */
export const GENERATED_TESTS_TIMEOUT_MS = 240_000;
/** File under the attempt directory that stores the normalized run (`GeneratedTestRunSchema`). */
export const GENERATED_TESTS_FILE = 'generated-tests.json';
/** File under the attempt directory that keeps Playwright's raw JSON report. */
export const GENERATED_TESTS_RAW_FILE = 'generated-tests.report.json';
/** File under the attempt directory that keeps the npm output of the run. */
export const GENERATED_TESTS_LOG_FILE = 'generated-tests.log';
/** Longest error excerpt kept per test. */
export const MAX_ERROR_EXCERPT = 400;
/** The npm script the generator writes. */
export const GENERATED_TESTS_SCRIPT = 'test:behavior';

const NonNegativeInt = z.number().int().min(0);

/** Outcome of one generated test. */
export const GeneratedTestResultSchema = z.strictObject({
  /** Spec title as written by the generator (`tr_01: click button "Menu" at 0/1 (1280×800)`), with the Playwright project name when one is set. */
  title: z.string().min(1),
  /** Transition id parsed from the title, or null when the title names none. */
  transitionId: z.string().nullable(),
  status: z.enum(['passed', 'failed', 'skipped', 'flaky']),
  durationMs: z.number().min(0),
  /** First error message of the failing result (ANSI codes stripped, whitespace collapsed, truncated), or null. */
  error: z.string().nullable(),
});
export type GeneratedTestResult = z.infer<typeof GeneratedTestResultSchema>;

/** A generated test run, as stored under `verify/attempt-<n>/generated-tests.json`. */
export const GeneratedTestRunSchema = z.strictObject({
  /** False when the tests could not be started; `reason` says why. */
  ran: z.boolean(),
  reason: z.string().nullable(),
  /** The command that was (or would have been) run. */
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: NonNegativeInt,
  /** Playwright's raw JSON report, relative to the scan directory, when it was written. */
  reportPath: z.string().nullable(),
  /** The npm output log, relative to the scan directory, when it was written. */
  logPath: z.string().nullable(),
  /** Why the report could not be parsed, when the run ended without a usable report. */
  parseError: z.string().nullable(),
  stats: z.strictObject({ passed: NonNegativeInt, failed: NonNegativeInt, skipped: NonNegativeInt, flaky: NonNegativeInt }),
  tests: z.array(GeneratedTestResultSchema),
});
export type GeneratedTestRun = z.infer<typeof GeneratedTestRunSchema>;

/* -------------------------------------------------------------- parsing */

/** The parts of Playwright's JSON reporter output the verifier reads (unknown keys are ignored). */
const ReportResultSchema = z.object({
  status: z.string(),
  duration: z.number().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});
const ReportTestSchema = z.object({
  status: z.enum(['skipped', 'expected', 'unexpected', 'flaky']),
  projectName: z.string().optional(),
  results: z.array(ReportResultSchema).optional(),
});
const ReportSpecSchema = z.object({
  title: z.string(),
  tests: z.array(ReportTestSchema).optional(),
});

interface ReportSuite {
  readonly title?: string | undefined;
  readonly specs?: readonly z.infer<typeof ReportSpecSchema>[] | undefined;
  readonly suites?: readonly ReportSuite[] | undefined;
}

const ReportSuiteSchema: z.ZodType<ReportSuite> = z.lazy(() =>
  z.object({
    title: z.string().optional(),
    specs: z.array(ReportSpecSchema).optional(),
    suites: z.array(ReportSuiteSchema).optional(),
  }),
);

const ReportSchema = z.object({
  suites: z.array(ReportSuiteSchema).optional(),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

/** Spec titles start with the transition id the generator wrote: `tr_01: click …`. */
const TITLE_TRANSITION = /^(tr_\d+):/;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Transition id a generated test title names, or null. */
export function transitionIdOfTitle(title: string): string | null {
  const match = TITLE_TRANSITION.exec(title);
  return match?.[1] ?? null;
}

/** Strip ANSI escapes, collapse whitespace and truncate an error message for a finding. */
export function errorExcerpt(message: string): string {
  const clean = message.replace(ANSI, '').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_ERROR_EXCERPT ? `${clean.slice(0, MAX_ERROR_EXCERPT)}…` : clean;
}

/** Tests and counts read from a Playwright JSON report. */
export interface ParsedReport {
  readonly tests: GeneratedTestResult[];
  readonly stats: GeneratedTestRun['stats'];
  /** Run-level errors Playwright reported outside any test (a config that fails to load, a missing browser). */
  readonly errors: string[];
}

function statusOf(status: z.infer<typeof ReportTestSchema>['status']): GeneratedTestResult['status'] {
  switch (status) {
    case 'expected':
      return 'passed';
    case 'unexpected':
      return 'failed';
    case 'flaky':
      return 'flaky';
    default:
      return 'skipped';
  }
}

function collect(suite: ReportSuite, out: GeneratedTestResult[]): void {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      const last = results[results.length - 1];
      const failing = [...results].reverse().find((r) => (r.errors?.length ?? 0) > 0 || r.error?.message !== undefined);
      const message = failing?.errors?.find((e) => e.message !== undefined)?.message ?? failing?.error?.message ?? null;
      const title = test.projectName !== undefined && test.projectName.length > 0 ? `${spec.title} [${test.projectName}]` : spec.title;
      out.push({
        title,
        transitionId: transitionIdOfTitle(spec.title),
        status: statusOf(test.status),
        durationMs: Math.max(0, Math.round(last?.duration ?? 0)),
        error: message === null ? null : errorExcerpt(message),
      });
    }
  }
  for (const child of suite.suites ?? []) collect(child, out);
}

/** Parse the text of a Playwright JSON report into test records and counts. */
export function parsePlaywrightReport(text: string): Result<ParsedReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err(toError(cause, 'validation', 'the Playwright JSON report is not JSON'));
  }
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) {
    return err(uidnaError('validation', `the Playwright JSON report has an unexpected shape: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`));
  }
  const tests: GeneratedTestResult[] = [];
  for (const suite of parsed.data.suites ?? []) collect(suite, tests);
  const stats = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const test of tests) stats[test.status] += 1;
  const errors = (parsed.data.errors ?? []).map((e) => e.message).filter((m): m is string => m !== undefined && m.length > 0).map(errorExcerpt);
  return ok({ tests, stats, errors });
}

/* -------------------------------------------------------------- running */

/** Input of `runGeneratedTests`. */
export interface GeneratedTestsInput {
  /** The generated project directory (absolute). */
  readonly outDir: string;
  /** URL of the already served build, e.g. `http://127.0.0.1:5173/`. */
  readonly serverUrl: string;
  readonly port: number;
  /** Absolute directory that receives the log and the reports (the attempt directory). */
  readonly artifactDir: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** `runGeneratedTests` result: the run with absolute artifact paths (the caller stores scan-relative ones). */
export interface GeneratedTestsOutcome extends Omit<GeneratedTestRun, 'reportPath' | 'logPath'> {
  readonly reportPath: string | null;
  readonly logPath: string | null;
  /** Run-level errors Playwright reported outside any test. */
  readonly errors: readonly string[];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Why the generated tests cannot be started in `outDir`, or null when everything they need is there. */
async function notRunnable(outDir: string): Promise<string | null> {
  if (!(await isFile(join(outDir, 'tests', 'behavior.spec.ts')))) return `tests/behavior.spec.ts is missing in ${outDir} (generate_project with behaviorTests: true writes it)`;
  if (!(await isFile(join(outDir, 'playwright.config.ts')))) return `playwright.config.ts is missing in ${outDir}`;
  if (!(await isFile(join(outDir, 'node_modules', '@playwright', 'test', 'package.json')))) return `@playwright/test is not installed in ${outDir} (run npm install there first)`;
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(outDir, 'package.json'), 'utf8'));
  } catch (cause) {
    return `package.json of ${outDir} could not be read: ${toError(cause, 'io').message}`;
  }
  const scripts = z.object({ scripts: z.record(z.string(), z.string()).optional() }).safeParse(manifest);
  if (!scripts.success || scripts.data.scripts?.[GENERATED_TESTS_SCRIPT] === undefined) return `package.json of ${outDir} has no "${GENERATED_TESTS_SCRIPT}" script`;
  return null;
}

/** Remove the raw report an earlier run left at `path`; null when it is gone (or never existed), else why the run cannot start. */
async function removeStaleReport(path: string): Promise<string | null> {
  try {
    await rm(path, { force: true });
    return null;
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT') return null;
    return `the previous ${GENERATED_TESTS_RAW_FILE} at ${path} could not be removed (${toError(cause, 'io').message}); its results would be read as this run's`;
  }
}

/**
 * Run the generated behavior tests against an already served build. Never
 * throws and never fails: a run that could not start has `ran: false` and a
 * reason; a run whose tests fail has their failures in `tests`. A raw report
 * an earlier run left in `artifactDir` is removed first; when it cannot be,
 * the run does not start.
 */
export async function runGeneratedTests(input: GeneratedTestsInput): Promise<GeneratedTestsOutcome> {
  const outDir = resolve(input.outDir);
  const artifactDir = resolve(input.artifactDir);
  const args = ['run', GENERATED_TESTS_SCRIPT, '--', '--reporter=json'];
  const command = `npm ${args.join(' ')}`;
  const base: GeneratedTestsOutcome = {
    ran: false,
    reason: null,
    command,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    reportPath: null,
    logPath: null,
    parseError: null,
    stats: { passed: 0, failed: 0, skipped: 0, flaky: 0 },
    tests: [],
    errors: [],
  };
  const reason = await notRunnable(outDir);
  if (reason !== null) return { ...base, reason };

  const rawReportPath = join(artifactDir, GENERATED_TESTS_RAW_FILE);
  const logPath = join(artifactDir, GENERATED_TESTS_LOG_FILE);
  // Attempt numbers can be reused: a report left by an earlier run must never be read as this run's.
  const stale = await removeStaleReport(rawReportPath);
  if (stale !== null) return { ...base, reason: stale };
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const env: Record<string, string> = {
    PORT: String(input.port),
    BASE_URL: input.serverUrl,
    PLAYWRIGHT_JSON_OUTPUT_NAME: rawReportPath,
    npm_config_update_notifier: 'false',
    ...(browsersPath !== undefined && browsersPath.length > 0 ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
  };
  const run = await runNpm(args, {
    cwd: outDir,
    env,
    timeoutMs: input.timeoutMs ?? GENERATED_TESTS_TIMEOUT_MS,
    logPath,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!run.ok) return { ...base, reason: `npm could not be started: ${run.error.message}` };
  const outcome = run.value;
  const result: GeneratedTestsOutcome = {
    ...base,
    ran: true,
    exitCode: outcome.code,
    timedOut: outcome.timedOut,
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    logPath: outcome.logPath,
  };

  // The report file is the primary source; a report printed to stdout (no output name honoured) is the fallback.
  let text: string;
  let reportPath: string | null = isAbsolute(rawReportPath) ? rawReportPath : resolve(outDir, rawReportPath);
  try {
    text = await readFile(reportPath, 'utf8');
  } catch (cause) {
    reportPath = null;
    const stdoutJson = outcome.stdout.split(/\r?\n/).find((line) => line.startsWith('{'));
    if (stdoutJson === undefined) {
      return { ...result, parseError: `no JSON report was written to ${GENERATED_TESTS_RAW_FILE} (${toError(cause, 'io').message}) and npm printed none` };
    }
    text = stdoutJson;
  }
  const parsed = parsePlaywrightReport(text);
  if (!parsed.ok) return { ...result, reportPath, parseError: parsed.error.message };
  return { ...result, reportPath, stats: parsed.value.stats, tests: parsed.value.tests, errors: parsed.value.errors };
}
