/**
 * Asset discovery and optional storage. Assets are the resources a page
 * renders: images (`<img>`, `<picture><source>`, `<video poster>`), videos,
 * inline `<svg>`, CSS `background-image` URLs and `<link rel="icon">`.
 *
 * Storage convention: when `assetDir` is given, same-origin and
 * cross-origin http(s) assets are fetched with the page's request context
 * (cookies included, so authenticated resources resolve), written to
 * `<assetDir>/<sha256-12>.<ext>` and reported in `localPath` relative to
 * the PARENT of `assetDir` with forward slashes. For `assetDir`
 * `.uidna/scan_x/assets` the local path is `assets/<digest>.<ext>`, i.e.
 * relative to the scan directory as `CapturedAsset.localPath` documents.
 *
 * URLs are read from the raw element attributes (the stored node attributes
 * are truncated and redacted), fetched as the page saw them, and reported
 * with secret-looking query parameters redacted, like the network ledger.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import type { Page } from 'playwright';
import { sha256, shortDigest } from '../domain/digest.js';
import { toError } from '../domain/errors.js';
import { IconLinksResultSchema, ImageSizesResultSchema } from './cdp-schemas.js';
import type { RawElement, RawTree } from './dom-tree.js';
import { evaluateInPage } from './in-page.js';
import type { BuiltState } from './nodes.js';
import { redactPageUrl } from './redact.js';
import type { CapturedAsset, NetworkEntry } from './types.js';

/** Default maximum stored bytes per asset. */
export const DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024;

/** Inputs for `collectAssets`. */
export interface AssetCollectionInput {
  readonly page: Page;
  readonly state: BuiltState;
  readonly tree: RawTree;
  readonly pageUrl: string;
  readonly network: readonly NetworkEntry[];
  readonly assetDir?: string;
  readonly maxAssetBytes?: number;
}

/** Assets plus what could not be done. */
export interface AssetCollection {
  readonly assets: readonly CapturedAsset[];
  readonly limitations: readonly string[];
}

