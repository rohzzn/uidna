/**
 * Behavior planning: observed click transitions become React state in the
 * nearest section, page or component (ARIA attributes, text and classes
 * switch with the state), Escape transitions reset it, `<details>` use
 * controlled `open`, hover/focus transitions become `hover:`/`focus:`
 * variants on the target, submit transitions become a controlled `onSubmit`
 * that runs `checkValidity()` per control and toggles the observed
 * validation messages, fill transitions are documented (the controls stay
 * uncontrolled) and navigation transitions are checked against the router
 * links. Everything that cannot be reproduced is reported with a reason, and
 * every implemented transition carries the expectations its behavior test
 * asserts.
 */
import { neverReplayed } from '../domain/safe-policy.js';
import type { Action, ActionTarget, Transition, UiNode, UiState, Viewport } from '@rohzzn/uidna-schema';
import { stableStringify } from '../domain/digest.js';
import { isFormControl, keptAttributes } from './attrs.js';
import { comparePaths } from './components.js';
import { compareStrings } from './jsx.js';
import { indexState, isAncestorPath, type GenNode, type GenerationModel } from './model.js';
import { pageKeyOf } from './site.js';
import { emissionInState, transitionClasses, viewInState, type StateEmission } from './styles.js';
import type { TokenIndex } from './tailwind-map.js';
import { traceToBase, unreplayableStepReason } from './trace.js';

