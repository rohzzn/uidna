/**
 * Deterministic synthetic captures that mirror Fixture A (`fixtures/a-marketing`).
 * The analysis layer is tested against these so it does not depend on the
 * browser module; they follow the `CapturedState` contract exactly, including
 * deduplicated style tables with UA defaults dropped, used pixel values for
 * `width`/`height`, roles and names, a role tree, assets and network entries.
 *
 * Two viewports are modelled: 1280 (desktop: menu inline, three-column cards,
 * two-column hero) and 390 (phone: hamburger visible, menu hidden unless open,
 * one-column cards and hero).
 */
import type { A11yProps, Box, RoleTreeNode, UiNode, Viewport } from '@rohzzn/uidna-schema';
import type { ScanRecord, StateRecord } from '../application/records.js';
import { STYLE_DEFAULTS } from '../browser/style-properties.js';
import type { CapturedAsset, CapturedFont, CapturedState, NetworkEntry } from '../browser/types.js';
import { parsePx } from '../domain/clustering.js';
import { digestValue, shortDigest } from '../domain/digest.js';

/** Fixed capture time used by default. */
export const FIXTURE_A_CAPTURED_AT = '2026-10-13T12:00:00.000Z';
/** Page URL used by default. */
export const FIXTURE_A_URL = 'http://127.0.0.1:4173/';
/** Document title of Fixture A. */
export const FIXTURE_A_TITLE = 'Lumen — Notes that think with you';
/** Fixture A palette as Chromium reports computed colors. */
export const FIXTURE_A_COLORS = {
  white: 'rgb(255, 255, 255)',
  surface: 'rgb(245, 247, 251)',
  text: 'rgb(27, 31, 42)',
  muted: 'rgb(91, 100, 116)',
  primary: 'rgb(47, 91, 234)',
  green: 'rgb(31, 157, 106)',
  amber: 'rgb(217, 138, 31)',
  border: 'rgb(223, 227, 236)',
  transparent: 'rgba(0, 0, 0, 0)',
} as const;
/** Fixture A font stack as Chromium reports it. */
export const FIXTURE_A_FONT = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
/** Card shadow as Chromium reports it. */
export const FIXTURE_A_SHADOW = 'rgba(27, 31, 42, 0.08) 0px 8px 24px 0px';

/** Options for one synthetic capture. */
export interface SyntheticCaptureOptions {
  /** 1280 (desktop) or 390 (phone). Default 1280. */
  readonly viewportWidth?: number;
  /** Phone only: the hamburger menu is open (aria-expanded true, menu visible). */
  readonly menuOpen?: boolean;
  /** Index of the FAQ item that is open (0-based), if any. */
  readonly openFaq?: number;
  readonly url?: string;
  readonly capturedAt?: string;
  /** State id used for the screenshot path. Default `st_01`. */
  readonly stateId?: string;
  /** `null` for no screenshot. Default: a full-page screenshot. */
  readonly screenshot?: { readonly truncated: boolean } | null;
  readonly limitations?: readonly string[];
  /** Additional assets (e.g. a cross-origin font) appended to the capture. */
  readonly extraAssets?: readonly CapturedAsset[];
  /** Additional network entries. */
  readonly extraNetwork?: readonly NetworkEntry[];
  /** Append an `<iframe>` and an inline `<svg>` to the footer to exercise limitations. */
  readonly withEmbeds?: boolean;
  /** Document title. Default `FIXTURE_A_TITLE`. */
  readonly title?: string;
  /** Primary navigation links (text and href) replacing Fixture A's four fragment links; used to model crawled pages. */
  readonly navLinks?: readonly { readonly text: string; readonly href: string }[];
}

/** A synthetic nav link. */
interface NavLinkSpec {
  readonly text: string;
  readonly href: string;
}

/** Fixture A's primary navigation. */
const DEFAULT_NAV_LINKS: readonly NavLinkSpec[] = [
  { text: 'Features', href: '#features' },
  { text: 'Pricing', href: '#pricing' },
  { text: 'FAQ', href: '#faq' },
  { text: 'Get started', href: '#start' },
];

/** Measured widths of Fixture A's nav links at 1280; other texts are estimated from their length. */
const NAV_LINK_WIDTHS: Readonly<Record<string, number>> = { Features: 66, Pricing: 56, FAQ: 36, 'Get started': 88 };

function navLinkWidth(text: string): number {
  return NAV_LINK_WIDTHS[text] ?? Math.round(text.length * 8.5);
}

/* ------------------------------------------------------------------ spec */

interface Spec {
  readonly tag: string;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly style?: Readonly<Record<string, string>>;
  readonly children?: readonly Spec[];
  readonly hidden?: boolean;
  readonly interactive?: boolean;
  readonly a11y?: A11yProps;
  readonly pseudoAfter?: { readonly content: string; readonly style: Readonly<Record<string, string>> };
  /** Explicit width for inline-level nodes. */
  readonly w?: number;
  /** Explicit content height for leaves. */
  readonly h?: number;
  /** `margin: 0 auto` centering inside the parent. */
  readonly center?: boolean;
  /** Absolutely positioned directly below the parent, spanning its width. */
  readonly absBelowParent?: boolean;
}

const BLOCK_TAGS = new Set(['div', 'section', 'header', 'nav', 'main', 'footer', 'figure', 'article', 'ul', 'details', 'h1', 'h2', 'h3', 'p', 'body', 'iframe']);
const INHERITED = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'cursor'] as const;

function defaultDisplay(tag: string): string {
  if (BLOCK_TAGS.has(tag)) return 'block';
  if (tag === 'li') return 'list-item';
  if (tag === 'button') return 'inline-block';
  return 'inline';
}

const isPhone = (width: number): boolean => width < 768;

function navLink(text: string, href: string, phone: boolean, w: number): Spec {
  return {
    tag: 'li',
    role: 'listitem',
    style: { 'list-style-type': 'none' },
    w: phone ? undefined : w,
    children: [
      {
        tag: 'a',
        role: 'link',
        name: text,
        text,
        attrs: { class: 'nav-link', href },
        interactive: true,
        a11y: { focusable: true },
        w: phone ? undefined : w,
        h: 22.5,
        style: phone
          ? { display: 'block', 'padding-top': '8px', 'padding-bottom': '8px', 'font-size': '15px', 'font-weight': '500', 'line-height': '22.5px', color: FIXTURE_A_COLORS.muted }
          : {
              display: 'inline-block',
              'padding-top': '8px',
              'padding-right': '4px',
              'padding-bottom': '8px',
              'padding-left': '4px',
              'font-size': '15px',
              'font-weight': '500',
              'line-height': '22.5px',
              color: FIXTURE_A_COLORS.muted,
            },
      },
    ],
  };
}

