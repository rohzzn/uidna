/**
 * The tracer the generated behavior tests and the verifier share: derived
 * states are re-entered only through transitions without side effects that
 * are not navigations, preferring the recorded parent, bounded, and the
 * refused producer is named.
 */
import { describe, expect, it } from 'vitest';
import type { Transition, UiState } from 'uidna-schema';
import { multiPageFormDocument } from './testing.js';
import { MAX_REPLAY_CHAIN, replayableStep, sideEffectCause, traceToBase, unreplayableStepReason } from './trace.js';

function fixture(): { transitions: Transition[]; statesById: Map<string, UiState>; state: (id: string) => UiState } {
  const dna = multiPageFormDocument();
  const statesById = new Map(dna.states.items.map((s) => [s.id, s] as const));
  const state = (id: string): UiState => {
    const found = statesById.get(id);
    if (found === undefined) throw new Error(`fixture state ${id} missing`);
    return found;
  };
  return { transitions: dna.states.transitions, statesById, state };
}

describe('traceToBase (shared by the generated tests and the verifier)', () => {
  it('replays the producing chain from the base state, preferring the recorded parent', () => {
    const { transitions, statesById, state } = fixture();
    const traced = traceToBase(transitions, statesById, state('st_07'));
    expect(traced.ok).toBe(true);
    if (traced.ok) {
      expect(traced.base.id).toBe('st_03');
      expect(traced.steps.map((t) => t.id)).toEqual(['tr_03', 'tr_04']);
    }
    expect(traceToBase(transitions, statesById, state('st_03'))).toMatchObject({ ok: true, steps: [] });
    // A second producer of st_06 that does not come from its recorded parent is only a fallback, and the lowest id wins among fallbacks.
    const tr03 = transitions.find((t) => t.id === 'tr_03');
    if (tr03 === undefined) throw new Error('tr_03 missing');
    const alternatives = [...transitions, { ...tr03, id: 'tr_91', from: 'st_05' }, { ...tr03, id: 'tr_90', from: 'st_05' }];
    const viaParent = traceToBase(alternatives, statesById, state('st_06'));
    expect(viaParent.ok && viaParent.steps.map((t) => t.id)).toEqual(['tr_03']);
    const withoutParent = alternatives.filter((t) => t.id !== 'tr_03');
    const viaFallback = traceToBase(withoutParent, statesById, state('st_06'));
    expect(viaFallback.ok && viaFallback.steps.map((t) => t.id)).toEqual(['tr_02', 'tr_90']);
  });

  it('never re-enters a state through a side effect or a navigation and names the refused producer', () => {
    const { transitions, statesById, state } = fixture();
    // The empty submit sent a blocked POST and the fills start from the state it produced.
    const sideEffect = transitions.map((t) => (t.id === 'tr_02' ? { ...t, sideEffects: true, network: { requests: 1, nonGet: 1 } } : t.id === 'tr_03' ? { ...t, from: 'st_05' } : t));
    const states = new Map(statesById);
    states.set('st_06', { ...state('st_06'), parentStateId: 'st_05' });
    const blocked = traceToBase(sideEffect, states, state('st_07'));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.blockedBy?.id).toBe('tr_02');
      expect(blocked.reason).toBe('no replayable transition produces st_05: tr_02 caused side effects when it was observed (a non-GET request) and is never repeated (a derived state reached through a side effect or a navigation cannot be re-entered)');
    }
    // A navigation never re-enters a derived state either, even without a side effect.
    const navigation = transitions.map((t) => (t.id === 'tr_06' ? { ...t, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } } : t));
    const nav = traceToBase(navigation, statesById, state('st_09'));
    expect(nav.ok).toBe(false);
    if (!nav.ok) {
      expect(nav.blockedBy?.id).toBe('tr_06');
      expect(nav.reason).toContain('tr_06 is a navigation to page pg_02 and never re-enters a derived state');
    }
    // No producer at all: nothing to name.
    const orphan = traceToBase(
      transitions.filter((t) => t.id !== 'tr_06'),
      statesById,
      state('st_09'),
    );
    expect(orphan).toMatchObject({ ok: false, blockedBy: null });
  });

  it('refuses a chain longer than MAX_REPLAY_CHAIN', () => {
    const { transitions, statesById, state } = fixture();
    const tr03 = transitions.find((t) => t.id === 'tr_03');
    if (tr03 === undefined) throw new Error('tr_03 missing');
    const chain = new Map(statesById);
    const long = [...transitions];
    let previous = 'st_06';
    for (let i = 0; i < MAX_REPLAY_CHAIN; i += 1) {
      const id = `st_${(50 + i).toString()}`;
      chain.set(id, { ...state('st_06'), id, parentStateId: previous });
      long.push({ ...tr03, id: `tr_${(50 + i).toString()}`, from: previous, to: id });
      previous = id;
    }
    const last = chain.get(previous);
    if (last === undefined) throw new Error('chain state missing');
    expect(traceToBase(long, chain, last)).toEqual({ ok: false, reason: `the chain of transitions producing ${previous} is longer than ${MAX_REPLAY_CHAIN} steps`, blockedBy: null });
  });

  it('describes side effects from the network counts and refuses navigations as steps', () => {
    expect(sideEffectCause({ network: { requests: 1, nonGet: 1 } })).toBe('a non-GET request');
    expect(sideEffectCause({ network: { requests: 5, nonGet: 2 } })).toBe('2 non-GET requests');
    expect(sideEffectCause({ network: { requests: 0, nonGet: 0 } })).toBe('a navigation');
    expect(replayableStep({ sideEffects: false, navigation: null })).toBe(true);
    expect(replayableStep({ sideEffects: false })).toBe(true);
    expect(replayableStep({ sideEffects: true, navigation: null })).toBe(false);
    expect(replayableStep({ sideEffects: false, navigation: { toPageId: 'pg_02', url: 'http://127.0.0.1:4173/features.html' } })).toBe(false);
    const { transitions } = fixture();
    const tr05 = transitions.find((t) => t.id === 'tr_05');
    if (tr05 === undefined) throw new Error('tr_05 missing');
    expect(unreplayableStepReason(tr05)).toBe('tr_05 caused side effects when it was observed (a non-GET request) and is never repeated');
  });
});
