/**
 * `BrowserProvider` for Chromium through Playwright. Two modes:
 *
 * - `launch`: a fresh headless Chromium with an ephemeral context (viewport,
 *   locale, timezone, color scheme, reduced motion, DPR 1, a `uidna/0.1.0`
 *   user-agent suffix). `close()` closes the browser.
 * - `attach`: connect over CDP to the user's own Chrome started with
 *   `--remote-debugging-port`, pick a page by target id, else the active
 *   (visible) page, else the first page. `close()` only detaches; the
 *   user's browser stays open.
 *
 * `probe()` reports Playwright and Chromium availability and CDP
 * reachability without launching anything.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { z } from 'zod';
import type { Viewport } from '@rohzzn/uidna-schema';
import type { Clock } from '../domain/clock.js';
import { systemClock } from '../domain/clock.js';
import { describeError, toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { BrowserVersionResultSchema, CdpVersionJsonSchema, TargetInfoResultSchema } from './cdp-schemas.js';
import { evaluateInPage } from './in-page.js';
import { PlaywrightSession } from './session.js';
import type { AttachOptions, BrowserAvailability, BrowserProvider, BrowserSession, LaunchOptions } from './types.js';

/** Appended to the browser's user agent in launch mode. */
export const USER_AGENT_SUFFIX = 'uidna/0.1.0';

/** Viewport used when the caller gives none. */
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };

/** Timeout for `GET <endpoint>/json/version` in `probe`. */
export const CDP_PROBE_TIMEOUT_MS = 2000;

/** Dependencies the provider accepts (tests inject a fixed clock). */
export interface ProviderDeps {
  readonly clock?: Clock;
}

/** Create the Playwright-backed provider. */
export function createPlaywrightProvider(deps: ProviderDeps = {}): BrowserProvider {
  const clock = deps.clock ?? systemClock;
  return {
    launch: (options) => launchSession(options ?? {}, clock),
    attach: (options) => attachSession(options, clock),
    probe: (cdpEndpoint) => probeAvailability(cdpEndpoint),
  };
}

/** Launch a fresh headless Chromium and open one page. */
export async function launchSession(options: LaunchOptions, clock: Clock = systemClock): Promise<Result<BrowserSession>> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  let browser: Browser;
  let sandboxed = true;
  const launchOptions = {
    headless: options.headless ?? true,
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  };
  try {
    // Playwright disables Chromium's sandbox by default; UI DNA turns it on and only falls back
    // (reported through `session.sandboxed`) when the host cannot run a sandboxed Chromium.
    browser = await chromium.launch({ ...launchOptions, chromiumSandbox: true });
  } catch (sandboxCause) {
    try {
      browser = await chromium.launch({ ...launchOptions, chromiumSandbox: false });
      sandboxed = false;
    } catch (cause) {
      return err(toError(cause, 'browser', `Chromium could not be launched (sandboxed attempt: ${describeError(sandboxCause)})`));
    }
  }
  try {
    const userAgent = await readUserAgent(browser);
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      javaScriptEnabled: true,
      reducedMotion: options.reducedMotion ?? 'reduce',
      colorScheme: options.colorScheme ?? 'light',
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      ...(options.timezoneId !== undefined ? { timezoneId: options.timezoneId } : {}),
      ...(userAgent !== null ? { userAgent: `${userAgent} ${USER_AGENT_SUFFIX}` } : {}),
    });
    const page = await context.newPage();
    const session = new PlaywrightSession({
      sandboxed,
      browser,
      page,
      mode: 'launch',
      clock,
      viewport,
      honorRobots: options.honorRobots ?? true,
      ...(options.rateLimitMs !== undefined ? { rateLimitMs: options.rateLimitMs } : {}),
      ownsBrowser: true,
    });
    return ok(session);
  } catch (cause) {
    await browser.close().catch(() => undefined);
    return err(toError(cause, 'browser', 'Browser context could not be created'));
  }
}

/** Attach to a running Chrome over CDP and adopt one of its pages. */
export async function attachSession(options: AttachOptions, clock: Clock = systemClock): Promise<Result<BrowserSession>> {
  const endpoint = options.cdpEndpoint.trim();
  if (!/^(https?|wss?):\/\//i.test(endpoint)) {
    return err(uidnaError('validation', `CDP endpoint must be an http(s):// or ws(s):// URL, got "${endpoint}"`));
  }
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  } catch (cause) {
    return err(toError(cause, 'browser', `Could not connect to Chrome at ${endpoint}. Start Chrome with --remote-debugging-port=9222`));
  }
  try {
    const pages = browser.contexts().flatMap((context: BrowserContext) => context.pages());
    if (pages.length === 0) {
      await browser.close().catch(() => undefined);
      return err(uidnaError('browser', 'The attached browser has no open page; open a tab first'));
    }
    let page: Page | undefined;
    if (options.targetId !== undefined) {
      page = await findPageByTargetId(pages, options.targetId);
      if (!page) {
        await browser.close().catch(() => undefined);
        return err(uidnaError('not-found', `No page with target id ${options.targetId} in the attached browser`));
      }
    } else {
      page = await findActivePage(pages);
    }
    if (!page) {
      await browser.close().catch(() => undefined);
      return err(uidnaError('browser', 'No page to attach to'));
    }
    let viewport: Viewport;
    if (options.viewport) {
      await page.setViewportSize({ width: options.viewport.width, height: options.viewport.height });
      viewport = { width: options.viewport.width, height: options.viewport.height };
    } else {
      const size = page.viewportSize();
      if (size) {
        viewport = { width: size.width, height: size.height };
      } else {
        const measured = await measureViewport(page);
        if (!measured.ok) {
          await browser.close().catch(() => undefined);
          return measured;
        }
        viewport = measured.value;
      }
    }
    const session = new PlaywrightSession({
      browser,
      page,
      mode: 'cdp',
      clock,
      viewport,
      honorRobots: false,
      ownsBrowser: false,
    });
    return ok(session);
  } catch (cause) {
    await browser.close().catch(() => undefined);
    return err(toError(cause, 'browser', 'Could not adopt a page from the attached browser'));
  }
}

