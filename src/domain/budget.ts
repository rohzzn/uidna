/**
 * Per-scan budgets and cancellation. A budget bounds wall-clock time, number
 * of pages, number of interactions and number of captured resources. When a
 * budget is exhausted the workflow stops with partial artifacts and reports
 * which limit was hit; it never silently truncates.
 */
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { UidnaError } from './errors.js';
import { uidnaError } from './errors.js';

/** Budget limits. `null` means unlimited for that dimension. */
export interface BudgetLimits {
  readonly timeMs: number | null;
  readonly pages: number | null;
  readonly actions: number | null;
  readonly resources: number | null;
}

/** Default limits applied when the caller gives none. */
export const DEFAULT_BUDGET: BudgetLimits = {
  timeMs: 600_000,
  pages: 1,
  actions: 200,
  resources: 2000,
};

/** Usage counters at a point in time. */
export interface BudgetUsage {
  readonly timeMs: number;
  readonly pages: number;
  readonly actions: number;
  readonly resources: number;
}

/** Which limit was hit, if any. */
export interface BudgetExhaustion {
  readonly dimension: keyof BudgetLimits;
  readonly limit: number;
  readonly used: number;
}

/** Progress notification sent by long operations. */
export interface ProgressEvent {
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
}

/** Receiver for progress events (MCP progress tokens, CLI output, tests). */
export interface ProgressReporter {
  report(event: ProgressEvent): void;
}

/** A reporter that discards events. */
export const silentProgress: ProgressReporter = { report: () => undefined };

/** Tracks consumption against limits and exposes cancellation. */
export class BudgetTracker {
  private readonly startedAt: number;
  private pages = 0;
  private actions = 0;
  private resources = 0;

  constructor(
    readonly limits: BudgetLimits = DEFAULT_BUDGET,
    private readonly clock: Clock = systemClock,
    readonly signal?: AbortSignal,
  ) {
    this.startedAt = clock.now().getTime();
  }

  /** Current usage. */
  usage(): BudgetUsage {
    return {
      timeMs: this.clock.now().getTime() - this.startedAt,
      pages: this.pages,
      actions: this.actions,
      resources: this.resources,
    };
  }

  /** Remaining wall-clock time, or `Infinity` when unlimited. */
  remainingMs(): number {
    if (this.limits.timeMs === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.limits.timeMs - this.usage().timeMs);
  }

  /** Record a page visit. */
  consumePage(): void {
    this.pages += 1;
  }

  /** Record an interaction. */
  consumeAction(): void {
    this.actions += 1;
  }

  /** Record `count` captured resources. */
  consumeResources(count = 1): void {
    this.resources += count;
  }

  /** True when cancellation has been requested. */
  cancelled(): boolean {
    return this.signal?.aborted === true;
  }

  /** The first exhausted dimension, or `null` when within budget. */
  exhausted(): BudgetExhaustion | null {
    const usage = this.usage();
    const dimensions: (keyof BudgetLimits)[] = ['timeMs', 'pages', 'actions', 'resources'];
    for (const dimension of dimensions) {
      const limit = this.limits[dimension];
      if (limit !== null && usage[dimension] > limit) {
        return { dimension, limit, used: usage[dimension] };
      }
    }
    return null;
  }

  /** True when one more unit of `dimension` would exceed its limit. */
  wouldExceed(dimension: keyof BudgetLimits, units = 1): boolean {
    const limit = this.limits[dimension];
    if (limit === null) return false;
    return this.usage()[dimension] + units > limit;
  }

  /**
   * Returns a tagged error when cancelled or exhausted, otherwise `null`.
   * Workflows call this between steps.
   */
  check(): UidnaError | null {
    if (this.cancelled()) return uidnaError('cancelled', 'Operation cancelled by caller');
    const hit = this.exhausted();
    if (hit) {
      return uidnaError('budget', `Budget exhausted: ${hit.dimension} used ${hit.used} of ${hit.limit}`, {
        details: { ...hit },
      });
    }
    return null;
  }
}

/** Merge partial limits over the defaults. */
export function resolveBudget(partial: Partial<BudgetLimits> | undefined): BudgetLimits {
  return {
    timeMs: partial?.timeMs === undefined ? DEFAULT_BUDGET.timeMs : partial.timeMs,
    pages: partial?.pages === undefined ? DEFAULT_BUDGET.pages : partial.pages,
    actions: partial?.actions === undefined ? DEFAULT_BUDGET.actions : partial.actions,
    resources: partial?.resources === undefined ? DEFAULT_BUDGET.resources : partial.resources,
  };
}
