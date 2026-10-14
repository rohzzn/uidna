/**
 * Renders sections, pages, layouts and components to TSX. Sections split a
 * page by landmark (banner/navigation → Header, contentinfo → Footer, the
 * rest → Main); multi-page documents render one component per page under
 * `src/pages/`, hoist a shared header and footer into a Layout around an
 * `<Outlet />`, and turn same-origin page links into react-router `<Link>`.
 * Components render their primary instance once with varying parts replaced
 * by props. Every element carries `data-uidna-path` so verification can match
 * it to the scanned node.
 */
import type { UiNode } from '@rohzzn/uidna-schema';
import type { AssetRegistry, AssetResolution } from './assets.js';
import { BOOLEAN_ATTRIBUTES, keptAttributes } from './attrs.js';
import type { AttrCondition, BehaviorPlan, ClassCondition, FormBehavior, NodeBehavior, ScopeResolver, StateVar, TextCondition } from './behavior.js';
import type { ComponentPlan, ComponentPlanning, PropValue } from './components.js';
import { commentText, element, jsString, jsxAttrName, printJsx, type JsxAttrValue, type JsxChild } from './jsx.js';
import { isFooterish, isHeaderish, joinPath, relativePath, splitLandmarks, VOID_TAGS, type GenNode, type GenerationModel } from './model.js';
import { routeAlias, type LayoutPlan, type PagePlan, type SitePlan } from './site.js';
import type { NodeClasses } from './styles.js';
import type { TokenIndex } from './tailwind-map.js';

/** A landmark section of a page, or the page itself (`kind: 'page'`). */
export interface SectionPlan {
  /** Component name: `Header`, `Main`, `Footer` (with a layout suffix), or the page name. */
  readonly name: string;
  readonly file: string;
  readonly roots: readonly GenNode[];
  readonly kind: 'section' | 'page';
}

/** Shared rendering inputs. */
export interface RenderContext {
  readonly model: GenerationModel;
  readonly tokens: TokenIndex;
  readonly assets: AssetRegistry;
  readonly components: ComponentPlanning;
  readonly behavior: BehaviorPlan;
  readonly classesOf: (node: GenNode) => NodeClasses;
  readonly scanId: string;
  /** Route pattern a page link resolves to; absent or null keeps `<a href>`. */
  readonly routeOf?: (node: UiNode) => string | null;
}

/** A rendered source file. */
export interface RenderedFile {
  readonly file: string;
  readonly code: string;
}

/** Options of `renderSection` for page components. */
export interface SectionRenderOptions {
  /** Document title set by the page component on mount (multi-page documents). */
  readonly title?: string;
  /** Doc comment of the component, when not a landmark section. */
  readonly doc?: string;
}

