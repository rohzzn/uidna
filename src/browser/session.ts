/**
 * `BrowserSession` over a Playwright page. One class serves both modes:
 * launch (UI DNA owns the browser) and cdp (attached to the user's Chrome,
 * where `close()` only detaches). Navigation honours robots.txt and a
 * per-origin rate limit in launch mode; dialogs are auto-dismissed and
 * reported; actions never leave the page's origin: while an action runs,
 * cross-origin main-frame navigations (of this page or of a page the action
 * opens) are aborted before any request reaches the other origin, and pages
 * the action still manages to open are closed.
 */
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, ElementHandle, Frame, Locator, Page, Request, Route } from 'playwright';
import type { Viewport } from '@uidna/schema';
import type { Clock } from '../domain/clock.js';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { capturePage, snapshotPage, type CaptureContext } from './capture.js';
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

/** `NetworkEntry.failure` of a cross-origin navigation that an action triggered and UI DNA aborted instead of sending. */
export const BLOCKED_NAVIGATION_FAILURE = 'blocked by UI DNA: cross-origin navigation during an action';

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
  /** True when `close()` should close the browser (launch mode). */
  readonly ownsBrowser: boolean;
  readonly robots?: RobotsCache;
}

type AriaRole = Parameters<Page['getByRole']>[0];
type Actionable =
  | { readonly kind: 'handle'; readonly element: ElementHandle }
  | { readonly kind: 'locator'; readonly locator: Locator };

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
export class PlaywrightSession implements BrowserSession {
  readonly id: string = newSessionId();
  readonly mode: BrowserMode;
  private readonly page: Page;
  private readonly browser: Browser;
  private readonly clock: Clock;
  private readonly ledger: NetworkLedger;
  private readonly robots: RobotsCache;
  private readonly honorRobots: boolean;
  private readonly rateLimitMs: number | undefined;
  /** True when `close()` closes the browser (launch mode); false when it only disconnects (cdp mode). */
  readonly ownsBrowser: boolean;
  private currentViewport: Viewport;
  private cdpSession: CDPSession | null = null;
  private cdpFailed = false;
  private readonly dialogs: string[] = [];
  private readonly lastNavigationAt = new Map<string, number>();
  /** Node id → node path of the last `capture()`; valid only while the captured document is still current. */
  private lastCapturePaths = new Map<string, string>();
  private closed = false;

  constructor(deps: SessionDeps) {
    this.mode = deps.mode;
    this.page = deps.page;
    this.browser = deps.browser;
    this.clock = deps.clock;
    this.currentViewport = deps.viewport;
    this.honorRobots = deps.honorRobots;
    this.rateLimitMs = deps.rateLimitMs;
    this.ownsBrowser = deps.ownsBrowser;
    this.robots = deps.robots ?? new RobotsCache();
    this.ledger = new NetworkLedger(deps.clock);
    this.ledger.attach(deps.page);
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
    let navigated = false;
    let navigationRequested = false;
    const blocked: string[] = [];
    let popups = 0;
    const onNavigated = (frame: Frame): void => {
      if (frame === this.page.mainFrame()) navigated = true;
    };
    const onPopup = (popup: Page): void => {
      popups += 1;
      popup.close().catch(() => undefined);
    };
    const guard = async (route: Route): Promise<void> => {
      const request = route.request();
      const target = classifyNavigation(request, this.page);
      if (target !== 'none' && target !== 'subframe' && originOf(request.url()) !== originBefore) {
        blocked.push(redactUrl(request.url()));
        this.ledger.block(request, BLOCKED_NAVIGATION_FAILURE);
        // `aborted` (net::ERR_ABORTED) cancels the navigation like `window.stop()`: no error page, and Playwright
        // clears its pending-navigation state so later actions do not wait on it. Other abort codes commit an error page.
        await route.abort('aborted').catch(() => undefined);
        return;
      }
      if (target === 'session') navigationRequested = true;
      await route.continue().catch(() => undefined);
    };
    // In launch mode the context is ours, so popups are guarded too; in cdp mode only this page is touched.
    const router: Page | BrowserContext = this.ownsBrowser ? this.page.context() : this.page;
    let routed = false;
    this.page.on('framenavigated', onNavigated);
    this.page.on('popup', onPopup);
    try {
      await router.route('**/*', guard);
      routed = true;
      const performed = await this.perform(action);
      await this.page.waitForTimeout(100);
      if (navigationRequested && !navigated) {
        await this.page
          .waitForEvent('framenavigated', { predicate: (frame) => frame === this.page.mainFrame(), timeout: DEFAULT_ACTION_TIMEOUT_MS })
          .catch(() => undefined);
      }
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
          reason: `The action would have navigated cross-origin to ${blocked[0] ?? ''}; the navigation was blocked and the page stayed at ${url}.`,
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
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch {
        // already gone
      }
      this.cdpSession = null;
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
    };
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
      return ok({ kind: 'handle', element });
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