interface Draft {
  id: string;
  kind: CapturedAsset['kind'];
  url: string;
  origin: CapturedAsset['origin'];
  mime?: string;
  bytes?: number;
  digest?: string;
  width?: number;
  height?: number;
  usedBy: string[];
  localPath?: string;
  /** Node ids of `<img>` elements, for natural size lookup. */
  imageNodeIds: string[];
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'apng', 'jfif', 'pjpeg']);
const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'ogg', 'mov', 'm4v']);
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** Discover (and optionally store) the assets referenced by a capture. Never throws. */
export async function collectAssets(input: AssetCollectionInput): Promise<AssetCollection> {
  const limitations: string[] = [];
  const drafts = new Map<string, Draft>();
  let pageOrigin: string | null = null;
  try {
    pageOrigin = new URL(input.pageUrl).origin;
  } catch {
    pageOrigin = null;
  }
  const register = (rawUrl: string, nodeId: string | null, kindHint: CapturedAsset['kind'] | null, imageNode: boolean): void => {
    const url = resolveUrl(rawUrl, input.pageUrl);
    if (url === null) return;
    let draft = drafts.get(url);
    if (!draft) {
      draft = {
        id: `a${drafts.size}`,
        kind: kindHint ?? classifyKind(url, undefined),
        url,
        origin: classifyOrigin(url, pageOrigin),
        usedBy: [],
        imageNodeIds: [],
      };
      drafts.set(url, draft);
    }
    if (nodeId !== null && !draft.usedBy.includes(nodeId)) draft.usedBy.push(nodeId);
    if (imageNode && nodeId !== null) draft.imageNodeIds.push(nodeId);
  };

  const parentTag = new Map<string, string>();
  for (const node of input.state.nodes) parentTag.set(node.id, node.tag);
  for (const node of input.state.nodes) {
    const rawIndex = input.state.elementIndexByNodeId.get(node.id);
    const element = rawIndex === undefined ? undefined : input.tree.elements[rawIndex];
    const attr = (name: string): string | undefined => (element === undefined ? undefined : rawAttribute(element, name));
    const parent = node.parentId === null ? null : (parentTag.get(node.parentId) ?? null);
    switch (node.tag) {
      case 'img': {
        const candidate = element?.currentSrc ?? firstSrcsetCandidate(attr('srcset')) ?? attr('src');
        if (candidate !== undefined && candidate !== '') register(candidate, node.id, null, true);
        break;
      }
      case 'source': {
        const candidate = firstSrcsetCandidate(attr('srcset')) ?? attr('src');
        if (candidate !== undefined && candidate !== '') register(candidate, node.id, parent === 'video' || parent === 'audio' ? 'video' : null, false);
        break;
      }
      case 'video': {
        const src = attr('src');
        const poster = attr('poster');
        if (src) register(src, node.id, 'video', false);
        if (poster) register(poster, node.id, 'image', false);
        break;
      }
      case 'svg': {
        if (parent !== 'svg') {
          const url = `inline:${node.id}`;
          drafts.set(url, { id: `a${drafts.size}`, kind: 'svg', url, origin: 'inline', usedBy: [node.id], imageNodeIds: [] });
        }
        break;
      }
      default:
        break;
    }
    const style = input.state.styles[node.styleId];
    const background = style?.['background-image'];
    if (background !== undefined && background !== 'none') {
      for (const url of extractCssUrls(background)) register(url, node.id, null, false);
    }
  }

  // Icons live in <head>, which is not part of the node list.
  try {
    const raw: unknown = await evaluateInPage(input.page, readIconLinks);
    const parsed = IconLinksResultSchema.safeParse(raw);
    if (parsed.success) for (const href of parsed.data) register(href, null, 'icon', false);
    else limitations.push('Icon links could not be read: unexpected in-page result.');
  } catch (cause) {
    limitations.push(`Icon links could not be read: ${toError(cause, 'capture').message}`);
  }

  // Natural sizes of <img> elements, measured from the DOM.
  const imageDrafts = [...drafts.values()].filter((draft) => draft.imageNodeIds.length > 0);
  if (imageDrafts.length > 0) {
    const pathById = new Map(input.state.nodes.map((node) => [node.id, node.path] as const));
    const paths = imageDrafts.map((draft) => pathById.get(draft.imageNodeIds[0] ?? '') ?? '');
    try {
      const raw: unknown = await evaluateInPage(input.page, readImageSizes, paths);
      const parsed = ImageSizesResultSchema.safeParse(raw);
      if (parsed.success) {
        parsed.data.forEach((size, i) => {
          const draft = imageDrafts[i];
          if (!draft || size === null || size.width <= 0 || size.height <= 0) return;
          draft.width = Math.round(size.width);
          draft.height = Math.round(size.height);
        });
      }
    } catch (cause) {
      limitations.push(`Image dimensions could not be read: ${toError(cause, 'capture').message}`);
    }
  }

  // Mime and size from the network ledger when the page already loaded the asset. Ledger URLs are redacted.
  const byUrl = new Map<string, NetworkEntry>();
  for (const entry of input.network) if (entry.status !== null && entry.status >= 200 && entry.status < 300 && !byUrl.has(entry.url)) byUrl.set(entry.url, entry);
  for (const draft of drafts.values()) {
    const entry = byUrl.get(redactPageUrl(draft.url));
    if (!entry) continue;
    if (entry.mime !== undefined) {
      draft.mime = entry.mime;
      draft.kind = draft.kind === 'other' ? classifyKind(draft.url, entry.mime) : draft.kind;
    }
    if (entry.bytes !== undefined) draft.bytes = entry.bytes;
  }

  if (input.assetDir !== undefined) {
    const stored = await storeAssets(input.page, [...drafts.values()], input.assetDir, input.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES);
    limitations.push(...stored);
  }

  const assets: CapturedAsset[] = [...drafts.values()].map((draft) => {
    const asset: { -readonly [K in keyof CapturedAsset]: CapturedAsset[K] } = {
      id: draft.id,
      kind: draft.kind,
      url: redactPageUrl(draft.url),
      origin: draft.origin,
      usedBy: draft.usedBy,
    };
    if (draft.mime !== undefined) asset.mime = draft.mime;
    if (draft.bytes !== undefined) asset.bytes = draft.bytes;
    if (draft.digest !== undefined) asset.digest = draft.digest;
    if (draft.width !== undefined) asset.width = draft.width;
    if (draft.height !== undefined) asset.height = draft.height;
    if (draft.localPath !== undefined) asset.localPath = draft.localPath;
    return asset;
  });
  return { assets, limitations };
}