const PLACEHOLDER_CLASSES = ['bg-[#e5e7eb]', 'flex', 'items-center', 'justify-center', 'overflow-hidden', 'text-[#6b7280]', 'text-[12px]'];
const DISPLAY_CLASSES = new Set(['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'list-item', 'hidden', 'contents', 'flow-root', 'table']);
const STATE_VARIANTS = new Set(['hover', 'focus', 'active', 'focus-visible', 'focus-within']);
/** Import path of the validity helper from any `src/<dir>/` file. */
const VALIDITY_IMPORT = '../lib/validity';

/** Landmark helpers live in `model.ts` (site planning needs them too); re-exported for callers of this module. */
export { isFooterish, isHeaderish, splitLandmarks };

/** Split the body's children into Header/Main/Footer by landmark (single-page layout). */
export function planSections(model: GenerationModel): SectionPlan[] {
  const { header, main, footer } = splitLandmarks(model);
  const sections: SectionPlan[] = [];
  if (header.length > 0) sections.push({ name: 'Header', file: 'src/sections/Header.tsx', roots: header, kind: 'section' });
  if (main.length > 0) sections.push({ name: 'Main', file: 'src/sections/Main.tsx', roots: main, kind: 'section' });
  if (footer.length > 0) sections.push({ name: 'Footer', file: 'src/sections/Footer.tsx', roots: footer, kind: 'section' });
  return sections;
}

/**
 * Sections of a page in a multi-page document: the page component holds
 * everything the shared layout does not, and the layout's source page also
 * renders the hoisted header and footer files. Returns the hoisted root paths
 * too, so planners can leave them out on the other pages of the group.
 */
export function planPageSections(page: PagePlan): { sections: SectionPlan[]; hoisted: { header: GenNode[]; footer: GenNode[] } } {
  const { header, main, footer } = splitLandmarks(page.model);
  const layout = page.layout;
  const hoistHeader = layout !== null && layout.header && header.length > 0;
  const hoistFooter = layout !== null && layout.footer && footer.length > 0;
  const own = [...(hoistHeader ? [] : header), ...main, ...(hoistFooter ? [] : footer)];
  const sections: SectionPlan[] = [];
  const isSource = layout !== null && layout.sourcePageId === page.page.id;
  if (layout !== null && isSource && hoistHeader) sections.push({ name: layout.headerName, file: layout.headerFile, roots: header, kind: 'section' });
  sections.push({ name: page.name, file: page.file, roots: own, kind: 'page' });
  if (layout !== null && isSource && hoistFooter) sections.push({ name: layout.footerName, file: layout.footerFile, roots: footer, kind: 'section' });
  return { sections, hoisted: { header: hoistHeader ? header : [], footer: hoistFooter ? footer : [] } };
}

/** Build the resolver that maps a node path to the file and render path it lives in. */
export function makeScopeResolver(model: GenerationModel, sections: readonly SectionPlan[], components: ComponentPlanning): ScopeResolver {
  return (path) => {
    const gn = model.byPath.get(path);
    if (gn === undefined || gn.kind === 'skipped') return null;
    let current: GenNode | null = gn;
    while (current !== null) {
      const instance = components.instanceByPath.get(current.path);
      if (instance) {
        const rel = relativePath(instance.instance.root.path, path);
        if (rel === null) return null;
        return { file: instance.plan.file, renderPath: joinPath(instance.plan.primary.path, rel), instanceRoot: instance.instance.root.path };
      }
      current = current.parent;
    }
    let top: GenNode = gn;
    while (top.parent !== null && top.parent.path !== '') top = top.parent;
    if (top.path === '') return null;
    const section = sections.find((s) => s.roots.some((root) => root.path === top.path));
    if (section === undefined) return null;
    return { file: section.file, renderPath: path, instanceRoot: null };
  };
}

interface ScopeState {
  readonly file: string;
  readonly component: ComponentPlan | null;
  readonly pathAttr: (node: GenNode) => JsxAttrValue;
  readonly imports: Set<string>;
  /** Names imported from react-router-dom. */
  readonly router: Set<string>;
}

/** Order classes: base (incl. before:/after:), then hover/focus variants, then breakpoints in ascending width. */
export function orderClasses(classes: Iterable<string>, breakpoints: readonly string[]): string[] {
  const rank = (cls: string): number => {
    const colon = cls.indexOf(':');
    if (colon < 0) return 0;
    const prefix = cls.slice(0, colon);
    const bp = breakpoints.indexOf(prefix);
    if (bp >= 0) return 10 + bp;
    if (STATE_VARIANTS.has(prefix)) return 1;
    return 0;
  };
  return [...new Set(classes)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function conditionExpr(state: StateVar, whenTrue: string, whenFalse: string): string {
  return `${state.name} ? ${jsString(whenTrue)} : ${jsString(whenFalse)}`;
}

/** Nested ternary over conditions in planning order: a later condition takes precedence, the first one's off-value is the base. */
function chainExpr<T>(conditions: readonly T[], state: (c: T) => StateVar, on: (c: T) => string, off: (c: T) => string): string {
  const first = conditions[0];
  if (first === undefined) return 'undefined';
  let expr = off(first);
  for (const condition of conditions) expr = `${state(condition).name} ? ${on(condition)} : ${expr}`;
  return expr;
}

/** Attribute value expression for one or more conditions on the same attribute. */
function attrConditionExpr(name: string, conditions: readonly AttrCondition[]): string {
  if (BOOLEAN_ATTRIBUTES.has(name)) return chainExpr(conditions, (c) => c.state, (c) => (c.whenTrue === null ? 'false' : 'true'), (c) => (c.whenFalse === null ? 'false' : 'true'));
  if (name === 'tabindex') {
    const numeric = (value: string | null): string => (value !== null && /^-?\d+$/.test(value) ? value : 'undefined');
    return chainExpr(conditions, (c) => c.state, (c) => numeric(c.whenTrue), (c) => numeric(c.whenFalse));
  }
  const text = (value: string | null): string => (value === null ? 'undefined' : jsString(value));
  return chainExpr(conditions, (c) => c.state, (c) => text(c.whenTrue), (c) => text(c.whenFalse));
}

/** Text expression for one or more text conditions on the same node. */
function textConditionExpr(conditions: readonly TextCondition[]): string {
  return chainExpr(conditions, (c) => c.state, (c) => jsString(c.whenTrue), (c) => jsString(c.whenFalse));
}

/**
 * Class expression for the conditions on one node: conditions with the same
 * classes share one `(a || b)` test; otherwise a later condition takes
 * precedence and every branch keeps the base classes it does not replace.
 */
function classConditionsExpr(conditions: readonly ClassCondition[]): string {
  const base = [...new Set(conditions.flatMap((c) => c.whenFalse))];
  const groups: { states: StateVar[]; on: string[]; key: string }[] = [];
  for (const condition of conditions) {
    const on = [...new Set([...condition.whenTrue, ...base.filter((cls) => !condition.whenFalse.includes(cls))])];
    const key = on.join(' ');
    const existing = groups.find((g) => g.key === key);
    if (existing) {
      if (!existing.states.includes(condition.state)) existing.states.push(condition.state);
    } else groups.push({ states: [condition.state], on, key });
  }
  let expr = jsString(base.join(' '));
  for (const group of groups) {
    const test = group.states.length === 1 ? (group.states[0]?.name ?? 'false') : `(${group.states.map((s) => s.name).join(' || ')})`;
    expr = `${test} ? ${jsString(group.on.join(' '))} : ${expr}`;
  }
  return expr;
}

function classNameAttr(staticClasses: readonly string[], dynamics: readonly string[]): JsxAttrValue | null {
  const staticText = staticClasses.join(' ');
  if (dynamics.length === 0) return staticText.length === 0 ? null : { kind: 'string', value: staticText };
  if (staticText.length === 0 && dynamics.length === 1 && dynamics[0] !== undefined) return { kind: 'expr', code: dynamics[0] };
  const parts = [staticText, ...dynamics.map((d) => `\${${d}}`)].filter((p) => p.length > 0);
  return { kind: 'expr', code: `\`${parts.join(' ')}\`` };
}

function propValueCode(value: PropValue): string {
  if (typeof value === 'string') return jsString(value);
  if ('src' in value) return `{ src: ${jsString(value.src)}, alt: ${jsString(value.alt)} }`;
  return `{ href: ${jsString(value.href)}, label: ${jsString(value.label)} }`;
}

function placeholderText(resolution: Extract<AssetResolution, { kind: 'placeholder' }>): string {
  const authorization = resolution.reason.includes('authoriz');
  return `Placeholder: ${resolution.assetKind} ${authorization ? 'not authorized' : 'not reproduced'} (${resolution.assetId})`;
}

/** Route the node links to when it renders as a `<Link>`, else null. */
function routerLinkOf(gn: GenNode, ctx: RenderContext, scope: ScopeState): string | null {
  if (gn.renderedTag !== 'a') return null;
  if (scope.component !== null) return scope.component.routerLinks.has(gn.path) ? (ctx.routeOf?.(gn.node) ?? null) : null;
  return ctx.routeOf?.(gn.node) ?? null;
}

/** Render a node and its subtree. */
function renderNode(gn: GenNode, ctx: RenderContext, scope: ScopeState): JsxChild[] {
  if (gn.kind === 'skipped') return [];
  const usage = ctx.components.instanceByPath.get(gn.path);
  if (usage) {
    const ownBody = scope.component !== null && usage.plan.definitionId === scope.component.definitionId && gn.path === scope.component.primary.path;
    if (!ownBody) return [renderUsage(gn, usage.plan, usage.instance, scope)];
  }

  const behavior = ctx.behavior.byPath.get(gn.path);
  const binding = scope.component?.bindings.get(gn.path);
  const variantNode = scope.component?.variants?.nodes.get(gn.path);
  const breakpoints = ctx.model.breakpoints.ordered.map((b) => b.name);

  let resolution: AssetResolution | null = null;
  const tag = gn.node.tag.toLowerCase();
  if (gn.kind === 'placeholder') resolution = ctx.assets.resolveUnreproducible(gn.node);
  else if (tag === 'img') resolution = ctx.assets.resolveImage(gn.node);
  const placeholder = resolution?.kind === 'placeholder' ? resolution : null;
  if (placeholder) ctx.assets.recordPlaceholder(placeholder, scope.file);
  const route = placeholder ? null : routerLinkOf(gn, ctx, scope);
  const isLink = route !== null || (scope.component !== null && scope.component.routerLinks.has(gn.path) && gn.renderedTag === 'a');
  const renderedTag = placeholder ? 'div' : isLink ? 'Link' : gn.renderedTag;
  if (isLink) scope.router.add('Link');

  // attributes
  const attrs: [string, JsxAttrValue][] = [];
  const captured = keptAttributes(gn.node, gn.renderedTag);
  const visible = gn.perViewport.some((n) => n !== null && n.box !== null);
  const conditions: ReadonlyMap<string, readonly AttrCondition[]> = behavior?.attrConditions ?? new Map<string, AttrCondition[]>();
  const seen = new Set<string>([...captured.keys(), ...conditions.keys()]);
  for (const name of [...seen].sort()) {
    if (name === 'hidden' && visible) continue;
    if (placeholder && (name === 'alt' || name === 'width' || name === 'height' || name === 'loading')) continue;
    if (behavior?.detailsState && name === 'open') continue;
    if (isLink && name === 'href') continue;
    const condition = conditions.get(name);
    const bound = binding?.attrs.get(name);
    const jsxName = jsxAttrName(name);
    if (condition !== undefined && condition.length > 0) {
      attrs.push([jsxName, { kind: 'expr', code: attrConditionExpr(name, condition) }]);
      continue;
    }
    if (bound !== undefined) {
      attrs.push([jsxName, { kind: 'expr', code: bound }]);
      continue;
    }
    const value = captured.get(name);
    if (value === undefined) continue;
    if (BOOLEAN_ATTRIBUTES.has(name)) attrs.push([jsxName, { kind: 'true' }]);
    else if (name === 'tabindex') {
      // A non-numeric tabindex is ignored by browsers; it is dropped here rather than replaced by an invented 0.
      if (/^-?\d+$/.test(value)) attrs.push([jsxName, { kind: 'expr', code: value }]);
    } else if (name === 'value' && tag === 'option') attrs.push(['value', { kind: 'string', value }]);
    else attrs.push([jsxName, { kind: 'string', value }]);
  }
  if (isLink) {
    // The href is a prop (varying between instances) or the route the link resolved to; either way it is the Link's `to`.
    const bound = binding?.link !== undefined ? `${binding.link}.href` : binding?.attrs.get('href');
    attrs.push(['to', bound !== undefined ? { kind: 'expr', code: bound } : { kind: 'string', value: route ?? captured.get('href') ?? '/' }]);
  } else if (binding?.link !== undefined && gn.renderedTag === 'a') {
    const index = attrs.findIndex(([n]) => n === 'href');
    const bound: [string, JsxAttrValue] = ['href', { kind: 'expr', code: `${binding.link}.href` }];
    if (index >= 0) attrs[index] = bound;
    else attrs.push(bound);
  }
  if (!placeholder && tag === 'img') {
    if (binding?.image !== undefined) {
      attrs.push(['src', { kind: 'expr', code: `${binding.image}.src` }]);
      const index = attrs.findIndex(([n]) => n === 'alt');
      const bound: [string, JsxAttrValue] = ['alt', { kind: 'expr', code: `${binding.image}.alt` }];
      if (index >= 0) attrs[index] = bound;
      else attrs.push(bound);
    } else if (resolution?.kind === 'file') {
      attrs.push(['src', { kind: 'string', value: resolution.src }]);
      if (!attrs.some(([n]) => n === 'alt')) attrs.push(['alt', { kind: 'string', value: '' }]);
    }
  }
  if (placeholder) {
    attrs.push(['role', { kind: 'string', value: 'img' }]);
    const altIndex = attrs.findIndex(([n]) => n === 'aria-label');
    const alt = binding?.image !== undefined ? ({ kind: 'expr', code: `${binding.image}.alt` } as const) : ({ kind: 'string', value: captured.get('alt') ?? `Placeholder for ${placeholder.assetKind}` } as const);
    if (altIndex >= 0) attrs[altIndex] = ['aria-label', alt];
    else attrs.push(['aria-label', alt]);
    attrs.push(['data-placeholder', { kind: 'string', value: `asset:${placeholder.assetId}` }]);
  }
  if (renderedTag === 'textarea') {
    // React forbids children on <textarea>; the captured text is its initial value.
    const text = gn.node.text;
    const initial: JsxAttrValue | null =
      binding?.text !== undefined
        ? { kind: 'expr', code: binding.text }
        : behavior !== undefined && behavior.textConditions.length > 0
          ? { kind: 'expr', code: textConditionExpr(behavior.textConditions) }
          : text !== null && text.length > 0
            ? { kind: 'string', value: text }
            : null;
    if (initial) attrs.push(['defaultValue', initial]);
  }
  if (behavior?.form?.noValidate != null && !attrs.some(([n]) => n === 'noValidate')) attrs.push(['noValidate', { kind: 'true' }]);
  attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // classes
  const classes = ctx.classesOf(gn);
  const removed = new Set<string>();
  const dynamics: string[] = [];
  const classConditions = behavior?.classConditions ?? [];
  for (const condition of classConditions) for (const cls of condition.whenFalse) removed.add(cls);
  if (classConditions.length === 1 && classConditions[0] !== undefined) dynamics.push(conditionExpr(classConditions[0].state, classConditions[0].whenTrue.join(' '), classConditions[0].whenFalse.join(' ')));
  else if (classConditions.length > 1) dynamics.push(classConditionsExpr(classConditions));
  let staticClasses = (variantNode ? variantNode.common : classes.classes).filter((cls) => !removed.has(cls));
  if (variantNode) dynamics.unshift(`VARIANT_CLASSES[variant].${variantNode.key}`);
  if (behavior) staticClasses = [...staticClasses, ...behavior.extraClasses];
  if (placeholder) {
    // Keep the measured visibility: `hidden` stays (at any breakpoint); other display values become the placeholder's `flex`.
    const mapped = staticClasses.map((cls) => {
      const colon = cls.lastIndexOf(':');
      const prefix = colon < 0 ? '' : cls.slice(0, colon + 1);
      const utility = colon < 0 ? cls : cls.slice(colon + 1);
      return DISPLAY_CLASSES.has(utility) && utility !== 'hidden' ? `${prefix}flex` : cls;
    });
    const hiddenAtBase = mapped.includes('hidden');
    staticClasses = [...mapped, ...PLACEHOLDER_CLASSES.filter((cls) => cls !== 'flex' || !hiddenAtBase)];
  }
  const className = classNameAttr(orderClasses(staticClasses, breakpoints), dynamics);
  const ordered: [string, JsxAttrValue][] = [];
  if (className) ordered.push(['className', className]);
  ordered.push(...attrs);
  ordered.push(['data-uidna-path', scope.pathAttr(gn)]);
  if (behavior?.detailsState) {
    ordered.push(['open', { kind: 'expr', code: behavior.detailsState.name }]);
    ordered.push(['onToggle', { kind: 'expr', code: `(event) => ${behavior.detailsState.setter}(event.currentTarget.open)` }]);
  }
  if (behavior?.clickToggle) {
    const state = behavior.clickToggle;
    if (state.mode === 'select') {
      const others = (ctx.behavior.stateVars.get(scope.file) ?? []).filter((v) => v !== state && v.mode === 'select' && v.group === state.group);
      ordered.push(['onClick', { kind: 'expr', code: others.length === 0 ? `() => ${state.setter}(true)` : `() => {
${[state, ...others].map((v) => `  ${v.setter}(${v === state ? 'true' : 'false'});`).join('\n')}
}` }]);
    } else ordered.push(['onClick', { kind: 'expr', code: `() => ${state.setter}((value) => !value)` }]);
  }
  if (behavior?.form && renderedTag === 'form') ordered.push(['onSubmit', { kind: 'expr', code: behavior.form.handler }]);

  // children
  const children: JsxChild[] = [];
  if (placeholder) children.push({ kind: 'text', value: placeholderText(placeholder) });
  else if (renderedTag === 'textarea') {
    // The initial value was written as the defaultValue attribute above; a textarea has no element children.
  } else {
    const text = gn.node.text;
    if (binding?.text !== undefined) children.push({ kind: 'expr', code: binding.text });
    else if (binding?.link !== undefined && gn.renderedTag === 'a') children.push({ kind: 'expr', code: `${binding.link}.label` });
    else if (behavior !== undefined && behavior.textConditions.length > 0) children.push({ kind: 'expr', code: textConditionExpr(behavior.textConditions) });
    else if (text !== null && text.length > 0) children.push({ kind: 'text', value: text });
    for (const child of gn.children) children.push(...renderNode(child, ctx, scope));
  }
  const selfClosing = VOID_TAGS.has(renderedTag);
  return [element(renderedTag, ordered, selfClosing ? [] : children, selfClosing)];
}

/** Render `<Name uidnaPath=… prop=… />` for a component instance. */
function renderUsage(gn: GenNode, plan: ComponentPlan, instance: ComponentPlan['instances'][number], scope: ScopeState): JsxChild {
  scope.imports.add(plan.name);
  const attrs: [string, JsxAttrValue][] = [['uidnaPath', scope.pathAttr(gn)]];
  for (const prop of plan.props) {
    const literal = instance.values.get(prop.name);
    if (literal === undefined) continue;
    const boundNode = scope.component?.bindings.get(joinPath(gn.path, prop.relativePath));
    let code: string;
    switch (prop.kind) {
      case 'text':
        code = boundNode?.text ?? propValueCode(literal);
        break;
      case 'string':
        code = (prop.attr === null ? boundNode?.text : boundNode?.attrs.get(prop.attr)) ?? propValueCode(literal);
        break;
      case 'image': {
        const value = typeof literal === 'object' && 'src' in literal ? literal : { src: '', alt: '' };
        const src = boundNode?.image !== undefined ? `${boundNode.image}.src` : (boundNode?.attrs.get('src') ?? jsString(value.src));
        const alt = boundNode?.image !== undefined ? `${boundNode.image}.alt` : (boundNode?.attrs.get('alt') ?? jsString(value.alt));
        code = `{ src: ${src}, alt: ${alt} }`;
        break;
      }
      case 'link': {
        const value = typeof literal === 'object' && 'href' in literal ? literal : { href: '', label: '' };
        const href = boundNode?.link !== undefined ? `${boundNode.link}.href` : (boundNode?.attrs.get('href') ?? jsString(value.href));
        const label = boundNode?.link !== undefined ? `${boundNode.link}.label` : (boundNode?.text ?? jsString(value.label));
        code = `{ href: ${href}, label: ${label} }`;
        break;
      }
      default:
        code = propValueCode(literal);
    }
    attrs.push([prop.name, { kind: 'expr', code }]);
  }
  if (plan.variants && instance.variantId !== null) attrs.push(['variant', { kind: 'string', value: instance.variantId }]);
  return element(plan.name, attrs, [], true);
}

function formHandler(form: FormBehavior): string[] {
  const lines: string[] = [];
  lines.push(`  // ${commentText(`submit on ${form.describe} (${form.transitionIds.join(', ')}): validation runs per control with checkValidity(); backend call not reproduced; wire your API here`)}`);
  lines.push(`  const ${form.handler} = (event: FormEvent<HTMLFormElement>): void => {`);
  lines.push('    event.preventDefault();');
  lines.push('    const form = event.currentTarget;');
  const valids: string[] = [];
  form.controls.forEach((control, index) => {
    const name = `valid${(index + 1).toString().padStart(2, '0')}`;
    valids.push(name);
    lines.push(`    // ${commentText(control.describe)}${control.messages.length > 0 ? `: ${commentText(control.messages.map((m) => JSON.stringify(m)).join(', '))}` : ''}`);
    lines.push(`    const ${name} = controlValidity(form, ${control.key === null ? 'null' : jsString(control.key)}, ${jsString(control.path)});`);
    lines.push(`    ${control.state.setter}(!${name});`);
  });
  if (form.invalid !== null || form.submitted !== null) {
    lines.push(`    const valid = ${valids.length > 0 ? `${valids.join(' && ')} && ` : ''}form.checkValidity();`);
    if (form.invalid !== null) lines.push(`    ${form.invalid.setter}(!valid);`);
    if (form.submitted !== null) lines.push(`    ${form.submitted.setter}(valid);`);
  }
  lines.push('  };');
  return lines;
}

function stateDeclarations(vars: readonly StateVar[], forms: readonly FormBehavior[], title: string | undefined): string[] {
  const lines: string[] = [];
  for (const state of vars) {
    lines.push(`  // ${commentText(state.description)}`);
    lines.push(`  const [${state.name}, ${state.setter}] = useState(false);`);
  }
  for (const state of vars) {
    if (state.escapeTransitionId === null) continue;
    lines.push(`  // Escape resets ${state.name} (${state.escapeTransitionId})`);
    lines.push('  useEffect(() => {');
    lines.push(`    if (!${state.name}) return undefined;`);
    lines.push('    const onKeyDown = (event: KeyboardEvent): void => {');
    lines.push(`      if (event.key === 'Escape') ${state.setter}(false);`);
    lines.push('    };');
    lines.push("    document.addEventListener('keydown', onKeyDown);");
    lines.push('    return () => {');
    lines.push("      document.removeEventListener('keydown', onKeyDown);");
    lines.push('    };');
    lines.push(`  }, [${state.name}]);`);
  }
  for (const form of forms) lines.push(...formHandler(form));
  if (title !== undefined) {
    lines.push('  // The document title the scan recorded for this page.');
    lines.push('  useEffect(() => {');
    lines.push(`    document.title = ${jsString(title)};`);
    lines.push('  }, []);');
  }
  return lines;
}

function reactImport(vars: readonly StateVar[], forms: readonly FormBehavior[], title: string | undefined): string | null {
  const names: string[] = [];
  if (vars.some((v) => v.escapeTransitionId !== null) || title !== undefined) names.push('useEffect');
  if (vars.length > 0) names.push('useState');
  if (forms.length > 0) names.push('type FormEvent');
  if (names.length === 0) return null;
  return `import { ${names.join(', ')} } from 'react';`;
}

function fileHeader(ctx: RenderContext, what: string): string[] {
  return [`// Generated by UI DNA from scan ${commentText(ctx.scanId)}: ${commentText(what)}.`, '// Names are placeholders; data-uidna-path attributes are a verification aid you may strip.'];
}

function routerImport(scope: ScopeState): string | null {
  if (scope.router.size === 0) return null;
  return `import { ${[...scope.router].sort().join(', ')} } from 'react-router-dom';`;
}

/** Render a section or page file. */
export function renderSection(section: SectionPlan, ctx: RenderContext, options: SectionRenderOptions = {}): RenderedFile {
  const scope: ScopeState = { file: section.file, component: null, pathAttr: (node) => ({ kind: 'string', value: node.path }), imports: new Set(), router: new Set() };
  const roots = section.roots.flatMap((root) => renderNode(root, ctx, scope));
  const vars = ctx.behavior.stateVars.get(section.file) ?? [];
  const forms = ctx.behavior.forms.get(section.file) ?? [];
  const lines: string[] = [...fileHeader(ctx, options.doc ?? `${section.name.toLowerCase()} section of the page`)];
  const react = reactImport(vars, forms, options.title);
  if (react) lines.push(react);
  const router = routerImport(scope);
  if (router) lines.push(router);
  for (const name of [...scope.imports].sort()) lines.push(`import { ${name} } from '../components/${name}';`);
  if (forms.length > 0) lines.push(`import { controlValidity } from '${VALIDITY_IMPORT}';`);
  lines.push('');
  if (section.kind === 'page') lines.push(`/** ${commentText(options.doc ?? `Page ${section.name}`)}: ${section.roots.map((r) => `<${r.renderedTag}> at path ${r.path || '(body)'}`).join(', ') || 'no own content (everything is in the shared layout)'}. */`);
  else lines.push(`/** ${section.name} landmark(s): ${section.roots.map((r) => `<${r.renderedTag}> at path ${r.path || '(body)'}`).join(', ')}. */`);
  lines.push(`export function ${section.name}() {`);
  lines.push(...stateDeclarations(vars, forms, options.title));
  lines.push('  return (');
  if (roots.length === 1 && roots[0] !== undefined) lines.push(...printJsx(roots[0], '    '));
  else {
    lines.push('    <>');
    for (const root of roots) lines.push(...printJsx(root, '      '));
    lines.push('    </>');
  }
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return { file: section.file, code: lines.join('\n') };
}

/** Render a component file. */
export function renderComponent(plan: ComponentPlan, ctx: RenderContext): RenderedFile {
  const scope: ScopeState = {
    file: plan.file,
    component: plan,
    pathAttr: (node) => {
      const rel = relativePath(plan.primary.path, node.path);
      if (rel === null || rel === '') return { kind: 'expr', code: 'uidnaPath' };
      return { kind: 'expr', code: `\`\${uidnaPath}/${rel}\`` };
    },
    imports: new Set(),
    router: new Set(),
  };
  const body = renderNode(plan.primary, ctx, scope);
  const vars = ctx.behavior.stateVars.get(plan.file) ?? [];
  const forms = ctx.behavior.forms.get(plan.file) ?? [];
  const lines: string[] = [...fileHeader(ctx, `component ${plan.generatedName} (${plan.definitionId}, ${plan.instances.length} instances)`)];
  const react = reactImport(vars, forms, undefined);
  if (react) lines.push(react);
  const router = routerImport(scope);
  if (router) lines.push(router);
  for (const name of [...scope.imports].sort()) lines.push(`import { ${name} } from './${name}';`);
  if (forms.length > 0) lines.push(`import { controlValidity } from '${VALIDITY_IMPORT}';`);
  lines.push('');
  const variantType = `${plan.name}Variant`;
  if (plan.variants) {
    lines.push(`/** Style variants ${plan.variants.declared ? 'declared in the UI DNA document' : 'observed between instances (ids synthesized by the generator)'}. */`);
    lines.push(`export type ${variantType} = ${plan.variants.ids.map((id) => jsString(id)).join(' | ')};`);
    lines.push('');
  }
  lines.push(`export interface ${plan.name}Props {`);
  lines.push('  /** Verification aid: node path of this instance in the scan (data-uidna-path). */');
  lines.push('  uidnaPath: string;');
  for (const prop of plan.props) {
    const what = prop.kind === 'image' ? 'src and alt' : prop.kind === 'link' ? 'href and label' : prop.attr === null ? 'text' : `attribute ${prop.attr}`;
    lines.push(`  /** ${prop.declared ? 'Declared prop' : 'Differs between instances'}: ${what} of the node at relative path "${prop.relativePath || '(root)'}". */`);
    lines.push(`  ${prop.name}: ${prop.tsType};`);
  }
  if (plan.variants) lines.push(`  variant?: ${variantType};`);
  lines.push('}');
  lines.push('');
  if (plan.variants) {
    const keys = [...plan.variants.nodes.values()].map((n) => n.key);
    lines.push(`const VARIANT_CLASSES: Record<${variantType}, { ${keys.map((k) => `${k}: string`).join('; ')} }> = {`);
    for (const id of plan.variants.ids) {
      const entries = [...plan.variants.nodes.values()].map((n) => `${n.key}: ${jsString((n.byVariant.get(id) ?? []).join(' '))}`);
      lines.push(`  ${jsString(id)}: { ${entries.join(', ')} },`);
    }
    lines.push('};');
    lines.push('');
  }
  const params = ['uidnaPath', ...plan.props.map((p) => p.name)];
  if (plan.variants) params.push(`variant = ${jsString(plan.variants.defaultId)}`);
  lines.push(`/** ${commentText(plan.generatedName)}: ${plan.instances.length} instances at ${plan.instances.map((i) => i.root.path).join(', ')}. */`);
  lines.push(`export function ${plan.name}({ ${params.join(', ')} }: ${plan.name}Props) {`);
  lines.push(...stateDeclarations(vars, forms, undefined));
  lines.push('  return (');
  for (const root of body) lines.push(...printJsx(root, '    '));
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return { file: plan.file, code: lines.join('\n') };
}

/** Render `src/App.tsx` for the single-page layout. */
export function renderApp(sections: readonly SectionPlan[], ctx: RenderContext): RenderedFile {
  const lines: string[] = [...fileHeader(ctx, 'application root')];
  for (const section of sections) lines.push(`import { ${section.name} } from './sections/${section.name}';`);
  lines.push('');
  lines.push('/** The scanned page, split by landmark. */');
  lines.push('export function App() {');
  lines.push('  return (');
  if (sections.length === 1 && sections[0] !== undefined) lines.push(`    <${sections[0].name} />`);
  else {
    lines.push('    <>');
    for (const section of sections) lines.push(`      <${section.name} />`);
    lines.push('    </>');
  }
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return { file: 'src/App.tsx', code: lines.join('\n') };
}

/** Render a layout file: the hoisted header and footer around an `<Outlet />`. */
export function renderLayout(layout: LayoutPlan, scanId: string): RenderedFile {
  const lines: string[] = [`// Generated by UI DNA from scan ${commentText(scanId)}: layout ${commentText(layout.id)} shared by pages ${commentText(layout.pageIds.join(', '))}.`, '// Names are placeholders; data-uidna-path attributes are a verification aid you may strip.'];
  lines.push("import { Outlet } from 'react-router-dom';");
  if (layout.header) lines.push(`import { ${layout.headerName} } from '../sections/${layout.headerName}';`);
  if (layout.footer) lines.push(`import { ${layout.footerName} } from '../sections/${layout.footerName}';`);
  lines.push('');
  const parts = [...(layout.header ? ['header'] : []), ...(layout.footer ? ['footer'] : [])].join(' and ');
  lines.push(`/** ${parts.charAt(0).toUpperCase()}${parts.slice(1)} rendered once from page ${commentText(layout.sourcePageId)} around the routed page. */`);
  lines.push(`export function ${layout.name}() {`);
  lines.push('  return (');
  lines.push('    <>');
  if (layout.header) lines.push(`      <${layout.headerName} />`);
  lines.push('      <Outlet />');
  if (layout.footer) lines.push(`      <${layout.footerName} />`);
  lines.push('    </>');
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return { file: layout.file, code: lines.join('\n') };
}

/** Render `src/App.tsx` with a `<BrowserRouter>` and one `<Route>` per page, grouped under their layouts. */
export function renderRouterApp(site: SitePlan, scanId: string): RenderedFile {
  const lines: string[] = [`// Generated by UI DNA from scan ${commentText(scanId)}: application root with react-router routes for ${site.pages.length} page(s).`, '// Names are placeholders; data-uidna-path attributes are a verification aid you may strip.'];
  lines.push("import { BrowserRouter, Route, Routes } from 'react-router-dom';");
  for (const layout of site.layouts) lines.push(`import { ${layout.name} } from './layouts/${layout.name}';`);
  for (const page of site.pages) lines.push(`import { ${page.name} } from './pages/${page.name}';`);
  lines.push('');
  lines.push('/** The scanned pages, routed by the patterns the scan recorded (see README "Pages and routes"). */');
  lines.push('export function App() {');
  lines.push('  return (');
  lines.push('    <BrowserRouter>');
  lines.push('      <Routes>');
  const patterns = new Set(site.pages.map((p) => p.route));
  const route = (page: PagePlan, indent: string): string[] => {
    const out = [`${indent}<Route path=${jsString(page.route)} element={<${page.name} />} />`];
    const alias = routeAlias(page.route);
    if (alias !== null && !patterns.has(alias)) out.push(`${indent}<Route path=${jsString(alias)} element={<${page.name} />} />`);
    return out;
  };
  for (const layout of site.layouts) {
    lines.push(`        <Route element={<${layout.name} />}>`);
    for (const page of site.pages) if (page.layout?.id === layout.id) lines.push(...route(page, '          '));
    lines.push('        </Route>');
  }
  for (const page of site.pages) if (page.layout === null) lines.push(...route(page, '        '));
  lines.push('      </Routes>');
  lines.push('    </BrowserRouter>');
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return { file: 'src/App.tsx', code: lines.join('\n') };
}

/** Classes for the `<body>` element (its own computed style, rendered in index.html). */
export function bodyClasses(ctx: RenderContext): string[] {
  const breakpoints = ctx.model.breakpoints.ordered.map((b) => b.name);
  return orderClasses(ctx.classesOf(ctx.model.body).classes, breakpoints);
}

export type { NodeBehavior };
