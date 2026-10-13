/**
 * Behavior planning: observed click transitions become React state in the
 * nearest section or component (ARIA attributes, text and classes switch
 * with the state), Escape transitions reset it, `<details>` use controlled
 * `open`, and hover/focus transitions become `hover:`/`focus:` variants on
 * the target. Everything that cannot be reproduced is reported with a reason.
 */
import type { Transition, UiNode, UiState } from '@uidna/schema';
import { stableStringify } from '../domain/digest.js';
import { keptAttributes } from './attrs.js';
import { comparePaths } from './components.js';
import { compareStrings } from './jsx.js';
import { indexState, type GenerationModel } from './model.js';
import { emissionInState, transitionClasses, viewInState, type StateEmission } from './styles.js';
import type { TokenIndex } from './tailwind-map.js';

/** A `useState` boolean in a section or component. */
export interface StateVar {
  readonly name: string;
  readonly setter: string;
  readonly transitionId: string;
  readonly escapeTransitionId: string | null;
  /** Scope file (`src/sections/Header.tsx` or `src/components/Card.tsx`). */
  readonly scopeKey: string;
  readonly mode: 'toggle' | 'details';
  readonly description: string;
}

/** Classes that switch with a state. */
export interface ClassCondition {
  readonly state: StateVar;
  readonly whenTrue: readonly string[];
  readonly whenFalse: readonly string[];
}

/** An attribute that switches with a state (`null` means absent). */
export interface AttrCondition {
  readonly state: StateVar;
  readonly whenTrue: string | null;
  readonly whenFalse: string | null;
}

/** Text that switches with a state. */
export interface TextCondition {
  readonly state: StateVar;
  readonly whenTrue: string;
  readonly whenFalse: string;
}

/** Everything behavior adds to one rendered node. */
export interface NodeBehavior {
  clickToggle: StateVar | null;
  detailsState: StateVar | null;
  readonly attrConditions: Map<string, AttrCondition>;
  textCondition: TextCondition | null;
  readonly classConditions: ClassCondition[];
  readonly extraClasses: Set<string>;
}

/** One line of the README "Behavior" section. */
export interface BehaviorReport {
  readonly transitionId: string;
  readonly action: string;
  readonly target: string;
  readonly status: 'implemented' | 'not-implemented';
  readonly detail: string;
  readonly file: string | null;
}

/** Result of behavior planning. */
export interface BehaviorPlan {
  /** Render path → behavior. */
  readonly byPath: ReadonlyMap<string, NodeBehavior>;
  /** Scope file → state variables declared there. */
  readonly stateVars: ReadonlyMap<string, readonly StateVar[]>;
  readonly reports: readonly BehaviorReport[];
}

/** Where a node is rendered. */
export interface ScopeLocation {
  /** Scope file. */
  readonly file: string;
  /** Path under which the node is rendered (the primary instance's path for component nodes). */
  readonly renderPath: string;
  /** Root path of the component instance containing the node, or null in a section. */
  readonly instanceRoot: string | null;
}

/** Resolves a node path (narrowest state) to its render location; null when the node is not rendered. */
export type ScopeResolver = (path: string) => ScopeLocation | null;

function describeTarget(target: Transition['action']['target']): string {
  if (target === null) return 'no target';
  const role = target.role ?? target.tag;
  return target.name === null ? `${role} at ${target.nodePath}` : `${role} "${target.name}" at ${target.nodePath}`;
}

function describeAction(transition: Transition): string {
  const { action } = transition;
  return action.type === 'key' ? `key ${action.key ?? '?'}` : action.type;
}

interface NodeChange {
  readonly path: string;
  readonly attrs: Map<string, { from: string | null; to: string | null }>;
  readonly text: { from: string; to: string } | null;
  readonly classes: { whenTrue: string[]; whenFalse: string[] } | null;
}

/** Diff two states node by node (matched by path). Null when the DOM structure differs. */
/** True when a proper ancestor of `path` is not rendered (box null) in the indexed state. */
function hiddenByAncestor(byPath: ReadonlyMap<string, UiNode>, path: string): boolean {
  const segments = path.split('/');
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    if (byPath.get(segments.slice(0, depth).join('/'))?.box === null) return true;
  }
  return path !== '' && byPath.get('')?.box === null;
}

/**
 * True when an ancestor <details> of `path` changed its `open` attribute: the browser shows and
 * hides its content natively. The details' own <summary> is not content and is never implied.
 */
