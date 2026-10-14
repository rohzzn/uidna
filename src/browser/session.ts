/**
 * `BrowserSession` over a Playwright page. One class serves both modes:
 * launch (UI DNA owns the browser) and cdp (attached to the user's Chrome,
 * where `close()` only detaches). Navigation honours robots.txt and a
 * per-origin rate limit in launch mode; dialogs are auto-dismissed and
 * reported; actions never leave the page's origin: while an action runs,
 * cross-origin main-frame navigations (of this page or of a page the action
 * opens) are aborted before any request reaches the other origin, and pages
 * the action still manages to open are closed. Same-origin document
 * navigations are blocked too, except for a click with
 * `allowNavigation: 'same-origin'` (crawling), which follows one GET
 * navigation (never a form POST) and honours robots.txt and the per-origin
 * rate limit on the way. Fill and submit actions additionally abort every
 * non-GET request they trigger and report it in `blockedRequests`;
 * `holdNonGetGuard()` keeps that guard up between actions as well (a form
 * chain, from its first step to the fresh load that reverts it), including
 * for the beacons and keepalive requests of a document being unloaded, which
 * Playwright neither reports nor routes.
 */
import { readLayoutSignature, readStyleConditions, type LayoutSignatureReading, type StyleConditions } from './responsive.js';
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, ElementHandle, Frame, Locator, Page, Request, Route } from 'playwright';
import type { Viewport } from '@rohzzn/uidna-schema';
import type { Clock } from '../domain/clock.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { JsonBodyRecorder } from './bodies.js';
import { capturePage, snapshotPage, type CaptureContext } from './capture.js';
import { ControlFactsSchema, RequestPausedSchema, SubmitResultSchema } from './cdp-schemas.js';
import { planFill, readControlFacts, submitFormAt } from './forms.js';
import { addInitScriptInPage, evaluateHandleInPage, evaluateInPage } from './in-page.js';
import { NetworkLedger } from './network.js';
import { redactUrl } from './redact.js';
import { RobotsCache } from './robots.js';
import type {
  ActionLocator,
  ActionOutcome,
  BrowserMode,
  BrowserSession,
  CaptureOptions,
  CapturedState,
  NavigateOptions,
  NavigationOutcome,
  NetworkEntry,
  NonGetGuardHold,
  PageSnapshot,
  StabilityOptions,
  StabilityOutcome,
  UiAction,
} from './types.js';

/** Default per-origin delay between navigations for non-local hosts. */
export const DEFAULT_RATE_LIMIT_MS = 1000;

/** Default timeout for one action. */
export const DEFAULT_ACTION_TIMEOUT_MS = 5000;

/** Timeout for an action whose target is hidden when the action starts (it may still appear, briefly). */
export const HIDDEN_TARGET_TIMEOUT_MS = 1000;

/** Prefix of every `NetworkEntry.failure` UI DNA sets on a request it aborted instead of sending. */
export const BLOCKED_BY_UIDNA = 'blocked by UI DNA';

/** `NetworkEntry.failure` of a document navigation (same- or cross-origin) that an action triggered and UI DNA aborted instead of sending. */
export const BLOCKED_NAVIGATION_FAILURE = `${BLOCKED_BY_UIDNA}: document navigation during an action`;

/** `NetworkEntry.failure` of a non-GET request (form submission, XHR, fetch, beacon) that a fill/submit action triggered, or that was made while a non-GET guard was held, and UI DNA aborted instead of sending. */
export const BLOCKED_REQUEST_FAILURE = `${BLOCKED_BY_UIDNA}: non-GET request during a fill/submit action`;

/** `NetworkEntry.failure` prefix of a same-origin navigation a click was allowed to follow but robots.txt disallows. */
export const ROBOTS_BLOCKED_NAVIGATION_FAILURE = `${BLOCKED_BY_UIDNA}: robots.txt disallows the navigation`;

/** True when UI DNA aborted the request instead of sending it: it never reached a server. */
export function blockedByUiDna(entry: Pick<NetworkEntry, 'failure'>): boolean {
  return entry.failure?.startsWith(BLOCKED_BY_UIDNA) === true;
}

/** How long a fill/submit action waits for the requests it triggered to settle, so every one of them met the guard before it is removed. */
export const ACTION_SETTLE_TIMEOUT_MS = 2000;

/** How long a click with `allowNavigation` waits for the navigation it was allowed to follow to commit. */
export const NAVIGATION_COMMIT_TIMEOUT_MS = 10_000;

/** Limitation recorded on a capture whose document has no recorded navigation request. */
export const NETWORK_INCOMPLETE_LIMITATION =
  'Network entries may be incomplete: no main-frame navigation request was recorded for the current document (requests made before the session started are not observed).';

