/**
 * Behavior rules derived from observed transitions. For every transition the
 * from and to states are compared node by node (matched by path) and the
 * differences are reported as effects: attribute toggles on the target,
 * attribute changes elsewhere, nodes shown, hidden or replaced, class
 * changes, style changes, text changes, navigations. Nothing is inferred: a
 * transition with no node-level difference yields an `unknown` effect that
 * says so, and a text change (which has no effect kind of its own) is an
 * `unknown` effect carrying the measured values.
 */
import type { ActionTarget, BehaviorEffect, BehaviorRule, ObservedProvenance, Transition, UiNode, UiState } from '@uidna/schema';
import { stableStringify } from '../domain/digest.js';
import { sequentialId } from '../domain/ids.js';
import { comparePaths } from './common.js';

/** Effects listed per rule before the remainder is summarized in one `unknown` effect. */
export const MAX_EFFECTS_PER_RULE = 200;

const BOOLEAN_PAIR = new Set(['true', 'false']);

function isToggle(from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && to !== undefined) return BOOLEAN_PAIR.has(from) && BOOLEAN_PAIR.has(to) && from !== to;
  // Presence toggles of boolean attributes such as `open`, `hidden`, `checked`.
  return (from === undefined) !== (to === undefined) && (from ?? to ?? '').length === 0;
}

function classSet(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/\s+/).filter((c) => c.length > 0));
}

