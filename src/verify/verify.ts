/**
 * `verify_reconstruction`: build and serve the generated project, render
 * every base state of every page the project's manifest lists at its
 * viewport and route (pages the generator left out are reported, not
 * compared), compare it with the original capture (pixels, geometry,
 * computed styles, assets, responsive visibility), replay the recorded
 * transitions (clicks, hovers, keys, fills, submits and same-origin
 * navigations, reaching derived states through the chain of transitions
 * that produced them, as the generated tests do) and compare what they changed,
 * optionally run the generated Playwright behavior tests against the same
 * server, then write the DiffReport. Deterministic and agent-free: every
 * comparison that could not be made is reported as a limitation or an
 * unknown, never silently skipped.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Box, Transition, UiDnaDocument, UiNode, UiState } from '@rohzzn/uidna-schema';
import type { WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { openSession, pageKey } from '../application/scan.js';
import { serveStatic, type StaticServer } from '../application/static-server.js';
import type { ActionLocator, BrowserSession, UiAction } from '../browser/types.js';
import { BoxMatchSchema, type BehaviorComparison, type DiffReport, type Finding, type FindingCategory, type FindingSeverity, type VisualComparison } from '../contracts/diff-report.js';
import { isoNow } from '../domain/clock.js';
import { describeError, toError, uidnaError } from '../domain/errors.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import { clickExclusion, DEFAULT_DENY_NAMES, linkTarget, matchDenyName, type NavigationOptions, neverReplayed } from '../domain/safe-policy.js';
import { buildProject } from '../generate/build.js';
import { renderKindOf } from '../generate/model.js';
import { MANIFEST_FILE } from '../generate/project.js';
import { MAX_REPLAY_CHAIN, sideEffectCause, traceToBase } from '../generate/trace.js';
import { countFindings, diffAttempts, findComponentId, findTokenId, FindingCounter, findingKey } from './findings.js';
import { GENERATED_TESTS_FILE, GeneratedTestRunSchema, runGeneratedTests, type GeneratedTestResult, type GeneratedTestRun, type GeneratedTestsOutcome } from './generated-tests.js';
import { boxDrift, matchNodes, normalizeName, normalizeText, PATH_ATTRIBUTE, placeholderOf, type MatchResult } from './match.js';
import { generatedRoutesFromDocument, generatedRoutesFromManifest, isLiteralRoute, orderByPage, pageNotGenerated, pathnameOf, routeReached, type GeneratedRoutes } from './pages.js';
import { comparePixels, toPixelComparison, type PixelDiff } from './pixels.js';
import { compareDeltas, diffRoleTrees, type RoleTreeDelta } from './roles.js';
import { compareStyles, type StyleCategory } from './styles.js';

/** Input of `verifyReconstruction`. */
export interface VerifyInput {
  readonly ctx: WorkflowContext;
  readonly scan: ScanRecord;
  readonly dna: UiDnaDocument;
  /** The generated project directory. */
  readonly outDir: string;
  /** 1-based attempt number within the scan. */
  readonly attempt: number;
  /** The previous attempt's report, for regressions and resolved findings. */
  readonly previous: DiffReport | null;
  readonly thresholds: DiffReport['thresholds'];
  /** Run `npm run build` before serving `dist/`. */
  readonly build: boolean;
  readonly label: string | null;
  readonly evidenceId: string;
  /** Restrict the comparison to base states captured at these widths. */
  readonly viewportWidths?: readonly number[];
  /** Also run the generated Playwright behavior tests (`tests/behavior.spec.ts`) against the served build. Default false. */
  readonly runGeneratedTests?: boolean;
}

const InputSchema = z.object({
  outDir: z.string().min(1),
  attempt: z.number().int().min(1),
  thresholds: z.object({
    pixelRatioHigh: z.number().min(0).max(1),
    pixelRatioMedium: z.number().min(0).max(1),
    boxDriftPx: z.number().min(0),
    colorDistance: z.number().min(0),
  }),
  build: z.boolean(),
  label: z.string().nullable(),
  evidenceId: z.string().min(1),
  viewportWidths: z.array(z.number().int().positive()).optional(),
  runGeneratedTests: z.boolean().optional(),
});

/** Maximum captured page height, the same as `scan_interface` uses so screenshots are comparable. */
const MAX_CAPTURE_HEIGHT = 4000;
/** Node paths are digits and slashes only; anything else never reaches a selector. */
const NODE_PATH_PATTERN = /^(\d+(\/\d+)*)?$/;
/** Tags that may appear in a text selector. */
const TAG_PATTERN = /^[a-z][a-z0-9-]*$/;
/** How many role tree entries a message lists before summarizing the rest. */
const MAX_LISTED_ENTRIES = 12;
/** Ids that may name artifact files under the attempt directory (`<id>.generated.png`, …); anything else never reaches the file system. */
const SAFE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The generated behavior tests and the verifier reach derived states through the same tracer (`src/generate/trace.ts`). */
export { MAX_REPLAY_CHAIN, traceToBase };

const posix = (path: string): string => path.split(sep).join('/');

/** Shared state of one verification run. */
interface Run {
  readonly ctx: WorkflowContext;
  readonly scan: ScanRecord;
  readonly dna: UiDnaDocument;
  readonly session: BrowserSession;
  readonly server: StaticServer;
  readonly attemptDir: string;
  readonly thresholds: DiffReport['thresholds'];
  readonly counter: FindingCounter;
  readonly limitations: string[];
  readonly unknowns: string[];
  readonly artifacts: string[];
  readonly statesById: ReadonlyMap<string, UiState>;
  /** The pages the generated app renders and their routes (from the generated project's manifest; see `readGeneratedRoutes`). */
  readonly routes: GeneratedRoutes;
}

/** What one base state comparison produced, kept for the cross-viewport pass. */
interface StateOutcome {
  readonly state: UiState;
  readonly comparison: VisualComparison;
  readonly match: MatchResult | null;
  readonly evidence: readonly string[];
}

/** Fields of a finding that vary per call. */
interface FindingDraft {
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly stateId: string;
  readonly viewport: UiState['viewport'];
  readonly property: string;
  readonly node: UiNode | null;
  readonly tokenId?: string | null;
  readonly transitionId?: string | null;
  readonly original: string | number | null;
  readonly generated: string | number | null;
  readonly delta: number | null;
  readonly message: string;
  readonly evidence: readonly string[];
}

function makeFinding(run: Run, draft: FindingDraft): Finding {
  const node = draft.node;
  const partial = {
    category: draft.category,
    stateId: draft.stateId,
    nodePath: node === null ? null : node.path,
    transitionId: draft.transitionId ?? null,
    property: draft.property,
  };
  return {
    id: run.counter.next(),
    category: draft.category,
    severity: draft.severity,
    stateId: draft.stateId,
    viewport: { ...draft.viewport },
    property: draft.property,
    nodeId: node === null ? null : node.id,
    nodePath: node === null ? null : node.path,
    role: node === null ? null : node.role,
    name: node === null ? null : node.name,
    componentId: node === null ? null : findComponentId(run.dna, draft.stateId, node),
    tokenId: draft.tokenId ?? null,
    transitionId: draft.transitionId ?? null,
    original: draft.original,
    generated: draft.generated,
    delta: draft.delta,
    message: draft.message,
    evidence: [...draft.evidence],
    key: findingKey(partial),
  };
}

function describeNode(node: UiNode): string {
  const role = node.role === null ? '' : ` role=${node.role}`;
  const name = node.name === null ? '' : ` "${node.name}"`;
  return `<${node.tag}>${role}${name} at ${node.path === '' ? '(body)' : node.path}`;
}

function describeBox(box: Box): string {
  return `x=${box.x} y=${box.y} w=${box.width} h=${box.height}`;
}

function listEntries(entries: readonly string[]): string {
  if (entries.length === 0) return 'none';
  const shown = entries.slice(0, MAX_LISTED_ENTRIES);
  const rest = entries.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` … and ${rest} more` : '');
}

/**
 * URL of the generated app for an original state URL: the served root with
 * the page's route when one is given (the crawled path such as
 * `/features.html`, which the generated app registers and the static server
 * answers with `index.html`), else the original path when it is
 * extension-less, plus the original query and hash.
 */
export function generatedUrl(serverUrl: string, originalUrl: string, route: string | null = null): string {
  const literal = route !== null && isLiteralRoute(route) ? route : null;
  try {
    const original = new URL(originalUrl);
    const pathname = literal ?? (extname(original.pathname) === '' ? original.pathname : '/');
    return new URL(`${pathname}${original.search}${original.hash}`, serverUrl).toString();
  } catch {
    if (literal === null) return serverUrl;
    try {
      return new URL(literal, serverUrl).toString();
    } catch {
      return serverUrl;
    }
  }
}

