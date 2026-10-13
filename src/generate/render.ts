/**
 * Renders sections and components to TSX. Sections split the page by
 * landmark (banner/navigation → Header, contentinfo → Footer, the rest →
 * Main); components render their primary instance once with varying parts
 * replaced by props. Every element carries `data-uidna-path` so verification
 * can match it to the scanned node.
 */
import type { AssetRegistry, AssetResolution } from './assets.js';
import { BOOLEAN_ATTRIBUTES, keptAttributes } from './attrs.js';
import type { AttrCondition, BehaviorPlan, NodeBehavior, ScopeResolver, StateVar } from './behavior.js';
import type { ComponentPlan, ComponentPlanning, PropValue } from './components.js';
import { commentText, element, jsString, jsxAttrName, printJsx, type JsxAttrValue, type JsxChild } from './jsx.js';
import { joinPath, relativePath, VOID_TAGS, type GenNode, type GenerationModel } from './model.js';
import type { NodeClasses } from './styles.js';
import type { TokenIndex } from './tailwind-map.js';

/** A landmark section of the page. */
export interface SectionPlan {
  readonly name: 'Header' | 'Main' | 'Footer';
  readonly file: string;
  readonly roots: readonly GenNode[];
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
}

/** A rendered source file. */
export interface RenderedFile {
  readonly file: string;
  readonly code: string;
}