function classDetails(from: string | undefined, to: string | undefined): string {
  const before = classSet(from);
  const after = classSet(to);
  const added = [...after].filter((c) => !before.has(c));
  const removed = [...before].filter((c) => !after.has(c));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added: ${added.join(' ')}`);
  if (removed.length > 0) parts.push(`removed: ${removed.join(' ')}`);
  return parts.join('; ') || 'class attribute changed';
}

function stylesEqual(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringify(a) === stableStringify(b);
}

function changedProperties(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((key) => a?.[key] !== b?.[key]).sort();
}

/** Effects for one node path present in both states. */
function nodeEffects(before: UiNode, after: UiNode, from: UiState, to: UiState, isTarget: boolean): BehaviorEffect[] {
  const effects: BehaviorEffect[] = [];
  const where = { targetNodeId: after.id, targetNodePath: after.path };
  if (before.tag !== after.tag) {
    // A different element now sits at this path: the old one is gone and a new one appeared.
    // Diffing their attributes would compare unrelated elements.
    const details = `node replaced: <${before.tag}> became <${after.tag}>`;
    return [
      { kind: 'hide', targetNodeId: before.id, targetNodePath: before.path, details },
      { kind: 'show', ...where, details },
    ];
  }
  const keys = [...new Set([...Object.keys(before.attrs), ...Object.keys(after.attrs)])].sort();
  for (const attribute of keys) {
    const fromValue = before.attrs[attribute];
    const toValue = after.attrs[attribute];
    if (fromValue === toValue) continue;
    if (attribute === 'class') {
      effects.push({
        kind: 'toggle-class',
        attribute,
        ...(fromValue === undefined ? {} : { from: fromValue }),
        ...(toValue === undefined ? {} : { to: toValue }),
        ...where,
        details: classDetails(fromValue, toValue),
      });
      continue;
    }
    const kind: BehaviorEffect['kind'] = isTarget && isToggle(fromValue, toValue) ? 'toggle-attribute' : 'set-attribute';
    effects.push({
      kind,
      attribute,
      ...(fromValue === undefined ? {} : { from: fromValue }),
      ...(toValue === undefined ? {} : { to: toValue }),
      ...where,
      ...(fromValue === undefined ? { details: 'attribute added' } : toValue === undefined ? { details: 'attribute removed' } : {}),
    });
  }
  if (before.visible !== after.visible) {
    effects.push({ kind: after.visible ? 'show' : 'hide', ...where });
  } else if (before.visible && after.visible && effects.length === 0) {
    const styleBefore = from.styles[before.styleId];
    const styleAfter = to.styles[after.styleId];
    if (!stylesEqual(styleBefore, styleAfter)) {
      const changed = changedProperties(styleBefore, styleAfter);
      effects.push({
        kind: 'style-change',
        ...where,
        details: changed.length > 8 ? `${changed.slice(0, 8).join(', ')} and ${changed.length - 8} more` : changed.join(', '),
      });
    }
  }
  if (before.text !== after.text) {
    // No effect kind describes a text change; it is reported as `unknown` with the
    // measured values rather than dropped, so the rule never claims "no difference".
    effects.push({
      kind: 'unknown',
      ...(before.text === null ? {} : { from: before.text }),
      ...(after.text === null ? {} : { to: after.text }),
      ...where,
      details: 'own text changed',
    });
  }
  return effects;
}

function bodyTarget(state: UiState): ActionTarget {
  const body = state.nodes.find((node) => node.path === '') ?? state.nodes[0];
  return {
    nodeId: body?.id ?? 'body',
    nodePath: body?.path ?? '',
    role: body?.role ?? null,
    name: body?.name ?? null,
    tag: body?.tag ?? 'body',
    nth: 0,
  };
}

function compareStates(transition: Transition, from: UiState, to: UiState): BehaviorEffect[] {
  const effects: BehaviorEffect[] = [];
  if (from.url !== to.url) effects.push({ kind: 'navigate', from: from.url, to: to.url });

  const beforeByPath = new Map(from.nodes.map((node) => [node.path, node]));
  const afterByPath = new Map(to.nodes.map((node) => [node.path, node]));
  const targetPath = transition.action.target?.nodePath;
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(comparePaths);
  // The action target first, then everything else in document order.
  if (targetPath !== undefined) {
    const index = paths.indexOf(targetPath);
    if (index > 0) {
      paths.splice(index, 1);
      paths.unshift(targetPath);
    }
  }

  for (const path of paths) {
    const before = beforeByPath.get(path);
    const after = afterByPath.get(path);
    if (before && after) {
      effects.push(...nodeEffects(before, after, from, to, path === targetPath));
    } else if (after) {
      effects.push({ kind: 'show', targetNodeId: after.id, targetNodePath: after.path, details: 'node added' });
    } else if (before) {
      effects.push({ kind: 'hide', targetNodeId: before.id, targetNodePath: before.path, details: 'node removed' });
    }
  }

  if (effects.length === 0) {
    effects.push({ kind: 'unknown', details: 'no attribute, text, visibility or style difference between the two states' });
  }
  if (effects.length > MAX_EFFECTS_PER_RULE) {
    const remainder = effects.length - MAX_EFFECTS_PER_RULE;
    effects.length = MAX_EFFECTS_PER_RULE;
    effects.push({ kind: 'unknown', details: `${remainder} further effects not listed` });
  }
  return effects;
}

/** Derive one behavior rule per transition by diffing its from and to states. */
export function deriveBehavior(states: readonly UiState[], transitions: readonly Transition[]): BehaviorRule[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  return transitions.map((transition, i) => {
    const from = byId.get(transition.from);
    const to = byId.get(transition.to);
    const target: ActionTarget = transition.action.target ?? (from ? bodyTarget(from) : { nodeId: 'body', nodePath: '', role: null, name: null, tag: 'body', nth: 0 });
    const effects: BehaviorEffect[] =
      from && to
        ? compareStates(transition, from, to)
        : [{ kind: 'unknown', details: `state ${from ? transition.to : transition.from} is not available for comparison` }];
    const evidenceId = transition.provenance.evidenceId ?? from?.evidenceId;
    const provenance: ObservedProvenance = {
      kind: 'observed',
      source: 'interaction',
      stateId: transition.from,
      ...(from ? { viewport: from.viewport } : {}),
      ...(evidenceId === undefined ? {} : { evidenceId }),
      capturedAt: transition.provenance.capturedAt,
      confidence: transition.provenance.confidence,
    };
    return {
      id: sequentialId('bhv', i + 1),
      event: {
        type: transition.action.type,
        target,
        ...(transition.action.key === undefined ? {} : { key: transition.action.key }),
      },
      transitionId: transition.id,
      effects,
      provenance,
    };
  });
}