/** Own text of every descendant of `node` in document order, joined by spaces; null when there is none (the safe policy's denied-name input). */
function subtreeTextOf(node: UiNode, byId: ReadonlyMap<string, UiNode>): string | null {
  const parts: string[] = [];
  const queue: string[] = [...node.childIds];
  const seen = new Set<string>([node.id]);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const child = byId.get(id);
    if (child === undefined) continue;
    if (child.text !== null) parts.push(child.text);
    queue.push(...child.childIds);
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/** Path, query and hash of a URL. The served origin carries a per-run port, so it never appears in a report. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/** Escape a string for a double-quoted Playwright CSS pseudo-class argument. */
function quoteSelectorText(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ')}"`;
}

/** `[data-uidna-path="…"]` for a node path, or null when the path is not digits and slashes. */
export function pathSelector(path: string): string | null {
  return NODE_PATH_PATTERN.test(path) ? `[${PATH_ATTRIBUTE}="${path}"]` : null;
}

/** `tag:text-is("…")` for a tag and own text, or null when either is unusable. */
export function textSelector(tag: string, text: string | null): string | null {
  const lower = tag.toLowerCase();
  const normalized = normalizeText(text);
  if (!TAG_PATTERN.test(lower) || normalized.length === 0) return null;
  return `${lower}:text-is(${quoteSelectorText(normalized)})`;
}

function severityForRatio(ratio: number, thresholds: DiffReport['thresholds']): FindingSeverity | null {
  if (ratio > thresholds.pixelRatioHigh) return 'high';
  if (ratio > thresholds.pixelRatioMedium) return 'medium';
  return null;
}

function styleSeverity(category: StyleCategory): FindingSeverity {
  return category === 'layout' ? 'low' : 'medium';
}

/* ------------------------------------------------------------ navigation */

/** Load the generated app for `state` (its page's route) at its viewport in a fresh document. Returns the limitations hit, or the reason it failed. */
async function loadState(run: Run, state: UiState, limitations: string[]): Promise<Result<void>> {
  const { session } = run;
  const resized = await session.setViewport(state.viewport);
  if (!resized.ok) return err(toError(resized.error, 'verify', `viewport ${state.viewport.width}×${state.viewport.height}`));
  // A fresh document for every load: same-URL navigations that differ only by hash would keep the previous page state.
  const blanked = await session.navigate('about:blank', { waitUntil: 'load', timeoutMs: 10_000 });
  if (!blanked.ok) limitations.push(`the previous document could not be unloaded before the load (${describeError(blanked.error)}); page state may carry over`);
  // A page the generator left out has no route of its own: loading the original path would render another page.
  if (pageNotGenerated(run.routes, state.pageId)) return err(uidnaError('verify', `page ${state.pageId} of state ${state.id} was not generated (${MANIFEST_FILE} does not list it)`));
  const route = run.routes.routeByPageId.get(state.pageId) ?? null;
  if (route === null) limitations.push(`page ${state.pageId} of state ${state.id} is not listed in the document; the generated app was loaded at the original path instead of a registered route`);
  const navigated = await session.navigate(generatedUrl(run.server.url, state.url, route), { waitUntil: 'load', timeoutMs: 30_000 });
  if (!navigated.ok) return err(toError(navigated.error, 'verify', 'load generated app'));
  if (navigated.value.status !== null && navigated.value.status >= 400) limitations.push(`the generated app responded with HTTP ${navigated.value.status}`);
  const stabilized = await session.stabilize();
  if (!stabilized.ok) limitations.push(`could not freeze animations in the generated app (${describeError(stabilized.error)})`);
  const stable = await session.waitForStability({ timeoutMs: 8_000 });
  if (stable.ok && !stable.value.stable) limitations.push(`the generated page kept changing for ${stable.value.waitedMs}ms before capture`);
  return ok(undefined);
}

/**
 * The pages the generated project renders and their routes, from the
 * manifest the generator wrote (`uidna.generated.json`): the generator drops
 * a page whose route pattern another page took and, with router "none",
 * every page but the first, so only the manifest knows. Without a readable
 * manifest, or with one generated from another scan than `scanId` (its page
 * ids may name other pages, see `generatedRoutesFromManifest`), the routes
 * are derived from the document (`pageRoute`) and a limitation says so.
 */
/** The scan a manifest was generated from when it is not `scanId`; null when it names `scanId` or no scan. */
function foreignScanOf(manifest: unknown, scanId: string): string | null {
  if (typeof manifest !== 'object' || manifest === null || !('scanId' in manifest)) return null;
  const named = manifest.scanId;
  return typeof named === 'string' && named !== scanId ? named : null;
}

/** Routes the generated app renders, and the other scan its manifest names, if any (see `readGeneratedRoutes`). */
interface GeneratedProject {
  readonly routes: GeneratedRoutes;
  /** The scan the project was generated from when it is not the scan being verified. */
  readonly foreignScanId: string | null;
}

async function readGeneratedRoutes(outDir: string, dna: UiDnaDocument, scanId: string, limitations: string[]): Promise<GeneratedProject> {
  const path = join(outDir, MANIFEST_FILE);
  const fallback = 'page routes were derived from the document, so a page the generator left out (router "none", or a route pattern another page took) may be compared at a route that renders another page';
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const missing = typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
    limitations.push(`${MANIFEST_FILE} of the generated project ${missing ? 'is missing' : `could not be read (${toError(cause, 'io').message})`}; ${fallback}`);
    return { routes: generatedRoutesFromDocument(dna), foreignScanId: null };
  }
  const json = tryCatch(
    (): unknown => JSON.parse(text),
    (cause) => toError(cause, 'validation', `${MANIFEST_FILE} is not JSON`),
  );
  const routes = json.ok ? generatedRoutesFromManifest(json.value, scanId) : json;
  const foreignScanId = json.ok ? foreignScanOf(json.value, scanId) : null;
  if (!routes.ok) {
    limitations.push(`${MANIFEST_FILE} of the generated project could not be used (${routes.error.message}); ${fallback}`);
    return { routes: generatedRoutesFromDocument(dna), foreignScanId };
  }
  return { routes: routes.value, foreignScanId };
}

/* ---------------------------------------------------------------- pixels */

interface PixelOutcome {
  readonly diff: PixelDiff;
  readonly diffPath: string | null;
}

/** Compare an original screenshot (scan-relative path) with a generated one (absolute path); writes the diff next to it. */
async function pixelsOf(run: Run, originalRelative: string, generatedAbsolute: string, diffAbsolute: string, limitations: string[]): Promise<PixelOutcome | null> {
  const original = await run.ctx.store.readBinary(run.scan.scanId, originalRelative);
  if (!original.ok) {
    limitations.push(`original screenshot ${originalRelative} could not be read (${describeError(original.error)}); pixels were not compared`);
    return null;
  }
  let generated: Buffer;
  try {
    generated = await readFile(generatedAbsolute);
  } catch (cause) {
    limitations.push(`generated screenshot could not be read (${toError(cause, 'io').message}); pixels were not compared`);
    return null;
  }
  const compared = comparePixels(original.value, generated);
  if (!compared.ok) {
    limitations.push(`pixels were not compared: ${compared.error.message}`);
    return null;
  }
  let diffPath: string | null = null;
  if (compared.value.diffImage !== null) {
    try {
      await writeFile(diffAbsolute, compared.value.diffImage);
      diffPath = run.ctx.store.relativePath(run.scan.scanId, diffAbsolute);
      run.artifacts.push(diffPath);
    } catch (cause) {
      limitations.push(`diff image could not be written (${toError(cause, 'io').message})`);
    }
  }
  if (compared.value.ssim === null && compared.value.ssimReason !== null) limitations.push(`SSIM not computed: ${compared.value.ssimReason}`);
  return { diff: compared.value, diffPath };
}

/* ------------------------------------------------------------ base states */

function emptyComparison(state: UiState, limitations: string[]): VisualComparison {
  return {
    stateId: state.id,
    viewport: { ...state.viewport },
    originalScreenshot: state.screenshot?.path ?? '',
    generatedScreenshot: null,
    pixels: null,
    geometry: { comparedNodes: 0, matchedNodes: 0, missingNodes: 0, extraNodes: 0, maxDriftPx: 0 },
    styles: { comparedProperties: 0, differingProperties: 0 },
    findings: [],
    limitations,
  };
}