/** A `useState` boolean in a section, page or component. */
export interface StateVar {
  readonly name: string;
  readonly setter: string;
  readonly transitionId: string;
  readonly escapeTransitionId: string | null;
  /** Scope file (`src/sections/Header.tsx`, `src/pages/Home.tsx` or `src/components/Card.tsx`). */
  readonly scopeKey: string;
  /**
   * `toggle` flips on click, `select` sets on click and resets the other states of its group (tabs),
   * `details` follows the element's open state; `form-error` is one control's validity after submit,
   * `form-invalid` any control's, `form-submitted` a valid submit.
   */
  readonly mode: 'toggle' | 'select' | 'details' | 'form-error' | 'form-invalid' | 'form-submitted';
  /** Exclusive group of `select` states (the path of the targets' common parent), else null. */
  readonly group: string | null;
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

/** A form control whose validity toggles observed messages. */
export interface FormControlBehavior {
  readonly state: StateVar;
  /** `name` or `id` attribute for `form.elements.namedItem`, or null when the control has neither. */
  readonly key: string | null;
  /** Render path of the control (fallback locator `[data-uidna-path]`). */
  readonly path: string;
  readonly describe: string;
  /** Observed message texts shown for this control. */
  readonly messages: string[];
  /** The browser's own validation message recorded on the control after the submit, when any. */
  readonly nativeMessage: string | null;
}

/** A `<form>` with a generated `onSubmit`. */
export interface FormBehavior {
  /** Render path of the form. */
  readonly formPath: string;
  readonly handler: string;
  readonly transitionIds: string[];
  readonly controls: FormControlBehavior[];
  /** True once any control is invalid after a submit (form-level messages). */
  invalid: StateVar | null;
  /** True once a submit passed validation (status messages; no request is made). */
  submitted: StateVar | null;
  /** `noValidate` on the form: captured, or implied by observed custom messages (native bubbles would block the submit event). */
  noValidate: 'captured' | 'implied' | null;
  readonly describe: string;
}

/** Everything behavior adds to one rendered node. Condition lists are in planning order; a later condition takes precedence when its state is set. */
export interface NodeBehavior {
  clickToggle: StateVar | null;
  detailsState: StateVar | null;
  readonly attrConditions: Map<string, AttrCondition[]>;
  readonly textConditions: TextCondition[];
  readonly classConditions: ClassCondition[];
  readonly extraClasses: Set<string>;
  form: FormBehavior | null;
}

/** How a behavior test locates a node: role and exact name (nth match) when known, always the path. */
export interface LocatorSpec {
  readonly path: string;
  readonly role: string | null;
  readonly name: string | null;
  readonly nth: number | null;
}

/** What a behavior test asserts after the action. */
export type Expectation =
  | { readonly kind: 'attribute'; readonly locator: LocatorSpec; readonly attribute: string; readonly value: string | null }
  | { readonly kind: 'visible'; readonly locator: LocatorSpec; readonly visible: boolean }
  | { readonly kind: 'text'; readonly locator: LocatorSpec; readonly text: string; readonly exact: boolean }
  | { readonly kind: 'url'; readonly pattern: string }
  | { readonly kind: 'value'; readonly locator: LocatorSpec; readonly value: string; readonly control: 'text' | 'select' | 'checkbox' };

/** One action of a behavior test. */
export interface TestStep {
  readonly action: Action['type'];
  readonly locator: LocatorSpec | null;
  readonly key: string | null;
  readonly value: string | null;
  readonly control: 'text' | 'select' | 'checkbox';
  /** True when a submit step clicks the target (a submit button) rather than requesting submission of its form. */
  readonly click: boolean;
}

/** A behavior test for an implemented transition. */
export interface TransitionTest {
  readonly transitionId: string;
  readonly pageId: string;
  readonly route: string;
  readonly viewport: Viewport;
  /** Steps that bring the page from its base state to the transition's from-state (traced by `traceToBase`, so never a side effect or a navigation). */
  readonly setup: readonly TestStep[];
  readonly step: TestStep;
  readonly expectations: readonly Expectation[];
  /** Escape revert observed after the action, with what it restores. */
  readonly revert: { readonly step: TestStep; readonly expectations: readonly Expectation[] } | null;
  /** Transitions with the same key replay the same interaction at the same viewport; one test covers them. */
  readonly dedupeKey: string;
}

/** One line of the README "Behavior" section. */
export interface BehaviorReport {
  readonly transitionId: string;
  readonly action: string;
  readonly target: string;
  readonly status: 'implemented' | 'not-implemented';
  readonly detail: string;
  readonly file: string | null;
  /** The behavior test, for implemented transitions whose outcome can be asserted. */
  readonly test: TransitionTest | null;
  /** True when the transition is never repeated (see `neverReplayed`): the generated suite skips it, as the verifier does. */
  readonly neverReplayed: boolean;
  /** Requests the action sent when it was observed; the skip of a never-replayed transition names its side effect from them (see `sideEffectCause`). */
  readonly network: Transition['network'];
}

/** Result of behavior planning. */
export interface BehaviorPlan {
  /** Render path → behavior. */
  readonly byPath: ReadonlyMap<string, NodeBehavior>;
  /** Scope file → state variables declared there. */
  readonly stateVars: ReadonlyMap<string, readonly StateVar[]>;
  /** Scope file → forms with a generated onSubmit there. */
  readonly forms: ReadonlyMap<string, readonly FormBehavior[]>;
  readonly reports: readonly BehaviorReport[];
  /**
   * Component instance roots whose nodes change together with nodes outside the instance's file.
   * The generator renders those definitions inline and plans again, so the state stays in one file.
   */
  readonly conflictingInstanceRoots: ReadonlySet<string>;
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

/** A node rendered by a layout shared from another page. */
export interface HoistedLocation {
  readonly file: string;
  readonly sectionName: string;
  readonly sourcePageId: string;
  readonly sourceModel: GenerationModel;
}

/** Options of `planBehavior`. */
export interface BehaviorOptions {
  /** Route pattern a page link resolves to, or null (see `makeRouteResolver`). */
  readonly routeOf?: (node: UiNode) => string | null;
  /** Page id → route pattern of every generated page. */
  readonly routeByPageId?: ReadonlyMap<string, string>;
  /** Route of the page being planned (tests open it); `/` by default. */
  readonly pageRoute?: string;
  /** Nodes under a header/footer that a layout renders from another page. */
  readonly hoisted?: (path: string) => HoistedLocation | null;
}

/** Attributes a test asserts directly (visibility covers `hidden`, the router covers `href`). */
const ATTR_NOT_TESTED: ReadonlySet<string> = new Set(['hidden', 'href', 'class', 'style', 'value', 'checked']);

function describeTarget(target: Transition['action']['target']): string {
  if (target === null) return 'no target';
  const role = target.role ?? target.tag;
  return target.name === null ? `${role} at ${target.nodePath}` : `${role} "${target.name}" at ${target.nodePath}`;
}

function describeAction(transition: Transition): string {
  const { action } = transition;
  return action.type === 'key' ? `key ${action.key ?? '?'}` : action.type;
}

/** Locator of a scanned node for a test. */
export function locatorOf(node: UiNode): LocatorSpec {
  return { path: node.path, role: node.role, name: node.name, nth: node.a11y.nth ?? null };
}

function locatorOfTarget(target: ActionTarget): LocatorSpec {
  return { path: target.nodePath, role: target.role, name: target.name, nth: target.nth };
}

function controlKind(node: UiNode | undefined): TestStep['control'] {
  if (node === undefined) return 'text';
  const tag = node.tag.toLowerCase();
  if (tag === 'select') return 'select';
  const type = (node.attrs.type ?? node.form?.type ?? '').toLowerCase();
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return 'checkbox';
  return 'text';
}

function stepOf(transition: Transition, fromState: UiState | undefined): TestStep {
  const { action } = transition;
  const target = action.target;
  const node = target === null || fromState === undefined ? undefined : (fromState.nodes.find((n) => n.id === target.nodeId) ?? fromState.nodes.find((n) => n.path === target.nodePath));
  const tag = node?.tag.toLowerCase() ?? target?.tag.toLowerCase() ?? '';
  const type = (node?.attrs.type ?? '').toLowerCase();
  // A <button> submits unless its type says otherwise; only submit and image inputs do.
  const submitControl = (tag === 'button' && type !== 'button' && type !== 'reset') || (tag === 'input' && (type === 'submit' || type === 'image'));
  return {
    action: action.type,
    locator: target === null ? null : locatorOfTarget(target),
    key: action.key ?? null,
    value: action.value ?? null,
    control: controlKind(node),
    click: action.type === 'submit' && submitControl,
  };
}

interface NodeChange {
  readonly path: string;
  readonly attrs: Map<string, { from: string | null; to: string | null }>;
  readonly text: { from: string; to: string } | null;
  readonly classes: { whenTrue: string[]; whenFalse: string[] } | null;
  /** Rendered (box) before and after. */
  readonly rendered: { from: boolean; to: boolean };
  readonly nodeTo: UiNode;
  /** True when the node has rendered element children (text assertions then use `toContainText`). */
  readonly hasChildren: boolean;
}

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

/** Diff two states node by node (matched by path). Null when the DOM structure differs. */
function diffStates(model: GenerationModel, from: UiState, to: UiState, prefix: string, tokens: TokenIndex): { changes: NodeChange[]; skippedProperties: number } | null {
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
    const rendered = { from: nodeFrom.box !== null, to: nodeTo.box !== null };
    if (attrs.size > 0 || text !== null || classes !== null) {
      changes.push({ path, attrs, text, classes, rendered, nodeTo, hasChildren: gn.children.some((c) => c.kind !== 'skipped') });
    }
  }
  return { changes, skippedProperties };
}

/** Expectations a test asserts for a set of wired changes (to-state values). */
function expectationsOf(changes: readonly NodeChange[], reverse = false): Expectation[] {
  const out: Expectation[] = [];
  for (const change of changes) {
    const locator = locatorOf(change.nodeTo);
    if (change.rendered.from !== change.rendered.to) out.push({ kind: 'visible', locator, visible: reverse ? change.rendered.from : change.rendered.to });
    for (const [attribute, values] of [...change.attrs.entries()].sort(([a], [b]) => compareStrings(a, b))) {
      if (ATTR_NOT_TESTED.has(attribute)) continue;
      out.push({ kind: 'attribute', locator, attribute, value: reverse ? values.from : values.to });
    }
    if (change.text !== null) {
      const text = reverse ? change.text.from : change.text.to;
      if (text.length > 0) out.push({ kind: 'text', locator, text, exact: !change.hasChildren });
    }
  }
  return out;
}

/** Plan behaviors for the document's transitions. */
export function planBehavior(model: GenerationModel, transitions: readonly Transition[], tokens: TokenIndex, resolve: ScopeResolver, options: BehaviorOptions = {}): BehaviorPlan {
  const byPath = new Map<string, NodeBehavior>();
  const stateVars = new Map<string, StateVar[]>();
  const forms = new Map<string, FormBehavior[]>();
  const reports: BehaviorReport[] = [];
  const implementedKeys = new Map<string, StateVar>();
  const formsByKey = new Map<string, FormBehavior>();
  const conflictingInstanceRoots = new Set<string>();
  const pageRoute = options.pageRoute ?? '/';
  let counter = 0;
  let errorCounter = 0;
  let formCounter = 0;

  const behaviorAt = (renderPath: string): NodeBehavior => {
    const existing = byPath.get(renderPath);
    if (existing) return existing;
    const created: NodeBehavior = { clickToggle: null, detailsState: null, attrConditions: new Map(), textConditions: [], classConditions: [], extraClasses: new Set(), form: null };
    byPath.set(renderPath, created);
    return created;
  };
  const report = (transition: Transition, status: BehaviorReport['status'], detail: string, file: string | null, test: TransitionTest | null = null): void => {
    reports.push({
      transitionId: transition.id,
      action: describeAction(transition),
      target: describeTarget(transition.action.target),
      status,
      detail,
      file,
      test,
      neverReplayed: neverReplayed(transition),
      network: { requests: transition.network.requests, nonGet: transition.network.nonGet },
    });
  };
  const addAttrCondition = (behavior: NodeBehavior, attr: string, condition: AttrCondition): void => {
    const list = behavior.attrConditions.get(attr) ?? [];
    list.push(condition);
    behavior.attrConditions.set(attr, list);
  };
  const declare = (file: string, state: StateVar): void => {
    const vars = stateVars.get(file) ?? [];
    vars.push(state);
    stateVars.set(file, vars);
  };
  const dedupeKey = (transition: Transition, viewport: Viewport): string => `${transition.from}|${transition.action.type}|${transition.action.key ?? ''}|${transition.action.value ?? ''}|${transition.action.target?.nodePath ?? ''}|${viewport.width}`;
  const slotOf = (stateId: string): number => model.slots.findIndex((slot) => slot.state.id === stateId);
  const notRenderedReason = (path: string): string => {
    const hoisted = options.hoisted?.(path);
    return hoisted ? `the target is in the ${hoisted.sectionName} shared from page ${hoisted.sourcePageId} (${hoisted.file}); its behavior is planned with that page` : 'the target is not rendered';
  };

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
    const fromState = model.statesById.get(transition.from);
    const toState = model.statesById.get(transition.to);
    if (fromState === undefined) {
      report(transition, 'not-implemented', `from-state ${transition.from} is missing`, null);
      continue;
    }
    if (toState === undefined) {
      report(transition, 'not-implemented', `to-state ${transition.to} is missing`, null);
      continue;
    }
    // The same tracer as the verifier: a from-state reachable only through a side effect or a navigation is never
    // re-entered, so the transition is neither reproduced from it nor tested (its setup would repeat the side effect).
    const traced = traceToBase(transitions, model.statesById, fromState);
    if (!traced.ok) {
      report(
        transition,
        'not-implemented',
        traced.blockedBy === null
          ? `from-state ${transition.from} is derived and cannot be reached from its base state by replaying transitions (${traced.reason})`
          : `from-state ${transition.from} is reachable only through ${traced.blockedBy.id}: ${unreplayableStepReason(traced.blockedBy)}; this transition is not reproduced from that state and not tested, because its test would have to repeat ${traced.blockedBy.id}`,
        null,
      );
      continue;
    }
    const slotIndex = slotOf(traced.base.id);
    const slot = model.slots[slotIndex];
    if (slotIndex < 0 || slot === undefined) {
      report(transition, 'not-implemented', `from-state ${transition.from} is not a rendered base state of this page`, null);
      continue;
    }
    const setup = traced.steps.map((t) => stepOf(t, model.statesById.get(t.from)));
    const viewport = slot.state.viewport;
    const testOf = (expectations: Expectation[], revert: TransitionTest['revert'] = null): TransitionTest => ({
      transitionId: transition.id,
      pageId: model.pageId,
      route: pageRoute,
      viewport,
      setup,
      step: stepOf(transition, fromState),
      expectations,
      revert,
      dedupeKey: dedupeKey(transition, viewport),
    });

    const target = model.byPath.get(action.target.nodePath);
    if (target === undefined || target.kind === 'skipped') {
      report(transition, 'not-implemented', 'the target is not a rendered node of the narrowest base state', null);
      continue;
    }

    /* ---------------------------------------------------------- navigation */
    if (transition.navigation) {
      const route = options.routeByPageId?.get(transition.navigation.toPageId);
      if (route === undefined) {
        report(transition, 'not-implemented', `the action led to page ${transition.navigation.toPageId}, which is not generated`, null);
        continue;
      }
      const hoisted = options.hoisted?.(target.path) ?? null;
      const location = resolve(target.path);
      if (location === null && hoisted === null) {
        report(transition, 'not-implemented', notRenderedReason(target.path), null);
        continue;
      }
      const linkNode = hoisted ? hoisted.sourceModel.byPath.get(target.path)?.node : target.node;
      const file = location?.file ?? hoisted?.file ?? null;
      if (linkNode?.tag.toLowerCase() !== 'a') {
        report(transition, 'not-implemented', `the navigation was triggered by <${target.node.tag}>, not a link; only <a href> links navigate in the generated app`, null);
        continue;
      }
      const linked = options.routeOf?.(linkNode) ?? null;
      const href = linkNode.attrs.href ?? '';
      const stripHash = (value: string): string => value.replace(/#.*$/, '');
      // An absolute href is written as-is, so following it would leave the generated app for the scanned origin.
      const absoluteHref = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.trim());
      let documentLink = false;
      let documentTarget: string | null = null;
      try {
        const resolved = new URL(href, model.pageUrl);
        documentLink = pageKeyOf(resolved.href) === pageKeyOf(transition.navigation.url);
        documentTarget = `${resolved.pathname}${resolved.search}${resolved.hash}`;
      } catch {
        documentLink = false;
      }
      if (linked !== null && stripHash(linked) === route) {
        // The Link navigates to exactly `linked` (the route plus any fragment), so the test asserts that URL, not the bare pattern.
        report(transition, 'implemented', `<Link to=${JSON.stringify(linked)}> navigates to page ${transition.navigation.toPageId}${hoisted ? ` (rendered by ${hoisted.sectionName} shared from page ${hoisted.sourcePageId})` : ''}`, file, testOf([{ kind: 'url', pattern: linked }]));
      } else if (documentLink && absoluteHref) {
        report(transition, 'not-implemented', `the link href ${JSON.stringify(href)} is absolute: it points at the scanned origin, not at the generated app, so the navigation is not replayed`, null);
      } else if (documentLink && documentTarget !== null) {
        report(transition, 'implemented', `<a href=${JSON.stringify(href)}> loads page ${transition.navigation.toPageId} as a document navigation`, file, testOf([{ kind: 'url', pattern: documentTarget }]));
      } else {
        report(transition, 'not-implemented', `the link href ${JSON.stringify(href)} does not resolve to the page the navigation led to (${transition.navigation.url})`, null);
      }
      continue;
    }

    const location = resolve(target.path);
    if (location === null) {
      report(transition, 'not-implemented', notRenderedReason(target.path), null);
      continue;
    }

    /* ---------------------------------------------------------------- fill */
    if (action.type === 'fill') {
      if (!isFormControl(target.node.tag)) {
        report(transition, 'not-implemented', `the fill target <${target.node.tag}> is not a form control`, null);
        continue;
      }
      const diff = diffStates(model, fromState, toState, '', tokens);
      if (diff === null) {
        report(transition, 'not-implemented', 'nodes were added or removed when the control was filled; live changes are not reproduced', null);
        continue;
      }
      const reacted = diff.changes.filter((c) => c.path !== target.path || [...c.attrs.keys()].some((a) => a !== 'value' && a !== 'checked') || c.text !== null || c.classes !== null);
      if (reacted.length > 0) {
        report(transition, 'not-implemented', `the page reacted to the input (${reacted.length} node(s) changed: ${reacted.map((c) => c.path || 'body').join(', ')}); the generated form validates on submit and does not reproduce live changes`, null);
        continue;
      }
      report(
        transition,
        'implemented',
        `no code needed: the control is uncontrolled, so the browser keeps the typed value${action.value === undefined ? '' : ` (${JSON.stringify(action.value)} was typed during the scan)`}`,
        location.file,
        testOf([{ kind: 'value', locator: locatorOfTarget(action.target), value: action.value ?? '', control: controlKind(target.node) }]),
      );
      continue;
    }

    /* -------------------------------------------------------------- submit */
    if (action.type === 'submit') {
      let formNode: GenNode | null = target;
      while (formNode !== null && formNode.renderedTag !== 'form') formNode = formNode.parent;
      if (formNode === null) {
        report(transition, 'not-implemented', 'the submit target is not inside a <form>', null);
        continue;
      }
      const formLocation = resolve(formNode.path);
      if (formLocation === null) {
        report(transition, 'not-implemented', notRenderedReason(formNode.path), null);
        continue;
      }
      const diff = diffStates(model, fromState, toState, '', tokens);
      if (diff === null) {
        report(transition, 'not-implemented', 'nodes were added or removed by the submit; the generator only toggles attributes, text and styles of existing nodes', null);
        continue;
      }
      const form = formNode;
      const inForm = (path: string): boolean => path === form.path || isAncestorPath(form.path, path);
      const controls: GenNode[] = [];
      const idToPath = new Map<string, string>();
      const toIndex = indexState(toState);
      const collect = (node: GenNode): void => {
        if (node.kind === 'skipped') return;
        if (isFormControl(node.node.tag) && node.kind === 'element') controls.push(node);
        const id = toIndex.byPath.get(node.path)?.attrs.id ?? node.node.attrs.id;
        if (id !== undefined && id.length > 0 && !idToPath.has(id)) idToPath.set(id, node.path);
        for (const child of node.children) collect(child);
      };
      collect(form);
      const controlByPath = new Map(controls.map((c) => [c.path, c] as const));
      const pathToId = new Map([...idToPath.entries()].map(([id, path]) => [path, id] as const));
      const referencedBy = (messagePath: string): GenNode | null => {
        const id = pathToId.get(messagePath);
        if (id === undefined) return null;
        for (const control of controls) {
          const attrs = toIndex.byPath.get(control.path)?.attrs ?? control.node.attrs;
          const refs = `${attrs['aria-errormessage'] ?? ''} ${attrs['aria-describedby'] ?? ''}`.split(/\s+/).filter((r) => r.length > 0);
          if (refs.includes(id)) return control;
        }
        return null;
      };
      const controlsUnder = (node: GenNode): GenNode[] => controls.filter((c) => c.path === node.path || isAncestorPath(node.path, c.path));
      // A message belongs to the only control of its wrapper, or to the closest preceding control that is a direct sibling;
      // a node that wraps exactly one control belongs to that control.
      const byProximity = (path: string): GenNode | null => {
        const node = model.byPath.get(path);
        if (node === undefined) return null;
        const inside = controlsUnder(node);
        if (inside.length === 1 && inside[0] !== undefined) return inside[0];
        if (inside.length > 1) return null;
        const parent = node.parent;
        if (parent === null) return null;
        const inWrapper = controlsUnder(parent);
        if (inWrapper.length === 1 && inWrapper[0] !== undefined) return inWrapper[0];
        const siblings = parent.children.filter((c) => controlByPath.has(c.path) && comparePaths(c.path, path) < 0);
        return siblings[siblings.length - 1] ?? null;
      };
      // A control owns a change only when the submit left it invalid (aria-invalid or native validity in the
      // to-state); a message next to a valid control (a status after a valid submit) is a form-level change,
      // otherwise it would be wired to show while the control is invalid, the opposite of what was observed.
      const invalidInTo = (control: GenNode): boolean => {
        const node = toIndex.byPath.get(control.path);
        return node !== undefined && (node.attrs['aria-invalid'] === 'true' || node.form?.valid === false);
      };
      const mapped = new Map<string, GenNode | null>();
      for (const change of diff.changes) {
        if (!inForm(change.path)) {
          mapped.set(change.path, null);
          continue;
        }
        const candidate = controlByPath.get(change.path) ?? referencedBy(change.path) ?? byProximity(change.path);
        mapped.set(change.path, candidate !== null && invalidInTo(candidate) ? candidate : null);
      }
      const invalidControls = controls.filter((c) => (toIndex.byPath.get(c.path)?.attrs['aria-invalid'] ?? '') === 'true' && (fromState.nodes.find((n) => n.path === c.path)?.attrs['aria-invalid'] ?? '') !== 'true');
      const showedErrors = invalidControls.length > 0 || diff.changes.some((c) => mapped.get(c.path) !== null && mapped.get(c.path) !== undefined && !controlByPath.has(c.path));

      const formKey = `${formLocation.file}|${formLocation.renderPath}|form`;
      let behavior = formsByKey.get(formKey);
      if (behavior === undefined) {
        formCounter += 1;
        const n = formCounter.toString().padStart(2, '0');
        const captured = keptAttributes(form.node, 'form').has('novalidate');
        behavior = {
          formPath: formLocation.renderPath,
          handler: `onSubmit${n}`,
          transitionIds: [],
          controls: [],
          invalid: null,
          submitted: null,
          noValidate: captured ? 'captured' : null,
          describe: `form${form.node.attrs.id === undefined ? '' : ` #${form.node.attrs.id}`} at ${form.path || 'body'}`,
        };
        formsByKey.set(formKey, behavior);
        behaviorAt(formLocation.renderPath).form = behavior;
        const list = forms.get(formLocation.file) ?? [];
        list.push(behavior);
        forms.set(formLocation.file, list);
      }
      const formBehavior = behavior;
      formBehavior.transitionIds.push(transition.id);
      if (showedErrors && formBehavior.noValidate === null) formBehavior.noValidate = 'implied';
      const controlState = (control: GenNode): FormControlBehavior => {
        const existing = formBehavior.controls.find((c) => c.path === control.path);
        if (existing) return existing;
        errorCounter += 1;
        const n = errorCounter.toString().padStart(2, '0');
        const key = control.node.attrs.name ?? control.node.attrs.id ?? null;
        const describe = `${control.node.tag}${key === null ? '' : ` "${key}"`} at ${control.path}`;
        const state: StateVar = {
          name: `error${n}`,
          setter: `setError${n}`,
          transitionId: transition.id,
          escapeTransitionId: null,
          scopeKey: formLocation.file,
          mode: 'form-error',
          group: null,
          description: `${describe} is invalid after submit (${transition.id})`,
        };
        declare(formLocation.file, state);
        const nativeMessage = toIndex.byPath.get(control.path)?.form?.validationMessage ?? null;
        const created: FormControlBehavior = { state, key: key !== null && key.length > 0 ? key : null, path: control.path, describe, messages: [], nativeMessage: nativeMessage !== null && nativeMessage.length > 0 ? nativeMessage : null };
        formBehavior.controls.push(created);
        return created;
      };
      const formLevel = (): StateVar => {
        if (showedErrors) {
          if (formBehavior.invalid === null) {
            counter += 1;
            const n = counter.toString().padStart(2, '0');
            formBehavior.invalid = { name: `invalid${n}`, setter: `setInvalid${n}`, transitionId: transition.id, escapeTransitionId: null, scopeKey: formLocation.file, mode: 'form-invalid', group: null, description: `any control of ${formBehavior.describe} is invalid after submit (${transition.id})` };
            declare(formLocation.file, formBehavior.invalid);
          }
          return formBehavior.invalid;
        }
        if (formBehavior.submitted === null) {
          counter += 1;
          const n = counter.toString().padStart(2, '0');
          formBehavior.submitted = { name: `submitted${n}`, setter: `setSubmitted${n}`, transitionId: transition.id, escapeTransitionId: null, scopeKey: formLocation.file, mode: 'form-submitted', group: null, description: `${formBehavior.describe} passed validation on submit (${transition.id}); backend call not reproduced` };
          declare(formLocation.file, formBehavior.submitted);
        }
        return formBehavior.submitted;
      };

      const wired: string[] = [];
      const notReproduced: string[] = [];
      const wiredChanges: NodeChange[] = [];
      for (const control of invalidControls) controlState(control);
      for (const change of diff.changes) {
        const changeLocation = resolve(change.path);
        if (changeLocation === null) {
          notReproduced.push(`${change.path || 'body'} (not rendered)`);
          continue;
        }
        if (changeLocation.file !== formLocation.file || changeLocation.instanceRoot !== formLocation.instanceRoot) {
          if (changeLocation.instanceRoot !== null) conflictingInstanceRoots.add(changeLocation.instanceRoot);
          if (formLocation.instanceRoot !== null) conflictingInstanceRoots.add(formLocation.instanceRoot);
          notReproduced.push(`${change.path || 'body'} (rendered in ${changeLocation.file}; state across files is not hoisted)`);
          continue;
        }
        const control = mapped.get(change.path) ?? null;
        const state = control === null ? formLevel() : controlState(control).state;
        if (control !== null && !controlByPath.has(change.path) && change.text !== null && change.text.to.length > 0) controlState(control).messages.push(change.text.to);
        const nodeBehavior = behaviorAt(changeLocation.renderPath);
        for (const [attr, values] of change.attrs) {
          addAttrCondition(nodeBehavior, attr, { state, whenTrue: values.to, whenFalse: values.from });
          wired.push(`${attr} on ${change.path}`);
        }
        if (change.text !== null) {
          nodeBehavior.textConditions.push({ state, whenTrue: change.text.to, whenFalse: change.text.from });
          wired.push(`text on ${change.path}`);
        }
        if (change.classes !== null) {
          nodeBehavior.classConditions.push({ state, whenTrue: change.classes.whenTrue, whenFalse: change.classes.whenFalse });
          wired.push(`classes on ${change.path} (${change.classes.whenFalse.join(' ') || '∅'} → ${change.classes.whenTrue.join(' ') || '∅'})`);
        }
        wiredChanges.push(change);
      }
      const notes: string[] = [];
      if (transition.sideEffects || transition.network.nonGet > 0) notes.push('the submission request was blocked during the scan and is never reproduced');
      if (formBehavior.noValidate === 'implied') notes.push('noValidate set because the page showed its own validation messages');
      if (diff.skippedProperties > 0) notes.push(`${diff.skippedProperties} changed propert${diff.skippedProperties === 1 ? 'y' : 'ies'} could not be expressed as classes`);
      if (notReproduced.length > 0) notes.push(`not reproduced: ${notReproduced.join(', ')}`);
      const messages = formBehavior.controls.map((c) => `${c.describe}: ${c.messages.map((m) => JSON.stringify(m)).join(', ') || 'no message text'}`);
      report(
        transition,
        'implemented',
        `${formBehavior.handler} runs checkValidity() per control${showedErrors ? ` and toggles ${wired.length} change(s) by validity (${messages.join('; ')})` : ` and toggles ${wired.length} change(s) once the form is valid`}; ${notes.join('; ') || 'no notes'}`,
        formLocation.file,
        testOf(expectationsOf(wiredChanges)),
      );
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
    if (traced.steps.length > 0) {
      report(transition, 'not-implemented', `from-state ${transition.from} is derived; ${action.type} transitions are only reproduced from a base state`, null);
      continue;
    }

    /* --------------------------------------------------------- hover/focus */
    if (action.type === 'hover' || action.type === 'focus') {
      const diff = diffStates(model, fromState, toState, '', tokens);
      if (diff === null) {
        report(transition, 'not-implemented', 'the DOM structure changed between the states; only style changes are reproduced for hover/focus', null);
        continue;
      }
      const own = diff.changes.find((c) => c.path === target.path);
      if (own?.classes === undefined || own.classes === null || own.classes.whenTrue.length === 0) {
        report(transition, 'not-implemented', "the target's computed style did not change (only other nodes or geometry changed)", null);
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
        testOf([]),
      );
      continue;
    }

    /* --------------------------------------------------------------- click */
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
      const roots = new Set<string>();
      if (anchor.instanceRoot !== null) roots.add(anchor.instanceRoot);
      for (const l of foreign) if (l.location?.instanceRoot !== null && l.location?.instanceRoot !== undefined) roots.add(l.location.instanceRoot);
      for (const root of roots) conflictingInstanceRoots.add(root);
      report(
        transition,
        'not-implemented',
        roots.size > 0
          ? `changes span ${anchor.file} and ${files}; the component instances at ${[...roots].join(', ')} are rendered inline on the next planning pass so the state stays in one file`
          : `changes span ${anchor.file} and ${files}; state hoisting across files is not implemented in the baseline`,
        null,
      );
      continue;
    }

    const detailsChange = isDetails && parent ? locations.find((l) => l.change.path === parent.path && l.change.attrs.has('open')) : undefined;
    // A target that becomes selected (tabs, listbox options) is set, not toggled, and resets its siblings.
    const targetTo = toState.nodes.find((n) => n.path === target.path);
    const targetFrom = fromState.nodes.find((n) => n.path === target.path);
    const becameSelected = targetTo !== undefined && (targetTo.attrs['aria-selected'] === 'true' || targetTo.a11y.selected === true) && !(targetFrom?.attrs['aria-selected'] === 'true' || targetFrom?.a11y.selected === true);
    const mode: StateVar['mode'] = detailsChange ? 'details' : becameSelected && !isDetails ? 'select' : 'toggle';
    const escape = mode === 'select' ? undefined : transitions.find((t) => t.action.type === 'key' && t.action.key === 'Escape' && t.from === transition.to && t.to === transition.from && !t.sideEffects);
    const reproducible = locations.filter((l) => !(mode === 'details' && inSummary(l.change.path) && (l.change.attrs.size > 0 || l.change.text !== null))).map((l) => l.change);
    const revert = escape === undefined ? null : { step: stepOf(escape, toState), expectations: expectationsOf(reproducible, true) };
    const key = `${anchor.file}|${anchor.renderPath}|${mode}`;
    const already = implementedKeys.get(key);
    if (already) {
      report(transition, 'implemented', `covered by ${already.name} (${already.transitionId}): same target in the same ${anchor.instanceRoot === null ? 'section' : 'component'}`, anchor.file, testOf(expectationsOf(reproducible), revert));
      continue;
    }
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
      group: mode === 'select' ? (target.parent?.path ?? '') : null,
      description: `${describeAction(transition)} on ${describeTarget(action.target)} (${transition.id})`,
    };
    implementedKeys.set(key, state);
    if (escape) escapeReverts.add(escape.id);
    declare(anchor.file, state);