/** Report Playwright, Chromium and CDP availability without launching a browser. */
export async function probeAvailability(cdpEndpoint?: string): Promise<BrowserAvailability> {
  const playwrightVersion = readPlaywrightVersion();
  let executablePath: string | null = null;
  let detail: string;
  let available = false;
  try {
    executablePath = chromium.executablePath();
    available = executablePath !== '' && existsSync(executablePath);
    detail = available ? `Chromium found at ${executablePath}` : `Chromium executable missing at ${executablePath}; run: npx playwright install chromium`;
  } catch (cause) {
    detail = `Chromium executable path could not be resolved: ${toError(cause, 'browser').message}`;
  }
  const cdp = cdpEndpoint === undefined ? null : await probeCdp(cdpEndpoint);
  return { playwrightVersion, chromium: { available, executablePath, detail }, cdp };
}

async function probeCdp(endpoint: string): Promise<NonNullable<BrowserAvailability['cdp']>> {
  const versionUrl = cdpVersionUrl(endpoint);
  if (versionUrl === null) return { endpoint, reachable: false, detail: `Endpoint "${endpoint}" is not an http(s):// or ws(s):// URL` };
  try {
    const response = await fetch(versionUrl, { signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS) });
    if (!response.ok) return { endpoint, reachable: false, detail: `${versionUrl} returned HTTP ${response.status}` };
    const parsed = CdpVersionJsonSchema.safeParse(await response.json());
    if (!parsed.success) return { endpoint, reachable: true, detail: `${versionUrl} responded but the body was not understood` };
    const browser = parsed.data.Browser;
    return browser !== undefined
      ? { endpoint, reachable: true, detail: `${versionUrl} reachable`, browser }
      : { endpoint, reachable: true, detail: `${versionUrl} reachable` };
  } catch (cause) {
    return { endpoint, reachable: false, detail: `${versionUrl} unreachable: ${toError(cause, 'browser').message}` };
  }
}

/** `http://host:port/json/version` for an http(s) or ws(s) CDP endpoint. */
export function cdpVersionUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.pathname = '/json/version';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function readPlaywrightVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const parsed = z.object({ version: z.string() }).safeParse(require('playwright/package.json'));
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

async function readUserAgent(browser: Browser): Promise<string | null> {
  try {
    const session = await browser.newBrowserCDPSession();
    try {
      const parsed = BrowserVersionResultSchema.safeParse(await session.send('Browser.getVersion'));
      return parsed.success ? parsed.data.userAgent : null;
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

async function findPageByTargetId(pages: readonly Page[], targetId: string): Promise<Page | undefined> {
  for (const page of pages) {
    try {
      const session = await page.context().newCDPSession(page);
      try {
        const parsed = TargetInfoResultSchema.safeParse(await session.send('Target.getTargetInfo'));
        if (parsed.success && parsed.data.targetInfo.targetId === targetId) return page;
      } finally {
        await session.detach().catch(() => undefined);
      }
    } catch {
      // try the next page
    }
  }
  return undefined;
}

/** The first page whose document is visible (the active tab of its window), else the first page. */
async function findActivePage(pages: readonly Page[]): Promise<Page | undefined> {
  for (const page of pages) {
    try {
      if ((await evaluateInPage(page, readVisibilityState)) === 'visible') return page;
    } catch {
      // not evaluable (crashed or closing page): try the next one
    }
  }
  return pages[0];
}

/** The page's inner size in CSS pixels. Fails instead of guessing when it cannot be read. */
async function measureViewport(page: Page): Promise<Result<Viewport>> {
  try {
    const parsed = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).safeParse(await evaluateInPage(page, readInnerSize));
    if (!parsed.success) return err(uidnaError('browser', 'The attached page reported no usable viewport size; pass `viewport` explicitly'));
    return ok(parsed.data);
  } catch (cause) {
    return err(toError(cause, 'browser', 'The viewport of the attached page could not be measured; pass `viewport` explicitly'));
  }
}

/* ------------------------------------------------------------ in-page code */

function readInnerSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function readVisibilityState(): string {
  return document.visibilityState;
}
