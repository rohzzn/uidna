/**
 * Page capture. Prefers CDP (`DOMSnapshot.captureSnapshot` for structure,
 * layout and computed styles; `Accessibility.getFullAXTree` for roles and
 * names, joined by backend node id) and falls back to an in-page walk when a
 * CDP call fails, recording a limitation whenever it does. `snapshotPage`
 * runs the same pipeline without styles, boxes, screenshot or assets, so the
 * digests of an unchanged page are identical to a full capture's.
 */
import { redactUrl } from './redact.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CDPSession, Page } from 'playwright';
import type { Viewport } from '@rohzzn/uidna-schema';
import type { Clock } from '../domain/clock.js';
import { sha256 } from '../domain/digest.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { collectAssets, DEFAULT_MAX_ASSET_BYTES } from './assets.js';
import { indexAxTree, type AxIndex } from './ax.js';
import { AxTreeResultSchema, DocumentMetricsSchema } from './cdp-schemas.js';
import { attachBackendIds, collectViaEvaluate, collectViaSnapshot, fillMissingStyles, type RawTree } from './dom-tree.js';
import { collectFonts } from './fonts.js';
import { evaluateInPage } from './in-page.js';
import { buildState } from './nodes.js';
import { CapturedStateSchema } from './schemas.js';
import { MAX_ATTR_LENGTH, MAX_TEXT_LENGTH, RENDERING_STYLE_PROPERTIES } from './style-properties.js';
import type { CaptureOptions, CapturedState, NetworkEntry, PageSnapshot, ScreenshotFile } from './types.js';

/** Default maximum captured page height in CSS pixels. */
export const DEFAULT_MAX_HEIGHT = 4000;

/** What `capturePage` and `snapshotPage` need from the session. */
export interface CaptureContext {
  readonly page: Page;
  /** A CDP session for the page, or null when CDP is unavailable. `reset` forces a fresh session after a failure. */
  readonly cdp: (reset?: boolean) => Promise<CDPSession | null>;
  readonly clock: Clock;
  readonly viewport: Viewport;
  /** Network entries of the current document, included in the capture. */
  readonly network: readonly NetworkEntry[];
  /** Why `network` may be incomplete (e.g. the session attached after the page loaded), or null. */
  readonly networkLimitation?: string | null;
}

/** Document metrics measured in-page. */
export interface DocumentMetrics {
  readonly width: number;
  readonly height: number;
  readonly scrollHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly url: string;
  readonly title: string;
}

/** Full capture of the current page. */
export async function capturePage(context: CaptureContext, options: CaptureOptions = {}): Promise<Result<CapturedState>> {
  const limitations: string[] = [];
  const styleProperties = options.styleProperties ?? RENDERING_STYLE_PROPERTIES;
  const includeHiddenNodes = options.includeHiddenNodes ?? true;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;

  const initialCdp = await context.cdp();
  if (initialCdp === null) limitations.push('CDP is unavailable for this page; the DOM was walked in-page and accessibility roles are unknown.');

  const treeResult = await collectTree(context, initialCdp, styleProperties, limitations);
  if (!treeResult.ok) return treeResult;
  let tree = treeResult.value;
  const filled = await fillMissingStyles(context.page, tree, styleProperties);
  tree = filled.tree;
  if (filled.limitation !== null) limitations.push(filled.limitation);

  // `collectTree` may have replaced the CDP session after a DOMSnapshot failure: use whatever is current now.
  const cdp = initialCdp === null ? null : await context.cdp();
  const ax = await collectAx(cdp, limitations);
  const built = buildState(tree, ax, { includeHiddenNodes, withStyles: true });
  if (built.truncated.attrs > 0) limitations.push(`${built.truncated.attrs} attribute value(s) were clipped to ${MAX_ATTR_LENGTH} characters.`);
  if (built.truncated.text > 0) limitations.push(`${built.truncated.text} text node(s) were clipped to ${MAX_TEXT_LENGTH} characters.`);
  if (context.networkLimitation) limitations.push(context.networkLimitation);

  const metricsResult = await readDocumentMetrics(context.page);
  if (!metricsResult.ok) return metricsResult;
  const metrics = metricsResult.value;

  let screenshot: ScreenshotFile | null = null;
  if (options.screenshotPath !== undefined) {
    const shot = await takeScreenshot(context.page, options.screenshotPath, maxHeight, metrics, context.viewport);
    if (!shot.ok) return shot;
    screenshot = shot.value.file;
    if (shot.value.limitation !== null) limitations.push(shot.value.limitation);
  }

  const fonts = await collectFonts(context.page, cdp, built, tree);
  limitations.push(...fonts.limitations);

  const assetInput: Parameters<typeof collectAssets>[0] = {
    page: context.page,
    state: built,
    tree,
    pageUrl: metrics.url,
    network: context.network,
    maxAssetBytes: options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
  };
  const assets = await collectAssets(options.assetDir === undefined ? assetInput : { ...assetInput, assetDir: options.assetDir });
  limitations.push(...assets.limitations);

  const state: CapturedState = {
    url: redactUrl(metrics.url),
    title: metrics.title,
    viewport: context.viewport,
    capturedAt: context.clock.now().toISOString(),
    document: { width: Math.round(metrics.width), height: Math.round(metrics.height), scrollHeight: Math.round(metrics.scrollHeight) },
    nodes: built.nodes,
    styles: built.styles,
    roleTree: built.roleTree,
    roleTreeDigest: built.roleTreeDigest,
    domDigest: built.domDigest,
    screenshot,
    fonts: fonts.fonts,
    assets: assets.assets,
    network: context.network,
    limitations: dedupe(limitations),
  };
  const validated = CapturedStateSchema.safeParse(state);
  if (!validated.success) {
    return err(uidnaError('capture', `Captured state failed validation: ${validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).slice(0, 5).join('; ')}`));
  }
  return ok(validated.data);
}