/** What a session needs from the provider. */
export interface SessionDeps {
  readonly browser: Browser;
  readonly page: Page;
  readonly mode: BrowserMode;
  readonly clock: Clock;
  readonly viewport: Viewport;
  /** Honor robots.txt before navigating (launch mode only). */
  readonly honorRobots: boolean;
  /** Minimum delay between navigations to the same origin; undefined picks 0 for local hosts and 1000 otherwise. */
  readonly rateLimitMs?: number;
  /** False when the browser runs without its sandbox. */
  readonly sandboxed?: boolean;
  /** True when `close()` should close the browser (launch mode). */
  readonly ownsBrowser: boolean;
  readonly robots?: RobotsCache;
}

type AriaRole = Parameters<Page['getByRole']>[0];
type Actionable =
  | { readonly kind: 'handle'; readonly element: ElementHandle; readonly path: string }
  | { readonly kind: 'locator'; readonly locator: Locator };

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const NODE_PATH_PATTERN = /^(\d+(\/\d+)*)?$/;

/** New session id, e.g. `sess_3f9a1c7b`. */
export function newSessionId(): string {
  return `sess_${randomBytes(4).toString('hex')}`;
}

/** True for hosts that need no rate limit. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

/** Playwright-backed `BrowserSession`. Create through `createPlaywrightProvider()`. */
/** How long `act()` waits for the popup report of a page whose request the guard already saw. */
const POPUP_REPORT_TIMEOUT_MS = 2000;

export class PlaywrightSession implements BrowserSession {
  readonly id: string = newSessionId();
  readonly mode: BrowserMode;
  private readonly page: Page;
  private readonly browser: Browser;
  private readonly clock: Clock;
  private readonly ledger: NetworkLedger;
  private readonly bodies = new JsonBodyRecorder();
  private readonly robots: RobotsCache;
  private readonly honorRobots: boolean;
  private readonly rateLimitMs: number | undefined;
  readonly sandboxed: boolean | undefined;
  /** True when `close()` closes the browser (launch mode); false when it only disconnects (cdp mode). */
  readonly ownsBrowser: boolean;
  private currentViewport: Viewport;
  private cdpSession: CDPSession | null = null;
  private cdpFailed = false;
  private readonly dialogs: string[] = [];
  private readonly lastNavigationAt = new Map<string, number>();
  /** Node id → node path of the last `capture()`; valid only while the captured document is still current. */
  private lastCapturePaths = new Map<string, string>();
  /** Non-GET guards currently held (`holdNonGetGuard`); while any is, every action blocks non-GET requests. */
  private heldGuards = 0;
  private closed = false;

  constructor(deps: SessionDeps) {
    this.mode = deps.mode;
    this.page = deps.page;
    this.browser = deps.browser;
    this.clock = deps.clock;
    this.currentViewport = deps.viewport;
    this.honorRobots = deps.honorRobots;
    this.rateLimitMs = deps.rateLimitMs;
    this.sandboxed = deps.sandboxed;
    this.ownsBrowser = deps.ownsBrowser;
    this.robots = deps.robots ?? new RobotsCache();
    this.ledger = new NetworkLedger(deps.clock);
    this.ledger.attach(deps.page);
    this.bodies.attach(deps.page);
    deps.page.on('dialog', (dialog) => {
      this.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      dialog.dismiss().catch(() => undefined);
    });
    addInitScriptInPage(deps.page, installMutationCounter).catch(() => undefined);
  }