async function compareState(run: Run, state: UiState): Promise<StateOutcome> {
  const { ctx, scan, dna, session, attemptDir, thresholds } = run;
  const limitations: string[] = [];
  const comparison = emptyComparison(state, limitations);
  const failed = (reason: string): StateOutcome => {
    limitations.push(reason);
    return { state, comparison, match: null, evidence: [] };
  };

  if (!SAFE_FILE_STEM.test(state.id)) return failed(`state id "${state.id}" is not a safe artifact file name; nothing was compared`);
  const original = await ctx.store.loadCapture(scan.scanId, state.id);
  if (!original.ok) return failed(`original capture could not be loaded (${describeError(original.error)}); nothing was compared`);
  if (state.screenshot === null) limitations.push('the original state has no screenshot; pixels were not compared');
  else if (state.screenshot.truncated) limitations.push(`the original screenshot was clipped at ${state.screenshot.height}px (document ${state.document.height}px); pixels below it were not compared`);

  const loaded = await loadState(run, state, limitations);
  if (!loaded.ok) return failed(`${loaded.error.message}; nothing was compared`);

  const generatedPath = join(attemptDir, `${state.id}.generated.png`);
  const captured = await session.capture({ screenshotPath: generatedPath, maxHeight: MAX_CAPTURE_HEIGHT });
  if (!captured.ok) return failed(`the generated app could not be captured (${describeError(captured.error)}); nothing was compared`);
  const generated = captured.value;
  const generatedRelative = ctx.store.relativePath(scan.scanId, generatedPath);
  comparison.generatedScreenshot = generatedRelative;
  run.artifacts.push(generatedRelative);
  for (const limitation of generated.limitations) limitations.push(`generated capture: ${limitation}`);

  const evidence: string[] = [];
  if (state.screenshot !== null) evidence.push(state.screenshot.path);
  evidence.push(generatedRelative);

  // Pixels.
  if (state.screenshot !== null && generated.screenshot !== null) {
    const pixels = await pixelsOf(run, state.screenshot.path, generatedPath, join(attemptDir, `${state.id}.diff.png`), limitations);
    if (pixels !== null) {
      if (pixels.diffPath !== null) evidence.push(pixels.diffPath);
      comparison.pixels = toPixelComparison(pixels.diff, pixels.diffPath);
      evidence.push(`states/${state.id}/capture.json`);
      const { diff } = pixels;
      if (diff.diffRatio === null) {
        limitations.push('the screenshots have no overlapping region; the pixel ratio is unknown');
      } else {
        const severity = severityForRatio(diff.diffRatio, thresholds);
        if (severity !== null) {
          comparison.findings.push(
            makeFinding(run, {
              category: 'layout',
              severity,
              stateId: state.id,
              viewport: state.viewport,
              property: 'pixels',
              node: null,
              original: null,
              generated: Math.round(diff.diffRatio * 1_000_000) / 1_000_000,
              delta: Math.round(diff.diffRatio * 1_000_000) / 1_000_000,
              message: `${(diff.diffRatio * 100).toFixed(2)}% of the ${diff.comparedPixels} compared pixels differ (${diff.width}×${diff.height} overlap${diff.ssim === null ? '' : `, SSIM ${diff.ssim.toFixed(4)}`})`,
              evidence,
            }),
          );
        }
      }
      if (diff.sizeMismatch) {
        limitations.push(`the screenshots differ in size (original ${diff.original.width}×${diff.original.height}, generated ${diff.generated.width}×${diff.generated.height}); pixels were compared on the ${diff.width}×${diff.height} overlap`);
      }
    }
  } else if (generated.screenshot === null) {
    limitations.push('no generated screenshot; pixels were not compared');
  }
  if (!evidence.includes(`states/${state.id}/capture.json`)) evidence.push(`states/${state.id}/capture.json`);

  // Document size, from the captured document metrics: screenshots are clipped at MAX_CAPTURE_HEIGHT, so their sizes
  // would hide a height difference between two tall pages.
  for (const axis of ['height', 'width'] as const) {
    const a = state.document[axis];
    const b = generated.document[axis];
    const delta = b - a;
    if (Math.abs(delta) <= thresholds.boxDriftPx) continue;
    comparison.findings.push(
      makeFinding(run, {
        category: 'layout',
        severity: Math.abs(delta) > thresholds.boxDriftPx * 10 ? 'high' : 'medium',
        stateId: state.id,
        viewport: state.viewport,
        property: `document.${axis}`,
        node: null,
        original: a,
        generated: b,
        delta,
        message: `the generated document is ${b}px ${axis === 'height' ? 'tall' : 'wide'}, the original ${a}px (difference ${delta}px)`,
        evidence,
      }),
    );
  }

  // Geometry. `missingNodes` counts only truly-absent subtree roots; roots whose counterpart exists but is
  // hidden are reported as responsive findings in the cross-viewport pass, not as missing geometry.
  const match = matchNodes(original.value, generated);
  const hiddenRootIds = new Set(match.hiddenInGenerated.map((pair) => pair.original.id));
  const absentRoots = match.missing.filter((root) => !hiddenRootIds.has(root.id));
  comparison.geometry = {
    comparedNodes: match.comparedNodes,
    matchedNodes: match.matches.length,
    missingNodes: absentRoots.length,
    extraNodes: match.extra.length,
    maxDriftPx: match.maxDriftPx,
  };
  if (!match.pathAttribute) {
    limitations.push(
      'the generated capture carries no data-uidna-path attributes (the capture attribute allowlist keeps only state-marker data-* attributes); nodes were matched by the structural path the generator produces, checked against the rendered tag, then by role, name and position, then by tag and text',
    );
  }

  // Styles, box drift and placeholders over matched nodes.
  let comparedProperties = 0;
  let differingProperties = 0;
  let stylesMissing = 0;
  for (const pair of match.matches) {
    const originalStyle = original.value.styles[pair.original.styleId];
    const generatedStyle = generated.styles[pair.generated.styleId];
    // A node whose style object is absent from its state's table is not compared: reading UA defaults for it would count assumed values.
    const styles = originalStyle === undefined || generatedStyle === undefined ? null : compareStyles(originalStyle, generatedStyle, thresholds);
    if (styles === null) stylesMissing += 1;
    comparedProperties += styles?.compared ?? 0;
    differingProperties += styles?.differences.length ?? 0;
    for (const difference of styles?.differences ?? []) {
      comparison.findings.push(
        makeFinding(run, {
          category: difference.category,
          severity: styleSeverity(difference.category),
          stateId: state.id,
          viewport: state.viewport,
          property: difference.property,
          node: pair.original,
          tokenId: findTokenId(dna, difference.property, difference.original),
          original: difference.original,
          generated: difference.generated,
          delta: difference.delta,
          message: `${difference.property} is ${difference.generated} in the generated app, ${difference.original} in the original${difference.delta === null ? '' : ` (${difference.category === 'color' ? 'RGB distance' : 'difference'} ${difference.delta})`} on ${describeNode(pair.original)}`,
          evidence,
        }),
      );
    }
    if (pair.original.box !== null && pair.generated.box !== null) {
      const drift = Math.round(boxDrift(pair.original.box, pair.generated.box) * 1000) / 1000;
      if (drift > thresholds.boxDriftPx) {
        comparison.findings.push(
          makeFinding(run, {
            category: 'layout',
            severity: drift > thresholds.boxDriftPx * 10 ? 'high' : 'medium',
            stateId: state.id,
            viewport: state.viewport,
            property: 'box',
            node: pair.original,
            original: describeBox(pair.original.box),
            generated: describeBox(pair.generated.box),
            delta: drift,
            message: `box drifts by ${drift}px on ${describeNode(pair.original)}: original ${describeBox(pair.original.box)}, generated ${describeBox(pair.generated.box)}`,
            evidence,
          }),
        );
      }
    }
    // Any matched node the generator rendered as a labeled placeholder (images, svg, video, iframe, canvas, …).
    const placeholder = placeholderOf(pair.generated);
    if (placeholder !== null) {
      const tag = pair.original.tag.toLowerCase();
      comparison.findings.push(
        makeFinding(run, {
          category: 'asset',
          severity: 'low',
          stateId: state.id,
          viewport: state.viewport,
          property: 'asset',
          node: pair.original,
          original: pair.original.attrs.src ?? `inline <${tag}>`,
          generated: `placeholder for asset ${placeholder.assetId}`,
          delta: null,
          message: `${describeNode(pair.original)} is rendered as a labeled placeholder for asset ${placeholder.assetId} (authorize the asset with annotate_dna to reproduce it)`,
          evidence,
        }),
      );
    }
  }
  comparison.styles = { comparedProperties, differingProperties };
  if (stylesMissing > 0) limitations.push(`${stylesMissing} matched node(s) have no style object in a capture's style table; their styles were not compared`);

  // Box matches for the HTML overlays.
  const boxes: { nodeId: string; original: Box; generated: Box | null }[] = [];
  for (const pair of match.matches) {
    if (pair.original.box !== null) boxes.push({ nodeId: pair.original.id, original: pair.original.box, generated: pair.generated.box });
  }
  for (const node of match.unmatched) {
    if (node.box !== null) boxes.push({ nodeId: node.id, original: node.box, generated: null });
  }
  const boxesRelative = ctx.store.relativePath(scan.scanId, join(attemptDir, `${state.id}.boxes.json`));
  const wrote = await ctx.store.writeJson(scan.scanId, boxesRelative, z.array(BoxMatchSchema), boxes);
  if (wrote.ok) run.artifacts.push(boxesRelative);
  else limitations.push(`box matches were not written (${describeError(wrote.error)})`);

  return { state, comparison, match, evidence };
}