/** Cheap identity snapshot: same digests as `capturePage` for an unchanged page. */
export async function snapshotPage(context: CaptureContext): Promise<Result<PageSnapshot>> {
  const limitations: string[] = [];
  const initialCdp = await context.cdp();
  const treeResult = await collectTree(context, initialCdp, [], limitations);
  if (!treeResult.ok) return treeResult;
  const cdp = initialCdp === null ? null : await context.cdp();
  const ax = await collectAx(cdp, limitations);
  const built = buildState(treeResult.value, ax, { includeHiddenNodes: true, withStyles: false });
  return ok({
    url: context.page.url(),
    domDigest: built.domDigest,
    roleTreeDigest: built.roleTreeDigest,
    nodeCount: built.nodes.length,
  });
}

/** Collect the raw tree, preferring DOMSnapshot and falling back to the in-page walk. */
export async function collectTree(context: CaptureContext, cdp: CDPSession | null, styleProperties: readonly string[], limitations: string[]): Promise<Result<RawTree>> {
  if (cdp !== null) {
    const viaSnapshot = await collectViaSnapshot(cdp, { styleProperties });
    if (viaSnapshot.ok) {
      limitations.push(...viaSnapshot.value.limitations);
      return viaSnapshot;
    }
    limitations.push(`${viaSnapshot.error.message}; falling back to the in-page walk.`);
  }
  const viaEvaluate = await collectViaEvaluate(context.page, { styleProperties });
  if (!viaEvaluate.ok) return viaEvaluate;
  let tree = viaEvaluate.value;
  if (cdp !== null) {
    // The DOMSnapshot call failed: try a fresh CDP session for backend ids so roles can still be mapped.
    const fresh = await context.cdp(true);
    tree = fresh === null ? { ...tree, limitations: [...tree.limitations, 'Accessibility roles are unknown: CDP is unavailable.'] } : await attachBackendIds(fresh, tree);
  }
  limitations.push(...tree.limitations);
  return ok(tree);
}

/** Fetch and index the accessibility tree; null (with a limitation) when unavailable. */
export async function collectAx(cdp: CDPSession | null, limitations: string[]): Promise<AxIndex | null> {
  if (cdp === null) return null;
  try {
    const raw: unknown = await cdp.send('Accessibility.getFullAXTree');
    const parsed = AxTreeResultSchema.safeParse(raw);
    if (!parsed.success) {
      limitations.push('Accessibility tree could not be parsed; roles and names are unknown.');
      return null;
    }
    return indexAxTree(parsed.data.nodes);
  } catch (cause) {
    limitations.push(`Accessibility tree unavailable (${toError(cause, 'capture').message}); roles and names are unknown.`);
    return null;
  }
}

/** Measure document size, URL and title in-page. */
export async function readDocumentMetrics(page: Page): Promise<Result<DocumentMetrics>> {
  try {
    const raw: unknown = await evaluateInPage(page, documentMetrics);
    const parsed = DocumentMetricsSchema.safeParse(raw);
    if (!parsed.success) return err(uidnaError('capture', 'Document metrics returned an unexpected shape'));
    return ok(parsed.data);
  } catch (cause) {
    return err(toError(cause, 'capture', 'Document metrics could not be read'));
  }
}

/**
 * Full-page PNG, clipped to `maxHeight` when the document is taller.
 * Writes the file and reports its real pixel dimensions and digest.
 * `ScreenshotFile.path` is `screenshotPath` exactly as given; the
 * application layer stores paths relative to the scan directory itself.
 */
export async function takeScreenshot(
  page: Page,
  screenshotPath: string,
  maxHeight: number,
  metrics: DocumentMetrics,
  viewport: Viewport,
): Promise<Result<{ file: ScreenshotFile; limitation: string | null }>> {
  const truncated = metrics.height > maxHeight;
  try {
    await mkdir(dirname(screenshotPath), { recursive: true });
    const bytes = await page.screenshot({
      fullPage: true,
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      timeout: 30_000,
      ...(truncated ? { clip: { x: 0, y: 0, width: Math.max(viewport.width, Math.round(metrics.width)), height: maxHeight } } : {}),
    });
    await writeFile(screenshotPath, bytes);
    const size = pngSize(bytes);
    if (size === null) return err(uidnaError('capture', 'Screenshot is not a valid PNG'));
    return ok({
      file: { path: screenshotPath, width: size.width, height: size.height, digest: sha256(bytes), truncated },
      limitation: truncated ? `Content below ${maxHeight}px was not captured in the screenshot (document height ${Math.round(metrics.height)}px).` : null,
    });
  } catch (cause) {
    return err(toError(cause, 'capture', 'Screenshot failed'));
  }
}

/** Width and height from a PNG IHDR chunk, or null when the buffer is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) if (bytes[i] !== signature[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/* ------------------------------------------------------------ in-page code */

function documentMetrics(): DocumentMetrics {
  const root = document.documentElement;
  const body = document.body as HTMLElement | null;
  return {
    width: Math.max(root.scrollWidth, root.clientWidth),
    height: root.scrollHeight,
    scrollHeight: Math.max(root.scrollHeight, body ? body.scrollHeight : 0),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    url: document.URL,
    title: document.title,
  };
}
