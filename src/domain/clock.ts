/**
 * Clock seam. Production code uses the system clock; tests can inject a fixed
 * one so that timestamps in documents and envelopes are deterministic.
 */

/** Source of the current time. */
export interface Clock {
  now(): Date;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that returns `start` and advances by `stepMs` on each call. */
export function fixedClock(start: Date | string, stepMs = 0): Clock {
  let current = new Date(start).getTime();
  return {
    now: () => {
      const value = new Date(current);
      current += stepMs;
      return value;
    },
  };
}

/** ISO-8601 timestamp, e.g. `2026-10-13T17:29:00.000Z`. */
export function isoNow(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}