/** Second pass over all states: missing subtrees become `missing` or `responsive` findings, hidden/visible mismatches `responsive`, extra nodes `layout`. */
function crossViewportFindings(run: Run, outcomes: readonly StateOutcome[]): void {
  for (const outcome of outcomes) {
    const { match, state, comparison, evidence } = outcome;
    if (match === null) continue;
    // A node matched in another state of the same page is a responsive difference; other pages share nothing by path.
    const matchedElsewhere = (path: string): string | null => {
      for (const other of outcomes) {
        if (other === outcome || other.match === null || other.state.pageId !== state.pageId) continue;
        if (other.match.matches.some((pair) => pair.original.path === path)) return other.state.id;
      }
      return null;
    };
    for (const root of match.missing) {
      const hidden = match.hiddenInGenerated.find((pair) => pair.original.id === root.id);
      const elsewhere = matchedElsewhere(root.path);
      if (hidden !== undefined || elsewhere !== null) {
        comparison.findings.push(
          makeFinding(run, {
            category: 'responsive',
            severity: 'medium',
            stateId: state.id,
            viewport: state.viewport,
            property: 'visibility',
            node: root,
            original: 'visible',
            generated: hidden !== undefined ? 'hidden' : 'missing',
            delta: null,
            message: `${describeNode(root)} is visible in the original at ${state.viewport.width}px but ${hidden !== undefined ? 'hidden' : 'absent'} in the generated app${elsewhere === null ? '' : ` (matched in ${elsewhere})`}`,
            evidence,
          }),
        );
      } else {
        comparison.findings.push(
          makeFinding(run, {
            category: 'missing',
            severity: 'high',
            stateId: state.id,
            viewport: state.viewport,
            property: 'node',
            node: root,
            original: describeNode(root),
            generated: null,
            delta: null,
            message: `${describeNode(root)} has no counterpart in the generated app (subtree root; descendants are not listed separately)`,
            evidence,
          }),
        );
      }
    }
    for (const pair of match.hiddenInOriginal) {
      comparison.findings.push(
        makeFinding(run, {
          category: 'responsive',
          severity: 'medium',
          stateId: state.id,
          viewport: state.viewport,
          property: 'visibility',
          node: pair.original,
          original: 'hidden',
          generated: 'visible',
          delta: null,
          message: `${describeNode(pair.original)} is hidden in the original at ${state.viewport.width}px but visible in the generated app`,
          evidence,
        }),
      );
    }
    for (const node of match.extra) {
      comparison.findings.push({
        ...makeFinding(run, {
          category: 'layout',
          severity: 'low',
          stateId: state.id,
          viewport: state.viewport,
          property: `extra-node:${node.path}`,
          node: null,
          original: null,
          generated: describeNode(node),
          delta: null,
          message: `generated ${describeNode(node)} has no counterpart in the original`,
          evidence,
        }),
        role: node.role,
        name: node.name,
      });
    }
  }
}

/* ------------------------------------------------------------ transitions */

interface Located {
  readonly label: string;
  readonly locator: ActionLocator;
}

/** What one attempt to act on a located target produced, as far as choosing among locators is concerned. */
export interface LocatorAttempt {
  readonly performed: boolean;
  readonly reason: string | null;
  /** Redacted URLs of the non-GET requests the action triggered and the session blocked (fill and submit actions). */
  readonly blockedRequests: readonly string[];
}

interface ReplayAttempt extends LocatorAttempt {
  readonly navigated: boolean;
  /** URL of the generated app after the action. */
  readonly url: string;
  /** The locator that acted on the target (`actedOn`); null when nothing was acted on or the action had no target. */
  readonly used: Located | null;
}

/**
 * True when the browser acted on the target: the action was performed, or it
 * made the page attempt a request UI DNA blocked. A native form submission is
 * blocked as a document navigation and reported as not performed, with the
 * request in `blockedRequests`: the target was found and acted on all the same.
 */
export function actedOn(attempt: Pick<LocatorAttempt, 'performed' | 'blockedRequests'>): boolean {
  return attempt.performed || attempt.blockedRequests.length > 0;
}

/**
 * Try `act` with each locator in order and stop at the first attempt that
 * acted on the target (`actedOn`): a later locator would repeat the action,
 * and an action that tried to send a request is never repeated. Returns that
 * attempt, or null with the reason of every locator tried.
 */
export async function tryLocators<L extends { readonly label: string }, A extends LocatorAttempt>(locators: readonly L[], act: (located: L) => Promise<A>): Promise<{ readonly attempt: A | null; readonly reasons: readonly string[] }> {
  const reasons: string[] = [];
  for (const located of locators) {
    const attempt = await act(located);
    if (actedOn(attempt)) return { attempt, reasons };
    reasons.push(`${located.label}: ${attempt.reason ?? 'not performed'}`);
  }
  return { attempt: null, reasons };
}

/** How a transition is replayed. */
interface ReplayOptions {
  /** The recorded action led to another crawled page: a click may follow one same-origin navigation. */
  readonly navigation: boolean;
}

/** Freeze animations again in the document a replayed action navigated to (the injected style is per document); a failure is a limitation of the capture that follows. */
async function restabilize(run: Run, transitionId: string, what: string): Promise<void> {
  const stabilized = await run.session.stabilize();
  if (!stabilized.ok) run.limitations.push(`transition ${transitionId}: could not freeze animations in the document ${what} navigated to (${describeError(stabilized.error)}); the capture after it may be mid-animation`);
}

/** The deny phrase (safe policy) found on a node's name or text, or null. */
function deniedName(node: UiNode, subtreeText: string | null): string | null {
  return (
    matchDenyName(node.name, DEFAULT_DENY_NAMES) ??
    matchDenyName(node.text, DEFAULT_DENY_NAMES) ??
    matchDenyName(node.attrs['aria-label'], DEFAULT_DENY_NAMES) ??
    matchDenyName(node.attrs.title, DEFAULT_DENY_NAMES) ??
    matchDenyName(subtreeText, DEFAULT_DENY_NAMES)
  );
}

/**
 * Why the safe policy would not follow a recorded navigation through `node`
 * from `fromState`, or null when it would: the node must be a link outside
 * any form whose href resolves (against the page URL, as the explorer
 * resolved it) to another crawled page of the same origin, and carry no
 * denied name. Decided from the recorded node, never from the document's
 * `navigation` field alone, so an edited document cannot make the verifier
 * click a submit control or follow a link the explorer refused.
 */
export function navigationExclusion(dna: Pick<UiDnaDocument, 'app'>, fromState: Pick<UiState, 'url' | 'pageId'>, node: UiNode, subtreeText: string | null): string | null {
  if (node.inForm) return 'inside a form';
  const tag = node.tag.toLowerCase();
  const href = node.attrs.href;
  if (tag !== 'a' || href === undefined) return `<${tag}> is not a link with an href (a navigation is replayed only through the link the original followed)`;
  if (href.trim().startsWith('#')) return 'fragment link: scroll only';
  const navigation: NavigationOptions = {
    pageUrl: fromState.url,
    pageId: fromState.pageId,
    pagesByKey: new Map(dna.app.pages.map((page) => [pageKey(page.url), page.id] as const)),
    keyOf: pageKey,
  };
  const link = linkTarget(node, navigation, DEFAULT_DENY_NAMES, subtreeText);
  if (link === null) return `<${tag}> is not a link the safe policy can resolve`;
  return link.kind === 'navigate' ? null : link.reason;
}

/**
 * Why the forms policy would not submit through `node`, or null when it
 * would: the target must be the `<form>` itself (denied names checked on its
 * name, aria-label and title) or a submit control without a denied name,
 * the only targets `classifyForms` ever chooses.
 */
export function submitExclusion(node: UiNode, subtreeText: string | null): string | null {
  const tag = node.tag.toLowerCase();
  if (tag === 'form') {
    const denied = matchDenyName(node.name, DEFAULT_DENY_NAMES) ?? matchDenyName(node.attrs['aria-label'], DEFAULT_DENY_NAMES) ?? matchDenyName(node.attrs.title, DEFAULT_DENY_NAMES);
    return denied === null ? null : `denied name: ${denied}`;
  }
  const type = node.attrs.type?.trim().toLowerCase();
  const isSubmitControl = (tag === 'button' && type !== 'button' && type !== 'reset') || (tag === 'input' && (type === 'submit' || type === 'image'));
  if (!isSubmitControl) return `<${tag}> is neither a form nor a submit control (the forms policy submits only through those)`;
  const denied = deniedName(node, subtreeText);
  return denied === null ? null : `denied name: ${denied}`;
}

/**
 * Locate the transition's target in the generated app and perform its action.
 * Strategies in order: role, accessible name and position (the locator the
 * report describes), the same with the normalized name, the generator's
 * `data-uidna-path` attribute, then rendered tag and own text; the first
 * that acts on the target ends the search, also when the action only made
 * the page attempt a request the session blocked (`tryLocators`). A click is
 * refused when the safe policy would not allow it on the recorded target;
 * for a navigation transition the link is clicked (the navigation is the
 * point) only when the safe policy would follow it (`navigationExclusion`),
 * and the click may follow one same-origin navigation. A submit is refused
 * when the forms policy would not submit through the recorded target
 * (`submitExclusion`).
 */