function card(variant: 'blue' | 'green' | 'amber', title: string, body: string, phone: boolean): Spec {
  const icon = variant === 'blue' ? FIXTURE_A_COLORS.primary : variant === 'green' ? FIXTURE_A_COLORS.green : FIXTURE_A_COLORS.amber;
  return {
    tag: 'article',
    role: 'article',
    attrs: { class: 'card' },
    style: {
      'padding-top': '24px',
      'padding-right': '24px',
      'padding-bottom': '24px',
      'padding-left': '24px',
      'border-top-left-radius': '12px',
      'border-top-right-radius': '12px',
      'border-bottom-right-radius': '12px',
      'border-bottom-left-radius': '12px',
      'background-color': FIXTURE_A_COLORS.white,
      ...border(FIXTURE_A_COLORS.border),
      'box-shadow': FIXTURE_A_SHADOW,
    },
    children: [
      {
        tag: 'div',
        attrs: { class: `card-icon card-icon-${variant}`, 'aria-hidden': 'true' },
        w: 40,
        h: 40,
        style: {
          'margin-bottom': '16px',
          'border-top-left-radius': '12px',
          'border-top-right-radius': '12px',
          'border-bottom-right-radius': '12px',
          'border-bottom-left-radius': '12px',
          'background-color': icon,
        },
      },
      {
        tag: 'h3',
        role: 'heading',
        name: title,
        text: title,
        attrs: { class: 'card-title' },
        a11y: { level: 3 },
        h: 30,
        style: { 'font-size': '20px', 'font-weight': '600', 'line-height': '30px', 'margin-bottom': '8px' },
      },
      {
        tag: 'p',
        role: 'paragraph',
        text: body,
        attrs: { class: 'card-body' },
        h: phone ? 67.5 : 45,
        style: { color: FIXTURE_A_COLORS.muted, 'font-size': '15px', 'line-height': '22.5px' },
      },
    ],
  };
}

function faqItem(question: string, answer: string, open: boolean): Spec {
  return {
    tag: 'details',
    role: 'group',
    attrs: open ? { class: 'accordion-item', open: '' } : { class: 'accordion-item' },
    style: {
      ...border(FIXTURE_A_COLORS.border),
      'border-top-left-radius': '12px',
      'border-top-right-radius': '12px',
      'border-bottom-right-radius': '12px',
      'border-bottom-left-radius': '12px',
      'background-color': FIXTURE_A_COLORS.white,
      'margin-bottom': '16px',
    },
    children: [
      {
        tag: 'summary',
        role: 'button',
        name: question,
        text: question,
        attrs: { class: 'accordion-summary' },
        interactive: true,
        a11y: { expanded: open, focusable: true },
        h: 25.5,
        style: {
          cursor: 'pointer',
          'padding-top': '16px',
          'padding-right': '24px',
          'padding-bottom': '16px',
          'padding-left': '24px',
          'font-size': '17px',
          'font-weight': '600',
          'line-height': '25.5px',
          'list-style-type': 'none',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
        },
        pseudoAfter: { content: open ? '"−"' : '"+"', style: { 'font-size': '20px', color: FIXTURE_A_COLORS.muted } },
      },
      {
        tag: 'div',
        attrs: { class: 'accordion-panel' },
        hidden: !open,
        style: { 'padding-right': '24px', 'padding-bottom': '24px', 'padding-left': '24px', color: FIXTURE_A_COLORS.muted },
        children: [{ tag: 'p', role: 'paragraph', text: answer, h: 24, style: {} }],
      },
    ],
  };
}

function border(color: string): Record<string, string> {
  return {
    'border-top-width': '1px',
    'border-right-width': '1px',
    'border-bottom-width': '1px',
    'border-left-width': '1px',
    'border-top-style': 'solid',
    'border-right-style': 'solid',
    'border-bottom-style': 'solid',
    'border-left-style': 'solid',
    'border-top-color': color,
    'border-right-color': color,
    'border-bottom-color': color,
    'border-left-color': color,
  };
}

function button(kind: 'primary' | 'secondary', text: string, href: string, w: number): Spec {
  const primary = kind === 'primary';
  return {
    tag: 'a',
    role: 'link',
    name: text,
    text,
    attrs: { class: `button button-${kind}`, href },
    interactive: true,
    a11y: { focusable: true },
    w,
    h: 24,
    style: {
      display: 'inline-flex',
      'align-items': 'center',
      'justify-content': 'center',
      'padding-top': '12px',
      'padding-right': '20px',
      'padding-bottom': '12px',
      'padding-left': '20px',
      'border-top-left-radius': '12px',
      'border-top-right-radius': '12px',
      'border-bottom-right-radius': '12px',
      'border-bottom-left-radius': '12px',
      'font-size': '16px',
      'font-weight': '600',
      'line-height': '24px',
      ...border(primary ? FIXTURE_A_COLORS.transparent : FIXTURE_A_COLORS.border),
      'background-color': primary ? FIXTURE_A_COLORS.primary : FIXTURE_A_COLORS.white,
      color: primary ? FIXTURE_A_COLORS.white : FIXTURE_A_COLORS.text,
    },
  };
}

