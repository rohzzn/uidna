/**
 * Component planning: which fingerprinted definitions become React
 * components, what their props are (declared props plus every text or
 * attribute that differs between instances) and which style variants exist.
 */
import type { ComponentDefinition, UiDnaDocument, UiNode } from 'uidna-schema';
import type { AssetRegistry } from './assets.js';
import { keptAttributes } from './attrs.js';
import { camelCase, compareStrings, pascalCase } from './jsx.js';
import { isAncestorPath, joinPath, relativePath, walk, type GenNode, type GenerationModel } from './model.js';
import type { NodeClasses } from './styles.js';

/** A prop of a generated component. */
export interface ComponentPropPlan {
  readonly name: string;
  readonly kind: 'text' | 'image' | 'link' | 'string';
  /** Path of the bound node relative to the component root. */
  readonly relativePath: string;
  /** For `string` props: the bound attribute, or null for the node's text. */
  readonly attr: string | null;
  readonly declared: boolean;
  readonly tsType: string;
}

/** A prop value of one instance. */
export type PropValue = string | { readonly src: string; readonly alt: string } | { readonly href: string; readonly label: string };

/** One instance of a component in the narrowest base state. */
export interface ComponentInstancePlan {
  readonly id: string;
  readonly root: GenNode;
  readonly variantId: string | null;
  readonly values: ReadonlyMap<string, PropValue>;
}

/** Style variants of a component. */
export interface VariantPlan {
  readonly ids: readonly string[];
  readonly defaultId: string;
  /** True when the ids come from the document's `variants`; false when synthesized from observed class differences. */
  readonly declared: boolean;
  /** Differing nodes keyed by primary-instance absolute path. */
  readonly nodes: ReadonlyMap<string, { readonly key: string; readonly common: readonly string[]; readonly byVariant: ReadonlyMap<string, readonly string[]> }>;
}

/** How a node in the component body reads its varying parts from props. */
export interface NodeBinding {
  /** Expression for the node's text (a prop name), when bound. */
  readonly text?: string;
  /** Attribute → expression. */
  readonly attrs: ReadonlyMap<string, string>;
  /** Prop name of an image binding (`{ src, alt }`). */
  readonly image?: string;
  /** Prop name of a link binding (`{ href, label }`). */
  readonly link?: string;
}

/** A definition that becomes a component file. */
export interface ComponentPlan {
  readonly definitionId: string;
  readonly generatedName: string;
  readonly name: string;
  readonly file: string;
  readonly primary: GenNode;
  readonly instances: readonly ComponentInstancePlan[];
  readonly props: readonly ComponentPropPlan[];
  readonly variants: VariantPlan | null;
  /** Bindings keyed by primary-instance absolute path. */
  readonly bindings: ReadonlyMap<string, NodeBinding>;
  /** Primary-instance paths of `<a>` nodes rendered as react-router `<Link>` (every instance's href resolves to a generated page). */
  readonly routerLinks: ReadonlySet<string>;
  readonly notes: readonly string[];
}

/** Options of `planComponents`. */
export interface ComponentPlanningOptions {
  /** Lower-cased names already taken (page names, components of other pages); the names chosen here are added. */
  readonly usedNames?: Set<string>;
  /** Route pattern a same-origin page link resolves to, or null (no router, or not a generated page). */
  readonly routeOf?: (node: UiNode) => string | null;
  /** Leave out definitions without any instance in the model's narrowest state instead of reporting them (multi-page documents). */
  readonly skipAbsent?: boolean;
  /** Instance roots under these paths belong to a layout shared from another page and are not planned here. */
  readonly excludedRoots?: readonly string[];
  /** Definitions rendered inline because a recorded transition changes their instances together with nodes outside them. */
  readonly excludedDefinitions?: ReadonlySet<string>;
}

/** Result of planning. */
export interface ComponentPlanning {
  readonly components: readonly ComponentPlan[];
  /** Instance root path → component and instance. */
  readonly instanceByPath: ReadonlyMap<string, { readonly plan: ComponentPlan; readonly instance: ComponentInstancePlan }>;
  readonly rejected: readonly { readonly definitionId: string; readonly generatedName: string; readonly reason: string }[];
}

const RESERVED_COMPONENT_NAMES = new Set(['App', 'Header', 'Main', 'Footer', 'Fragment', 'React', 'Component', 'StrictMode', 'Layout', 'Link', 'NavLink', 'Outlet', 'Route', 'Routes', 'BrowserRouter', 'Navigate']);