async function performTransition(run: Run, transition: Transition, fromState: UiState, options: ReplayOptions = { navigation: false }): Promise<ReplayAttempt> {
  const { session } = run;
  const { action } = transition;
  const target = action.target;
  const refused = (reason: string): ReplayAttempt => ({ performed: false, reason, navigated: false, url: session.currentUrl(), blockedRequests: [], used: null });
  const act = async (located: Located | null): Promise<ReplayAttempt> => {
    let uiAction: UiAction;
    if (action.type === 'key') {
      if (action.key === undefined) return refused('the recorded key action has no key');
      uiAction = located === null ? { kind: 'key', key: action.key } : { kind: 'key', key: action.key, target: located.locator };
    } else {
      if (located === null) return refused('the recorded action has no target');
      if (action.type === 'fill') uiAction = { kind: 'fill', target: located.locator, value: action.value ?? '' };
      else if (action.type === 'submit') uiAction = { kind: 'submit', target: located.locator };
      else if (action.type === 'click' && options.navigation) uiAction = { kind: 'click', target: located.locator, allowNavigation: 'same-origin' };
      else uiAction = { kind: action.type, target: located.locator };
    }
    const outcome = await session.act(uiAction);
    if (!outcome.ok) return refused(describeError(outcome.error));
    const attempt = { performed: outcome.value.performed, reason: outcome.value.reason ?? null, blockedRequests: outcome.value.blockedRequests ?? [] };
    return { ...attempt, navigated: outcome.value.navigated, url: outcome.value.url, used: actedOn(attempt) ? located : null };
  };
  if (target === null) return act(null);

  const originalNode = fromState.nodes.find((node) => node.id === target.nodeId) ?? fromState.nodes.find((node) => node.path === target.nodePath);
  if (action.type === 'click' || action.type === 'submit') {
    // The policies decide clicks and submits from the recorded node (forms, links, submit controls, denied names); a target they cannot check is not acted on.
    if (originalNode === undefined) return refused(`target node ${target.nodeId} is not in state ${fromState.id}, so the ${action.type === 'submit' ? 'forms' : 'safe'} policy could not be checked; the ${action.type} was not replayed`);
    const byId = new Map(fromState.nodes.map((node) => [node.id, node] as const));
    const subtree = subtreeTextOf(originalNode, byId);
    if (action.type === 'submit') {
      const exclusion = submitExclusion(originalNode, subtree);
      if (exclusion !== null) return refused(`the forms policy does not submit through this target (${exclusion}); the submit was not replayed`);
    } else if (options.navigation) {
      const exclusion = navigationExclusion(run.dna, fromState, originalNode, subtree);
      if (exclusion !== null) return refused(`the safe policy does not follow this link (${exclusion}); the navigation was not replayed`);
    } else {
      const exclusion = clickExclusion(originalNode, DEFAULT_DENY_NAMES, subtree);
      if (exclusion !== null) return refused(`the safe policy does not click this target (${exclusion}); the click was not replayed`);
    }
  }
  const locators: Located[] = [];
  if (target.role !== null) {
    const raw = target.name;
    const normalized = normalizeName(raw);
    locators.push({ label: `role ${target.role}${raw === null ? '' : ` "${raw}"`} #${target.nth}`, locator: { role: target.role, nth: target.nth, ...(raw === null ? {} : { name: raw }) } });
    if (raw !== null && normalized !== raw) locators.push({ label: `role ${target.role} "${normalized}" #${target.nth}`, locator: { role: target.role, name: normalized, nth: target.nth } });
  }
  const selector = pathSelector(target.nodePath);
  if (selector !== null) locators.push({ label: `selector ${selector}`, locator: { selector } });
  else run.unknowns.push(`transition ${transition.id}: target path "${target.nodePath}" is not digits and slashes; no attribute selector was built from it`);
  const byText = textSelector(originalNode === undefined ? target.tag : renderKindOf(originalNode).renderedTag, originalNode?.text ?? null);
  if (byText !== null) locators.push({ label: `selector ${byText}`, locator: { selector: byText } });
  if (locators.length === 0) return refused('no locator could be built for the target (no path, role or text)');

  // A submission the session blocked stops the search: the next locator would submit again.
  const tried = await tryLocators(locators, act);
  return tried.attempt ?? refused(tried.reasons.join('; '));
}

/** The role tree entry states of the target node that a transition changed in the original. */
function targetStateChange(fromState: UiState, toState: UiState, target: NonNullable<Transition['action']['target']>): { readonly property: string; readonly from: string; readonly to: string }[] {
  const before = fromState.nodes.find((node) => node.id === target.nodeId) ?? fromState.nodes.find((node) => node.path === target.nodePath);
  const after = toState.nodes.find((node) => node.path === target.nodePath);
  if (before === undefined || after === undefined) return [];
  const changes: { property: string; from: string; to: string }[] = [];
  const expandedBefore = before.a11y.expanded === undefined ? 'unset' : String(before.a11y.expanded);
  const expandedAfter = after.a11y.expanded === undefined ? 'unset' : String(after.a11y.expanded);
  if (expandedBefore !== expandedAfter) changes.push({ property: 'a11y.expanded', from: expandedBefore, to: expandedAfter });
  for (const attribute of ['open', 'aria-expanded']) {
    const a = before.attrs[attribute] ?? 'absent';
    const b = after.attrs[attribute] ?? 'absent';
    if (a !== b) changes.push({ property: `attrs.${attribute}`, from: a, to: b });
  }
  return changes;
}

function readTargetState(node: UiNode | undefined, property: string): string {
  if (node === undefined) return 'absent';
  if (property === 'a11y.expanded') return node.a11y.expanded === undefined ? 'unset' : String(node.a11y.expanded);
  return node.attrs[property.slice('attrs.'.length)] ?? 'absent';
}

export { neverReplayed };

/**
 * Replay one transition against the generated app and compare what it
 * changed. Returns null, after recording an unknown, when the transition is
 * never replayed (it caused side effects when it was observed) or cannot be
 * described at all (neither of its states is in the document and it records
 * no viewport to report under).
 */