  /** @inheritdoc */
  async navigate(url: string, options: NavigateOptions = {}): Promise<Result<NavigationOutcome>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    let target: URL;
    try {
      target = new URL(url);
    } catch (cause) {
      return err(toError(cause, 'validation', `Invalid URL ${url}`));
    }
    if (!['http:', 'https:', 'file:', 'about:'].includes(target.protocol)) {
      return err(uidnaError('validation', `Unsupported URL scheme ${target.protocol}`, { details: { url } }));
    }
    const isHttp = target.protocol === 'http:' || target.protocol === 'https:';
    if (this.mode === 'launch' && this.honorRobots && isHttp) {
      const decision = await this.robots.check(target.href);
      if (!decision.ok) return decision;
    }
    if (isHttp) await this.applyRateLimit(target);
    try {
      const response = await this.page.goto(target.href, { waitUntil: options.waitUntil ?? 'load', timeout: options.timeoutMs ?? 30_000 });
      const finalUrl = this.page.url();
      const redirected = (response?.request().redirectedFrom() ?? null) !== null || stripHash(finalUrl) !== stripHash(target.href);
      return ok({ url: finalUrl, status: response?.status() ?? null, redirected });
    } catch (cause) {
      return err(toError(cause, 'navigation', `Navigation to ${target.href} failed`));
    }
  }

  /** @inheritdoc */
  async reload(options: NavigateOptions = {}): Promise<Result<NavigationOutcome>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    try {
      const response = await this.page.reload({ waitUntil: options.waitUntil ?? 'load', timeout: options.timeoutMs ?? 30_000 });
      return ok({ url: this.page.url(), status: response?.status() ?? null, redirected: false });
    } catch (cause) {
      return err(toError(cause, 'navigation', 'Reload failed'));
    }
  }

  /** @inheritdoc */
  async setViewport(viewport: Viewport): Promise<Result<void>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    try {
      await this.page.setViewportSize({ width: viewport.width, height: viewport.height });
      this.currentViewport = { width: viewport.width, height: viewport.height };
      return ok(undefined);
    } catch (cause) {
      return err(toError(cause, 'browser', 'Viewport could not be set'));
    }
  }

  /** @inheritdoc */
  async layoutSignature(options: { readonly keyAttribute?: string; readonly maxNodes?: number } = {}): Promise<Result<LayoutSignatureReading>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    return readLayoutSignature(this.page, options);
  }

  /** @inheritdoc */
  async readStyleConditions(): Promise<Result<StyleConditions>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    return readStyleConditions(this.page);
  }

  /** @inheritdoc */
  viewport(): Viewport {
    return this.currentViewport;
  }

  /** @inheritdoc */
  currentUrl(): string {
    return this.page.url();
  }

  /** @inheritdoc */
  async capture(options: CaptureOptions = {}): Promise<Result<CapturedState>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    const result = await capturePage(this.captureContext(), options);
    if (result.ok) {
      this.lastCapturePaths = new Map(result.value.nodes.map((node) => [node.id, node.path] as const));
      // Marks the captured document so its node ids are refused once the document has been replaced.
      await evaluateInPage(this.page, setCaptureMarker).catch(() => undefined);
    }
    return result;
  }

  /** @inheritdoc */
  async snapshot(): Promise<Result<PageSnapshot>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    return snapshotPage(this.captureContext());
  }

  /** @inheritdoc */
  async act(action: UiAction): Promise<Result<ActionOutcome>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    const started = Date.now();
    const dialogsStart = this.dialogs.length;
    const before = this.page.url();
    const originBefore = originOf(before);
    const networkMarker = this.ledger.mark();
    // A click may follow one same-origin document navigation (crawled pages); nothing else ever leaves the document.
    const followSameOrigin = action.kind === 'click' && action.allowNavigation === 'same-origin';
    // Fill and submit actions never let a non-GET request (form submission, XHR, fetch) reach any server, and no
    // action does while a guard is held. This route takes precedence over the held guard's (Playwright runs the
    // handler added last first) and only continues GET requests, so nesting it lets nothing through.
    const blockNonGet = action.kind === 'fill' || action.kind === 'submit' || this.heldGuards > 0;
    let navigated = false;
    const blocked: string[] = [];
    let blockedDetail = '';
    const blockedRequests: string[] = [];
    let popups = 0;
    // A popup's first request reaches the guard before Playwright reports the popup; under load the report can
    // arrive after the settle window, so a seen request makes `act()` wait for it.
    let otherPageRequests = 0;
    const popupSeen = deferred();
    const nav: { commit: Deferred | null } = { commit: null };
    const onNavigated = (frame: Frame): void => {
      if (frame !== this.page.mainFrame()) return;
      navigated = true;
      nav.commit?.resolve();
    };
    const onPopup = (popup: Page): void => {
      popups += 1;
      popupSeen.resolve();
      popup.close().catch(() => undefined);
    };
    const abort = async (route: Route): Promise<void> => {
      // `aborted` (net::ERR_ABORTED) cancels the navigation like `window.stop()`: no error page, and Playwright
      // clears its pending-navigation state so later actions do not wait on it. Other abort codes commit an error page.
      await route.abort('aborted').catch(() => undefined);
    };
    const guard = async (route: Route): Promise<void> => {
      const request = route.request();
      const url = request.url();
      const target = classifyNavigation(request, this.page);
      const sameOrigin = originOf(url) === originBefore;
      const nonGet = request.method().toUpperCase() !== 'GET';
      // Every document navigation of this page that an action requests is blocked, same-origin or not (hash changes
      // never issue a request and are reported as navigated), unless the click may follow a same-origin GET that
      // robots.txt allows (a POST form submission is never followed, whatever the origin); other pages (popups) are
      // blocked only cross-origin and closed either way.
      let navigationBlock: string | null = null;
      if (target === 'other-page') otherPageRequests += 1;
      if (target === 'session') {
        if (!(followSameOrigin && sameOrigin && !nonGet)) {
          navigationBlock = BLOCKED_NAVIGATION_FAILURE;
        } else if (this.mode === 'launch' && this.honorRobots) {
          const decision = await this.robots.check(url);
          if (!decision.ok) {
            navigationBlock = `${ROBOTS_BLOCKED_NAVIGATION_FAILURE} (${decision.error.message})`;
            if (blockedDetail === '') blockedDetail = ` by robots.txt (${decision.error.message})`;
          }
        }
      } else if (target === 'other-page' && !sameOrigin) {
        navigationBlock = BLOCKED_NAVIGATION_FAILURE;
      }
      if (navigationBlock !== null) {
        blocked.push(redactUrl(url));
        if (blockNonGet && nonGet) blockedRequests.push(redactUrl(url));
        this.ledger.block(request, navigationBlock);
        nav.commit?.resolve();
        await abort(route);
        return;
      }
      if (target === 'session') {
        // An allowed navigation: `act()` waits for it to commit (or for a later hop to be blocked) before it looks at the page.
        nav.commit ??= deferred();
        // It is a navigation like `navigate()`: the same per-origin rate limit applies, once per navigation (not per redirect hop).
        if (request.redirectedFrom() === null) {
          const parsed = parseUrl(url);
          if (parsed !== null) await this.applyRateLimit(parsed);
        }
      } else if (blockNonGet && nonGet) {
        blockedRequests.push(redactUrl(url));
        this.ledger.block(request, BLOCKED_REQUEST_FAILURE);
        await abort(route);
        return;
      }
      await route.continue().catch(() => undefined);
    };
    const router = this.router();
    let routed = false;
    this.page.on('framenavigated', onNavigated);
    this.page.on('popup', onPopup);
    try {
      await router.route('**/*', guard);
      routed = true;
      const performed = await this.perform(action);
      await this.page.waitForTimeout(100);
      if (otherPageRequests > 0 && popups === 0) await Promise.race([popupSeen.promise, sleep(POPUP_REPORT_TIMEOUT_MS)]);
      if (nav.commit !== null) await Promise.race([nav.commit.promise, sleep(NAVIGATION_COMMIT_TIMEOUT_MS)]);
      if (blockNonGet) await this.settleRequests(networkMarker);
      if (navigated || this.page.url() !== before) {
        navigated = true;
        await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
      }
      let url = this.page.url();
      let outcome = performed;
      if (navigated && originOf(url) !== originBefore) {
        // Defence in depth: a cross-origin document committed although the guard should have aborted its request.
        const destination = redactUrl(url);
        let wentBack = false;
        try {
          await this.page.goBack({ waitUntil: 'load', timeout: 10_000 });
          wentBack = true;
        } catch {
          wentBack = false;
        }
        url = this.page.url();
        outcome = {
          performed: false,
          reason: wentBack
            ? `The action navigated cross-origin to ${destination}; navigated back to ${url}.`
            : `The action navigated cross-origin to ${destination}; navigating back failed, the page is now at ${url}.`,
        };
      } else if (blocked.length > 0) {
        outcome = {
          performed: false,
          reason: `The action would have navigated to ${blocked[0] ?? ''}; the navigation was blocked${blockedDetail} and the page stayed at ${url}.`,
        };
      } else if (popups > 0) {
        outcome = { performed: false, reason: `The action opened ${popups} new page(s); they were closed because UI DNA explores one page at a time.` };
      }
      const result: { -readonly [K in keyof ActionOutcome]: ActionOutcome[K] } = {
        performed: outcome.performed,
        navigated,
        url,
        dialogs: this.dialogs.slice(dialogsStart),
        durationMs: Date.now() - started,
      };
      if (outcome.reason !== undefined) result.reason = outcome.reason;
      if (blocked.length > 0) result.blockedNavigation = blocked[0] ?? '';
      if (blockNonGet) result.blockedRequests = blockedRequests;
      return ok(result);
    } catch (cause) {
      return err(toError(cause, 'browser', 'Action failed'));
    } finally {
      this.page.off('framenavigated', onNavigated);
      this.page.off('popup', onPopup);
      if (routed) await router.unroute('**/*', guard).catch(() => undefined);
    }
  }

  /** @inheritdoc */
  async holdNonGetGuard(): Promise<Result<NonGetGuardHold>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    const marker = this.ledger.mark();
    const router = this.router();
    // Requests Playwright tracks are routed: a non-GET one is aborted and recorded with UI DNA's reason.
    const guard = async (route: Route): Promise<void> => {
      const request = route.request();
      if (request.method().toUpperCase() === 'GET') {
        await route.continue().catch(() => undefined);
        return;
      }
      this.ledger.block(request, BLOCKED_REQUEST_FAILURE);
      await route.abort('aborted').catch(() => undefined);
    };
    let interceptor: CDPSession | null = null;
    try {
      await router.route('**/*', guard);
      // Requests the inspector cannot attribute (the beacons and keepalive requests of a document being unloaded)
      // carry no network id: Playwright continues them without a route or a request event. A CDP session of the
      // guard's own intercepts every request of the page after (or before) Playwright's and fails those.
      const cdp = await this.page.context().newCDPSession(this.page);
      interceptor = cdp;
      cdp.on('Fetch.requestPaused', (payload) => this.onRequestPaused(cdp, payload));
      await cdp.send('Fetch.enable');
    } catch (cause) {
      await router.unroute('**/*', guard).catch(() => undefined);
      if (interceptor !== null) await interceptor.detach().catch(() => undefined);
      return err(toError(cause, 'browser', 'The non-GET guard could not be installed'));
    }
    const cdp = interceptor;
    this.heldGuards += 1;
    let released = false;
    return ok({
      release: async () => {
        if (released) return;
        released = true;
        try {
          // Like `act()`: requests the page has just started meet the guard before it is removed.
          await this.page.waitForTimeout(100);
          await this.settleRequests(marker);
        } catch {
          // The page is gone: nothing is left to guard.
        }
        this.heldGuards = Math.max(0, this.heldGuards - 1);
        await cdp.send('Fetch.disable').catch(() => undefined);
        await cdp.detach().catch(() => undefined);
        await router.unroute('**/*', guard).catch(() => undefined);
      },
    });
  }

  /**
   * `Fetch.requestPaused` on a held guard's own CDP session: a non-GET request
   * without a network id (untracked, so never routed) is failed and recorded;
   * every other request is continued, and the route sees the tracked ones.
   */
  private onRequestPaused(cdp: CDPSession, payload: unknown): void {
    const event = RequestPausedSchema.safeParse(payload);
    if (!event.success) return;
    const { requestId, request, networkId, resourceType } = event.data;
    if (networkId === undefined && request.method.toUpperCase() !== 'GET') {
      this.ledger.recordUntracked({ method: request.method, url: request.url, resourceType }, BLOCKED_REQUEST_FAILURE);
      cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => undefined);
      return;
    }
    cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
  }

  /** @inheritdoc */
  async waitForStability(options: StabilityOptions = {}): Promise<Result<StabilityOutcome>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    const timeoutMs = options.timeoutMs ?? 5000;
    const quietMs = options.quietMs ?? 300;
    const started = Date.now();
    try {
      let lastCount = await this.readMutationCount();
      let quietSince = Date.now();
      while (Date.now() - started < timeoutMs) {
        const pending = this.ledger.inFlight();
        const quietFor = Date.now() - quietSince;
        if (pending === 0 && quietFor >= quietMs) {
          return ok({ stable: true, waitedMs: Date.now() - started, pendingRequests: 0 });
        }
        await this.page.waitForTimeout(Math.min(50, Math.max(1, quietMs - quietFor)));
        const count = await this.readMutationCount();
        if (count !== lastCount) {
          lastCount = count;
          quietSince = Date.now();
        }
        if (pending > 0) quietSince = Math.max(quietSince, Date.now() - quietMs);
      }
      return ok({ stable: false, waitedMs: Date.now() - started, pendingRequests: this.ledger.inFlight() });
    } catch (cause) {
      return err(toError(cause, 'browser', 'Stability wait failed'));
    }
  }

  /** @inheritdoc */
  async stabilize(): Promise<Result<void>> {
    if (this.closed) return err(uidnaError('browser', 'Session is closed'));
    try {
      await this.page.emulateMedia({ reducedMotion: 'reduce' });
      await evaluateInPage(this.page, injectStabilizeStyle);
      await evaluateInPage(this.page, waitForFonts);
      return ok(undefined);
    } catch (cause) {
      return err(toError(cause, 'browser', 'Stabilize failed'));
    }
  }

  /** @inheritdoc */
  networkSince(marker?: string): readonly NetworkEntry[] {
    return this.ledger.since(marker);
  }

  /** @inheritdoc */
  markNetwork(): string {
    return this.ledger.mark();
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ledger.detach();
    this.bodies.detach();
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch {
        // already gone
      }
      this.cdpSession = null;
    }
    if (!this.ownsBrowser) {
      // Leave the user's tab as we found it: drop the stabilization style we injected.
      try {
        await evaluateInPage(this.page, removeStabilizeStyle);
      } catch {
        // the page may be gone
      }
    }
    try {
      // In cdp mode this only disconnects from the user's browser (verified in provider.test.ts); in launch mode it closes it.
      await this.browser.close();
    } catch {
      // never throw from close
    }
  }

  private captureContext(): CaptureContext {
    const documentNetwork = this.ledger.sinceDocumentStart();
    return {
      page: this.page,
      cdp: (reset) => this.cdp(reset ?? false),
      clock: this.clock,
      viewport: this.currentViewport,
      network: documentNetwork ?? this.ledger.since(),
      networkLimitation: documentNetwork === null ? NETWORK_INCOMPLETE_LIMITATION : null,
      jsonBodies: (maxBodyBytes) => this.bodies.collect(maxBodyBytes),
    };
  }

  /** Where request guards are installed: in launch mode the context is ours, so popups are guarded too; in cdp mode only this page is touched. */
  private router(): Page | BrowserContext {
    return this.ownsBrowser ? this.page.context() : this.page;
  }

  /** Wait (bounded) until the requests recorded since `marker` have finished or failed, so a blocked request is never left pending. */
  private async settleRequests(marker: string): Promise<void> {
    const started = Date.now();
    while (this.ledger.inFlightSince(marker) > 0 && Date.now() - started < ACTION_SETTLE_TIMEOUT_MS) {
      await this.page.waitForTimeout(50);
    }
  }

  /** Node path of an actionable: known for handles, computed in-page for locators (null when the element is not under `<body>`, e.g. in a shadow root). */
  private async pathOf(actionable: Actionable): Promise<string | null> {
    if (actionable.kind === 'handle') return actionable.path;
    const raw: unknown = await actionable.locator.evaluate((el: Element) => {
      const parts: number[] = [];
      let node: Element | null = el;
      while (node !== null && node !== document.body) {
        const parent: Element | null = node.parentElement;
        if (parent === null) return null;
        parts.unshift(Array.prototype.indexOf.call(parent.children, node));
        node = parent;
      }
      return node === null ? null : parts.join('/');
    });
    return typeof raw === 'string' && NODE_PATH_PATTERN.test(raw) ? raw : null;
  }

  private async cdp(reset: boolean): Promise<CDPSession | null> {
    if (reset && this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch {
        // ignore
      }
      this.cdpSession = null;
      this.cdpFailed = false;
    }
    if (this.cdpSession) return this.cdpSession;
    if (this.cdpFailed && !reset) return null;
    try {
      const session = await this.page.context().newCDPSession(this.page);
      this.cdpSession = session;
      return session;
    } catch {
      this.cdpFailed = true;
      return null;
    }
  }

  private async applyRateLimit(target: URL): Promise<void> {
    const limit = this.rateLimitMs ?? (isLocalHost(target.hostname) ? 0 : DEFAULT_RATE_LIMIT_MS);
    const last = this.lastNavigationAt.get(target.origin);
    if (limit > 0 && last !== undefined) {
      const wait = last + limit - Date.now();
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    this.lastNavigationAt.set(target.origin, Date.now());
  }

  private async perform(action: UiAction): Promise<{ performed: boolean; reason?: string }> {
    switch (action.kind) {
      case 'click':
      case 'hover':
      case 'focus': {
        const resolved = await this.resolveTarget(action.target);
        if (!resolved.ok) return { performed: false, reason: resolved.error.message };
        try {
          // A target hidden at the start gets a short wait instead of the full actionability timeout.
          const visibleNow = await (resolved.value.kind === 'handle' ? resolved.value.element.isVisible() : resolved.value.locator.isVisible());
          const timeout = visibleNow ? DEFAULT_ACTION_TIMEOUT_MS : HIDDEN_TARGET_TIMEOUT_MS;
          if (action.kind === 'click') {
            // Navigations are awaited by `act()` itself; a blocked cross-origin navigation would otherwise stall the click.
            const options = { timeout, noWaitAfter: true };
            await (resolved.value.kind === 'handle' ? resolved.value.element.click(options) : resolved.value.locator.click(options));
          } else if (action.kind === 'hover') {
            await (resolved.value.kind === 'handle' ? resolved.value.element.hover({ timeout }) : resolved.value.locator.hover({ timeout }));
          } else {
            await (resolved.value.kind === 'handle' ? resolved.value.element.focus() : resolved.value.locator.focus({ timeout }));
          }
          return { performed: true };
        } catch (cause) {
          if (this.page.isClosed()) throw cause;
          return { performed: false, reason: toError(cause, 'browser').message };
        } finally {
          if (resolved.value.kind === 'handle') await resolved.value.element.dispose().catch(() => undefined);
        }
      }
      case 'blur':
        await evaluateInPage(this.page, blurActiveElement);
        return { performed: true };
      case 'key': {
        if (action.target) {
          const resolved = await this.resolveTarget(action.target);
          if (!resolved.ok) return { performed: false, reason: resolved.error.message };
          try {
            await (resolved.value.kind === 'handle' ? resolved.value.element.focus() : resolved.value.locator.focus({ timeout: DEFAULT_ACTION_TIMEOUT_MS }));
          } catch (cause) {
            if (this.page.isClosed()) throw cause;
            return { performed: false, reason: toError(cause, 'browser').message };
          } finally {
            if (resolved.value.kind === 'handle') await resolved.value.element.dispose().catch(() => undefined);
          }
        }
        try {
          await this.page.keyboard.press(action.key);
          return { performed: true };
        } catch (cause) {
          if (this.page.isClosed()) throw cause;
          return { performed: false, reason: toError(cause, 'browser').message };
        }
      }
      case 'fill': {
        const resolved = await this.resolveTarget(action.target);
        if (!resolved.ok) return { performed: false, reason: resolved.error.message };
        const actionable = resolved.value;
        try {
          const path = await this.pathOf(actionable);
          if (path === null) return { performed: false, reason: 'The target cannot be addressed by a node path (it is not under <body>, e.g. inside a shadow root); it was not filled' };
          const facts = ControlFactsSchema.safeParse(await evaluateInPage(this.page, readControlFacts, path));
          if (!facts.success) return { performed: false, reason: 'The target control could not be inspected (unexpected in-page result)' };
          const plan = planFill(facts.data, action.value);
          if (plan.kind === 'refuse') return { performed: false, reason: plan.reason };
          const visibleNow = await (actionable.kind === 'handle' ? actionable.element.isVisible() : actionable.locator.isVisible());
          const options = { timeout: visibleNow ? DEFAULT_ACTION_TIMEOUT_MS : HIDDEN_TARGET_TIMEOUT_MS };
          if (plan.kind === 'fill') {
            await (actionable.kind === 'handle' ? actionable.element.fill(action.value, options) : actionable.locator.fill(action.value, options));
          } else if (plan.kind === 'check') {
            await (actionable.kind === 'handle' ? actionable.element.setChecked(plan.checked, options) : actionable.locator.setChecked(plan.checked, options));
          } else {
            await (actionable.kind === 'handle' ? actionable.element.selectOption(plan.option, options) : actionable.locator.selectOption(plan.option, options));
          }
          return { performed: true };
        } catch (cause) {
          if (this.page.isClosed()) throw cause;
          return { performed: false, reason: toError(cause, 'browser').message };
        } finally {
          if (actionable.kind === 'handle') await actionable.element.dispose().catch(() => undefined);
        }
      }
      case 'submit': {
        const resolved = await this.resolveTarget(action.target);
        if (!resolved.ok) return { performed: false, reason: resolved.error.message };
        const actionable = resolved.value;
        try {
          const path = await this.pathOf(actionable);
          if (path === null) return { performed: false, reason: 'The target cannot be addressed by a node path (it is not under <body>, e.g. inside a shadow root); nothing was submitted' };
          const result = SubmitResultSchema.safeParse(await evaluateInPage(this.page, submitFormAt, path));
          if (!result.success) return { performed: false, reason: 'The form could not be submitted (unexpected in-page result)' };
          if (!result.data.submitted) return { performed: false, reason: result.data.reason ?? 'The form was not submitted' };
          return { performed: true };
        } catch (cause) {
          if (this.page.isClosed()) throw cause;
          return { performed: false, reason: toError(cause, 'browser').message };
        } finally {
          if (actionable.kind === 'handle') await actionable.element.dispose().catch(() => undefined);
        }
      }
      case 'scroll':
        await evaluateInPage(this.page, scrollTo, action.y);
        return { performed: true };
      case 'reset-pointer':
        await this.page.mouse.move(0, 0);
        return { performed: true };
      default:
        return { performed: false, reason: 'Unknown action kind' };
    }
  }

  private async resolveTarget(target: ActionLocator): Promise<Result<Actionable>> {
    if (target.nodeId !== undefined || target.nodePath !== undefined) {
      let path = target.nodePath;
      if (path === undefined && target.nodeId !== undefined) {
        if (this.lastCapturePaths.size > 0 && !(await this.captureDocumentIsCurrent())) {
          return err(uidnaError('not-found', `Node id ${target.nodeId} belongs to a capture of a previous document; capture the current page first`));
        }
        path = this.lastCapturePaths.get(target.nodeId);
      }
      if (path === undefined) {
        return err(uidnaError('not-found', `Unknown node id ${target.nodeId ?? ''}: it is not part of the last capture of this session`));
      }
      if (!NODE_PATH_PATTERN.test(path)) return err(uidnaError('validation', `Invalid node path "${path}"`));
      const handle = await evaluateHandleInPage(this.page, resolveNodePath, path);
      const element = handle.asElement();
      if (element === null) {
        await handle.dispose().catch(() => undefined);
        return err(uidnaError('not-found', `Node path "${path}" does not resolve to an element in the current document`));
      }
      return ok({ kind: 'handle', element, path });
    }
    if (target.role !== undefined) {
      const options: { name?: string; exact?: boolean } = {};
      if (target.name !== undefined) {
        options.name = target.name;
        options.exact = true;
      }
      try {
        const locator = this.page.getByRole(target.role as AriaRole, options).nth(target.nth ?? 0);
        const count = await locator.count();
        if (count === 0) {
          return err(uidnaError('not-found', `No element with role "${target.role}"${target.name === undefined ? '' : ` and name "${target.name}"`}${target.nth ? ` at index ${target.nth}` : ''}`));
        }
        return ok({ kind: 'locator', locator });
      } catch (cause) {
        if (this.page.isClosed()) throw cause;
        return err(toError(cause, 'validation', `Role locator "${target.role}" could not be evaluated`));
      }
    }
    if (target.selector !== undefined) {
      try {
        const locator = this.page.locator(target.selector).first();
        const count = await locator.count();
        if (count === 0) return err(uidnaError('not-found', `Selector "${target.selector}" matches nothing`));
        return ok({ kind: 'locator', locator });
      } catch (cause) {
        if (this.page.isClosed()) throw cause;
        return err(toError(cause, 'validation', `Selector "${target.selector}" is invalid`));
      }
    }
    return err(uidnaError('validation', 'Action target has no nodeId, nodePath, role or selector'));
  }

  /** True while the document captured by the last `capture()` is still the current one. */
  private async captureDocumentIsCurrent(): Promise<boolean> {
    try {
      return (await evaluateInPage(this.page, readCaptureMarker)) === true;
    } catch {
      return false;
    }
  }

  private async readMutationCount(): Promise<number> {
    let count = asCount(await evaluateInPage(this.page, readMutations));
    if (count < 0) {
      await evaluateInPage(this.page, installMutationCounter);
      count = asCount(await evaluateInPage(this.page, readMutations));
    }
    return count;
  }
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash < 0 ? url : url.slice(0, hash);
}