function pageSpec(width: number, menuOpen: boolean, openFaq: number | undefined, withEmbeds: boolean, navLinks: readonly NavLinkSpec[]): Spec {
  const phone = isPhone(width);
  const sectionPad = phone
    ? { 'padding-top': '32px', 'padding-right': '16px', 'padding-bottom': '32px', 'padding-left': '16px' }
    : { 'padding-top': '48px', 'padding-right': '24px', 'padding-bottom': '48px', 'padding-left': '24px' };
  const contentWidth = Math.min(width, 1120);
  const heroCols = phone ? `${width - 32}px` : `${(contentWidth - 48 - 48) / 2}px ${(contentWidth - 48 - 48) / 2}px`;
  const cardCols = phone ? `${width - 32}px` : Array(3).fill(`${Math.round(((contentWidth - 48 - 48) / 3) * 1000) / 1000}px`).join(' ');

  const menu: Spec = {
    tag: 'ul',
    role: 'list',
    attrs: { class: menuOpen ? 'nav-menu is-open' : 'nav-menu', id: 'primary-menu' },
    hidden: phone && !menuOpen,
    absBelowParent: phone && menuOpen,
    style: phone
      ? {
          display: 'flex',
          position: 'absolute',
          top: '72px',
          left: '0px',
          right: '0px',
          'flex-direction': 'column',
          'align-items': 'stretch',
          'padding-top': '8px',
          'padding-right': '24px',
          'padding-bottom': '16px',
          'padding-left': '24px',
          'background-color': FIXTURE_A_COLORS.white,
          'border-bottom-width': '1px',
          'border-bottom-style': 'solid',
          'border-bottom-color': FIXTURE_A_COLORS.border,
          'z-index': '10',
        }
      : { display: 'flex', 'align-items': 'center', gap: '24px', 'column-gap': '24px', 'row-gap': '24px' },
    children: navLinks.map((link) => navLink(link.text, link.href, phone, navLinkWidth(link.text))),
  };

  const footerChildren: Spec[] = [
    { tag: 'p', role: 'paragraph', text: 'Lumen', attrs: { class: 'footer-brand' }, w: 58, h: 27, style: { 'font-weight': '700', 'font-size': '18px', 'line-height': '27px' } },
    {
      tag: 'ul',
      role: 'list',
      attrs: { class: 'footer-links' },
      w: 190,
      style: { display: 'flex', gap: '24px', 'column-gap': '24px', 'row-gap': '24px' },
      children: [
        ['Home', '#top', 38],
        ['Features', '#features', 58],
        ['FAQ', '#faq', 28],
      ].map(([text, href, w]) => ({
        tag: 'li',
        role: 'listitem',
        style: { 'list-style-type': 'none' },
        w: Number(w),
        children: [
          {
            tag: 'a',
            role: 'link',
            name: String(text),
            text: String(text),
            attrs: { class: 'footer-link', href: String(href) },
            interactive: true,
            a11y: { focusable: true },
            w: Number(w),
            h: 21,
            style: { 'font-size': '14px', 'line-height': '21px', color: FIXTURE_A_COLORS.muted },
          },
        ],
      })),
    },
    { tag: 'p', role: 'paragraph', text: 'Fixture A for UI DNA. No real product.', attrs: { class: 'footer-copy' }, w: 232, h: 19.5, style: { 'font-size': '13px', 'line-height': '19.5px', color: FIXTURE_A_COLORS.muted } },
  ];
  if (withEmbeds) {
    footerChildren.push(
      { tag: 'iframe', role: 'Iframe', name: 'Map', attrs: { src: 'https://maps.example.com/embed', title: 'Map' }, w: 300, h: 150, style: { display: 'block' } },
      { tag: 'svg', role: 'img', name: 'Logo mark', attrs: { 'aria-label': 'Logo mark' }, w: 24, h: 24, style: { display: 'inline-block', fill: FIXTURE_A_COLORS.primary, stroke: 'none' } },
    );
  }

  return {
    tag: 'body',
    style: { 'font-family': FIXTURE_A_FONT, color: FIXTURE_A_COLORS.text, 'background-color': FIXTURE_A_COLORS.white, 'line-height': '24px', 'font-size': '16px', 'font-weight': '400' },
    children: [
      {
        tag: 'header',
        role: 'banner',
        attrs: { class: 'site-header' },
        style: { 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': FIXTURE_A_COLORS.border, 'background-color': FIXTURE_A_COLORS.white },
        children: [
          {
            tag: 'nav',
            role: 'navigation',
            name: 'Primary',
            attrs: { class: 'navbar', 'aria-label': 'Primary' },
            center: true,
            style: {
              position: 'relative',
              'max-width': '1120px',
              'padding-top': '16px',
              'padding-right': '24px',
              'padding-bottom': '16px',
              'padding-left': '24px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              gap: '24px',
              'row-gap': '24px',
              'column-gap': '24px',
            },
            children: [
              {
                tag: 'a',
                role: 'link',
                name: 'Lumen',
                attrs: { class: 'brand', href: '#top' },
                interactive: true,
                a11y: { focusable: true },
                w: 94,
                style: { display: 'flex', 'align-items': 'center', gap: '8px', 'row-gap': '8px', 'column-gap': '8px', 'font-weight': '700', 'font-size': '20px', 'line-height': '30px' },
                children: [
                  {
                    tag: 'span',
                    attrs: { class: 'brand-mark', 'aria-hidden': 'true' },
                    w: 24,
                    h: 24,
                    style: {
                      display: 'inline-block',
                      'border-top-left-radius': '6px',
                      'border-top-right-radius': '6px',
                      'border-bottom-right-radius': '6px',
                      'border-bottom-left-radius': '6px',
                      'background-color': FIXTURE_A_COLORS.primary,
                    },
                  },
                  { tag: 'span', text: 'Lumen', attrs: { class: 'brand-name' }, w: 62, h: 30, style: { display: 'inline' } },
                ],
              },
              {
                tag: 'button',
                role: 'button',
                name: menuOpen ? 'Close menu' : 'Open menu',
                attrs: {
                  class: 'nav-toggle',
                  type: 'button',
                  'aria-expanded': menuOpen ? 'true' : 'false',
                  'aria-controls': 'primary-menu',
                  'aria-label': menuOpen ? 'Close menu' : 'Open menu',
                },
                hidden: !phone,
                interactive: true,
                a11y: { expanded: menuOpen, controls: ['primary-menu'], focusable: true },
                w: 40,
                h: 22,
                style: {
                  display: 'flex',
                  'flex-direction': 'column',
                  'justify-content': 'center',
                  gap: '4px',
                  'row-gap': '4px',
                  'column-gap': '4px',
                  'padding-top': '8px',
                  'padding-right': '8px',
                  'padding-bottom': '8px',
                  'padding-left': '8px',
                  ...border(FIXTURE_A_COLORS.border),
                  'border-top-left-radius': '6px',
                  'border-top-right-radius': '6px',
                  'border-bottom-right-radius': '6px',
                  'border-bottom-left-radius': '6px',
                  'background-color': FIXTURE_A_COLORS.white,
                  cursor: 'pointer',
                },
                children: [0, 1, 2].map(() => ({
                  tag: 'span',
                  attrs: { class: 'nav-toggle-bar', 'aria-hidden': 'true' },
                  h: 2,
                  style: { display: 'block', 'background-color': FIXTURE_A_COLORS.text, 'border-top-left-radius': '2px', 'border-top-right-radius': '2px', 'border-bottom-right-radius': '2px', 'border-bottom-left-radius': '2px' },
                })),
              },
              menu,
            ],
          },
        ],
      },
      {
        tag: 'main',
        role: 'main',
        attrs: { id: 'top' },
        children: [
          {
            tag: 'section',
            role: 'region',
            name: 'Notes that think with you',
            attrs: { class: 'hero', 'aria-labelledby': 'hero-title' },
            center: true,
            style: {
              'max-width': '1120px',
              ...(phone
                ? { 'padding-top': '48px', 'padding-right': '16px', 'padding-bottom': '48px', 'padding-left': '16px', gap: '32px', 'row-gap': '32px', 'column-gap': '32px' }
                : { 'padding-top': '64px', 'padding-right': '24px', 'padding-bottom': '64px', 'padding-left': '24px', gap: '48px', 'row-gap': '48px', 'column-gap': '48px' }),
              display: 'grid',
              'grid-template-columns': heroCols,
              'grid-template-rows': phone ? '320px 280px' : '320px',
              'align-items': 'center',
            },
            children: [
              {
                tag: 'div',
                attrs: { class: 'hero-copy' },
                children: [
                  {
                    tag: 'p',
                    role: 'paragraph',
                    text: 'Now in public beta',
                    attrs: { class: 'eyebrow' },
                    w: 150,
                    h: 19.5,
                    style: {
                      display: 'inline-block',
                      'padding-top': '4px',
                      'padding-right': '16px',
                      'padding-bottom': '4px',
                      'padding-left': '16px',
                      'border-top-left-radius': '999px',
                      'border-top-right-radius': '999px',
                      'border-bottom-right-radius': '999px',
                      'border-bottom-left-radius': '999px',
                      'background-color': FIXTURE_A_COLORS.surface,
                      color: FIXTURE_A_COLORS.primary,
                      'font-size': '13px',
                      'font-weight': '600',
                      'line-height': '19.5px',
                      'letter-spacing': '0.26px',
                      'text-transform': 'uppercase',
                    },
                  },
                  {
                    tag: 'h1',
                    role: 'heading',
                    name: 'Notes that think with you',
                    text: 'Notes that think with you',
                    attrs: { class: 'hero-title', id: 'hero-title' },
                    a11y: { level: 1 },
                    h: phone ? 70.4 : 105.6,
                    style: phone
                      ? { 'margin-top': '16px', 'font-size': '32px', 'line-height': '35.2px', 'font-weight': '700', 'letter-spacing': '-0.64px' }
                      : { 'margin-top': '16px', 'font-size': '48px', 'line-height': '52.8px', 'font-weight': '700', 'letter-spacing': '-0.96px' },
                  },
                  {
                    tag: 'p',
                    role: 'paragraph',
                    text: 'Lumen keeps your ideas connected. Write, link and revisit, and let structure appear on its own.',
                    attrs: { class: 'hero-lead' },
                    h: phone ? 72 : 54,
                    style: phone
                      ? { 'margin-top': '16px', 'font-size': '16px', 'line-height': '24px', color: FIXTURE_A_COLORS.muted, 'max-width': '480px' }
                      : { 'margin-top': '16px', 'font-size': '18px', 'line-height': '27px', color: FIXTURE_A_COLORS.muted, 'max-width': '480px' },
                  },
                  {
                    tag: 'div',
                    attrs: { class: 'hero-actions' },
                    style: { 'margin-top': '24px', display: 'flex', 'flex-wrap': 'wrap', gap: '16px', 'row-gap': '16px', 'column-gap': '16px' },
                    children: [button('primary', 'Start writing', '#start', 142), button('secondary', 'See how it works', '#features', 172)],
                  },
                ],
              },
              {
                tag: 'figure',
                role: 'figure',
                attrs: { class: 'hero-figure' },
                children: [
                  {
                    tag: 'img',
                    role: 'img',
                    name: 'Abstract illustration of connected notes',
                    attrs: { class: 'hero-image', src: 'assets/illustration.svg', alt: 'Abstract illustration of connected notes', width: '520', height: '400' },
                    h: phone ? 275 : 397,
                    style: { display: 'block', 'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-right-radius': '12px', 'border-bottom-left-radius': '12px' },
                  },
                ],
              },
            ],
          },
          {
            tag: 'section',
            role: 'region',
            name: 'Everything in one place',
            attrs: { class: 'features', id: 'features', 'aria-labelledby': 'features-title' },
            center: true,
            style: { 'max-width': '1120px', ...sectionPad },
            children: [
              {
                tag: 'h2',
                role: 'heading',
                name: 'Everything in one place',
                text: 'Everything in one place',
                attrs: { class: 'section-title', id: 'features-title' },
                a11y: { level: 2 },
                h: phone ? 31.2 : 38.4,
                style: phone
                  ? { 'font-size': '26px', 'line-height': '31.2px', 'font-weight': '700', 'margin-bottom': '32px' }
                  : { 'font-size': '32px', 'line-height': '38.4px', 'font-weight': '700', 'margin-bottom': '32px' },
              },
              {
                tag: 'div',
                attrs: { class: 'card-grid' },
                style: { display: 'grid', 'grid-template-columns': cardCols, 'grid-template-rows': phone ? '187px 187px 187px' : '164px', gap: '24px', 'row-gap': '24px', 'column-gap': '24px' },
                children: [
                  card('blue', 'Capture quickly', 'Jot down a thought in a second. Lumen files it where it belongs and keeps it searchable.', phone),
                  card('green', 'Link naturally', 'Mention a note and the link is made. Backlinks show you what connects to what.', phone),
                  card('amber', 'Review calmly', 'A daily digest surfaces the notes that matter today, so nothing important is lost.', phone),
                ],
              },
            ],
          },
          {
            tag: 'section',
            role: 'region',
            name: 'Frequently asked questions',
            attrs: { class: 'faq', id: 'faq', 'aria-labelledby': 'faq-title' },
            style: { 'background-color': FIXTURE_A_COLORS.surface, ...sectionPad },
            children: [
              {
                tag: 'h2',
                role: 'heading',
                name: 'Frequently asked questions',
                text: 'Frequently asked questions',
                attrs: { class: 'section-title', id: 'faq-title' },
                a11y: { level: 2 },
                center: true,
                h: phone ? 31.2 : 38.4,
                style: phone
                  ? { 'max-width': '1120px', 'font-size': '26px', 'line-height': '31.2px', 'font-weight': '700', 'margin-bottom': '32px' }
                  : { 'max-width': '1120px', 'font-size': '32px', 'line-height': '38.4px', 'font-weight': '700', 'margin-bottom': '32px' },
              },
              {
                tag: 'div',
                attrs: { class: 'accordion' },
                center: true,
                style: { 'max-width': '760px' },
                children: [
                  faqItem('Is there a free plan?', 'Yes. The free plan includes unlimited notes on one device and seven days of history.', openFaq === 0),
                  faqItem('Can I export my notes?', 'Every note can be exported as Markdown at any time, individually or as a full archive.', openFaq === 1),
                  faqItem('Does Lumen work offline?', 'Lumen is offline first. Changes sync when you are back online, with no merge conflicts.', openFaq === 2),
                ],
              },
            ],
          },
        ],
      },
      {
        tag: 'footer',
        role: 'contentinfo',
        attrs: { class: 'site-footer', id: 'start' },
        style: { 'border-top-width': '1px', 'border-top-style': 'solid', 'border-top-color': FIXTURE_A_COLORS.border, 'background-color': FIXTURE_A_COLORS.white },
        children: [
          {
            tag: 'div',
            attrs: { class: 'footer-inner' },
            center: true,
            style: {
              'max-width': '1120px',
              'padding-top': '32px',
              'padding-right': '24px',
              'padding-bottom': '32px',
              'padding-left': '24px',
              display: 'flex',
              'justify-content': 'space-between',
              gap: '24px',
              'row-gap': '24px',
              'column-gap': '24px',
              ...(phone ? { 'flex-direction': 'column', 'align-items': 'flex-start' } : { 'align-items': 'center', 'flex-wrap': 'wrap' }),
            },
            children: footerChildren,
          },
        ],
      },
    ],
  };
}

/* ---------------------------------------------------------------- layout */

interface Laid {
  readonly spec: Spec;
  readonly box: Box | null;
  readonly style: Record<string, string>;
  readonly children: Laid[];
}

interface Sides {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

function sides(style: Readonly<Record<string, string>>, prefix: 'padding' | 'margin' | 'border'): Sides {
  const suffix = prefix === 'border' ? '-width' : '';
  const read = (side: string): number => parsePx(style[`${prefix}-${side}${suffix}`]) ?? 0;
  return { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') };
}

function gaps(style: Readonly<Record<string, string>>): { row: number; column: number } {
  const row = parsePx(style['row-gap']);
  const column = parsePx(style['column-gap']);
  const both = (style.gap ?? '').split(/\s+/).map((v) => parsePx(v));
  return { row: row ?? both[0] ?? 0, column: column ?? both[1] ?? both[0] ?? 0 };
}

/** Resolve the final style of a node: inherited text properties, tag defaults, then the spec's own values. */
function resolveStyle(spec: Spec, parent: Readonly<Record<string, string>> | null): Record<string, string> {
  const style: Record<string, string> = { display: defaultDisplay(spec.tag), 'box-sizing': 'border-box', fill: 'rgb(0, 0, 0)', stroke: 'none' };
  if (parent) for (const prop of INHERITED) if (parent[prop] !== undefined) style[prop] = parent[prop];
  if (spec.tag === 'a') style.cursor = 'pointer';
  if (spec.tag === 'button') style.cursor = 'default';
  Object.assign(style, spec.style ?? {});
  return style;
}

function hiddenSubtree(spec: Spec, parentStyle: Readonly<Record<string, string>> | null): Laid {
  const style = resolveStyle(spec, parentStyle);
  style.display = 'none';
  style.width = 'auto';
  style.height = 'auto';
  return { spec, box: null, style, children: (spec.children ?? []).map((child) => hiddenSubtree(child, style)) };
}

/** Lay a node out at (x, y) with `available` width; returns its box and laid-out children. */
function place(spec: Spec, x: number, y: number, available: number, parentStyle: Readonly<Record<string, string>> | null): Laid {
  if (spec.hidden) return hiddenSubtree(spec, parentStyle);
  const style = resolveStyle(spec, parentStyle);
  const pad = sides(style, 'padding');
  const bw = sides(style, 'border');
  let width = spec.w ?? parsePx(style.width) ?? available;
  const maxW = parsePx(style['max-width']);
  if (maxW !== null && width > maxW) width = maxW;
  if (spec.center && width < available) {
    const side = (available - width) / 2;
    x += side;
    style['margin-left'] = `${round(side)}px`;
    style['margin-right'] = `${round(side)}px`;
  }
  const contentX = x + pad.left + bw.left;
  const contentY = y + pad.top + bw.top;
  const contentW = width - pad.left - pad.right - bw.left - bw.right;
  const flowChildren = (spec.children ?? []).filter((c) => !c.absBelowParent);
  const display = style.display;
  let children: Laid[] = [];
  let contentH = spec.h ?? 0;

  const measure = (child: Spec, w: number): number => place(child, 0, 0, w, style).box?.height ?? 0;

  if (flowChildren.length > 0 && (display === 'flex' || display === 'inline-flex') && style['flex-direction'] !== 'column') {
    const gap = gaps(style).column;
    const visible = flowChildren.filter((c) => !c.hidden);
    const fixed = visible.map((c) => c.w ?? parsePx(c.style?.width ?? ''));
    const fixedSum = fixed.reduce<number>((sum, w) => sum + (w ?? 0), 0);
    const flexible = fixed.filter((w) => w === null).length;
    const share = flexible > 0 ? Math.max(0, (contentW - gap * (visible.length - 1) - fixedSum) / flexible) : 0;
    const widths = fixed.map((w) => w ?? share);
    const heights = visible.map((c, i) => measure(c, widths[i] ?? 0));
    const rowH = Math.max(0, ...heights);
    const used = widths.reduce((s, w) => s + w, 0) + gap * (visible.length - 1);
    const free = Math.max(0, contentW - used);
    const justify = style['justify-content'];
    const extra = justify === 'space-between' && visible.length > 1 ? free / (visible.length - 1) : 0;
    let cx = contentX + (justify === 'center' ? free / 2 : 0);
    let i = 0;
    children = flowChildren.map((child) => {
      if (child.hidden) return hiddenSubtree(child, style);
      const w = widths[i] ?? 0;
      const h = heights[i] ?? 0;
      const cy = style['align-items'] === 'center' ? contentY + (rowH - h) / 2 : contentY;
      const laid = place(child, cx, cy, w, style);
      cx += w + gap + extra;
      i += 1;
      return laid;
    });
    contentH = Math.max(contentH, rowH);
  } else if (flowChildren.length > 0 && (display === 'flex' || display === 'inline-flex')) {
    const gap = gaps(style).row;
    let cy = contentY;
    children = flowChildren.map((child, i) => {
      if (child.hidden) return hiddenSubtree(child, style);
      const w = child.w ?? contentW;
      const laid = place(child, contentX, cy, w, style);
      cy += (laid.box?.height ?? 0) + (i < flowChildren.length - 1 ? gap : 0);
      return laid;
    });
    contentH = Math.max(contentH, cy - contentY);
  } else if (flowChildren.length > 0 && display === 'grid') {
    const cols = (style['grid-template-columns'] ?? '').split(/\s+/).map((v) => parsePx(v) ?? 0);
    const g = gaps(style);
    const n = Math.max(1, cols.length);
    const rows: Spec[][] = [];
    flowChildren.forEach((child, i) => {
      const r = Math.floor(i / n);
      (rows[r] ??= []).push(child);
    });
    let cy = contentY;
    const out: Laid[] = [];
    rows.forEach((row, r) => {
      const heights = row.map((c, i) => measure(c, cols[i] ?? contentW));
      const rowH = Math.max(0, ...heights);
      let cx = contentX;
      row.forEach((child, i) => {
        const w = cols[i] ?? contentW;
        const h = heights[i] ?? 0;
        const y0 = style['align-items'] === 'center' ? cy + (rowH - h) / 2 : cy;
        out.push(place(child, cx, y0, w, style));
        cx += w + g.column;
      });
      cy += rowH + (r < rows.length - 1 ? g.row : 0);
    });
    children = out;
    contentH = Math.max(contentH, cy - contentY);
  } else if (flowChildren.length > 0) {
    let cy = contentY;
    children = flowChildren.map((child) => {
      if (child.hidden) return hiddenSubtree(child, style);
      const m = sides(child.style ?? {}, 'margin');
      cy += m.top;
      const laid = place(child, contentX, cy, contentW, style);
      cy += (laid.box?.height ?? 0) + m.bottom;
      return laid;
    });
    contentH = Math.max(contentH, cy - contentY);
  }

  const height = contentH + pad.top + pad.bottom + bw.top + bw.bottom;
  const box: Box = { x: round(x), y: round(y), width: round(width), height: round(height) };
  style.width = `${box.width}px`;
  style.height = `${box.height}px`;

  // Absolutely positioned children (the open phone menu) sit below the parent, spanning it.
  const ordered: Laid[] = [];
  let flowIndex = 0;
  for (const child of spec.children ?? []) {
    if (child.absBelowParent) {
      ordered.push(place(child, x, y + height, width, style));
    } else {
      const laid = children[flowIndex];
      flowIndex += 1;
      if (laid) ordered.push(laid);
    }
  }
  return { spec, box, style, children: ordered };
}

/* --------------------------------------------------------------- assemble */

/** Drop properties equal to the UA default, the way the instrument stores styles. */
function compactStyle(style: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(style).sort()) {
    const value = style[key];
    if (value === undefined) continue;
    if ((STYLE_DEFAULTS as Readonly<Record<string, string | undefined>>)[key] === value) continue;
    out[key] = value;
  }
  return out;
}

interface Assembled {
  readonly nodes: UiNode[];
  readonly styles: Record<string, Record<string, string>>;
  readonly roleTree: RoleTreeNode[];
}

function assemble(root: Laid): Assembled {
  const nodes: UiNode[] = [];
  const styles: Record<string, Record<string, string>> = {};
  const roleTree: RoleTreeNode[] = [];
  const roleCounters = new Map<string, number>();

  const intern = (style: Readonly<Record<string, string>>): string => {
    const compact = compactStyle(style);
    const id = `s${digestValue(compact, 8)}`;
    styles[id] ??= compact;
    return id;
  };

  const walk = (laid: Laid, parentId: string | null, path: string, depth: number, a11yDepth: number): string => {
    const id = `n${nodes.length.toString().padStart(3, '0')}`;
    const spec = laid.spec;
    const visible = laid.box !== null;
    const role = spec.role ?? null;
    const name = spec.name ?? null;
    const a11y: A11yProps = { ...(spec.a11y ?? {}) };
    if (role !== null && visible) {
      const key = `${role}\u0000${name ?? ''}`;
      const nth = roleCounters.get(key) ?? 0;
      roleCounters.set(key, nth + 1);
      a11y.nth = nth;
      const states: Record<string, string | boolean | number> = {};
      if (a11y.expanded !== undefined) states.expanded = a11y.expanded;
      if (a11y.level !== undefined) states.level = a11y.level;
      roleTree.push({ nodeId: id, role, name: name ?? '', depth: a11yDepth, states });
    }
    if (!visible) a11y.hidden = true;
    const node: UiNode = {
      id,
      parentId,
      path,
      depth,
      tag: spec.tag,
      role,
      name,
      attrs: { ...(spec.attrs ?? {}) },
      text: spec.text ?? null,
      box: laid.box,
      styleId: intern(laid.style),
      a11y,
      visible,
      interactive: spec.interactive ?? false,
      inForm: false,
      childIds: [],
      ...(spec.pseudoAfter && visible
        ? { pseudo: { after: { content: spec.pseudoAfter.content, styleId: intern({ ...laid.style, display: 'inline', ...spec.pseudoAfter.style }) } } }
        : {}),
    };
    nodes.push(node);
    const childIds = laid.children.map((child, i) => walk(child, id, path === '' ? `${i}` : `${path}/${i}`, depth + 1, role !== null && visible ? a11yDepth + 1 : a11yDepth));
    node.childIds.push(...childIds);
    return id;
  };

  walk(root, null, '', 0, 0);
  return { nodes, styles, roleTree };
}

/** Build one synthetic Fixture A capture. Deterministic for equal options. */
export function buildFixtureACapture(options: SyntheticCaptureOptions = {}): CapturedState {
  const width = options.viewportWidth ?? 1280;
  const viewport: Viewport = { width, height: width >= 1200 ? 800 : width >= 700 ? 1024 : 844 };
  const url = options.url ?? FIXTURE_A_URL;
  const capturedAt = options.capturedAt ?? FIXTURE_A_CAPTURED_AT;
  const stateId = options.stateId ?? 'st_01';
  const menuOpen = isPhone(width) && (options.menuOpen ?? false);

  const laid = place(pageSpec(width, menuOpen, options.openFaq, options.withEmbeds ?? false, options.navLinks ?? DEFAULT_NAV_LINKS), 0, 0, width, null);
  const { nodes, styles, roleTree } = assemble(laid);
  const documentHeight = Math.ceil(laid.box?.height ?? 0);
  const imgNode = nodes.find((n) => n.tag === 'img');
  const iframeNode = nodes.find((n) => n.tag === 'iframe');

  const assets: CapturedAsset[] = [
    {
      id: 'as_01',
      kind: 'image',
      url: new URL('assets/illustration.svg', url).toString(),
      origin: 'same-origin',
      mime: 'image/svg+xml',
      bytes: 1874,
      digest: shortDigest('fixture-a-illustration'),
      width: 520,
      height: 400,
      usedBy: imgNode ? [imgNode.id] : [],
      localPath: `assets/${shortDigest('fixture-a-illustration')}.svg`,
    },
    ...(options.extraAssets ?? []),
  ];
  if (iframeNode) {
    assets.push({ id: 'as_02', kind: 'other', url: 'https://maps.example.com/embed', origin: 'cross-origin', usedBy: [iframeNode.id] });
  }

  const network: NetworkEntry[] = [
    { id: 'rq_01', method: 'GET', url, status: 200, resourceType: 'document', mime: 'text/html', bytes: 5120, startedAt: capturedAt },
    { id: 'rq_02', method: 'GET', url: new URL('styles.css', url).toString(), status: 200, resourceType: 'stylesheet', mime: 'text/css', bytes: 6144, startedAt: capturedAt },
    { id: 'rq_03', method: 'GET', url: new URL('app.js', url).toString(), status: 200, resourceType: 'script', mime: 'text/javascript', bytes: 820, startedAt: capturedAt },
    { id: 'rq_04', method: 'GET', url: new URL('assets/illustration.svg', url).toString(), status: 200, resourceType: 'image', mime: 'image/svg+xml', bytes: 1874, startedAt: capturedAt },
    ...(options.extraNetwork ?? []),
  ];

  const fonts: CapturedFont[] = [{ family: 'Segoe UI', source: 'local', status: 'loaded' }];

  const screenshotOption = options.screenshot === undefined ? { truncated: false } : options.screenshot;
  const screenshotHeight = screenshotOption?.truncated ? Math.min(documentHeight, 1200) : documentHeight;
  const screenshot =
    screenshotOption === null
      ? null
      : {
          path: `states/${stateId}/screenshot.png`,
          width,
          height: Math.max(1, screenshotHeight),
          digest: shortDigest(`screenshot:${stateId}:${width}:${menuOpen}:${options.openFaq ?? -1}`),
          truncated: screenshotOption.truncated,
        };

  return {
    url,
    title: options.title ?? FIXTURE_A_TITLE,
    viewport,
    capturedAt,
    document: { width, height: documentHeight, scrollHeight: documentHeight },
    nodes,
    styles,
    roleTree,
    roleTreeDigest: digestValue(roleTree.map((r) => ({ role: r.role, name: r.name, depth: r.depth, states: r.states }))),
    domDigest: digestValue(nodes.map((n) => ({ tag: n.tag, path: n.path, attrs: n.attrs, text: n.text, visible: n.visible }))),
    screenshot,
    fonts,
    assets,
    network,
    limitations: [...(options.limitations ?? [])],
  };
}

/** The two base states of Fixture A: `st_01` at 1280 and `st_02` at 390. */
export function buildFixtureACaptures(options: Omit<SyntheticCaptureOptions, 'viewportWidth' | 'stateId' | 'menuOpen'> = {}): Map<string, CapturedState> {
  return new Map([
    ['st_01', buildFixtureACapture({ ...options, viewportWidth: 1280, stateId: 'st_01' })],
    ['st_02', buildFixtureACapture({ ...options, viewportWidth: 390, stateId: 'st_02' })],
  ]);
}

/** Scan id used by the synthetic scan record. */
export const FIXTURE_A_SCAN_ID = 'scan_20261013_a1b2c3';

/** Options for the synthetic scan record. */
export interface SyntheticScanOptions {
  /** Captures the record must describe; defaults to `buildFixtureACaptures()`. */
  readonly captures?: ReadonlyMap<string, CapturedState>;
  /** State ids that are derived, with their parent and the transition that produced them. */
  readonly derived?: Readonly<Record<string, { parentStateId: string; viaTransitionId: string }>>;
  readonly toolVersion?: string;
  /** Crawled pages (seed first) written to `scan.pages`; omitted for a single-page scan written before crawls. */
  readonly pages?: ScanRecord['pages'];
  /** Page id per state id; states not listed belong to the seed page (`pg_01`) when `pages` is set, else carry no page id. */
  readonly pageIdByState?: Readonly<Record<string, string>>;
}

/**
 * A `ScanRecord` consistent with the given captures: one state entry per
 * capture, with capture and screenshot paths laid out as the scan store does.
 */
export function buildFixtureAScanRecord(options: SyntheticScanOptions = {}): ScanRecord {
  const captures = options.captures ?? buildFixtureACaptures();
  const states: StateRecord[] = [];
  let i = 0;
  for (const [stateId, capture] of captures) {
    i += 1;
    const derived = options.derived?.[stateId];
    const pageId = options.pageIdByState?.[stateId] ?? (options.pages === undefined ? undefined : 'pg_01');
    states.push({
      stateId,
      ...(pageId === undefined ? {} : { pageId }),
      kind: derived ? 'derived' : 'base',
      parentStateId: derived?.parentStateId ?? null,
      viewport: capture.viewport,
      url: capture.url,
      title: capture.title,
      capturePath: `states/${stateId}/capture.json`,
      screenshotPath: capture.screenshot === null ? null : `states/${stateId}/screenshot.png`,
      domDigest: capture.domDigest,
      roleTreeDigest: capture.roleTreeDigest,
      nodeCount: capture.nodes.length,
      capturedAt: capture.capturedAt,
      evidenceId: derived ? 'ev_0000000000ex' : `ev_${i.toString().padStart(12, '0')}`,
      viaTransitionId: derived?.viaTransitionId ?? null,
    });
  }
  const viewports = [...new Map(states.map((s) => [s.viewport.width, s.viewport])).values()];
  return {
    scanId: FIXTURE_A_SCAN_ID,
    toolVersion: options.toolVersion ?? '0.1.0',
    createdAt: FIXTURE_A_CAPTURED_AT,
    updatedAt: FIXTURE_A_CAPTURED_AT,
    target: { kind: 'url', url: FIXTURE_A_URL },
    browser: { mode: 'launch', name: 'chromium', version: '131.0' },
    viewports,
    pageId: 'pg_01',
    ...(options.pages === undefined ? {} : { pages: options.pages.map((page) => ({ ...page })) }),
    status: 'captured',
    budget: {
      limits: { timeMs: 180_000, pages: options.pages?.length ?? 1, actions: 60, resources: 400 },
      used: { timeMs: 4200, pages: options.pages?.length ?? 1, actions: 0, resources: 4 },
    },
    states,
    limitations: [],
    unknowns: [],
    steps: {
      scan: { at: FIXTURE_A_CAPTURED_AT, evidenceId: 'ev_000000000001' },
      explore: null,
      generate: null,
      verify: [],
      report: null,
    },
  };
}

/** URL of the second page of the synthetic multi-page scan. */
export const FIXTURE_A_FEATURES_URL = 'http://127.0.0.1:4173/features.html';

/** Primary navigation of the synthetic multi-page scan: two same-origin pages (one crawled, one not), a fragment and a cross-origin link. */
export const MULTI_PAGE_NAV_LINKS: readonly { readonly text: string; readonly href: string }[] = [
  { text: 'Features', href: '/features.html' },
  { text: 'Pricing', href: '/pricing.html' },
  { text: 'FAQ', href: '#faq' },
  { text: 'Status', href: 'https://example.com/status' },
];

/** The synthetic multi-page scan: captures, the scan record that lists its pages, and the link the crawl followed. */
export interface MultiPageFixture {
  readonly captures: Map<string, CapturedState>;
  readonly scan: ScanRecord;
  /** Node path (in the seed's 1280 capture) of the nav link that led the crawl to the features page. */
  readonly featuresLinkPath: string;
}

/**
 * A two-page crawl modelled on Fixture A: the seed (`pg_01`, `/`) and a
 * features page (`pg_02`, `/features.html`) that the crawl reached through the
 * seed's "Features" nav link, each captured at 1280 and 390 with the same
 * header and footer. The nav also links to `/pricing.html` (same origin, not
 * crawled), a fragment and a cross-origin status page.
 */
export function buildMultiPageFixture(): MultiPageFixture {
  const common = { navLinks: MULTI_PAGE_NAV_LINKS };
  const seedDesktop = buildFixtureACapture({ ...common, viewportWidth: 1280, stateId: 'st_01' });
  const captures = new Map<string, CapturedState>([
    ['st_01', seedDesktop],
    ['st_02', buildFixtureACapture({ ...common, viewportWidth: 390, stateId: 'st_02' })],
    ['st_03', buildFixtureACapture({ ...common, viewportWidth: 1280, stateId: 'st_03', url: FIXTURE_A_FEATURES_URL, title: 'Lumen — Features', openFaq: 0 })],
    ['st_04', buildFixtureACapture({ ...common, viewportWidth: 390, stateId: 'st_04', url: FIXTURE_A_FEATURES_URL, title: 'Lumen — Features', openFaq: 0 })],
  ]);
  const featuresLink = seedDesktop.nodes.find((n) => n.tag === 'a' && n.attrs.href === '/features.html');
  const featuresLinkPath = featuresLink?.path ?? '';
  const scan = buildFixtureAScanRecord({
    captures,
    pages: [
      { pageId: 'pg_01', url: FIXTURE_A_URL, depth: 0, discoveredVia: null, title: FIXTURE_A_TITLE },
      { pageId: 'pg_02', url: FIXTURE_A_FEATURES_URL, depth: 1, discoveredVia: `pg_01:${featuresLinkPath}`, title: 'Lumen — Features' },
    ],
    pageIdByState: { st_01: 'pg_01', st_02: 'pg_01', st_03: 'pg_02', st_04: 'pg_02' },
  });
  return { captures, scan, featuresLinkPath };
}

/** Find a node by a simple selector: `#id`, `.class` or `tag`. First match in document order. */
export function findNode(state: CapturedState, selector: string): UiNode | undefined {
  if (selector.startsWith('#')) return state.nodes.find((n) => n.attrs.id === selector.slice(1));
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return state.nodes.find((n) => (n.attrs.class ?? '').split(/\s+/).includes(cls));
  }
  return state.nodes.find((n) => n.tag === selector);
}

/** All nodes matching a simple selector (see `findNode`). */
export function findNodes(state: CapturedState, selector: string): UiNode[] {
  if (selector.startsWith('#')) return state.nodes.filter((n) => n.attrs.id === selector.slice(1));
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return state.nodes.filter((n) => (n.attrs.class ?? '').split(/\s+/).includes(cls));
  }
  return state.nodes.filter((n) => n.tag === selector);
}