async function replayTransition(run: Run, transition: Transition): Promise<BehaviorComparison | null> {
  const { ctx, scan, dna, session, attemptDir, statesById } = run;
  const fromState = statesById.get(transition.from);
  const toState = statesById.get(transition.to);
  const target = transition.action.target;
  const navigation = transition.navigation ?? null;
  // A transition that caused a non-GET request is never repeated. A recorded same-origin navigation (a crawled
  // page) is replayed as such; one that also sent a non-GET request is not.
  if (neverReplayed(transition)) {
    run.unknowns.push(
      `transition ${transition.id}: not replayed because it caused side effects when it was observed (${transition.network.nonGet} non-GET request(s)${navigation === null && transition.network.nonGet === 0 ? ', a navigation' : ''}); the reconstruction of this ${transition.action.type} is unverified`,
    );
    return null;
  }
  // The viewport the comparison is reported under: the from-state's, else the to-state's, else the one the transition recorded.
  const viewport = fromState?.viewport ?? toState?.viewport ?? transition.provenance.viewport;
  if (viewport === undefined) {
    run.unknowns.push(`transition ${transition.id}: not compared; neither state ${transition.from} nor ${transition.to} is in the document and the transition records no viewport`);
    return null;
  }
  // The locator the report describes (role, name, nth); replaced by the one that acted when a role locator succeeds.
  const locator = { role: target?.role ?? null, name: target === null ? null : normalizeName(target.name) || null, nth: target?.nth ?? 0 };
  const base: BehaviorComparison = {
    transitionId: transition.id,
    fromStateId: transition.from,
    toStateId: transition.to,
    viewport: { ...viewport },
    action: {
      type: transition.action.type,
      target: target === null ? null : { ...target },
      ...(transition.action.key === undefined ? {} : { key: transition.action.key }),
      ...(transition.action.value === undefined ? {} : { value: transition.action.value }),
    },
    locator,
    replayed: false,
    reason: null,
    roleTreeMatch: null,
    roleTreeDiff: { missing: [], extra: [] },
    pixels: null,
    generatedScreenshot: null,
    findings: [],
  };
  const skip = (reason: string, limitation: string): BehaviorComparison => {
    run.limitations.push(limitation);
    return { ...base, reason };
  };
  if (fromState === undefined || toState === undefined) {
    return skip('the transition references a state the document does not contain', `transition ${transition.id}: skipped, its from or to state is not in the document`);
  }
  if (!SAFE_FILE_STEM.test(transition.id)) {
    return skip('the transition id is not a safe artifact file name', `transition ${transition.id}: skipped, its id is not a safe artifact file name`);
  }
  // A page the generator left out has no route in the generated app: neither its states nor a navigation to it can be compared.
  if (pageNotGenerated(run.routes, fromState.pageId)) {
    return skip(`page ${fromState.pageId} of from-state ${fromState.id} was not generated`, `transition ${transition.id}: skipped, page ${fromState.pageId} of its from-state ${fromState.id} was not generated; not compared`);
  }
  if (navigation !== null && pageNotGenerated(run.routes, navigation.toPageId)) {
    return skip(`the action leads to page ${navigation.toPageId}, which was not generated`, `transition ${transition.id}: skipped, it navigates to page ${navigation.toPageId}, which was not generated; not compared`);
  }

  // Reach the from-state: a base state is loaded directly; a derived state is reached by replaying the chain of
  // transitions that produced it from its base state (bounded by MAX_REPLAY_CHAIN).
  const trace = traceToBase(dna.states.transitions, statesById, fromState);
  if (!trace.ok) {
    return skip(`from-state ${fromState.id} is unreachable: ${trace.reason}`, `transition ${transition.id}: skipped, from-state ${fromState.id} is unreachable (${trace.reason})`);
  }
  const limitations: string[] = [];
  const loaded = await loadState(run, trace.base, limitations);
  for (const limitation of limitations) run.limitations.push(`transition ${transition.id}: ${limitation}`);
  if (!loaded.ok) return skip(loaded.error.message, `transition ${transition.id}: skipped, ${loaded.error.message}`);
  for (const step of trace.steps) {
    const stepFrom = statesById.get(step.from);
    if (stepFrom === undefined) return skip(`from-state ${fromState.id} unreachable: state ${step.from} is missing`, `transition ${transition.id}: skipped, state ${step.from} of the producing chain is missing`);
    const reached = await performTransition(run, step, stepFrom);
    if (!reached.performed) {
      return skip(
        `from-state ${fromState.id} unreachable: replaying ${step.id} failed (${reached.reason ?? 'not performed'})`,
        `transition ${transition.id}: skipped, from-state ${fromState.id} could not be reached by replaying ${step.id} (${reached.reason ?? 'not performed'})`,
      );
    }
    if (reached.blockedRequests.length > 0) run.limitations.push(`transition ${transition.id}: replaying ${step.id} on the way to ${fromState.id} triggered ${reached.blockedRequests.length} blocked request(s); ${step.id} has its own replay entry`);
    if (reached.navigated) {
      run.limitations.push(`transition ${transition.id}: replaying ${step.id} on the way to ${fromState.id} navigated the generated app to ${pathOf(reached.url)}; the from-state may not be the recorded one`);
      await restabilize(run, transition.id, `replaying ${step.id}`);
    }
    const settled = await session.waitForStability({ timeoutMs: 5_000 });
    if (!settled.ok) run.limitations.push(`transition ${transition.id}: the stability wait after replaying ${step.id} failed (${describeError(settled.error)})`);
    else if (!settled.value.stable) run.limitations.push(`transition ${transition.id}: the generated page kept changing for ${settled.value.waitedMs}ms after replaying ${step.id}; the from-state capture may be mid-transition`);
  }

  const before = await session.capture();
  if (!before.ok) return skip(`the generated app could not be captured before the action (${describeError(before.error)})`, `transition ${transition.id}: skipped, capture before the action failed`);
  const targetMatch = target === null ? null : (matchNodes(fromState, before.value).byOriginalId.get(target.nodeId) ?? null);

  const attempt = await performTransition(run, transition, fromState, { navigation: navigation !== null });
  const evidenceBase = [`states/${fromState.id}/capture.json`, `states/${toState.id}/capture.json`];
  // A native form submission the session blocked is not performed, but the target was acted on: the comparison below
  // reports the request the generated form tried to send.
  if (!actedOn(attempt)) {
    run.unknowns.push(`transition ${transition.id}: the target could not be located or acted on in the generated app (${attempt.reason ?? 'not performed'})`);
    const finding = makeFinding(run, {
      category: 'behavior',
      severity: 'high',
      stateId: fromState.id,
      viewport: fromState.viewport,
      property: 'replay',
      node: fromState.nodes.find((node) => node.id === target?.nodeId) ?? null,
      transitionId: transition.id,
      original: `${transition.action.type}${transition.action.key === undefined ? '' : ` ${transition.action.key}`} on ${target === null ? 'no target' : `${target.role ?? target.tag}${target.name === null ? '' : ` "${target.name}"`} at ${target.nodePath}`}`,
      generated: null,
      delta: null,
      message: `transition ${transition.id} could not be replayed: ${attempt.reason ?? 'the action was not performed'}`,
      evidence: evidenceBase,
    });
    return { ...base, reason: attempt.reason ?? 'the action was not performed', findings: [finding] };
  }
  if (!attempt.performed) run.limitations.push(`transition ${transition.id}: the session blocked the action's request (${attempt.reason ?? 'not performed'}); the page was compared as it stayed`);
  const usedLocator = attempt.used?.locator;
  const reportedLocator = usedLocator?.role !== undefined ? { role: usedLocator.role, name: usedLocator.name ?? null, nth: usedLocator.nth ?? 0 } : locator;
  if (attempt.used !== null && usedLocator?.role === undefined) {
    run.limitations.push(`transition ${transition.id}: the target was located by ${attempt.used.label}, not by role and name; the locator in the report is the recorded target's`);
  }
  // A navigation loaded a new document: the animation freeze `loadState` injected left with the old one.
  if (attempt.navigated) await restabilize(run, transition.id, 'the action');
  const settled = await session.waitForStability({ timeoutMs: 5_000 });
  if (!settled.ok) run.limitations.push(`transition ${transition.id}: the stability wait after the action failed (${describeError(settled.error)})`);
  else if (!settled.value.stable) run.limitations.push(`transition ${transition.id}: the generated page kept changing for ${settled.value.waitedMs}ms after the action; the capture may be mid-transition`);

  const afterPath = join(attemptDir, `${transition.id}.after.png`);
  const after = await session.capture({ screenshotPath: afterPath, maxHeight: MAX_CAPTURE_HEIGHT });
  if (!after.ok) return skip(`the generated app could not be captured after the action (${describeError(after.error)})`, `transition ${transition.id}: capture after the action failed`);
  const afterRelative = ctx.store.relativePath(scan.scanId, afterPath);
  run.artifacts.push(afterRelative);
  const evidence = [...evidenceBase, afterRelative];
  if (toState.screenshot !== null) evidence.unshift(toState.screenshot.path);

  const originalDelta: RoleTreeDelta = diffRoleTrees(fromState.roleTree, toState.roleTree);
  const generatedDelta: RoleTreeDelta = diffRoleTrees(before.value.roleTree, after.value.roleTree);
  const deltas = compareDeltas(originalDelta, generatedDelta);
  const findings: Finding[] = [];
  const targetNode = target === null ? null : (fromState.nodes.find((node) => node.id === target.nodeId) ?? null);
  if (!deltas.match) {
    findings.push(
      makeFinding(run, {
        category: 'behavior',
        severity: 'high',
        stateId: fromState.id,
        viewport: fromState.viewport,
        property: 'role-tree',
        node: targetNode,
        transitionId: transition.id,
        original: `+${originalDelta.added.length} −${originalDelta.removed.length} entries`,
        generated: `+${generatedDelta.added.length} −${generatedDelta.removed.length} entries`,
        delta: null,
        message: `the role tree change after ${transition.id} differs from the original (missing: ${listEntries(deltas.missing)}; extra: ${listEntries(deltas.extra)})`,
        evidence,
      }),
    );
  }

  // Navigation: a recorded navigation must reach the target page's route (the crawled path or its extension-less
  // alias); any other transition never navigated when it was observed, so a navigation here is a behavior difference.
  let navigationMatch = true;
  if (navigation !== null) {
    const expectedRoute = run.routes.routeByPageId.get(navigation.toPageId) ?? null;
    const actualPath = pathnameOf(after.value.url);
    const reached = expectedRoute !== null ? routeReached(expectedRoute, actualPath) : actualPath === pathnameOf(navigation.url);
    if (expectedRoute === null) run.limitations.push(`transition ${transition.id}: page ${navigation.toPageId} is not listed in the document; the destination was compared with the recorded URL path instead of a registered route`);
    if (toState.pageId !== navigation.toPageId) run.limitations.push(`transition ${transition.id}: its to-state ${toState.id} belongs to page ${toState.pageId}, not to the recorded destination page ${navigation.toPageId}; the role tree was compared with ${toState.id}`);
    if (!reached) {
      navigationMatch = false;
      findings.push(
        makeFinding(run, {
          category: 'behavior',
          severity: 'high',
          stateId: fromState.id,
          viewport: fromState.viewport,
          property: 'navigation',
          node: targetNode,
          transitionId: transition.id,
          original: `navigated to ${pathOf(navigation.url)} (page ${navigation.toPageId})`,
          generated: attempt.navigated ? `navigated to ${pathOf(after.value.url)}` : 'stayed on the page',
          delta: null,
          message: `the action of ${transition.id} ${attempt.navigated ? `navigated the generated app to ${pathOf(after.value.url)}` : 'did not navigate the generated app'}; the original reached page ${navigation.toPageId} at ${pathOf(navigation.url)}${expectedRoute === null ? '' : ` (route ${expectedRoute})`}`,
          evidence,
        }),
      );
    }
  } else if (attempt.navigated) {
    navigationMatch = false;
    findings.push(
      makeFinding(run, {
        category: 'behavior',
        severity: 'high',
        stateId: fromState.id,
        viewport: fromState.viewport,
        property: 'navigation',
        node: targetNode,
        transitionId: transition.id,
        original: 'stayed on the page',
        generated: `navigated to ${pathOf(after.value.url)}`,
        delta: null,
        message: `the action of ${transition.id} navigated the generated app to ${pathOf(after.value.url)}; the original stayed on the page, so the role tree and pixels after it compare a different document`,
        evidence,
      }),
    );
  }

  // A generated form never performs a request: the original's submission was blocked during the scan and is not reproduced.
  if (attempt.blockedRequests.length > 0) {
    findings.push(
      makeFinding(run, {
        category: 'behavior',
        severity: 'high',
        stateId: fromState.id,
        viewport: fromState.viewport,
        property: 'request',
        node: targetNode,
        transitionId: transition.id,
        original: 'no request was sent',
        generated: `${attempt.blockedRequests.length} blocked request(s): ${listEntries(attempt.blockedRequests)}`,
        delta: null,
        message: `the generated form tried to send ${attempt.blockedRequests.length} request(s) when ${transition.id} was replayed (${listEntries(attempt.blockedRequests)}); UI DNA blocked them; a generated form must not perform a request`,
        evidence,
      }),
    );
  }

  // The target's expanded/open state must change the way it did in the original (not for a navigation: the to-state is another page).
  let stateMatch = true;
  if (target !== null && navigation === null) {
    const changes = targetStateChange(fromState, toState, target);
    if (changes.length > 0) {
      if (targetMatch === null) {
        run.limitations.push(`transition ${transition.id}: the target's expanded/open state could not be checked (its counterpart was not found in the generated capture)`);
      } else {
        const generatedAfter = after.value.nodes.find((node) => node.path === targetMatch.generated.path);
        for (const change of changes) {
          const a = readTargetState(targetMatch.generated, change.property);
          const b = readTargetState(generatedAfter, change.property);
          if (a === change.from && b === change.to) continue;
          stateMatch = false;
          findings.push(
            makeFinding(run, {
              category: 'behavior',
              severity: deltas.match ? 'medium' : 'high',
              stateId: fromState.id,
              viewport: fromState.viewport,
              property: `target-state:${change.property}`,
              node: targetNode,
              transitionId: transition.id,
              original: `${change.from} → ${change.to}`,
              generated: `${a} → ${b}`,
              delta: null,
              message: `${change.property} of the target changed ${change.from} → ${change.to} in the original but ${a} → ${b} in the generated app after ${transition.id}`,
              evidence,
            }),
          );
        }
      }
    }
  }

  let pixels: BehaviorComparison['pixels'] = null;
  if (toState.screenshot !== null && after.value.screenshot !== null) {
    const pixelLimitations: string[] = [];
    const compared = await pixelsOf(run, toState.screenshot.path, afterPath, join(attemptDir, `${transition.id}.diff.png`), pixelLimitations);
    for (const limitation of pixelLimitations) run.limitations.push(`transition ${transition.id}: ${limitation}`);
    if (compared !== null) pixels = toPixelComparison(compared.diff, compared.diffPath);
  } else {
    run.limitations.push(`transition ${transition.id}: ${toState.screenshot === null ? 'the original to-state has no screenshot' : 'no screenshot after the action'}; pixels were not compared`);
  }

  return {
    ...base,
    locator: reportedLocator,
    replayed: true,
    reason: null,
    roleTreeMatch: deltas.match && stateMatch && navigationMatch && attempt.blockedRequests.length === 0,
    roleTreeDiff: { missing: [...deltas.missing], extra: [...deltas.extra] },
    pixels,
    generatedScreenshot: afterRelative,
    findings,
  };
}