/**
 * What `request` would navigate: the session page's main frame, a subframe,
 * another page (a popup's first navigation has no frame yet, so asking for
 * one throws; so do service-worker requests, which are never navigations),
 * or nothing (a subresource).
 */
function classifyNavigation(request: Request, sessionPage: Page): 'session' | 'subframe' | 'other-page' | 'none' {
  if (!request.isNavigationRequest()) return 'none';
  try {
    const frame = request.frame();
    if (frame.parentFrame() !== null) return 'subframe';
    return frame.page() === sessionPage ? 'session' : 'other-page';
  } catch {
    return 'other-page';
  }
}

/* ------------------------------------------------------------ in-page code */

interface UidnaWindow {
  __uidnaMutations?: number;
  __uidnaObserver?: MutationObserver;
  __uidnaCaptured?: boolean;
}

function installMutationCounter(): void {
  const w = window as unknown as UidnaWindow;
  if (w.__uidnaObserver) return;
  w.__uidnaMutations = 0;
  const observer = new MutationObserver((records) => {
    w.__uidnaMutations = (w.__uidnaMutations ?? 0) + records.length;
  });
  const start = (): void => {
    if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  w.__uidnaObserver = observer;
}

function readMutations(): number {
  const w = window as unknown as UidnaWindow;
  return w.__uidnaObserver ? (w.__uidnaMutations ?? 0) : -1;
}

function setCaptureMarker(): void {
  (window as unknown as UidnaWindow).__uidnaCaptured = true;
}

function readCaptureMarker(): boolean {
  return (window as unknown as UidnaWindow).__uidnaCaptured === true;
}

function removeStabilizeStyle(): void {
  document.getElementById('uidna-stabilize')?.remove();
}

function injectStabilizeStyle(): void {
  const id = 'uidna-stabilize';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent =
    '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; ' +
    'transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }';
  (document.head || document.documentElement).appendChild(style);
}

function waitForFonts(): Promise<void> {
  return Promise.race([
    document.fonts.ready.then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 5000);
    }),
  ]);
}

function blurActiveElement(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

function scrollTo(y: number): void {
  window.scrollTo(0, y);
}

function resolveNodePath(path: string): Element | null {
  let el: Element | null = document.body;
  if (path === '') return el;
  for (const part of path.split('/')) {
    if (el === null) return null;
    el = el.children[Number(part)] ?? null;
  }
  return el;
}
