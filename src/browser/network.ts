/**
 * Network ledger. Records request metadata for every request a page makes
 * from the moment the session starts. URLs are redacted, bodies and headers
 * are never stored. Markers let callers slice the ledger (`markNetwork` /
 * `networkSince`), and `sinceDocumentStart` returns the entries that belong
 * to the current document (from its main-frame navigation request onward),
 * which is what a capture reports as its `network`.
 */
import type { Page, Request, Response } from 'playwright';
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import { redactUrl } from './redact.js';
import type { NetworkEntry } from './types.js';

interface MutableEntry {
  id: string;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  mime?: string;
  bytes?: number;
  startedAt: string;
  startedMs: number;
  durationMs?: number;
  fromCache?: boolean;
  failure?: string;
  settled: boolean;
  /** True for the request that started a new main-frame document (redirect hops excluded). */
  documentStart: boolean;
  /** True when UI DNA answered the request itself (never sent); its synthetic response is not recorded. */
  blocked: boolean;
}

/**
 * Failure recorded for a request of a document the browser replaced before the request
 * settled. Chromium cancels such requests and Playwright reports neither `requestfinished`
 * nor `requestfailed` for them; a non-GET one may still have reached its server.
 */
export const ABANDONED_BY_NAVIGATION = 'abandoned: its document was replaced by a navigation';

/** Records page requests; attach once per page. */
export class NetworkLedger {
  private readonly entries: MutableEntry[] = [];
  private readonly byRequest = new WeakMap<Request, MutableEntry>();
  /** Requests UI DNA answered itself, by reason; consulted whichever of `block` and the `request` event comes first. */
  private readonly blockedRequests = new WeakMap<Request, string>();
  private detachFns: (() => void)[] = [];
  private page: Page | null = null;

  constructor(private readonly clock: Clock = systemClock) {}