/** Numeric, segment-wise path ordering. */
export function comparePaths(a: string, b: string): number {
  const as = a === '' ? [] : a.split('/').map(Number);
  const bs = b === '' ? [] : b.split('/').map(Number);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d;
  }
  return as.length - bs.length;
}

function subtreeByRelativePath(root: GenNode): Map<string, GenNode> {
  const out = new Map<string, GenNode>();
  walk(root, (node) => {
    const rel = relativePath(root.path, node.path);
    if (rel !== null) out.set(rel, node);
  });
  return out;
}

/** Unique component name. Uniqueness is case-insensitive: the name is also the file name, and Windows and macOS file systems fold case. */
function componentName(definition: ComponentDefinition, used: Set<string>): string {
  const annotated = definition.name?.value ?? null;
  let name = pascalCase(annotated ?? definition.generatedName, 'Component');
  if (RESERVED_COMPONENT_NAMES.has(name)) name = `${name}Component`;
  const taken = (candidate: string): boolean => used.has(candidate.toLowerCase());
  if (taken(name)) {
    const base = name;
    let n = 2;
    while (taken(`${base}${n}`)) n += 1;
    name = `${base}${n}`;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * Plan the components of a document. `classesOf` must return the static
 * responsive classes of a node (used to detect style variants).
 */
export function planComponents(dna: UiDnaDocument, model: GenerationModel, assets: AssetRegistry, classesOf: (node: GenNode) => NodeClasses, options: ComponentPlanningOptions = {}): ComponentPlanning {
  const components: ComponentPlan[] = [];
  const rejected: { definitionId: string; generatedName: string; reason: string }[] = [];
  const instanceByPath = new Map<string, { plan: ComponentPlan; instance: ComponentInstancePlan }>();
  const claimed = new Map<string, string>();
  const usedNames = options.usedNames ?? new Set<string>();
  const excludedRoots = options.excludedRoots ?? [];
  const excluded = (path: string): boolean => excludedRoots.some((root) => root === path || isAncestorPath(root, path));
  const definitions = [...dna.components.definitions].sort((a, b) => compareStrings(a.id, b.id));

  // First pass: eligibility and claimed roots (nested components need the full set of roots).
  const eligible: { definition: ComponentDefinition; roots: { id: string; root: GenNode }[]; primaryTree: Map<string, GenNode> }[] = [];
  for (const definition of definitions) {
    const reject = (reason: string): void => {
      rejected.push({ definitionId: definition.id, generatedName: definition.generatedName, reason });
    };
    if (options.excludedDefinitions?.has(definition.id)) {
      reject('rendered inline: a recorded transition changes its instances together with nodes outside the component, and the generator keeps that state in one file');
      continue;
    }
    if (definition.instanceCount < 2) {
      reject('fewer than two instances');
      continue;
    }
    const seen = new Set<string>();
    const instances = dna.components.instances
      .filter((inst) => inst.definitionId === definition.id && inst.stateId === model.narrowest.state.id && !excluded(inst.nodePath))
      .sort((a, b) => comparePaths(a.nodePath, b.nodePath) || compareStrings(a.id, b.id))
      .filter((inst) => {
        if (seen.has(inst.nodePath)) return false;
        seen.add(inst.nodePath);
        return true;
      });
    if (instances.length === 0 && options.skipAbsent) continue;
    const roots: { id: string; root: GenNode }[] = [];
    let missing: string | null = null;
    for (const inst of instances) {
      const root = model.byPath.get(inst.nodePath);
      if (root?.kind !== 'element') {
        missing = inst.nodePath;
        break;
      }
      roots.push({ id: inst.id, root });
    }
    if (missing !== null) {
      reject(`instance at path ${missing} is not a renderable node of the narrowest base state`);
      continue;
    }
    if (roots.length < 2) {
      reject(`only ${roots.length} instance(s) in the narrowest base state ${model.narrowest.state.id}`);
      continue;
    }
    if (roots.some((a) => roots.some((b) => isAncestorPath(a.root.path, b.root.path)))) {
      reject('instances are nested in each other');
      continue;
    }
    const owner = roots.map((r) => claimed.get(r.root.path)).find((o) => o !== undefined);
    if (owner !== undefined) {
      reject(`instance root already belongs to ${owner}`);
      continue;
    }
    const primary = roots[0];
    if (primary === undefined) continue;
    const primaryTree = subtreeByRelativePath(primary.root);
    let structural: string | null = null;
    for (const other of roots.slice(1)) {
      const tree = subtreeByRelativePath(other.root);
      if (tree.size !== primaryTree.size) {
        structural = `instance ${other.root.path} has ${tree.size} nodes, primary has ${primaryTree.size}`;
        break;
      }
      for (const [rel, node] of primaryTree) {
        const counterpart = tree.get(rel);
        if (counterpart === undefined) {
          structural = `instance ${other.root.path} lacks relative path "${rel}"`;
          break;
        }
        if (counterpart.renderedTag !== node.renderedTag || counterpart.kind !== node.kind) {
          structural = `instance ${other.root.path} differs from the primary at relative path "${rel}"`;
          break;
        }
      }
      if (structural !== null) break;
    }
    if (structural !== null) {
      reject(`instances differ structurally: ${structural}`);
      continue;
    }
    for (const r of roots) claimed.set(r.root.path, definition.generatedName);
    eligible.push({ definition, roots, primaryTree });
  }

  const allRoots = new Set(eligible.flatMap((e) => e.roots.map((r) => r.root.path)));
  const insideNestedInstance = (root: GenNode, node: GenNode): boolean => {
    let current = node.parent;
    while (current !== null && current.path !== root.path) {
      if (allRoots.has(current.path)) return true;
      current = current.parent;
    }
    return allRoots.has(node.path) && node.path !== root.path;
  };

  for (const { definition, roots, primaryTree } of eligible) {
    const notes: string[] = [];
    const name = componentName(definition, usedNames);
    const primary = roots[0];
    if (primary === undefined) continue;
    const props: ComponentPropPlan[] = [];
    const usedPropNames = new Set(['uidnaPath', 'variant']);
    const uniqueProp = (candidate: string): string => {
      let nameCandidate = candidate;
      let n = 2;
      while (usedPropNames.has(nameCandidate)) {
        nameCandidate = `${candidate}${n}`;
        n += 1;
      }
      usedPropNames.add(nameCandidate);
      return nameCandidate;
    };
    const coveredText = new Set<string>();
    const coveredAttr = new Set<string>();
    for (const declared of [...definition.props].sort((a, b) => comparePaths(a.relativePath, b.relativePath) || compareStrings(a.name, b.name))) {
      const node = primaryTree.get(declared.relativePath);
      if (node === undefined) {
        notes.push(`declared prop "${declared.name}" points at relative path "${declared.relativePath}", which is not a rendered node; ignored`);
        continue;
      }
      const propName = uniqueProp(camelCase(declared.name, `prop${props.length + 1}`));
      switch (declared.kind) {
        case 'text':
          props.push({ name: propName, kind: 'text', relativePath: declared.relativePath, attr: null, declared: true, tsType: 'string' });
          coveredText.add(declared.relativePath);
          break;
        case 'image':
          props.push({ name: propName, kind: 'image', relativePath: declared.relativePath, attr: null, declared: true, tsType: '{ src: string; alt: string }' });
          coveredAttr.add(`${declared.relativePath}#src`);
          coveredAttr.add(`${declared.relativePath}#alt`);
          break;
        case 'link':
          props.push({ name: propName, kind: 'link', relativePath: declared.relativePath, attr: null, declared: true, tsType: '{ href: string; label: string }' });
          coveredAttr.add(`${declared.relativePath}#href`);
          coveredText.add(declared.relativePath);
          break;
        default:
          props.push({ name: propName, kind: 'text', relativePath: declared.relativePath, attr: null, declared: true, tsType: 'string' });
          coveredText.add(declared.relativePath);
          notes.push(`declared prop "${declared.name}" of kind ${declared.kind} is rendered as the node's text`);
          break;
      }
    }

    // Observed differences between instances become props too.
    const relPaths = [...primaryTree.keys()].sort(comparePaths);
    const counters = new Map<string, number>();
    const autoName = (base: string): string => {
      const n = (counters.get(base) ?? 0) + 1;
      counters.set(base, n);
      return uniqueProp(`${base}${n.toString().padStart(2, '0')}`);
    };
    for (const rel of relPaths) {
      const primaryNode = primaryTree.get(rel);
      if (primaryNode === undefined) continue;
      const nodes = roots.map((r) => model.byPath.get(joinPath(r.root.path, rel))).filter((n): n is GenNode => n !== undefined);
      if (nodes.length !== roots.length) continue;
      const texts = nodes.map((n) => n.node.text ?? '');
      if (!coveredText.has(rel) && texts.some((t) => t !== texts[0])) {
        props.push({ name: autoName('text'), kind: 'string', relativePath: rel, attr: null, declared: false, tsType: 'string' });
        coveredText.add(rel);
      }
      const attrSets = nodes.map((n) => keptAttributes(n.node, n.renderedTag));
      // An <img> whose src or alt differs between instances gets an image prop resolved through the asset
      // registry per instance; the raw page src is never written (unauthorized assets stay placeholders).
      if (primaryNode.node.tag.toLowerCase() === 'img' && !coveredAttr.has(`${rel}#src`) && !coveredAttr.has(`${rel}#alt`)) {
        const sources = nodes.map((n) => n.node.attrs.src ?? '');
        const alts = nodes.map((_, i) => attrSets[i]?.get('alt') ?? '');
        if (sources.some((s) => s !== sources[0]) || alts.some((a) => a !== alts[0])) {
          props.push({ name: autoName('image'), kind: 'image', relativePath: rel, attr: null, declared: false, tsType: '{ src: string; alt: string }' });
          coveredAttr.add(`${rel}#src`);
          coveredAttr.add(`${rel}#alt`);
        }
      }
      const attrNames = new Set<string>();
      for (const set of attrSets) for (const key of set.keys()) attrNames.add(key);
      for (const attr of [...attrNames].sort(compareStrings)) {
        if (coveredAttr.has(`${rel}#${attr}`)) continue;
        const values = nodes.map((_, i) => attrSets[i]?.get(attr) ?? '');
        if (values.every((v) => v === values[0])) continue;
        props.push({ name: autoName(camelCase(attr, 'attr')), kind: 'string', relativePath: rel, attr, declared: false, tsType: 'string' });
        coveredAttr.add(`${rel}#${attr}`);
      }
    }

    // Variants: nodes rendered by this component whose static classes differ between instances.
    const ownPaths = relPaths.filter((rel) => {
      const node = primaryTree.get(rel);
      return node !== undefined && !insideNestedInstance(primary.root, node);
    });
    const classSignatures = roots.map((r) => {
      const perPath = new Map<string, string[]>();
      for (const rel of ownPaths) {
        const node = model.byPath.get(joinPath(r.root.path, rel));
        perPath.set(rel, node === undefined ? [] : [...classesOf(node).classes]);
      }
      return perPath;
    });
    const differingPaths = ownPaths.filter((rel) => {
      const first = classSignatures[0]?.get(rel)?.join(' ') ?? '';
      return classSignatures.some((sig) => (sig.get(rel)?.join(' ') ?? '') !== first);
    });
    let variants: VariantPlan | null = null;
    const variantByInstance = new Map<string, string>();
    if (differingPaths.length > 0) {
      const signatureOf = (index: number): string => differingPaths.map((rel) => `${rel}=${classSignatures[index]?.get(rel)?.join(' ') ?? ''}`).join('|');
      const groups = new Map<string, number[]>();
      roots.forEach((_, index) => {
        const sig = signatureOf(index);
        const members = groups.get(sig);
        if (members) members.push(index);
        else groups.set(sig, [index]);
      });
      const observed = [...groups.values()];
      // Does the document's variant partition match the observed one?
      const declaredPartition = new Map<string, string>();
      for (const variant of definition.variants) for (const id of variant.instanceIds) declaredPartition.set(id, variant.id);
      const declaredMatches =
        definition.variants.length > 0 &&
        roots.every((r) => declaredPartition.has(r.id)) &&
        observed.every((members) => {
          const ids = new Set(members.map((i) => declaredPartition.get(roots[i]?.id ?? '')));
          return ids.size === 1;
        }) &&
        new Set(roots.map((r) => declaredPartition.get(r.id))).size === observed.length;
      const ids: string[] = [];
      observed.forEach((members, groupIndex) => {
        const first = members[0];
        const id = declaredMatches && first !== undefined ? (declaredPartition.get(roots[first]?.id ?? '') ?? `variant${groupIndex + 1}`) : `variant${(groupIndex + 1).toString().padStart(2, '0')}`;
        ids.push(id);
        for (const index of members) {
          const root = roots[index];
          if (root) variantByInstance.set(root.root.path, id);
        }
      });
      if (definition.variants.length > 0 && !declaredMatches) {
        notes.push('the document declares variants whose instance partition does not match the observed class differences; variant ids were synthesized');
      }
      const nodes = new Map<string, { key: string; common: string[]; byVariant: Map<string, string[]> }>();
      for (const rel of differingPaths) {
        const lists = classSignatures.map((sig) => sig.get(rel) ?? []);
        const common = (lists[0] ?? []).filter((cls) => lists.every((list) => list.includes(cls)));
        const byVariant = new Map<string, string[]>();
        observed.forEach((members, groupIndex) => {
          const representative = members[0];
          const id = ids[groupIndex];
          if (representative === undefined || id === undefined) return;
          byVariant.set(id, (lists[representative] ?? []).filter((cls) => !common.includes(cls)));
        });
        const key = rel === '' ? 'root' : `p${rel.replace(/\//g, '_')}`;
        nodes.set(joinPath(primary.root.path, rel), { key, common, byVariant });
      }
      variants = { ids, defaultId: variantByInstance.get(primary.root.path) ?? ids[0] ?? 'variant01', declared: declaredMatches, nodes };
    }

    // Router links: <a> nodes of this component whose href resolves to a generated page for every instance.
    const routerLinks = new Set<string>();
    const routeOf = options.routeOf;
    if (routeOf !== undefined) {
      for (const rel of ownPaths) {
        const primaryNode = primaryTree.get(rel);
        if (primaryNode?.renderedTag !== 'a') continue;
        const routes = roots.map((r) => {
          const node = model.byPath.get(joinPath(r.root.path, rel));
          return node === undefined ? null : routeOf(node.node);
        });
        if (routes.every((route) => route !== null)) routerLinks.add(joinPath(primary.root.path, rel));
      }
    }
    const routeValue = (rel: string, node: GenNode | undefined, href: string): string => {
      if (!routerLinks.has(joinPath(primary.root.path, rel)) || node === undefined || routeOf === undefined) return href;
      return routeOf(node.node) ?? href;
    };

    // Instance values.
    const instances: ComponentInstancePlan[] = roots.map((r) => {
      const values = new Map<string, PropValue>();
      for (const prop of props) {
        const node = model.byPath.get(joinPath(r.root.path, prop.relativePath));
        const text = node?.node.text ?? '';
        const attrs = node ? keptAttributes(node.node, node.renderedTag) : new Map<string, string>();
        switch (prop.kind) {
          case 'text':
            values.set(prop.name, text);
            break;
          case 'string':
            values.set(prop.name, prop.attr === null ? text : prop.attr === 'href' ? routeValue(prop.relativePath, node, attrs.get('href') ?? '') : (attrs.get(prop.attr) ?? ''));
            break;
          case 'image': {
            const resolution = node ? assets.resolveImage(node.node) : null;
            values.set(prop.name, { src: resolution?.kind === 'file' ? resolution.src : '', alt: attrs.get('alt') ?? '' });
            break;
          }
          case 'link':
            values.set(prop.name, { href: routeValue(prop.relativePath, node, attrs.get('href') ?? ''), label: text });
            break;
          default:
            break;
        }
      }
      return { id: r.id, root: r.root, variantId: variantByInstance.get(r.root.path) ?? null, values };
    });

    // Bindings for the component body (primary instance paths).
    const bindings = new Map<string, { text?: string; attrs: Map<string, string>; image?: string; link?: string }>();
    const bindingAt = (rel: string): { text?: string; attrs: Map<string, string>; image?: string; link?: string } => {
      const abs = joinPath(primary.root.path, rel);
      const existing = bindings.get(abs);
      if (existing) return existing;
      const created = { attrs: new Map<string, string>() };
      bindings.set(abs, created);
      return created;
    };
    for (const prop of props) {
      const binding = bindingAt(prop.relativePath);
      switch (prop.kind) {
        case 'text':
          binding.text = prop.name;
          break;
        case 'string':
          if (prop.attr === null) binding.text = prop.name;
          else binding.attrs.set(prop.attr, prop.name);
          break;
        case 'image':
          binding.image = prop.name;
          break;
        case 'link':
          binding.link = prop.name;
          break;
        default:
          break;
      }
    }

    const plan: ComponentPlan = {
      definitionId: definition.id,
      generatedName: definition.generatedName,
      name,
      file: `src/components/${name}.tsx`,
      primary: primary.root,
      instances,
      props,
      variants,
      bindings,
      routerLinks,
      notes,
    };
    if (routerLinks.size > 0) notes.push(`${routerLinks.size} link(s) render as react-router <Link> because every instance's href resolves to a generated page`);
    components.push(plan);
    for (const instance of instances) instanceByPath.set(instance.root.path, { plan, instance });
  }

  return { components, instanceByPath, rejected };
}
