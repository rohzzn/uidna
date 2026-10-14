/**
 * Which controls a later exploration run must not act on again: page-scoped
 * keys, persisted keys win, and a navigation between two crawled pages is not
 * a side effect.
 */
import { describe, expect, it } from 'vitest';
import type { Action } from '@rohzzn/uidna-schema';
import { knownSideEffects } from './explore-workflow.js';
import type { AttemptedInteraction } from './records.js';

const scan = {
  pageId: 'pg_01',
  states: [
    { stateId: 'st_01', pageId: 'pg_01' },
    { stateId: 'st_02', pageId: 'pg_02' },
    { stateId: 'st_03' },
  ],
};

const click = (nodePath: string): Action => ({ type: 'click', target: { nodeId: `n_${nodePath}`, nodePath, role: 'link', name: 'Go', tag: 'a', nth: 0 } });

const attempt = (stateId: string, nodePath: string, outcome: AttemptedInteraction['outcome'], transitionId: string | null = null): AttemptedInteraction => ({
  stateId,
  action: click(nodePath),
  outcome,
  transitionId,
  reason: null,
  durationMs: 1,
});

describe('knownSideEffects', () => {
  it('scopes keys to the page of the state the action started from', () => {
    const keys = knownSideEffects(scan, { attempted: [attempt('st_02', '0/1', 'side-effect'), attempt('st_03', '0/2', 'side-effect')] }, []);
    expect([...keys].sort()).toEqual(['pg_01:0/2', 'pg_02:0/1']);
  });

  it('treats a navigation that left the crawl as a side effect, and one between crawled pages as not', () => {
    const keys = knownSideEffects(scan, { attempted: [attempt('st_01', '0/3', 'navigated', null), attempt('st_01', '0/4', 'navigated', 'tr_01'), attempt('st_01', '0/5', 'changed', 'tr_02')] }, []);
    expect([...keys]).toEqual(['pg_01:0/3']);
  });

  it('adds the targets of side-effect transitions, but not navigations without side effects', () => {
    const keys = knownSideEffects(scan, null, [
      { from: 'st_02', sideEffects: true, action: click('1/0') },
      { from: 'st_01', sideEffects: false, action: click('1/1') },
      { from: 'st_01', sideEffects: true, action: { type: 'key', target: null, key: 'Escape' } },
    ]);
    expect([...keys]).toEqual(['pg_02:1/0']);
  });

  it('prefers the keys a record persisted over re-deriving them from its attempts', () => {
    const keys = knownSideEffects(scan, { attempted: [attempt('st_01', '0/9', 'side-effect')], sideEffectKeys: ['pg_02:0/7'] }, []);
    expect([...keys]).toEqual(['pg_02:0/7']);
  });
});