    const wired: string[] = [];
    const notReproduced: string[] = [];
    if (mode === 'details' && parent) {
      behaviorAt(anchor.renderPath).detailsState = state;
      behaviorAt(anchor.renderPath).extraClasses.add('group');
      wired.push(`<details open={${name}}> with onToggle`);
    } else {
      behaviorAt(location.renderPath).clickToggle = state;
      wired.push(mode === 'select' ? `onClick selects ${name} (resets the other selected states of ${state.group ?? 'its group'})` : `onClick toggles ${name}`);
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
        addAttrCondition(behavior, attr, { state, whenTrue: values.to, whenFalse: values.from });
        wired.push(`${attr} on ${change.path}`);
      }
      if (change.text !== null) {
        behavior.textConditions.push({ state, whenTrue: change.text.to, whenFalse: change.text.from });
        wired.push(`text on ${change.path}`);
      }
      if (change.classes !== null) {
        behavior.classConditions.push({ state, whenTrue: change.classes.whenTrue, whenFalse: change.classes.whenFalse });
        wired.push(`classes on ${change.path} (${change.classes.whenFalse.join(' ') || '∅'} → ${change.classes.whenTrue.join(' ') || '∅'})`);
      }
    }
    const notes: string[] = [];
    if (mode === 'select') notes.push('the target became selected, so the click sets the state instead of toggling it; no transition back to the base selection was recorded');
    else {
      notes.push(escape ? `Escape resets it (${escape.id})` : 'no Escape revert was observed');
      notes.push(reverseClick ? `the reverse click was observed (${reverseClick.id})` : 'toggling back is assumed, the reverse click was not observed');
    }
    if (anchor.instanceRoot !== null) notes.push('state lives in the component, so every instance toggles independently');
    if (diff.skippedProperties > 0) notes.push(`${diff.skippedProperties} changed propert${diff.skippedProperties === 1 ? 'y' : 'ies'} could not be expressed as classes`);
    if (notReproduced.length > 0) notes.push(`not reproduced: ${notReproduced.join(', ')}`);
    report(transition, 'implemented', `${name}: ${wired.join(', ')}; ${notes.join('; ')}`, anchor.file, testOf(expectationsOf(reproducible), revert));
  }

  return { byPath, stateVars, forms, reports, conflictingInstanceRoots };
}
