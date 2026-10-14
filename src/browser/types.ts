/**
 * Browser adapter contracts. Two adapters implement `BrowserSession`:
 * Playwright-launched Chromium (public URLs) and attach-to-your-own-Chrome
 * over CDP (authorized authenticated sessions). Everything above the browser
 * layer (explore, verify, workflows) programs against these types only.
 */
import type { LayoutSignatureReading, StyleConditions } from './responsive.js';
import type { RoleTreeNode, UiNode, Viewport } from '@rohzzn/uidna-schema';
import type { Result } from '../domain/result.js';

export type { Viewport, UiNode, RoleTreeNode };

/** How the browser was obtained. */
export type BrowserMode = 'launch' | 'cdp';

/** A font face the page declared or used. */
export interface CapturedFont {
  readonly family: string;
  readonly source: 'local' | 'url' | 'data';
  readonly url?: string;
  readonly weight?: string;
  readonly style?: string;
  readonly status: 'loaded' | 'unloaded' | 'error';
}

/** A resource referenced by the page (image, svg, font, video). */
export interface CapturedAsset {
  readonly id: string;
  /** `data` is a captured JSON response (only when `captureBodies` is on). */
  readonly kind: 'font' | 'image' | 'svg' | 'video' | 'icon' | 'data' | 'other';
  readonly url: string;
  readonly origin: 'same-origin' | 'cross-origin' | 'inline' | 'data';
  readonly mime?: string;
  readonly bytes?: number;
  readonly digest?: string;
  readonly width?: number;
  readonly height?: number;
  /** Node ids that reference the asset in this capture. */
  readonly usedBy: readonly string[];
  /** Local copy relative to the scan directory, when stored. */
  readonly localPath?: string;
  /** For `data` assets: the request that produced the response (URL redacted). */
  readonly request?: { readonly method: string; readonly status: number | null; readonly mime: string | null };
}

/** Network request metadata. Bodies are never stored; secret headers are redacted. */
export interface NetworkEntry {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly resourceType: string;
  readonly mime?: string;
  readonly bytes?: number;
  readonly startedAt: string;
  readonly durationMs?: number;
  readonly fromCache?: boolean;
  readonly failure?: string;
}

/** One screenshot written to disk. */
export interface ScreenshotFile {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly digest: string;
  readonly truncated: boolean;
}

/** Everything captured from one page at one viewport at one moment. */
export interface CapturedState {
  readonly url: string;
  readonly title: string;
  readonly viewport: Viewport;
  readonly capturedAt: string;
  readonly document: { readonly width: number; readonly height: number; readonly scrollHeight: number };
  /** Document order; the first node is `<body>`. */
  readonly nodes: readonly UiNode[];
  /** Deduplicated style objects keyed by `UiNode.styleId`. */
  readonly styles: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly roleTree: readonly RoleTreeNode[];
  readonly roleTreeDigest: string;
  readonly domDigest: string;
  readonly screenshot: ScreenshotFile | null;
  readonly fonts: readonly CapturedFont[];
  readonly assets: readonly CapturedAsset[];
  readonly network: readonly NetworkEntry[];
  /** What this capture could not do, in plain words. */
  readonly limitations: readonly string[];
}

/** A cheap identity snapshot used to detect changes without a full capture. */
export interface PageSnapshot {
  readonly url: string;
  readonly domDigest: string;
  readonly roleTreeDigest: string;
  readonly nodeCount: number;
}

/** Capture options. */
export interface CaptureOptions {
  /** Absolute path for the screenshot PNG; omit to skip the screenshot. */
  readonly screenshotPath?: string;
  /** Maximum captured page height in CSS pixels; taller pages are reported as truncated. */
  readonly maxHeight?: number;
  /** Rendering properties to capture; defaults to `RENDERING_STYLE_PROPERTIES`. */
  readonly styleProperties?: readonly string[];
  /** Include nodes that are not rendered (display: none). Default true; they matter for menus. */
  readonly includeHiddenNodes?: boolean;
  /** Directory for stored asset copies, relative paths are returned in `CapturedAsset.localPath`. Omit to skip. */
  readonly assetDir?: string;
  /** Maximum bytes per stored asset copy. */
  readonly maxAssetBytes?: number;
  /** Store JSON response bodies of XHR/fetch requests as `data` assets (redacted). Default 'none'. */
  readonly captureBodies?: 'none' | 'json';
  /** Maximum bytes of one captured body. */
  readonly maxBodyBytes?: number;
}