/* -------------------------------------------------------- generated tests */

/**
 * The limitation for a generated test that ran (not skipped) although it
 * repeats a transition the verifier never repeats, or null. The generated
 * suite decides for itself what it replays and runs outside UI DNA's network
 * guard (its submit helper only prevents the native submission), so the
 * report says when a test exercised a transition that caused side effects
 * (`neverReplayed`), or one whose from-state only a side effect or a
 * navigation reaches (`traceToBase`): the test's setup has to repeat that
 * producer to get there.
 */
export function repeatedByGeneratedTest(transitions: readonly Transition[], statesById: ReadonlyMap<string, UiState>, test: Pick<GeneratedTestResult, 'title' | 'transitionId' | 'status'>): string | null {
  if (test.status === 'skipped' || test.transitionId === null) return null;
  const exercised = transitions.find((t) => t.id === test.transitionId);
  if (exercised === undefined) return null;
  const guard = "the generated suite runs outside UI DNA's network guard";
  if (neverReplayed(exercised)) {
    return `generated test "${test.title}" exercised ${exercised.id}, which caused side effects when it was observed (${exercised.network.nonGet} non-GET request(s)); the verifier never replays it, and ${guard}`;
  }
  const from = statesById.get(exercised.from);
  const setup = from === undefined ? null : traceToBase(transitions, statesById, from);
  if (setup === null || setup.ok || setup.blockedBy === null) return null;
  const blocked = setup.blockedBy;
  return `generated test "${test.title}" exercised ${blocked.id} to reach the from-state ${exercised.from} of ${exercised.id}, which ${blocked.sideEffects ? `caused side effects when it was observed (${sideEffectCause(blocked)})` : `is a navigation to page ${blocked.navigation?.toPageId ?? '?'}`}; the verifier never replays it on the way to a state, and ${guard}`;
}

/**
 * Turn a generated test run into evidence: one `behavior` finding per failed
 * test (attached to the replay of the same transition when there is one,
 * else to the comparison of the base state the test opens), an unknown per
 * skipped test, a limitation when the tests could not run or their report
 * could not be read.
 */
function recordGeneratedTests(run: Run, result: GeneratedTestsOutcome, outcomes: readonly StateOutcome[], behavioral: readonly BehaviorComparison[]): void {
  if (!result.ran) {
    run.limitations.push(`generated tests were not run: ${result.reason ?? 'unknown reason'}`);
    return;
  }
  const { statesById } = run;
  const transitionsById = new Map(run.dna.states.transitions.map((t) => [t.id, t] as const));
  // Finding evidence is scan-relative like every other artifact path; the outcome carries absolute paths.
  const evidence = [result.reportPath, result.logPath].filter((path): path is string => path !== null).map((path) => run.ctx.store.relativePath(run.scan.scanId, path));
  const place = (transitionId: string | null, draft: Omit<FindingDraft, 'stateId' | 'viewport' | 'node' | 'transitionId' | 'evidence'>): void => {
    const transition = transitionId === null ? undefined : transitionsById.get(transitionId);
    const fromState = transition === undefined ? undefined : statesById.get(transition.from);
    const replay = transitionId === null ? undefined : behavioral.find((b) => b.transitionId === transitionId);
    const trace = fromState === undefined ? null : traceToBase(run.dna.states.transitions, statesById, fromState);
    const hostOutcome = outcomes.find((o) => trace?.ok === true && o.state.id === trace.base.id) ?? outcomes[0];
    const host = replay?.findings ?? hostOutcome?.comparison.findings;
    if (host === undefined) {
      run.limitations.push(`generated test finding could not be attached to any comparison: ${draft.message}`);
      return;
    }
    const state = fromState ?? hostOutcome?.state;
    if (state === undefined) {
      run.limitations.push(`generated test finding has no state to report under: ${draft.message}`);
      return;
    }
    const targetNode = transition?.action.target === null || transition === undefined || fromState === undefined ? null : (fromState.nodes.find((node) => node.id === transition.action.target?.nodeId) ?? null);
    host.push(makeFinding(run, { ...draft, stateId: state.id, viewport: state.viewport, node: targetNode, transitionId: transition?.id ?? null, evidence }));
  };
  for (const test of result.tests) {
    // A transition the verifier never repeats is reported when a test ran it, or ran it as its setup.
    const repeated = repeatedByGeneratedTest(run.dna.states.transitions, statesById, test);
    if (repeated !== null) run.limitations.push(repeated);
    if (test.status === 'skipped') {
      run.unknowns.push(`generated test skipped: ${test.title}`);
    } else if (test.status === 'flaky') {
      run.limitations.push(`generated test "${test.title}" passed only on retry`);
    } else if (test.status === 'failed') {
      place(test.transitionId, {
        category: 'behavior',
        severity: 'high',
        property: 'generated-test',
        original: 'the recorded transition',
        generated: `failed generated test`,
        delta: null,
        message: `generated test "${test.title}" failed${test.error === null ? '' : `: ${test.error}`}`,
      });
    }
  }
  for (const error of result.errors) run.limitations.push(`the generated test run reported an error outside any test: ${error}`);
  if (result.parseError !== null) run.limitations.push(`the generated test report could not be read (${result.parseError}); only the exit code ${result.exitCode ?? 'null'} of the run is known`);
  if (result.timedOut) {
    place(null, {
      category: 'behavior',
      severity: 'high',
      property: 'generated-test-run',
      original: 'the generated tests complete',
      generated: `timed out after ${result.durationMs}ms`,
      delta: null,
      message: `the generated test run (${result.command}) timed out after ${result.durationMs}ms`,
    });
  } else if (result.exitCode !== 0 && result.stats.failed === 0) {
    place(null, {
      category: 'behavior',
      severity: 'high',
      property: 'generated-test-run',
      original: 'exit code 0',
      generated: `exit code ${result.exitCode ?? 'null'}`,
      delta: null,
      message: `the generated test run (${result.command}) exited with code ${result.exitCode ?? 'null'} without reporting a failing test${result.errors.length > 0 ? ` (${result.errors[0] ?? ''})` : ''}; see ${result.logPath ?? 'the npm output'}`,
    });
  }
}

/* ------------------------------------------------------------------ main */

