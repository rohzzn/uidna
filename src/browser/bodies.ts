/**
 * JSON response bodies as `data` assets (opt-in through
 * `CaptureOptions.captureBodies: 'json'`).
 *
 * `JsonBodyRecorder` watches a page's XHR and fetch responses. It keeps a
 * reference to every JSON response of the current document but reads no
 * body until a capture asks for bodies: that first request arms the
 * recorder, which then reads bodies as responses arrive (so they are
 * available even when the next capture runs much later) and backfills the
 * responses it only referenced so far from the browser's network buffer,
 * when the browser still has them. Bodies are parsed and redacted the
 * moment they are read: values of keys that match
 * `SENSITIVE_PARAM_PATTERN` at any depth become `[redacted]`, and only the
 * redacted document is kept. Entries belong to one document, like the
 * network ledger: a committed main-frame navigation clears them, and a body
 * whose read was still in progress at that moment is discarded rather than
 * attributed to the new document. A body identical (URL and content) to one
 * already kept for the document is not kept twice (polling), and at most
 * `MAX_RECORDED_BODIES` distinct bodies are kept per document; the rest are
 * counted and reported as a limitation.
 *
 * `collectDataAssets` turns recorded bodies into `CapturedAsset`s of kind
 * `data` (deduplicated by URL and content, sorted by URL then digest so the
 * order is deterministic) and writes each one to `<assetDir>/<sha256-12>.json`
 * when an asset directory is given. `digest` and `localPath` describe the
 * stored (redacted) copy; `bytes` is the size of the body as received.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Frame, Page, Request, Response } from 'playwright';
import { sha256, shortDigest } from '../domain/digest.js';
import { toError } from '../domain/errors.js';
import { classifyOrigin } from './assets.js';
import { REDACTED, redactUrl, SENSITIVE_PARAM_PATTERN } from './redact.js';
import type { CapturedAsset } from './types.js';

/** Default maximum size of one captured body. */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** How long one body read may take before it is given up (a response that never finishes must not stall a capture). */
export const BODY_READ_TIMEOUT_MS = 5000;

/** Playwright resource types whose JSON responses are captured. */
export const JSON_RESOURCE_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch']);

/** Maximum distinct bodies kept per document (a long-running page that polls must not grow without bound). */
export const MAX_RECORDED_BODIES = 500;

/** True for statuses whose response carries no body to read (redirect hops, 204 No Content, 205 Reset Content). */
export function hasNoBody(status: number): boolean {
  return (status >= 300 && status < 400) || status === 204 || status === 205;
}

/** True for `application/json` and `+json` media types (parameters and case ignored). */
export function isJsonMime(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'application/json' || mime.endsWith('+json');
}

/** Replace the values of secret-looking keys (any depth) with `[redacted]`. Arrays are walked; other values are returned as is. */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_PARAM_PATTERN.test(key) ? REDACTED : redactJson(inner);
    }
    return out;
  }
  return value;
}

/** One JSON body recorded for the current document (already redacted). */
export interface RecordedJsonBody {
  /** Response URL with secret-looking query parameters redacted. */
  readonly url: string;
  readonly method: string;
  readonly status: number;
  /** Media type without parameters. */
  readonly mime: string;
  /** Size of the body as received, in bytes. */
  readonly bytes: number;
  /** The redacted document, serialized with two-space indentation and a trailing newline. */
  readonly json: string;
  /** SHA-256 of `json`. */
  readonly digest: string;
}

/** Recorded bodies plus what could not be captured. */
export interface JsonBodyCollection {
  readonly bodies: readonly RecordedJsonBody[];
  readonly limitations: readonly string[];
}

interface Referenced {
  readonly response: Response;
  readonly url: string;
}