/** How to locate an element for an action. Prefer `nodeId` from the last capture; fall back to role+name. */
export interface ActionLocator {
  readonly nodeId?: string;
  readonly nodePath?: string;
  readonly role?: string;
  readonly name?: string;
  /** Index among matches of role+name (0-based). */
  readonly nth?: number;
  readonly selector?: string;
}

/** An action the browser can perform on the current page. */
export type UiAction =
  /** `allowNavigation: 'same-origin'` lets the click follow a same-origin document navigation (crawled pages); cross-origin is always blocked. */
  | { readonly kind: 'click'; readonly target: ActionLocator; readonly allowNavigation?: 'same-origin' }
  | { readonly kind: 'hover'; readonly target: ActionLocator }
  | { readonly kind: 'focus'; readonly target: ActionLocator }
  | { readonly kind: 'blur' }
  | { readonly kind: 'key'; readonly key: string; readonly target?: ActionLocator }
  /** Type a synthetic value into a text-like control (select by value for <select>, check for checkboxes when value is 'true'). */
  | { readonly kind: 'fill'; readonly target: ActionLocator; readonly value: string }
  /** Submit the form that contains the target (or the target form itself); the resulting request is blocked by the navigation guard. */
  | { readonly kind: 'submit'; readonly target: ActionLocator }
  | { readonly kind: 'scroll'; readonly y: number }
  /** Move the pointer to the top-left corner so nothing is hovered. */
  | { readonly kind: 'reset-pointer' };

/** Outcome of an action. */
export interface ActionOutcome {
  readonly performed: boolean;
  /** Why the action was not performed, when `performed` is false. */
  readonly reason?: string;
  /** True when the action caused a navigation (URL change or document reload). */
  readonly navigated: boolean;
  readonly url: string;
  /** Dialog messages (alert/confirm/prompt) that were auto-dismissed. */
  readonly dialogs: readonly string[];
  /** Redacted URL of a document navigation the action requested and UI DNA blocked (same- or cross-origin). */
  readonly blockedNavigation?: string;
  /** Redacted URLs of non-GET requests (form submissions, XHR/fetch) the action triggered and UI DNA blocked (fill/submit actions). */
  readonly blockedRequests?: readonly string[];
  readonly durationMs: number;
}

/** Options for stability waits. */
export interface StabilityOptions {
  /** Give up after this long. */
  readonly timeoutMs?: number;
  /** The DOM must stay unchanged for this long. */
  readonly quietMs?: number;
}

/** Result of a stability wait. */
export interface StabilityOutcome {
  readonly stable: boolean;
  readonly waitedMs: number;
  readonly pendingRequests: number;
}

/** Navigation options. */
export interface NavigateOptions {
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  readonly timeoutMs?: number;
}

/** Outcome of a navigation. */
export interface NavigationOutcome {
  readonly url: string;
  readonly status: number | null;
  readonly redirected: boolean;
}

/** A held non-GET guard; see `BrowserSession.holdNonGetGuard`. */
export interface NonGetGuardHold {
  /** Wait (bounded) for the requests made while the guard was held to settle, then remove it. Idempotent; never throws. */
  release(): Promise<void>;
}