/** Verify a generated project against its scan and write the DiffReport for this attempt. */
export async function verifyReconstruction(input: VerifyInput): Promise<Result<DiffReport>> {
  const parsed = InputSchema.safeParse({
    outDir: input.outDir,
    attempt: input.attempt,
    thresholds: input.thresholds,
    build: input.build,
    label: input.label,
    evidenceId: input.evidenceId,
    viewportWidths: input.viewportWidths === undefined ? undefined : [...input.viewportWidths],
    runGeneratedTests: input.runGeneratedTests,
  });
  if (!parsed.success) return err(uidnaError('validation', `invalid verify input: ${parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`));
  const { ctx, scan, dna } = input;
  const options = parsed.data;
  const outDir = isAbsolute(options.outDir) ? options.outDir : resolve(ctx.cwd, options.outDir);
  const thresholds = { ...options.thresholds };
  const limitations: string[] = [];
  const unknowns: string[] = [];
  const artifacts: string[] = [];

  // Base states grouped by page in document order, widest viewport first within a page.
  const baseStates = orderByPage(
    dna,
    dna.states.items.filter((s) => s.kind === 'base'),
  );
  let selected = baseStates;
  if (options.viewportWidths !== undefined) {
    const widths = new Set(options.viewportWidths);
    selected = baseStates.filter((s) => widths.has(s.viewport.width));
    for (const width of widths) {
      if (!baseStates.some((s) => s.viewport.width === width)) unknowns.push(`viewport ${width}: no base state was captured at this width; nothing to compare`);
    }
  }
  if (selected.length === 0) return err(uidnaError('validation', `scan ${scan.scanId} has no base state to compare${options.viewportWidths === undefined ? '' : ' at the requested viewports'}`));
  // Only the pages the generator wrote have a route in the generated app; the others are reported, never loaded at a borrowed route.
  const { routes, foreignScanId } = await readGeneratedRoutes(outDir, dna, scan.scanId, limitations);
  const leftOut = new Map<string, string[]>();
  for (const state of selected) {
    if (pageNotGenerated(routes, state.pageId)) leftOut.set(state.pageId, [...(leftOut.get(state.pageId) ?? []), state.id]);
  }
  for (const [pageId, stateIds] of leftOut) limitations.push(`page ${pageId} was not generated; not compared (${MANIFEST_FILE} does not list it; base state(s) ${stateIds.join(', ')})`);
  selected = selected.filter((s) => !leftOut.has(s.pageId));
  if (selected.length === 0) return err(uidnaError('validation', `no base state of scan ${scan.scanId} belongs to a page the generated project renders (${MANIFEST_FILE} lists ${[...routes.routeByPageId.keys()].join(', ') || 'no page'})`));
  const transitions = dna.states.transitions;
  // A project generated from another scan carries that scan's behavior tests, whose transition ids are numbered per scan: never matched against this one.
  const runTests = (options.runGeneratedTests ?? false) && foreignScanId === null;
  if ((options.runGeneratedTests ?? false) && foreignScanId !== null) {
    limitations.push(`the generated behavior tests were not run: the project was generated from scan ${foreignScanId}, so its tests replay that scan's transitions, whose ids name other transitions in scan ${scan.scanId}`);
  }
  const total = (options.build ? 1 : 0) + selected.length + transitions.length + (runTests ? 1 : 0) + 1;
  let current = 0;
  const progress = (message: string): void => {
    current += 1;
    ctx.progress.report({ message, current, total });
  };
  /** Read afresh each time: a property narrowed by an earlier check would not see an abort that happened during an await. */
  const aborted = (): boolean => ctx.signal?.aborted === true;

  if (options.build) {
    progress(`building ${outDir}`);
    const built = await buildProject(outDir, { ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
    if (!built.ok) return err(uidnaError('verify', `npm run build could not run in ${outDir}: ${built.error.message}`, { cause: built.error }));
    if (!built.value.ok) {
      return err(uidnaError('verify', `npm run build failed in ${outDir}${built.value.distDir === null ? ' (no dist/index.html was produced)' : ''}; see ${posix(built.value.logPath)}`, { details: { logPath: posix(built.value.logPath), durationMs: built.value.durationMs } }));
    }
  }
  const dist = join(outDir, 'dist');
  try {
    if (!(await stat(join(dist, 'index.html'))).isFile()) return err(uidnaError('verify', `${join(dist, 'index.html')} is not a file`));
  } catch (cause) {
    return err(toError(cause, 'verify', `${join(dist, 'index.html')} is missing; build the project first (build=true)`));
  }

  const attemptDirResult = tryCatch(
    () => ctx.store.attemptDir(scan.scanId, options.attempt),
    (cause) => toError(cause, 'validation', 'attempt directory'),
  );
  if (!attemptDirResult.ok) return attemptDirResult;
  const attemptDir = attemptDirResult.value;
  try {
    await mkdir(attemptDir, { recursive: true });
  } catch (cause) {
    return err(toError(cause, 'io', `create ${attemptDir}`));
  }

  const served = await serveStatic(dist, { spaFallback: true });
  if (!served.ok) return served;
  const server = served.value;
  const first = selected[0];
  if (first === undefined) {
    await server.close();
    return err(uidnaError('internal', 'no base state selected'));
  }
  const opened = await openSession(ctx, { url: server.url }, first.viewport);
  if (!opened.ok) {
    await server.close();
    return opened;
  }
  const session = opened.value;
  const run: Run = {
    ctx,
    scan,
    dna,
    session,
    server,
    attemptDir,
    thresholds,
    counter: new FindingCounter(),
    limitations,
    unknowns,
    artifacts,
    statesById: new Map(dna.states.items.map((s) => [s.id, s] as const)),
    routes,
  };

  const outcomes: StateOutcome[] = [];
  const behavioral: BehaviorComparison[] = [];
  let generatedTests: GeneratedTestRun | null = null;
  let cancelled = false;
  try {
    for (const state of selected) {
      if (ctx.signal?.aborted === true) {
        cancelled = true;
        break;
      }
      progress(`comparing ${state.id} (page ${state.pageId}) at ${state.viewport.width}×${state.viewport.height}`);
      outcomes.push(await compareState(run, state));
    }
    if (!cancelled) crossViewportFindings(run, outcomes);
    for (const transition of transitions) {
      if (cancelled || ctx.signal?.aborted === true) {
        cancelled = true;
        break;
      }
      progress(`replaying ${transition.id} (${transition.action.type}${transition.navigation ? ', navigation' : ''})`);
      const replayed = await replayTransition(run, transition);
      if (replayed !== null) behavioral.push(replayed);
    }
    if (runTests && !cancelled && ctx.signal?.aborted !== true) {
      progress('running the generated behavior tests');
      const result = await runGeneratedTests({ outDir, serverUrl: server.url, port: server.port, artifactDir: attemptDir, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
      // A cancellation kills the npm child mid-run: its partial outcome is not evidence, so no report is written from it.
      if (aborted()) {
        cancelled = true;
      } else {
        recordGeneratedTests(run, result, outcomes, behavioral);
        const relativeOrNull = (path: string | null): string | null => (path === null ? null : ctx.store.relativePath(scan.scanId, path));
        generatedTests = {
          ran: result.ran,
          reason: result.reason,
          command: result.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          reportPath: relativeOrNull(result.reportPath),
          logPath: relativeOrNull(result.logPath),
          parseError: result.parseError,
          stats: { ...result.stats },
          tests: result.tests.map((t) => ({ ...t })),
        };
        const relative = `verify/attempt-${options.attempt}/${GENERATED_TESTS_FILE}`;
        const wrote = await ctx.store.writeJson(scan.scanId, relative, GeneratedTestRunSchema, generatedTests);
        if (wrote.ok) artifacts.push(relative);
        else limitations.push(`the generated test run was not stored (${describeError(wrote.error)})`);
        for (const path of [generatedTests.reportPath, generatedTests.logPath]) if (path !== null) artifacts.push(path);
      }
    }
  } finally {
    await session.close();
    await server.close();
  }
  if (cancelled) return err(uidnaError('cancelled', `verification of ${scan.scanId} attempt ${options.attempt} was cancelled`));

  progress('writing the diff report');
  const visual = outcomes.map((o) => o.comparison);
  const findings = [...visual.flatMap((v) => v.findings), ...behavioral.flatMap((b) => b.findings)];
  const counts = countFindings(findings);
  const previous = input.previous;
  const attemptDiff = diffAttempts(previous, findings);
  const reportRelative = `verify/attempt-${options.attempt}/diff-report.json`;
  const report: DiffReport = {
    id: `${scan.scanId}_attempt-${options.attempt}`,
    scanId: scan.scanId,
    outDir: posix(outDir),
    attempt: options.attempt,
    createdAt: isoNow(ctx.clock),
    thresholds,
    summary: {
      states: visual.length,
      transitions: behavioral.length,
      findings: findings.length,
      byCategory: counts.byCategory,
      bySeverity: counts.bySeverity,
      transitionsReplayed: behavioral.filter((b) => b.replayed).length,
      transitionsMatched: behavioral.filter((b) => b.roleTreeMatch === true).length,
    },
    visual,
    behavioral,
    regressions: attemptDiff.regressions,
    resolved: attemptDiff.resolved,
    previousAttempt: previous === null ? null : previous.attempt,
    limitations: [...new Set(limitations)],
    unknowns: [...new Set(unknowns)],
    artifacts: [reportRelative, ...new Set(artifacts)],
  };
  const saved = await ctx.store.saveDiffReport(scan.scanId, report);
  if (!saved.ok) return saved;
  scan.steps.verify = [
    ...scan.steps.verify.filter((entry) => entry.attempt !== options.attempt),
    { attempt: options.attempt, at: isoNow(ctx.clock), evidenceId: options.evidenceId, reportPath: saved.value, label: options.label },
  ].sort((a, b) => a.attempt - b.attempt);
  const savedScan = await ctx.store.saveScan(scan);
  if (!savedScan.ok) return savedScan;
  return ok(report);
}
