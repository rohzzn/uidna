/**
 * Reaching a derived state again: the one tracer the generated behavior
 * tests (their setup steps) and the verifier (the chain it replays before a
 * transition) share, so neither ever repeats a transition the other refuses.
 * A derived state is re-entered by replaying the transitions that produced
 * it, from its base state; only transitions without side effects that are
 * not navigations may be replayed on the way, and the chain is bounded.
 * Pure and deterministic.
 */
import type { Transition, UiState } from 'uidna-schema';

/** Longest chain of producing transitions replayed to reach a derived from-state. */
export const MAX_REPLAY_CHAIN = 8;

/** Code-point string order: locale independent. */
function compareIds(a: Transition, b: Transition): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * True when a transition may be replayed to reach the state it produced: it
 * caused no side effect when it was observed and it is not a navigation (a
 * navigation produces another page, never a derived state to re-enter).
 */
export function replayableStep(transition: Pick<Transition, 'sideEffects' | 'navigation'>): boolean {
  return !transition.sideEffects && (transition.navigation ?? null) === null;
}

/**
 * What the side effect of a transition was when it was observed, for
 * messages: `a non-GET request`, `<n> non-GET requests`, or `a navigation`
 * (a side effect without a non-GET request is a navigation: a document load,
 * a blocked one, or a hash change).
 */
export function sideEffectCause(transition: Pick<Transition, 'network'>): string {
  const nonGet = transition.network.nonGet;
  if (nonGet === 1) return 'a non-GET request';
  if (nonGet > 1) return `${nonGet} non-GET requests`;
  return 'a navigation';
}

/** Why a producing transition is not replayed on the way to the state it produced (see `replayableStep`). */
export function unreplayableStepReason(transition: Transition): string {
  if (transition.sideEffects) return `${transition.id} caused side effects when it was observed (${sideEffectCause(transition)}) and is never repeated`;
  return `${transition.id} is a navigation to page ${transition.navigation?.toPageId ?? '?'} and never re-enters a derived state`;
}

/** The base state a derived state descends from and the transitions that replay the descent, or why none could be traced. */
export type Trace =
  | { readonly ok: true; readonly base: UiState; readonly steps: readonly Transition[] }
  | {
      readonly ok: false;
      readonly reason: string;
      /** The producer that was refused because it caused side effects or is a navigation (the recorded parent's first), or null when no producer was refused. */
      readonly blockedBy: Transition | null;
    };

/**
 * Trace a state back to a base state through the transitions that produced
 * it: the one from its recorded parent when it is replayable, else the
 * replayable producer with the lowest id. Side-effect transitions and
 * navigations never produce a re-enterable derived state (`blockedBy` names
 * the refused producer), and the chain is bounded by `MAX_REPLAY_CHAIN`.
 */
export function traceToBase(transitions: readonly Transition[], statesById: ReadonlyMap<string, UiState>, state: UiState): Trace {
  const steps: Transition[] = [];
  const seen = new Set<string>([state.id]);
  let current = state;
  while (current.kind !== 'base') {
    if (steps.length >= MAX_REPLAY_CHAIN) return { ok: false, reason: `the chain of transitions producing ${state.id} is longer than ${MAX_REPLAY_CHAIN} steps`, blockedBy: null };
    const target = current;
    const candidates = transitions.filter((t) => t.to === target.id && t.from !== target.id && statesById.has(t.from) && !seen.has(t.from)).sort(compareIds);
    const producers = candidates.filter(replayableStep);
    const via = producers.find((t) => t.from === target.parentStateId) ?? producers[0];
    const from = via === undefined ? undefined : statesById.get(via.from);
    if (via === undefined || from === undefined) {
      const blockedBy = candidates.find((t) => t.from === target.parentStateId) ?? candidates[0] ?? null;
      return {
        ok: false,
        reason:
          blockedBy === null
            ? `no replayable transition produces ${target.id} (no recorded transition leads to it from a known state)`
            : `no replayable transition produces ${target.id}: ${unreplayableStepReason(blockedBy)} (a derived state reached through a side effect or a navigation cannot be re-entered)`,
        blockedBy,
      };
    }
    steps.unshift(via);
    seen.add(from.id);
    current = from;
  }
  return { ok: true, base: current, steps };
}