/** A live browser page under UI DNA's control. */
export interface BrowserSession {
  readonly id: string;
  readonly mode: BrowserMode;
  /** False when Chromium had to be launched without its sandbox (reported as a limitation). Undefined in attach mode. */
  readonly sandboxed?: boolean;
  /** Load a URL in the page. Honors robots.txt in launch mode. */
  navigate(url: string, options?: NavigateOptions): Promise<Result<NavigationOutcome>>;
  /** Reload the current page (used to revert to a base state). */
  reload(options?: NavigateOptions): Promise<Result<NavigationOutcome>>;
  /** Resize the viewport. */
  setViewport(viewport: Viewport): Promise<Result<void>>;
  /** Current viewport. */
  viewport(): Viewport;
  /** Current URL. */
  currentUrl(): string;
  /** Full capture of the current page. */
  capture(options?: CaptureOptions): Promise<Result<CapturedState>>;
  /** Cheap identity snapshot of the current page. */
  snapshot(): Promise<Result<PageSnapshot>>;
  /** Perform an action. Never navigates cross-origin: such actions report `performed: false`. */
  act(action: UiAction): Promise<Result<ActionOutcome>>;
  /**
   * Keep every non-GET request of the page from reaching a server until the
   * returned hold is released, between actions too: such requests (fetch,
   * XHR, form submissions, and the beacons and keepalive requests of a
   * document being unloaded) are aborted and recorded in the network ledger
   * with a `failure` that starts with `blocked by UI DNA`. GET requests,
   * document navigations included, proceed. Every action performed while a
   * guard is held blocks non-GET requests as fill and submit actions do.
   * Holds nest; release each one once.
   */
  holdNonGetGuard(): Promise<Result<NonGetGuardHold>>;
  /** Wait until the DOM and network are quiet. */
  waitForStability(options?: StabilityOptions): Promise<Result<StabilityOutcome>>;
  /** Freeze animations, transitions, carets and smooth scrolling for deterministic screenshots. */
  stabilize(): Promise<Result<void>>;
  /**
   * The layout signature of the current document (see `SIGNATURE_PROPERTIES` in
   * src/domain/responsive.ts), keyed by node path, or by `keyAttribute` when given.
   * Read-only: never acts on the page.
   */
  layoutSignature(options?: { readonly keyAttribute?: string; readonly maxNodes?: number }): Promise<Result<LayoutSignatureReading>>;
  /** Width conditions of the page's readable stylesheets with the nodes their rules match. Read-only. */
  readStyleConditions(): Promise<Result<StyleConditions>>;
  /** Network entries recorded since `marker` (from `markNetwork`), or all when omitted. */
  networkSince(marker?: string): readonly NetworkEntry[];
  /** Create a marker for `networkSince`. */
  markNetwork(): string;
  /** Close the page (launch mode also closes the browser). Never throws. */
  close(): Promise<void>;
}

/** Launch options for Playwright-managed Chromium. */
export interface LaunchOptions {
  readonly headless?: boolean;
  readonly viewport?: Viewport;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly colorScheme?: 'light' | 'dark';
  readonly reducedMotion?: 'reduce' | 'no-preference';
  /** Honor robots.txt before navigating (default true). */
  readonly honorRobots?: boolean;
  /** Minimum delay between navigations to the same origin in milliseconds (default 0 for localhost, 1000 otherwise). */
  readonly rateLimitMs?: number;
  /** Executable path override (e.g. a system Chrome). */
  readonly executablePath?: string;
}

/** Attach options for the user's own Chrome started with `--remote-debugging-port`. */
export interface AttachOptions {
  /** `http://localhost:9222` or a `ws://` endpoint. */
  readonly cdpEndpoint: string;
  /** Target id to attach to; the active page when omitted. */
  readonly targetId?: string;
  readonly viewport?: Viewport;
}

/** Availability report for `uidna doctor`. */
export interface BrowserAvailability {
  readonly playwrightVersion: string | null;
  readonly chromium: { readonly available: boolean; readonly executablePath: string | null; readonly detail: string };
  readonly cdp: { readonly endpoint: string; readonly reachable: boolean; readonly detail: string; readonly browser?: string } | null;
}

/** Factory for sessions. */
export interface BrowserProvider {
  launch(options?: LaunchOptions): Promise<Result<BrowserSession>>;
  attach(options: AttachOptions): Promise<Result<BrowserSession>>;
  probe(cdpEndpoint?: string): Promise<BrowserAvailability>;
}