const PLACEHOLDER_CLASSES = ['bg-[#e5e7eb]', 'flex', 'items-center', 'justify-center', 'overflow-hidden', 'text-[#6b7280]', 'text-[12px]'];
const DISPLAY_CLASSES = new Set(['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'list-item', 'hidden', 'contents', 'flow-root', 'table']);
const STATE_VARIANTS = new Set(['hover', 'focus', 'active', 'focus-visible', 'focus-within']);

/** Split the body's children into Header/Main/Footer by landmark. */
export function planSections(model: GenerationModel): SectionPlan[] {
  const children = model.body.children.filter((child) => child.kind !== 'skipped');
  const isHeaderish = (node: GenNode): boolean => {
    const role = (node.node.attrs.role ?? node.node.role ?? '').toLowerCase();
    return node.renderedTag === 'header' || node.renderedTag === 'nav' || role === 'banner' || role === 'navigation';
  };
  const isFooterish = (node: GenNode): boolean => {
    const role = (node.node.attrs.role ?? node.node.role ?? '').toLowerCase();
    return node.renderedTag === 'footer' || role === 'contentinfo';
  };
  let headerEnd = 0;
  for (const child of children) {
    if (!isHeaderish(child)) break;
    headerEnd += 1;
  }
  let footerStart = children.length;
  while (footerStart > headerEnd) {
    const candidate = children[footerStart - 1];
    if (candidate === undefined || !isFooterish(candidate)) break;
    footerStart -= 1;
  }
  const sections: SectionPlan[] = [];
  const header = children.slice(0, headerEnd);
  const main = children.slice(headerEnd, footerStart);
  const footer = children.slice(footerStart);
  if (header.length > 0) sections.push({ name: 'Header', file: 'src/sections/Header.tsx', roots: header });
  if (main.length > 0) sections.push({ name: 'Main', file: 'src/sections/Main.tsx', roots: main });
  if (footer.length > 0) sections.push({ name: 'Footer', file: 'src/sections/Footer.tsx', roots: footer });
  return sections;
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
  const breakpoints = ctx.model.slots.map((s) => s.breakpoint).filter((b): b is string => b !== null);

  let resolution: AssetResolution | null = null;
  const tag = gn.node.tag.toLowerCase();
  if (gn.kind === 'placeholder') resolution = ctx.assets.resolveUnreproducible(gn.node);
  else if (tag === 'img') resolution = ctx.assets.resolveImage(gn.node);
  const placeholder = resolution?.kind === 'placeholder' ? resolution : null;
  if (placeholder) ctx.assets.recordPlaceholder(placeholder, scope.file);
  const renderedTag = placeholder ? 'div' : gn.renderedTag;

  // attributes
  const attrs: [string, JsxAttrValue][] = [];
  const captured = keptAttributes(gn.node, gn.renderedTag);
  const visible = gn.perViewport.some((n) => n !== null && n.box !== null);
  const conditions: ReadonlyMap<string, AttrCondition> = behavior?.attrConditions ?? new Map<string, AttrCondition>();
  const seen = new Set<string>([...captured.keys(), ...conditions.keys()]);
  for (const name of [...seen].sort()) {
    if (name === 'hidden' && visible) continue;
    if (placeholder && (name === 'alt' || name === 'width' || name === 'height' || name === 'loading')) continue;
    if (behavior?.detailsState && name === 'open') continue;
    const condition = conditions.get(name);
    const bound = binding?.attrs.get(name);
    const jsxName = jsxAttrName(name);
    if (condition) {
      const whenTrue = condition.whenTrue === null ? 'undefined' : jsString(condition.whenTrue);
      const whenFalse = condition.whenFalse === null ? 'undefined' : jsString(condition.whenFalse);
      if (BOOLEAN_ATTRIBUTES.has(name)) attrs.push([jsxName, { kind: 'expr', code: `${condition.state.name} ? ${condition.whenTrue === null ? 'false' : 'true'} : ${condition.whenFalse === null ? 'false' : 'true'}` }]);
      else attrs.push([jsxName, { kind: 'expr', code: `${condition.state.name} ? ${whenTrue} : ${whenFalse}` }]);
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
  if (binding?.link !== undefined && gn.renderedTag === 'a') {
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
        : behavior?.textCondition
          ? { kind: 'expr', code: conditionExpr(behavior.textCondition.state, behavior.textCondition.whenTrue, behavior.textCondition.whenFalse) }
          : text !== null && text.length > 0
            ? { kind: 'string', value: text }
            : null;
    if (initial) attrs.push(['defaultValue', initial]);
  }
  attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // classes
  const classes = ctx.classesOf(gn);
  const removed = new Set<string>();
  const dynamics: string[] = [];
  for (const condition of behavior?.classConditions ?? []) {
    for (const cls of condition.whenFalse) removed.add(cls);
    dynamics.push(conditionExpr(condition.state, condition.whenTrue.join(' '), condition.whenFalse.join(' ')));
  }
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
  if (behavior?.clickToggle) ordered.push(['onClick', { kind: 'expr', code: `() => ${behavior.clickToggle.setter}((value) => !value)` }]);

  // children
  const children: JsxChild[] = [];
  if (placeholder) children.push({ kind: 'text', value: placeholderText(placeholder) });
  else if (renderedTag === 'textarea') {
    // The initial value was written as the defaultValue attribute above; a textarea has no element children.
  } else {
    const text = gn.node.text;
    if (binding?.text !== undefined) children.push({ kind: 'expr', code: binding.text });
    else if (binding?.link !== undefined && gn.renderedTag === 'a') children.push({ kind: 'expr', code: `${binding.link}.label` });
    else if (behavior?.textCondition) children.push({ kind: 'expr', code: conditionExpr(behavior.textCondition.state, behavior.textCondition.whenTrue, behavior.textCondition.whenFalse) });
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

function stateDeclarations(vars: readonly StateVar[]): string[] {
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
  return lines;
}

function reactImport(vars: readonly StateVar[]): string | null {
  if (vars.length === 0) return null;
  const names = ['useState'];
  if (vars.some((v) => v.escapeTransitionId !== null)) names.unshift('useEffect');
  return `import { ${names.join(', ')} } from 'react';`;
}

function fileHeader(ctx: RenderContext, what: string): string[] {
  return [`// Generated by UI DNA from scan ${commentText(ctx.scanId)}: ${commentText(what)}.`, '// Names are placeholders; data-uidna-path attributes are a verification aid you may strip.'];
}

/** Render a section file. */
export function renderSection(section: SectionPlan, ctx: RenderContext): RenderedFile {
  const scope: ScopeState = { file: section.file, component: null, pathAttr: (node) => ({ kind: 'string', value: node.path }), imports: new Set() };
  const roots = section.roots.flatMap((root) => renderNode(root, ctx, scope));
  const vars = ctx.behavior.stateVars.get(section.file) ?? [];
  const lines: string[] = [...fileHeader(ctx, `${section.name.toLowerCase()} section of the page`)];
  const react = reactImport(vars);
  if (react) lines.push(react);
  for (const name of [...scope.imports].sort()) lines.push(`import { ${name} } from '../components/${name}';`);
  lines.push('');
  lines.push(`/** ${section.name} landmark(s): ${section.roots.map((r) => `<${r.renderedTag}> at path ${r.path || '(body)'}`).join(', ')}. */`);
  lines.push(`export function ${section.name}() {`);
  lines.push(...stateDeclarations(vars));
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
  };
  const body = renderNode(plan.primary, ctx, scope);
  const vars = ctx.behavior.stateVars.get(plan.file) ?? [];
  const lines: string[] = [...fileHeader(ctx, `component ${plan.generatedName} (${plan.definitionId}, ${plan.instances.length} instances)`)];
  const react = reactImport(vars);
  if (react) lines.push(react);
  for (const name of [...scope.imports].sort()) lines.push(`import { ${name} } from './${name}';`);
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
  lines.push(...stateDeclarations(vars));
  lines.push('  return (');
  for (const root of body) lines.push(...printJsx(root, '    '));
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return { file: plan.file, code: lines.join('\n') };
}

/** Render `src/App.tsx`. */
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

/** Classes for the `<body>` element (its own computed style, rendered in index.html). */
export function bodyClasses(ctx: RenderContext): string[] {
  const breakpoints = ctx.model.slots.map((s) => s.breakpoint).filter((b): b is string => b !== null);
  return orderClasses(ctx.classesOf(ctx.model.body).classes, breakpoints);
}

export type { NodeBehavior };
