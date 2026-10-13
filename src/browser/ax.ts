/**
 * Accessibility tree handling. Chrome's `Accessibility.getFullAXTree` reports
 * internal role names (`StaticText`, `DisclosureTriangle`, `image`); UI DNA
 * normalizes them to the ARIA role names Playwright's `getByRole` resolves,
 * so a role recorded in a capture can be replayed as a locator.
 */
import type { A11yProps } from '@uidna/schema';
import type { AxNodeData } from './cdp-schemas.js';

/**
 * Chrome AX roles that are not part of the role tree: text runs, generic
 * containers and the document root. They become `role: null`.
 */
export const NON_TREE_AX_ROLES: ReadonlySet<string> = new Set([
  'StaticText',
  'InlineTextBox',
  'generic',
  'none',
  'presentation',
  'LineBreak',
  'RootWebArea',
  'Ignored',
]);

/**
 * Explicit mappings from Chrome internal roles to Playwright role names.
 *
 * Measured against Chromium 156 / Playwright 1.64 (tests/.tmp/roles.mjs
 * rendered 80 common elements and compared `Accessibility.getFullAXTree`
 * roles with the roles `page.getByRole` resolves): every lowercase Chrome
 * role is an ARIA role Playwright accepts unchanged; `image` is `img`;
 * every CamelCase Chrome-internal role (`DisclosureTriangle` for
 * `<summary>`, `Figcaption`, `LabelText`, `DescriptionList`, `Legend`,
 * `Abbr`, `Video`, `Canvas`, `Iframe`, `Section`, `LineBreak`, ...) has no
 * Playwright role at all. Such nodes keep their accessible name,
 * `a11y.expanded` and `interactive`, so they remain addressable by node id,
 * path or `data-uidna-path`, just not by role.
 */
export const AX_ROLE_MAP: Readonly<Record<string, string | null>> = {
  image: 'img',
};

/**
 * Normalize a Chrome AX role to a Playwright-compatible role, or `null` when
 * the node has no place in the role tree. A `form` without an accessible
 * name is `null` because Playwright only gives named forms the `form` role.
 */
export function normalizeAxRole(role: string | undefined | null, name?: string | null): string | null {
  if (role === undefined || role === null || role === '') return null;
  if (NON_TREE_AX_ROLES.has(role)) return null;
  if (Object.prototype.hasOwnProperty.call(AX_ROLE_MAP, role)) return AX_ROLE_MAP[role] ?? null;
  if (role !== role.toLowerCase()) return null;
  if (role === 'form' && (name === undefined || name === null || name.trim() === '')) return null;
  return role;
}

/** Collapse runs of whitespace to one space and trim. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Accessibility facts about one DOM node, keyed by backend node id. */
export interface AxInfo {
  readonly rawRole: string;
  readonly role: string | null;
  readonly name: string | null;
  readonly description: string | null;
  /** A11y properties, with `controls` still holding backend node ids. */
  readonly props: Omit<A11yProps, 'controls' | 'nth'>;
  readonly controlsBackendIds: readonly number[];
}

/** Index of the accessibility tree by backend DOM node id (non-ignored nodes only). */
export type AxIndex = ReadonlyMap<number, AxInfo>;

/** Build the index from the raw AX nodes. */
export function indexAxTree(nodes: readonly AxNodeData[]): AxIndex {
  const index = new Map<number, AxInfo>();
  for (const node of nodes) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    if (index.has(node.backendDOMNodeId)) continue;
    const rawRole = stringValue(node.role?.value) ?? '';
    const name = node.name ? collapseWhitespace(stringValue(node.name.value) ?? '') : '';
    const description = node.description ? collapseWhitespace(stringValue(node.description.value) ?? '') : '';
    const { props, controls } = readProperties(node);
    index.set(node.backendDOMNodeId, {
      rawRole,
      role: normalizeAxRole(rawRole, name),
      name: name === '' ? null : name,
      description: description === '' ? null : description,
      props,
      controlsBackendIds: controls,
    });
  }
  return index;
}

function readProperties(node: AxNodeData): { props: AxInfo['props']; controls: number[] } {
  const props: { -readonly [K in keyof AxInfo['props']]: AxInfo['props'][K] } = {};
  let controls: number[] = [];
  for (const property of node.properties ?? []) {
    const value = property.value.value;
    switch (property.name) {
      case 'expanded':
        if (typeof value === 'boolean') props.expanded = value;
        break;
      case 'pressed': {
        const tristate = readTristate(value);
        if (tristate !== undefined) props.pressed = tristate;
        break;
      }
      case 'selected':
        if (typeof value === 'boolean') props.selected = value;
        break;
      case 'checked': {
        const tristate = readTristate(value);
        if (tristate !== undefined) props.checked = tristate;
        break;
      }
      case 'disabled':
        if (typeof value === 'boolean') props.disabled = value;
        break;
      case 'hidden':
        if (typeof value === 'boolean') props.hidden = value;
        break;
      case 'focusable':
        if (typeof value === 'boolean') props.focusable = value;
        break;
      case 'focused':
        if (typeof value === 'boolean') props.focused = value;
        break;
      case 'level':
        if (typeof value === 'number' && Number.isInteger(value)) props.level = value;
        break;
      case 'hasPopup':
        if (typeof value === 'string' && value !== '' && value !== 'false') props.haspopup = value;
        break;
      case 'modal':
        if (typeof value === 'boolean') props.modal = value;
        break;
      case 'controls':
        controls = (property.value.relatedNodes ?? []).map((related) => related.backendDOMNodeId);
        break;
      default:
        break;
    }
  }
  return { props, controls };
}

function readTristate(value: unknown): boolean | 'mixed' | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'mixed') return 'mixed';
  return undefined;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