function toggledDetailsAncestor(fromByPath: ReadonlyMap<string, UiNode>, toByPath: ReadonlyMap<string, UiNode>, path: string): boolean {
  const segments = path.split('/');
  const self = fromByPath.get(path);
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const ancestorPath = segments.slice(0, depth).join('/');
    const before = fromByPath.get(ancestorPath);
    const after = toByPath.get(ancestorPath);
    if (before?.tag === 'details' && after?.tag === 'details' && (before.attrs.open === undefined) !== (after.attrs.open === undefined)) {
      const isOwnSummary = self?.tag === 'summary' && depth === segments.length - 1;
      return !isOwnSummary;
    }
  }
  return false;
}

function diffStates(
  model: GenerationModel,
  from: UiState,
  to: UiState,
  prefix: string,
  tokens: TokenIndex,
): { changes: NodeChange[]; skippedProperties: number } | null {
  const fromIndex = indexState(from);
  const toIndex = indexState(to);
  if (fromIndex.byPath.size !== toIndex.byPath.size) return null;
  for (const path of fromIndex.byPath.keys()) if (!toIndex.byPath.has(path)) return null;
  const changes: NodeChange[] = [];
  let skippedProperties = 0;
  const paths = [...fromIndex.byPath.keys()].sort(comparePaths);
  for (const path of paths) {
    const gn = model.byPath.get(path);
    if (gn === undefined || gn.kind === 'skipped') continue;
    const nodeFrom = fromIndex.byPath.get(path);
    const nodeTo = toIndex.byPath.get(path);
    if (nodeFrom === undefined || nodeTo === undefined) continue;
    if (nodeFrom.tag !== nodeTo.tag) return null;
    const attrs = new Map<string, { from: string | null; to: string | null }>();
    const attrsFrom = keptAttributes(nodeFrom, gn.renderedTag);
    const attrsTo = keptAttributes(nodeTo, gn.renderedTag);
    for (const name of new Set([...attrsFrom.keys(), ...attrsTo.keys()])) {
      const a = attrsFrom.get(name) ?? null;
      const b = attrsTo.get(name) ?? null;
      if (a !== b) attrs.set(name, { from: a, to: b });
    }
    const text = (nodeFrom.text ?? '') !== (nodeTo.text ?? '') ? { from: nodeFrom.text ?? '', to: nodeTo.text ?? '' } : null;
    let classes: { whenTrue: string[]; whenFalse: string[] } | null = null;
    const styleChanged = stableStringify(from.styles[nodeFrom.styleId] ?? {}) !== stableStringify(to.styles[nodeTo.styleId] ?? {});
    // A node that is unrendered only because an ancestor is unrendered needs no classes of its own:
    // its visibility follows the ancestor, which carries the change.
    const impliedByAncestor =
      !styleChanged &&
      (hiddenByAncestor(fromIndex.byPath, path) || hiddenByAncestor(toIndex.byPath, path) || toggledDetailsAncestor(fromIndex.byPath, toIndex.byPath, path));
    if (!impliedByAncestor && (styleChanged || nodeFrom.pseudo !== undefined || nodeTo.pseudo !== undefined || nodeFrom.box === null || nodeTo.box === null)) {
      const viewFrom = viewInState(gn, from, fromIndex.byPath);
      const viewTo = viewInState(gn, to, toIndex.byPath);
      if (viewFrom !== null && viewTo !== null) {
        const options = { skipUaDefaults: false, inheritedSkip: null };
        const emissionFrom: StateEmission = emissionInState(viewFrom, from, options);
        const emissionTo: StateEmission = emissionInState(viewTo, to, options);
        const forward = transitionClasses(emissionFrom, emissionTo, tokens, prefix);
        const backward = transitionClasses(emissionTo, emissionFrom, tokens, prefix);
        skippedProperties += forward.skipped.length;
        if (forward.classes.length > 0 || backward.classes.length > 0) classes = { whenTrue: forward.classes, whenFalse: backward.classes };
      }
    }
    if (attrs.size > 0 || text !== null || classes !== null) changes.push({ path, attrs, text, classes });
  }
  return { changes, skippedProperties };
}

