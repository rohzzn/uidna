/**
 * `scan_interface`: capture a page at each viewport into a new scan and
 * assemble the first UI DNA document from the base states.
 */
import type { UiDnaDocument } from 'uidna-schema';
import { emptyResponsiveRecord, measureResponsive, resolveResponsiveOptions } from './responsive.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transition } from 'uidna-schema';
import { assembleDna } from '../analysis/index.js';
import { redactUrl } from '../browser/redact.js';
import type { BrowserSession, CapturedState } from '../browser/types.js';
import { DEFAULT_VIEWPORT_WIDTHS, validateTarget, viewportFromWidth, type scanInterface as scanInterfaceContract } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { BudgetTracker, resolveBudget, type BudgetLimits } from '../domain/budget.js';
import { isoNow } from '../domain/clock.js';
import { describeError, toError, uidnaError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { newScanId, sequentialId, stateId as makeStateId } from '../domain/ids.js';
import { err, ok, type Result } from '../domain/result.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { stateSummaries } from './inspect.js';
import type { ScanRecord, StateRecord } from './records.js';

/** Identity of a page for crawling: the URL without its fragment, with a normalized trailing slash. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.endsWith('/') && parsed.pathname.length > 1 ? parsed.pathname.slice(0, -1) : parsed.pathname;
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

const NON_DOCUMENT_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|gz|tgz|mp4|webm|mp3|wav|woff2?|ttf|otf|css|js|mjs|json|xml|txt|csv)$/i;

/** Same-origin document links on a captured page that a crawl may follow, deduplicated by page key. */
export function discoverLinks(capture: CapturedState, pageUrl: string, crawl: { include?: string[] | undefined; exclude?: string[] | undefined } | undefined): { url: string; nodePath: string }[] {
  let origin: URL;
  try {
    origin = new URL(pageUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: { url: string; nodePath: string }[] = [];
  for (const node of capture.nodes) {
    if (node.tag !== 'a') continue;
    const href = node.attrs.href;
    if (href === undefined || href.trim() === '' || href.trim().startsWith('#')) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (resolved.origin !== origin.origin || !/^https?:$/.test(resolved.protocol)) continue;
    if (NON_DOCUMENT_EXTENSION.test(resolved.pathname)) continue;
    if (crawl?.include && crawl.include.length > 0 && !crawl.include.some((prefix) => resolved.pathname.startsWith(prefix))) continue;
    if (crawl?.exclude?.some((prefix) => resolved.pathname.startsWith(prefix))) continue;
    resolved.hash = '';
    const key = pageKey(resolved.href);
    if (seen.has(key) || key === pageKey(pageUrl)) continue;
    seen.add(key);
    out.push({ url: resolved.href, nodePath: node.path });
  }
  return out;
}

/** Origin (scheme, host, port) of a CDP endpoint; the path of a ws:// endpoint is a debugging token and is never stored. */
export function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return redactUrl(endpoint);
  }
}

/** Resolve viewport widths from input, config and defaults; widest first, deduplicated. */
export function resolveViewports(input: readonly number[] | undefined, config: readonly number[] | undefined): { width: number; height: number }[] {
  const widths = [...new Set(input ?? config ?? DEFAULT_VIEWPORT_WIDTHS)].sort((a, b) => b - a);
  return widths.map(viewportFromWidth);
}

/** Merge config and input budgets. */
export function resolveLimits(ctx: WorkflowContext, input: Partial<BudgetLimits> | undefined): BudgetLimits {
  return resolveBudget({ ...(ctx.config.budget ?? {}), ...(input ?? {}) });
}

/** Make a capture's artifact paths relative to the scan directory. */
export function relativizeCapture(ctx: WorkflowContext, scanId: string, capture: CapturedState): CapturedState {
  return {
    ...capture,
    screenshot: capture.screenshot ? { ...capture.screenshot, path: ctx.store.relativePath(scanId, capture.screenshot.path) } : null,
    assets: capture.assets.map((asset) =>
      asset.localPath === undefined ? asset : { ...asset, localPath: ctx.store.relativePath(scanId, asset.localPath) },
    ),
  };
}

/** Capture the current page into a new state of `scan`. Returns the capture, or the reason it failed. */
export async function captureState(
  ctx: WorkflowContext,
  session: BrowserSession,
  scan: ScanRecord,
  options: {
    stateId: string;
    /** Page the state belongs to; defaults to the scan's seed page. */
    pageId?: string;
    kind: 'base' | 'derived';
    parentStateId: string | null;
    viaTransitionId: string | null;
    evidenceId: string;
    budget: BudgetTracker;
    captureBodies?: 'none' | 'json';
  },
): Promise<Result<{ capture: CapturedState; record: StateRecord }>> {
  const scanDir = ctx.store.scanDir(scan.scanId);
  const stateDir = ctx.store.stateDir(scan.scanId, options.stateId);
  try {
    await mkdir(stateDir, { recursive: true });
  } catch (cause) {
    return err(toError(cause, 'io', `create ${stateDir}`));
  }
  const captured = await session.capture({
    screenshotPath: join(stateDir, 'screenshot.png'),
    assetDir: join(scanDir, 'assets'),
    maxHeight: 4000,
    ...(options.captureBodies === undefined ? {} : { captureBodies: options.captureBodies }),
  });
  if (!captured.ok) return captured;
  const capture = relativizeCapture(ctx, scan.scanId, captured.value);
  options.budget.consumeResources(capture.assets.length + capture.network.length);
  const saved = await ctx.store.saveCapture(scan.scanId, options.stateId, capture);
  if (!saved.ok) return saved;
  const record: StateRecord = {
    stateId: options.stateId,
    pageId: options.pageId ?? scan.pageId,
    kind: options.kind,
    parentStateId: options.parentStateId,
    viewport: capture.viewport,
    url: capture.url,
    title: capture.title,
    capturePath: saved.value,
    screenshotPath: capture.screenshot ? capture.screenshot.path : null,
    domDigest: capture.domDigest,
    roleTreeDigest: capture.roleTreeDigest,
    nodeCount: capture.nodes.length,
    capturedAt: capture.capturedAt,
    evidenceId: options.evidenceId,
    viaTransitionId: options.viaTransitionId,
  };
  return ok({ capture, record });
}

/** Open a session for a scan target: attach over CDP or launch Chromium. */
export async function openSession(
  ctx: WorkflowContext,
  target: { url?: string | undefined; cdpEndpoint?: string | undefined; targetId?: string | undefined; headless?: boolean | undefined },
  viewport: { width: number; height: number },
): Promise<Result<BrowserSession>> {
  if (target.cdpEndpoint) {
    return ctx.provider.attach({ cdpEndpoint: target.cdpEndpoint, ...(target.targetId === undefined ? {} : { targetId: target.targetId }), viewport });
  }
  return ctx.provider.launch({
    headless: target.headless ?? ctx.config.headless ?? true,
    honorRobots: true,
    viewport,
  });
}

/** Rebuild and store the UI DNA document from the scan's captures. */
export async function reassembleDna(ctx: WorkflowContext, scan: ScanRecord, transitions?: Transition[]): Promise<Result<string>> {
  const captures = await ctx.store.loadAllCaptures(scan.scanId, scan);
  if (!captures.ok) return captures;
  // A previous document carries the agent's annotations: failing to read it must not silently drop them.
  const previous = (await ctx.store.hasDna(scan.scanId)) ? await ctx.store.loadDna(scan.scanId) : null;
  if (previous !== null && !previous.ok) return previous;
  // The explore record carries per-page coverage; it is absent before the first exploration.
  const explore = await ctx.store.loadExplore(scan.scanId);
  if (!explore.ok) return explore;
  // Stylesheet conditions and probe results; absent for scans made before 0.3.0 or with responsive measurement off.
  const responsive = await ctx.store.loadResponsive(scan.scanId);
  if (!responsive.ok) return responsive;
  const assembled = assembleDna({
    scan,
    captures: captures.value,
    ...(transitions === undefined ? {} : { transitions }),
    explore: explore.value,
    responsive: responsive.value,
    previous: previous ? previous.value : null,
    toolVersion: ctx.toolVersion,
    clock: ctx.clock,
  });
  if (!assembled.ok) return assembled;
  return ctx.store.saveDna(scan.scanId, assembled.value);
}

/** `scan_interface`. */
export async function scanInterface(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof scanInterfaceContract>,
): Promise<Result<Envelope<ToolOutput<typeof scanInterfaceContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const targetError = validateTarget(input);
  if (targetError) return err(uidnaError('validation', targetError));
  const viewports = resolveViewports(input.viewports, ctx.config.viewports);
  const first = viewports[0];
  if (!first) return err(uidnaError('validation', 'at least one viewport is required'));
  const maxPages = input.crawl?.maxPages ?? 1;
  // A crawl of N pages needs a page budget of at least N unless the caller bounded it explicitly.
  const requestedLimits = resolveLimits(ctx, input.budget);
  const limits: BudgetLimits =
    input.budget?.pages === undefined && requestedLimits.pages !== null && requestedLimits.pages < maxPages ? { ...requestedLimits, pages: maxPages } : requestedLimits;
  const budget = new BudgetTracker(limits, ctx.clock, ctx.signal);
  const pages: NonNullable<ScanRecord['pages']> = [];
  const scanId = newScanId(ctx.clock.now());
  const now = isoNow(ctx.clock);
  const limitations: string[] = [];
  const unknowns: string[] = [];

  ctx.progress.report({ message: `opening ${input.cdpEndpoint ? 'CDP session' : 'Chromium'}`, current: 0, total: viewports.length + 2 });
  const opened = await openSession(ctx, input, first);
  if (!opened.ok) return opened;
  const session = opened.value;

  const scan: ScanRecord = {
    scanId,
    toolVersion: ctx.toolVersion,
    createdAt: now,
    updatedAt: now,
    target: {
      kind: input.cdpEndpoint ? 'cdp' : 'url',
      url: redactUrl(input.url ?? session.currentUrl()),
      // The CDP endpoint is stored without its path: a ws:// endpoint path is a per-browser debugging token.
      ...(input.cdpEndpoint ? { cdp: { endpoint: endpointOrigin(input.cdpEndpoint), ...(input.targetId === undefined ? {} : { targetId: input.targetId }) } } : {}),
    },
    browser: { mode: session.mode, name: 'chromium', version: null },
    viewports,
    pageId: 'pg_01',
    pages: [],
    status: 'capturing',
    budget: { limits, used: budget.usage() },
    states: [],
    limitations,
    unknowns,
    steps: { scan: null, explore: null, generate: null, verify: [], report: null },
  };
  const created = await ctx.store.createScan(scan);
  if (!created.ok) {
    await session.close();
    return created;
  }
  const responsiveOptions = resolveResponsiveOptions(input.responsive);
  const evidence = await ctx.ledger.record({
    kind: 'scan',
    inputs: { url: input.url, cdpEndpoint: input.cdpEndpoint, targetId: input.targetId, viewports: viewports.map((v) => v.width), budget: limits, responsive: responsiveOptions },
    scanId,
  });
  const responsive = emptyResponsiveRecord(scanId, evidence.id, responsiveOptions);

  try {
    if (input.url) {
      budget.consumePage();
      ctx.progress.report({ message: `loading ${input.url}`, current: 1, total: viewports.length + 2 });
      const navigated = await session.navigate(input.url, { waitUntil: 'load', timeoutMs: Math.min(30_000, Math.max(5_000, budget.remainingMs())) });
      if (!navigated.ok) {
        scan.status = 'failed';
        limitations.push(`navigation failed: ${describeError(navigated.error)}`);
        await ctx.store.saveScan(scan);
        return err(uidnaError(navigated.error._tag, `scan ${scanId}: ${navigated.error.message}`, { details: { scanId, scanDir: created.value }, cause: navigated.error }));
      }
      scan.target.url = redactUrl(navigated.value.url);
      if (navigated.value.status !== null && navigated.value.status >= 400) {
        limitations.push(`page responded with HTTP ${navigated.value.status}`);
      }
    } else {
      scan.target.url = redactUrl(session.currentUrl());
    }
    if (session.sandboxed === false) limitations.push('Chromium ran without its sandbox: this host could not start a sandboxed Chromium');

    // Breadth-first crawl over same-origin links; the seed page is depth 0. Cross-origin links are
    // recorded by the assembler as navigation edges but never followed.
    const queue: { url: string; depth: number; discoveredVia: string | null }[] = [{ url: scan.target.url, depth: 0, discoveredVia: null }];
    const visited = new Set<string>([pageKey(scan.target.url)]);
    while (queue.length > 0 && pages.length < maxPages) {
      const next = queue.shift();
      if (next === undefined) break;
      if (pages.length > 0) {
        const stop = budget.check();
        if (stop || budget.wouldExceed('pages')) {
          unknowns.push(`page ${next.url}: not crawled (${stop ? stop.message : 'page budget exhausted'})`);
          continue;
        }
        budget.consumePage();
        ctx.progress.report({ message: `loading ${next.url} (page ${pages.length + 1} of at most ${maxPages})` });
        const navigated = await session.navigate(next.url, { waitUntil: 'load', timeoutMs: Math.min(30_000, Math.max(5_000, budget.remainingMs())) });
        if (!navigated.ok) {
          unknowns.push(`page ${next.url}: not crawled (${describeError(navigated.error)})`);
          continue;
        }
        if (pageKey(navigated.value.url) !== pageKey(next.url) && visited.has(pageKey(navigated.value.url))) {
          unknowns.push(`page ${next.url}: redirected to an already crawled page`);
          continue;
        }
        visited.add(pageKey(navigated.value.url));
        next.url = redactUrl(navigated.value.url);
      }
      const pageId = sequentialId('pg', pages.length + 1);
      let title = '';
      let widest: CapturedState | null = null;
      for (const [index, viewport] of viewports.entries()) {
        const stop = budget.check();
        if (stop) {
          unknowns.push(`${pageId} viewport ${viewport.width}: not captured (${stop.message})`);
          continue;
        }
        ctx.progress.report({ message: `capturing ${pageId} at ${viewport.width}×${viewport.height}`, current: index + 2, total: viewports.length + 2 });
        const resized = await session.setViewport(viewport);
        if (!resized.ok) {
          unknowns.push(`${pageId} viewport ${viewport.width}: not captured (${describeError(resized.error)})`);
          continue;
        }
        const stabilized = await session.stabilize();
        if (!stabilized.ok) limitations.push(`${pageId} viewport ${viewport.width}: could not freeze animations (${describeError(stabilized.error)})`);
        const stable = await session.waitForStability({ timeoutMs: Math.min(8_000, Math.max(1_000, budget.remainingMs())) });
        if (stable.ok && !stable.value.stable) limitations.push(`${pageId} viewport ${viewport.width}: page kept changing for ${stable.value.waitedMs}ms before capture`);
        const stateId = makeStateId(scan.states.length + 1);
        const captured = await captureState(ctx, session, scan, {
          stateId,
          pageId,
          kind: 'base',
          parentStateId: null,
          viaTransitionId: null,
          evidenceId: evidence.id,
          budget,
          ...(input.captureBodies === undefined ? {} : { captureBodies: input.captureBodies }),
        });
        if (!captured.ok) {
          unknowns.push(`${pageId} viewport ${viewport.width}: capture failed (${describeError(captured.error)})`);
          continue;
        }
        scan.states.push(captured.value.record);
        limitations.push(...captured.value.capture.limitations.map((l) => `${pageId} viewport ${viewport.width}: ${l}`));
        title = captured.value.capture.title;
        if (widest === null || captured.value.capture.viewport.width > widest.viewport.width) widest = captured.value.capture;
        scan.budget = { limits, used: budget.usage() };
        await ctx.store.saveScan(scan);
      }
      const capturedWidths = scan.states.filter((state) => state.pageId === pageId && state.kind === 'base').map((state) => state.viewport.width);
      if (capturedWidths.length > 0 && (responsiveOptions.css || responsiveOptions.probe)) {
        ctx.progress.report({ message: `measuring breakpoints of ${pageId}` });
        const measured = await measureResponsive(session, { pageId, scannedWidths: capturedWidths, options: responsiveOptions, budget });
        responsive.pages[pageId] = measured;
        limitations.push(...measured.limitations.map((l) => `${pageId} responsive: ${l}`));
        scan.budget = { limits, used: budget.usage() };
      }
      pages.push({ pageId, url: next.url, depth: next.depth, discoveredVia: next.discoveredVia, title });
      scan.pages = pages;
      if (maxPages > 1 && widest !== null) {
        for (const link of discoverLinks(widest, next.url, input.crawl)) {
          const key = pageKey(link.url);
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push({ url: link.url, depth: next.depth + 1, discoveredVia: `${pageId}:${link.nodePath}` });
        }
        if (pages.length >= maxPages && queue.length > 0) {
          limitations.push(`crawl stopped at ${maxPages} page${maxPages === 1 ? '' : 's'}; ${queue.length} discovered same-origin link target${queue.length === 1 ? '' : 's'} not visited`);
        }
      }
    }
  } finally {
    await session.close();
  }

  scan.budget = { limits, used: budget.usage() };
  scan.pages = pages;
  const expectedStates = pages.length * viewports.length;
  scan.status = scan.states.length === expectedStates && pages.length > 0 ? 'captured' : scan.states.length > 0 ? 'partial' : 'failed';
  scan.steps.scan = { at: isoNow(ctx.clock), evidenceId: evidence.id };
  if (scan.states.length === 0) {
    await ctx.store.saveScan(scan);
    return err(uidnaError('capture', `scan ${scanId}: no viewport could be captured`, { details: { scanId, scanDir: created.value, unknowns } }));
  }

  if (Object.keys(responsive.pages).length > 0) {
    const savedResponsive = await ctx.store.saveResponsive(scanId, responsive);
    if (!savedResponsive.ok) limitations.push(`responsive measurements not saved: ${describeError(savedResponsive.error)}`);
  }
  ctx.progress.report({ message: 'assembling UI DNA document', current: viewports.length + 2, total: viewports.length + 2 });
  const dnaPath = await reassembleDna(ctx, scan);
  if (!dnaPath.ok) {
    scan.status = 'partial';
    limitations.push(`UI DNA document not written: ${describeError(dnaPath.error)}`);
    await ctx.store.saveScan(scan);
    return err(uidnaError(dnaPath.error._tag, `scan ${scanId}: ${dnaPath.error.message}`, { details: { scanId, scanDir: created.value }, cause: dnaPath.error }));
  }
  await ctx.store.saveScan(scan);

  const dna = await ctx.store.loadDna(scanId);
  if (!dna.ok) return dna;
  const byKind: Record<string, number> = {};
  const byOrigin: Record<string, number> = {};
  for (const asset of dna.value.assets) {
    byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1;
    byOrigin[asset.origin] = (byOrigin[asset.origin] ?? 0) + 1;
  }
  const artifacts = [
    'scan.json',
    'dna.json',
    ...(Object.keys(responsive.pages).length > 0 ? ['responsive.json'] : []),
    ...scan.states.flatMap((s) => [s.capturePath, ...(s.screenshotPath ? [s.screenshotPath] : [])]),
  ];
  const finalEvidence = ctx.ledger.withArtifacts(evidence, artifacts);
  const result: ToolOutput<typeof scanInterfaceContract> = {
    scanId,
    scanDir: created.value,
    target: { kind: scan.target.kind, url: scan.target.url },
    pages: dna.value.app.pages.map((page) => ({
      pageId: page.id,
      url: page.url,
      title: page.title.value ?? '',
      depth: page.depth ?? 0,
      discoveredVia: page.discoveredVia ?? null,
      stateIds: page.stateIds,
    })),
    states: stateSummaries(dna.value),
    breakpoints: breakpointSummaries(dna.value),
    assets: { count: dna.value.assets.length, byKind, byOrigin },
    budget: { used: { ...budget.usage() }, limits: { ...limits } },
    dnaPath: dnaPath.value,
  };
  return ok(envelope(finalEvidence, result, { limitations, unknowns }));
}

/** Located breakpoints of a document as tools report them, ascending by width. */
export function breakpointSummaries(dna: UiDnaDocument): ToolOutput<typeof scanInterfaceContract>['breakpoints'] {
  const responsive = dna.visual.responsive;
  if (responsive === undefined) return [];
  const conditionText = new Map(responsive.conditions.map((c) => [c.id, c.text] as const));
  return [...responsive.breakpoints]
    .sort((a, b) => a.minWidth - b.minWidth)
    .map((b) => ({
      minWidth: b.minWidth,
      source: b.source,
      bracket: { ...b.bracket },
      conditions: b.conditionIds.map((id) => conditionText.get(id) ?? id),
      pageIds: [...b.pageIds],
      rules: responsive.rules.filter((r) => r.breakpointId === b.id).length,
    }));
}