async function storeAssets(page: Page, drafts: Draft[], assetDir: string, maxBytes: number): Promise<string[]> {
  const limitations: string[] = [];
  try {
    await mkdir(assetDir, { recursive: true });
  } catch (cause) {
    return [`Asset directory could not be created: ${toError(cause, 'io').message}`];
  }
  const parent = dirname(assetDir);
  for (const draft of drafts) {
    if (draft.origin !== 'same-origin' && draft.origin !== 'cross-origin') continue;
    if (!/^https?:/i.test(draft.url)) continue;
    if (draft.bytes !== undefined && draft.bytes > maxBytes) {
      limitations.push(`Asset ${draft.url} not stored: ${draft.bytes} bytes exceeds the ${maxBytes} byte limit.`);
      continue;
    }
    try {
      const response = await page.request.get(draft.url, { timeout: 15_000, maxRedirects: 5 });
      if (!response.ok()) {
        limitations.push(`Asset ${draft.url} not stored: HTTP ${response.status()}.`);
        continue;
      }
      const headers = response.headers();
      const declared = Number.parseInt(headers['content-length'] ?? '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        limitations.push(`Asset ${draft.url} not stored: ${declared} bytes exceeds the ${maxBytes} byte limit.`);
        continue;
      }
      const body = await response.body();
      if (body.length > maxBytes) {
        limitations.push(`Asset ${draft.url} not stored: ${body.length} bytes exceeds the ${maxBytes} byte limit.`);
        continue;
      }
      const mime = headers['content-type']?.split(';')[0]?.trim();
      if (mime && draft.mime === undefined) draft.mime = mime;
      if (draft.kind === 'other') draft.kind = classifyKind(draft.url, draft.mime);
      const digest = sha256(body);
      const ext = extensionFor(draft.url, draft.mime);
      const fileName = `${shortDigest(body)}.${ext}`;
      const filePath = join(assetDir, fileName);
      await writeFile(filePath, body);
      draft.bytes = body.length;
      draft.digest = digest;
      draft.localPath = relative(parent, filePath).split(sep).join('/');
    } catch (cause) {
      limitations.push(`Asset ${draft.url} not stored: ${toError(cause, 'io').message}`);
    }
  }
  return limitations;
}

/** First value of a raw (unfiltered, untruncated) attribute, matched case-insensitively. */
export function rawAttribute(element: Pick<RawElement, 'attrs'>, name: string): string | undefined {
  for (const [attrName, value] of element.attrs) if (attrName.toLowerCase() === name) return value;
  return undefined;
}

/** Resolve a raw attribute URL against the page URL; null when invalid. */
export function resolveUrl(raw: string, base: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/** Origin class of an asset URL relative to the page origin. */
export function classifyOrigin(url: string, pageOrigin: string | null): CapturedAsset['origin'] {
  if (url.startsWith('data:')) return 'data';
  if (url.startsWith('inline:')) return 'inline';
  try {
    const origin = new URL(url).origin;
    if (pageOrigin !== null && origin === pageOrigin) return 'same-origin';
    return 'cross-origin';
  } catch {
    return 'cross-origin';
  }
}

/** Asset kind from the URL extension or mime type. */
export function classifyKind(url: string, mime: string | undefined): CapturedAsset['kind'] {
  const lowerMime = mime?.toLowerCase() ?? '';
  if (lowerMime === 'image/svg+xml') return 'svg';
  if (lowerMime.startsWith('image/')) return 'image';
  if (lowerMime.startsWith('font/') || lowerMime.includes('font')) return 'font';
  if (lowerMime.startsWith('video/')) return 'video';
  const ext = urlExtension(url);
  if (ext === 'svg') return 'svg';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ext === 'ico') return 'icon';
  if (url.startsWith('data:image/svg')) return 'svg';
  if (url.startsWith('data:image/')) return 'image';
  if (url.startsWith('data:font/')) return 'font';
  return 'other';
}

/** The first candidate URL of a `srcset` attribute. */
export function firstSrcsetCandidate(srcset: string | undefined): string | undefined {
  if (srcset === undefined) return undefined;
  const first = srcset.split(',')[0]?.trim();
  if (!first) return undefined;
  const url = first.split(/\s+/)[0];
  return url === undefined || url === '' ? undefined : url;
}

/** URLs inside `url(...)` tokens of a CSS value. */
export function extractCssUrls(value: string): string[] {
  const urls: string[] = [];
  const pattern = /url\((["']?)([^"')]+)\1\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const url = match[2]?.trim();
    if (url) urls.push(url);
  }
  return urls;
}

function urlExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return extname(basename(pathname)).slice(1).toLowerCase();
  } catch {
    return '';
  }
}

function extensionFor(url: string, mime: string | undefined): string {
  const fromUrl = urlExtension(url);
  if (fromUrl !== '' && /^[a-z0-9]{1,8}$/.test(fromUrl)) return fromUrl;
  const fromMime = mime === undefined ? undefined : MIME_EXTENSIONS[mime.toLowerCase()];
  return fromMime ?? 'bin';
}

/* ------------------------------------------------------------ in-page code */

function readIconLinks(): string[] {
  const links = Array.from(document.querySelectorAll('link[rel~="icon"]'));
  const hrefs: string[] = [];
  for (const link of links) {
    if (link instanceof HTMLLinkElement && link.href !== '') hrefs.push(link.href);
  }
  return hrefs;
}

function readImageSizes(paths: string[]): ({ width: number; height: number } | null)[] {
  const resolve = (path: string): Element | null => {
    let el: Element | null = document.body;
    if (path === '') return el;
    for (const part of path.split('/')) {
      if (el === null) return null;
      el = el.children[Number(part)] ?? null;
    }
    return el;
  };
  return paths.map((path) => {
    const el = resolve(path);
    if (!(el instanceof HTMLImageElement)) return null;
    return { width: el.naturalWidth, height: el.naturalHeight };
  });
}