  /** Start listening to `page`. Idempotent per ledger: call `detach` before attaching another page. */
  attach(page: Page): void {
    this.page = page;
    const onRequest = (request: Request): void => this.onRequest(request);
    const onResponse = (response: Response): void => this.onResponse(response);
    const onFinished = (request: Request): void => this.onFinished(request);
    const onFailed = (request: Request): void => this.onFailed(request);
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    this.detachFns.push(() => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    });
  }

  /** Stop listening. */
  detach(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.page = null;
  }

  /** Opaque marker for `since`. */
  mark(): string {
    return `net:${this.entries.length}`;
  }

  /** Entries recorded after `marker` (all entries when omitted or unparseable). */
  since(marker?: string): NetworkEntry[] {
    let start = 0;
    if (marker !== undefined) {
      const match = /^net:(\d+)$/.exec(marker);
      if (match?.[1] !== undefined) start = Math.min(Number(match[1]), this.entries.length);
    }
    return this.entries.slice(start).map(toEntry);
  }

  /**
   * Entries of the current document: from the most recent main-frame
   * navigation request onward, or null when no such request was recorded
   * (the session attached to an already loaded page).
   */
  sinceDocumentStart(): NetworkEntry[] | null {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i]?.documentStart) return this.entries.slice(i).map(toEntry);
    }
    return null;
  }

  /**
   * Record that `request` was answered by UI DNA instead of being sent
   * (a blocked cross-origin navigation). The entry keeps `status: null`
   * and carries `reason` as its failure; the synthetic response is ignored.
   */
  block(request: Request, reason: string): void {
    this.blockedRequests.set(request, reason);
    const entry = this.byRequest.get(request);
    if (!entry) return;
    entry.blocked = true;
    entry.failure = reason;
  }

  /**
   * Record a request UI DNA aborted that the page's request events never
   * report: Playwright does not track the requests the inspector cannot
   * attribute (the keepalive requests and beacons of an unloading document),
   * so they have no `Request`. The entry is settled, keeps `status: null`
   * and carries `reason` as its failure.
   */
  recordUntracked(request: { readonly method: string; readonly url: string; readonly resourceType: string }, reason: string): void {
    this.entries.push({
      id: `req_${this.entries.length + 1}`,
      method: request.method,
      url: redactUrl(request.url),
      status: null,
      resourceType: request.resourceType.toLowerCase(),
      startedAt: this.clock.now().toISOString(),
      startedMs: Date.now(),
      durationMs: 0,
      failure: reason,
      settled: true,
      documentStart: false,
      blocked: true,
    });
  }

  /** Number of requests that have neither finished nor failed. */
  inFlight(): number {
    let count = 0;
    for (const entry of this.entries) if (!entry.settled) count += 1;
    return count;
  }

  /** Number of requests recorded after `marker` that have neither finished nor failed. */
  inFlightSince(marker: string): number {
    const match = /^net:(\d+)$/.exec(marker);
    const start = match?.[1] === undefined ? 0 : Math.min(Number(match[1]), this.entries.length);
    let count = 0;
    for (let i = start; i < this.entries.length; i += 1) if (!this.entries[i]?.settled) count += 1;
    return count;
  }

  private onRequest(request: Request): void {
    const now = this.clock.now();
    const entry: MutableEntry = {
      id: `req_${this.entries.length + 1}`,
      method: request.method(),
      url: redactUrl(request.url()),
      status: null,
      resourceType: request.resourceType(),
      startedAt: now.toISOString(),
      startedMs: Date.now(),
      settled: false,
      documentStart: this.isDocumentStart(request),
      blocked: false,
    };
    const blockedReason = this.blockedRequests.get(request);
    if (blockedReason !== undefined) {
      entry.blocked = true;
      entry.failure = blockedReason;
    }
    this.entries.push(entry);
    this.byRequest.set(request, entry);
  }

  private isDocumentStart(request: Request): boolean {
    if (!request.isNavigationRequest() || request.redirectedFrom() !== null) return false;
    try {
      // Service-worker requests have no frame and throw here.
      return this.page !== null && request.frame() === this.page.mainFrame();
    } catch {
      return false;
    }
  }

  private onResponse(response: Response): void {
    const request = response.request();
    const entry = this.byRequest.get(request);
    if (!entry || entry.blocked) return;
    entry.status = response.status();
    if (this.replacesMainDocument(request, entry.status)) this.abandonPending(entry);
    const headers = response.headers();
    const contentType = headers['content-type'];
    if (contentType !== undefined) {
      const mime = contentType.split(';')[0]?.trim();
      if (mime) entry.mime = mime;
    }
    const length = headers['content-length'];
    if (length !== undefined) {
      const bytes = Number.parseInt(length, 10);
      if (Number.isFinite(bytes) && bytes >= 0) entry.bytes = bytes;
    }
    if (response.fromServiceWorker()) entry.fromCache = true;
  }

  /**
   * True when `request` is a main-frame navigation whose response replaces the document:
   * not a redirect hop, and not a 204/205, which leave the current document in place.
   */
  private replacesMainDocument(request: Request, status: number): boolean {
    if (!request.isNavigationRequest()) return false;
    if (status === 204 || status === 205 || (status >= 300 && status < 400)) return false;
    try {
      // Service-worker requests have no frame and throw here.
      return this.page !== null && request.frame() === this.page.mainFrame();
    } catch {
      return false;
    }
  }

  /**
   * Settle every request still pending when a new main-frame document arrives: the browser
   * cancels the old document's requests without telling Playwright, so `inFlight` would
   * otherwise count them forever and every later stability wait would run to its timeout.
   * The new document's own requests start after its response, so none is settled here.
   */
  private abandonPending(document: MutableEntry): void {
    const now = Date.now();
    for (const entry of this.entries) {
      if (entry.settled || entry === document) continue;
      entry.settled = true;
      if (!entry.blocked && entry.failure === undefined) entry.failure = ABANDONED_BY_NAVIGATION;
      entry.durationMs = Math.max(0, now - entry.startedMs);
    }
  }

  private onFinished(request: Request): void {
    const entry = this.byRequest.get(request);
    if (!entry) return;
    // A request settled as abandoned that finishes after all was not abandoned.
    if (entry.failure === ABANDONED_BY_NAVIGATION) delete entry.failure;
    entry.settled = true;
    const timing = request.timing();
    entry.durationMs = timing.responseEnd >= 0 ? Math.max(0, Math.round(timing.responseEnd)) : Math.max(0, Date.now() - entry.startedMs);
  }

  private onFailed(request: Request): void {
    const entry = this.byRequest.get(request);
    if (!entry) return;
    entry.settled = true;
    // A blocked request fails with the browser's generic abort code; the recorded reason is UI DNA's.
    if (!entry.blocked) entry.failure = request.failure()?.errorText ?? 'failed';
    entry.durationMs = Math.max(0, Date.now() - entry.startedMs);
  }
}

function toEntry(entry: MutableEntry): NetworkEntry {
  const out: { -readonly [K in keyof NetworkEntry]: NetworkEntry[K] } = {
    id: entry.id,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    resourceType: entry.resourceType,
    startedAt: entry.startedAt,
  };
  if (entry.mime !== undefined) out.mime = entry.mime;
  if (entry.bytes !== undefined) out.bytes = entry.bytes;
  if (entry.durationMs !== undefined) out.durationMs = entry.durationMs;
  if (entry.fromCache !== undefined) out.fromCache = entry.fromCache;
  if (entry.failure !== undefined) out.failure = entry.failure;
  return out;
}