/** Plan behaviors for the document's transitions. */
export function planBehavior(model: GenerationModel, transitions: readonly Transition[], tokens: TokenIndex, resolve: ScopeResolver): BehaviorPlan {
  const byPath = new Map<string, NodeBehavior>();
  const stateVars = new Map<string, StateVar[]>();
  const reports: BehaviorReport[] = [];
  const implementedKeys = new Map<string, StateVar>();
  let counter = 0;

  const behaviorAt = (renderPath: string): NodeBehavior => {
    const existing = byPath.get(renderPath);
    if (existing) return existing;
    const created: NodeBehavior = { clickToggle: null, detailsState: null, attrConditions: new Map(), textCondition: null, classConditions: [], extraClasses: new Set() };
    byPath.set(renderPath, created);
    return created;
  };
  const report = (transition: Transition, status: BehaviorReport['status'], detail: string, file: string | null): void => {
    reports.push({ transitionId: transition.id, action: describeAction(transition), target: describeTarget(transition.action.target), status, detail, file });
  };

  const slotOf = (stateId: string): number => model.slots.findIndex((slot) => slot.state.id === stateId);
  const sorted = [...transitions].sort((a, b) => {
    const wa = model.statesById.get(a.from)?.viewport.width ?? 0;
    const wb = model.statesById.get(b.from)?.viewport.width ?? 0;
    return wa - wb || comparePaths(a.action.target?.nodePath ?? '', b.action.target?.nodePath ?? '') || compareStrings(a.id, b.id);
  });
  const escapeReverts = new Set<string>();

  for (const transition of sorted) {
    if (escapeReverts.has(transition.id)) continue;
    const { action } = transition;
    if (action.target === null) {
      report(transition, 'not-implemented', 'the action has no target element', null);
      continue;
    }
    if (transition.sideEffects) {
      report(transition, 'not-implemented', 'the action caused a non-GET request or a navigation; never reproduced', null);
      continue;
    }
    if (action.type === 'key') {
      report(transition, 'not-implemented', 'key transitions are only reproduced as Escape reverts of an implemented click', null);
      continue;
    }
    const slotIndex = slotOf(transition.from);
    const slot = model.slots[slotIndex];
    if (slotIndex < 0 || slot === undefined) {
      report(transition, 'not-implemented', `from-state ${transition.from} is not a rendered base state`, null);
      continue;
    }
    const fromState = slot.state;
    const toState = model.statesById.get(transition.to);
    if (toState === undefined) {
      report(transition, 'not-implemented', `to-state ${transition.to} is missing`, null);
      continue;
    }
    const target = model.byPath.get(action.target.nodePath);
    if (target === undefined || target.kind === 'skipped') {
      report(transition, 'not-implemented', 'the target is not a rendered node of the narrowest base state', null);
      continue;
    }
    const location = resolve(target.path);
    if (location === null) {
      report(transition, 'not-implemented', 'the target is not rendered', null);
      continue;
    }
    if (action.type === 'hover' || action.type === 'focus') {
      const diff = diffStates(model, fromState, toState, '', tokens);
      if (diff === null) {
        report(transition, 'not-implemented', 'the DOM structure changed between the states; only style changes are reproduced for hover/focus', null);
        continue;
      }
      const own = diff.changes.find((c) => c.path === target.path);
      if (own?.classes === undefined || own.classes === null || own.classes.whenTrue.length === 0) {
        report(transition, 'not-implemented', 'the target\'s computed style did not change (only other nodes or geometry changed)', null);
        continue;
      }
      const behavior = behaviorAt(location.renderPath);
      const variant = `${action.type}:`;
      for (const cls of own.classes.whenTrue) behavior.extraClasses.add(`${variant}${cls}`);
      const others = diff.changes.filter((c) => c.path !== target.path).length;
      report(
        transition,
        'implemented',
        `${variant} classes on the target (${own.classes.whenTrue.join(' ')})${others > 0 ? `; ${others} other node(s) also changed and are not reproduced` : ''}${slot.breakpoint === null ? '' : `; observed at ${slot.width}px, applied at every width`}${location.instanceRoot === null ? '' : '; the target is in a component, so every instance gets the variant'}`,
        location.file,
      );
      continue;
    }

    // click
    // Like hover and focus variants, click-state classes are observed at one width and applied at every width.
    const diff = diffStates(model, fromState, toState, '', tokens);
    if (diff === null) {
      report(transition, 'not-implemented', 'nodes were added or removed between the states; the baseline only reproduces attribute, text and style changes on existing nodes', null);
      continue;
    }
    if (diff.changes.length === 0) {
      report(transition, 'not-implemented', 'no attribute, text or style changed on any node (only geometry changed)', null);
      continue;
    }
    const locations = diff.changes.map((c) => ({ change: c, location: resolve(c.path) }));
    const unrendered = locations.find((l) => l.location === null);
    if (unrendered) {
      report(transition, 'not-implemented', `node ${unrendered.change.path} changed but is not rendered`, null);
      continue;
    }
    // details/summary: the browser toggles `open` natively. The state lives with the <details>
    // element; the summary's own changes (e.g. a marker in ::after) become `group-open:` variants
    // so they need no state even when the summary is a separate component.
    const parent = target.parent;
    const isDetails = target.renderedTag === 'summary' && parent?.renderedTag === 'details';
    const anchor = isDetails && parent ? (resolve(parent.path) ?? location) : location;
    const inSummary = (path: string): boolean => path === target.path || path.startsWith(`${target.path}/`);
    const foreign = locations.filter(
      (l) =>
        l.location !== null &&
        !(l.location.file === anchor.file && l.location.instanceRoot === anchor.instanceRoot) &&
        !(isDetails && inSummary(l.change.path)),
    );
    if (foreign.length > 0) {
      const files = [...new Set(foreign.map((l) => l.location?.file ?? '?'))].join(', ');
      report(transition, 'not-implemented', `changes span ${anchor.file} and ${files}; state hoisting across files is not implemented in the baseline`, null);
      continue;
    }

    const detailsChange = isDetails && parent ? locations.find((l) => l.change.path === parent.path && l.change.attrs.has('open')) : undefined;
    const mode: StateVar['mode'] = detailsChange ? 'details' : 'toggle';
    const key = `${anchor.file}|${anchor.renderPath}|${mode}`;
    const already = implementedKeys.get(key);
    if (already) {
      report(transition, 'implemented', `covered by ${already.name} (${already.transitionId}): same target in the same ${anchor.instanceRoot === null ? 'section' : 'component'}`, anchor.file);
      continue;
    }
    const escape = transitions.find((t) => t.action.type === 'key' && t.action.key === 'Escape' && t.from === transition.to && t.to === transition.from && !t.sideEffects);
    const reverseClick = transitions.find((t) => t.id !== transition.id && t.action.type === 'click' && t.from === transition.to && t.to === transition.from && t.action.target?.nodePath === action.target?.nodePath);
    counter += 1;
    const name = `state${counter.toString().padStart(2, '0')}`;
    const state: StateVar = {
      name,
      setter: `set${name.charAt(0).toUpperCase()}${name.slice(1)}`,
      transitionId: transition.id,
      escapeTransitionId: escape?.id ?? null,
      scopeKey: anchor.file,
      mode,
      description: `${describeAction(transition)} on ${describeTarget(action.target)} (${transition.id})`,
    };
    implementedKeys.set(key, state);
    if (escape) escapeReverts.add(escape.id);
    const vars = stateVars.get(anchor.file) ?? [];
    vars.push(state);
    stateVars.set(anchor.file, vars);

    const wired: string[] = [];
    const notReproduced: string[] = [];
    if (mode === 'details' && parent) {
      behaviorAt(anchor.renderPath).detailsState = state;
      behaviorAt(anchor.renderPath).extraClasses.add('group');
      wired.push(`<details open={${name}}> with onToggle`);
    } else {
      behaviorAt(location.renderPath).clickToggle = state;
      wired.push(`onClick toggles ${name}`);
    }
    for (const { change, location: changeLocation } of locations) {
      if (changeLocation === null) continue;
      const behavior = behaviorAt(changeLocation.renderPath);
      if (mode === 'details' && inSummary(change.path)) {
        // The summary may live in another file: express its open-state styling as group-open: variants.
        if (change.classes !== null) {
          for (const cls of change.classes.whenTrue) behavior.extraClasses.add(`group-open:${cls}`);
          wired.push(`group-open: classes on ${change.path} (${change.classes.whenTrue.join(' ')})`);
        }
        for (const attr of change.attrs.keys()) notReproduced.push(`${attr} on ${change.path} (summary attribute changes need state across files)`);
        if (change.text !== null) notReproduced.push(`text on ${change.path} (summary text changes need state across files)`);
        continue;
      }
      for (const [attr, values] of change.attrs) {
        if (mode === 'details' && attr === 'open' && change.path === parent?.path) continue;
        behavior.attrConditions.set(attr, { state, whenTrue: values.to, whenFalse: values.from });
        wired.push(`${attr} on ${change.path}`);
      }
      if (change.text !== null) {
        behavior.textCondition = { state, whenTrue: change.text.to, whenFalse: change.text.from };
        wired.push(`text on ${change.path}`);
      }
      if (change.classes !== null) {
        behavior.classConditions.push({ state, whenTrue: change.classes.whenTrue, whenFalse: change.classes.whenFalse });
        wired.push(`classes on ${change.path} (${change.classes.whenFalse.join(' ') || '∅'} → ${change.classes.whenTrue.join(' ') || '∅'})`);
      }
    }
    const notes: string[] = [];
    notes.push(escape ? `Escape resets it (${escape.id})` : 'no Escape revert was observed');
    notes.push(reverseClick ? `the reverse click was observed (${reverseClick.id})` : 'toggling back is assumed, the reverse click was not observed');
    if (anchor.instanceRoot !== null) notes.push('state lives in the component, so every instance toggles independently');
    if (diff.skippedProperties > 0) notes.push(`${diff.skippedProperties} changed propert${diff.skippedProperties === 1 ? 'y' : 'ies'} could not be expressed as classes`);
    if (notReproduced.length > 0) notes.push(`not reproduced: ${notReproduced.join(', ')}`);
    report(transition, 'implemented', `${name}: ${wired.join(', ')}; ${notes.join('; ')}`, anchor.file);
  }

  return { byPath, stateVars, reports };
}