/** Records JSON responses of one page; attach once per page. */
export class JsonBodyRecorder {
  private armed = false;
  private maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
  /** JSON responses of the current document whose body has not been read (the recorder was not armed when they arrived). */
  private referenced: Referenced[] = [];
  private recorded: RecordedJsonBody[] = [];
  private limitations: string[] = [];
  /** Reads in progress, awaited by `collect` so a capture sees every body that already arrived. */
  private reads = new Set<Promise<void>>();
  /** Incremented by `reset`: a read started under an older generation belongs to a previous document and is discarded. */
  private generation = 0;
  /** Distinct bodies of this document not kept because `MAX_RECORDED_BODIES` was reached. */
  private dropped = 0;
  /** A main-frame document response was received; the next main-frame navigation commits it and starts a new document. */
  private documentPending = false;
  private detachFns: (() => void)[] = [];

  /** Start listening to `page`. */
  attach(page: Page): void {
    const onResponse = (response: Response): void => this.onResponse(page, response);
    const onNavigated = (frame: Frame): void => this.onNavigated(page, frame);
    page.on('response', onResponse);
    page.on('framenavigated', onNavigated);
    this.detachFns.push(() => {
      page.off('response', onResponse);
      page.off('framenavigated', onNavigated);
    });
  }

  /** Stop listening and drop everything recorded. */
  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.reset();
  }

  /** True once a capture asked for bodies; from then on bodies are read as responses arrive. */
  isArmed(): boolean {
    return this.armed;
  }

  /**
   * Arm the recorder (if it is not yet), read the bodies of the responses
   * referenced so far, wait for reads in progress and return the bodies of
   * the current document. Never throws: unreadable bodies become limitations.
   */
  async collect(maxBodyBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<JsonBodyCollection> {
    this.armed = true;
    // Reads keep the largest limit asked for so far; each capture then applies its own limit to what was recorded.
    this.maxBodyBytes = Math.max(this.maxBodyBytes, maxBodyBytes);
    const pending = this.referenced;
    this.referenced = [];
    for (const entry of pending) this.track(this.read(entry.response, entry.url));
    while (this.reads.size > 0) await Promise.all([...this.reads]);
    const bodies: RecordedJsonBody[] = [];
    const limitations = [...this.limitations];
    for (const body of this.recorded) {
      if (body.bytes > maxBodyBytes) limitations.push(`JSON body of ${body.url} not captured: ${body.bytes} bytes exceeds the ${maxBodyBytes} byte limit.`);
      else bodies.push(body);
    }
    if (this.dropped > 0) limitations.push(`${this.dropped} distinct JSON response(s) were not kept: this document already had ${MAX_RECORDED_BODIES} recorded bodies.`);
    // Reads finish in network order; the capture must not depend on it.
    limitations.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { bodies, limitations };
  }

  private onResponse(page: Page, response: Response): void {
    const request = response.request();
    if (this.isDocumentResponse(page, request, response)) {
      this.documentPending = true;
      return;
    }
    if (!JSON_RESOURCE_TYPES.has(request.resourceType())) return;
    if (!isJsonMime(response.headers()['content-type'])) return;
    if (hasNoBody(response.status())) return; // a redirect hop or an empty response has nothing to read
    const url = response.url();
    if (this.armed) this.track(this.read(response, url));
    else this.referenced.push({ response, url });
  }

  private onNavigated(page: Page, frame: Frame): void {
    if (frame !== page.mainFrame() || !this.documentPending) return;
    this.documentPending = false;
    this.reset();
  }

  private isDocumentResponse(page: Page, request: Request, response: Response): boolean {
    if (!request.isNavigationRequest()) return false;
    const status = response.status();
    if (status >= 300 && status < 400) return false; // a redirect hop does not commit a document
    try {
      return request.frame() === page.mainFrame();
    } catch {
      return false; // service-worker requests have no frame
    }
  }

  private reset(): void {
    this.generation += 1;
    this.dropped = 0;
    this.referenced = [];
    this.recorded = [];
    this.limitations = [];
    this.reads = new Set();
  }

  private track(read: Promise<void>): void {
    this.reads.add(read);
    read.finally(() => this.reads.delete(read)).catch(() => undefined);
  }

  private async read(response: Response, rawUrl: string): Promise<void> {
    const generation = this.generation;
    const url = redactUrl(rawUrl);
    const headers = response.headers();
    const declared = Number.parseInt(headers['content-length'] ?? '', 10);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      this.limitations.push(`JSON body of ${url} not captured: ${declared} bytes exceeds the ${this.maxBodyBytes} byte limit.`);
      return;
    }
    let text: string;
    try {
      text = await Promise.race([
        response.text(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`the body was not available within ${BODY_READ_TIMEOUT_MS}ms`)), BODY_READ_TIMEOUT_MS).unref();
        }),
      ]);
    } catch (cause) {
      // The document may have changed while the body was pending: the outcome then belongs to the previous document.
      if (generation === this.generation) this.limitations.push(`JSON body of ${url} not captured: ${toError(cause, 'capture').message}`);
      return;
    }
    if (generation !== this.generation) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxBodyBytes) {
      this.limitations.push(`JSON body of ${url} not captured: ${bytes} bytes exceeds the ${this.maxBodyBytes} byte limit.`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.limitations.push(`JSON body of ${url} not captured: the response is not valid JSON.`);
      return;
    }
    const json = `${JSON.stringify(redactJson(parsed), null, 2)}\n`;
    const digest = sha256(json);
    if (this.recorded.some((body) => body.url === url && body.digest === digest)) return; // the same body again (polling): one copy is enough
    if (this.recorded.length >= MAX_RECORDED_BODIES) {
      this.dropped += 1;
      return;
    }
    this.recorded.push({
      url,
      method: response.request().method(),
      status: response.status(),
      mime: headers['content-type']?.split(';')[0]?.trim() ?? 'application/json',
      bytes,
      json,
      digest,
    });
  }
}

/** Inputs for `collectDataAssets`. */
export interface DataAssetInput {
  readonly bodies: readonly RecordedJsonBody[];
  /** URL of the captured page, for the origin classification. */
  readonly pageUrl: string;
  /** Index of the first data asset (`a<index>`), so ids continue after the page's other assets. */
  readonly firstIndex: number;
  readonly assetDir?: string;
}

/** Data assets plus what could not be stored. */
export interface DataAssetCollection {
  readonly assets: readonly CapturedAsset[];
  readonly limitations: readonly string[];
}

/** Turn recorded bodies into `data` assets, writing local copies when `assetDir` is given. Never throws. */
export async function collectDataAssets(input: DataAssetInput): Promise<DataAssetCollection> {
  const limitations: string[] = [];
  let pageOrigin: string | null = null;
  try {
    pageOrigin = new URL(input.pageUrl).origin;
  } catch {
    pageOrigin = null;
  }
  const unique = new Map<string, RecordedJsonBody>();
  for (const body of input.bodies) {
    const key = `${body.url}\u0000${body.digest}`;
    if (!unique.has(key)) unique.set(key, body);
  }
  const bodies = [...unique.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  let dirReady = false;
  if (input.assetDir !== undefined && bodies.length > 0) {
    try {
      await mkdir(input.assetDir, { recursive: true });
      dirReady = true;
    } catch (cause) {
      limitations.push(`Asset directory could not be created: ${toError(cause, 'io').message}`);
    }
  }
  const assets: CapturedAsset[] = [];
  for (const [i, body] of bodies.entries()) {
    const asset: { -readonly [K in keyof CapturedAsset]: CapturedAsset[K] } = {
      id: `a${input.firstIndex + i}`,
      kind: 'data',
      url: body.url,
      origin: classifyOrigin(body.url, pageOrigin),
      mime: body.mime,
      bytes: body.bytes,
      digest: body.digest,
      usedBy: [],
      request: { method: body.method, status: body.status, mime: body.mime },
    };
    if (input.assetDir !== undefined && dirReady) {
      const filePath = join(input.assetDir, `${shortDigest(body.json)}.json`);
      try {
        await writeFile(filePath, body.json, 'utf8');
        asset.localPath = relative(dirname(input.assetDir), filePath).split(sep).join('/');
      } catch (cause) {
        limitations.push(`Data asset ${body.url} not stored: ${toError(cause, 'io').message}`);
      }
    }
    assets.push(asset);
  }
  return { assets, limitations };
}
