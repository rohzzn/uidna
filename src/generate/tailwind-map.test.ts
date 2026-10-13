import { describe, expect, it } from 'vitest';
import { arbitraryValue, classesFor, normalizeColor, normalizeFontFamily, pseudoContentClass, tokenClassName, uaDefaultDisplay, type TokenIndex } from './tailwind-map.js';

const tokens: TokenIndex = {
  colors: new Map([
    ['#2f5bea', 'color-01'],
    ['#1b1f2a', 'color-02'],
  ]),
  fontSizes: new Map([['18px', 'size-01']]),
  radii: new Map([['12px', 'radius-01']]),
  fontFamilies: new Map([[normalizeFontFamily('"Segoe UI", Roboto, sans-serif'), 'font-01']]),
};

function classes(style: Record<string, string>, extra: Parameters<typeof classesFor>[1] = {}): string[] {
  return [...classesFor(style, extra).classes];
}

describe('normalizeColor', () => {
  it('turns rgb() into lowercase hex and rgba() into 8-digit hex or transparent', () => {
    expect(normalizeColor('rgb(47, 91, 234)')).toBe('#2f5bea');
    expect(normalizeColor('rgba(27, 31, 42, 0.08)')).toBe('#1b1f2a14');
    expect(normalizeColor('rgba(0, 0, 0, 0)')).toBe('transparent');
    expect(normalizeColor('rgb(47 91 234 / 50%)')).toBe('#2f5bea80');
    expect(normalizeColor('#FFF')).toBe('#ffffff');
    expect(normalizeColor('#2f5beaff')).toBe('#2f5bea');
    expect(normalizeColor('oklch(0.6 0.2 250)')).toBe('oklch(0.6 0.2 250)');
  });
});

describe('arbitraryValue', () => {
  it('replaces spaces with underscores and removes spaces inside functions', () => {
    expect(arbitraryValue('0px 8px 24px rgba(27, 31, 42, 0.08)')).toBe('0px_8px_24px_rgba(27,31,42,0.08)');
    expect(arbitraryValue('1fr 1fr')).toBe('1fr_1fr');
    expect(arbitraryValue('auto 520 / 400')).toBe('auto_520/400');
  });
  it('rejects values that cannot live in a class name', () => {
    expect(arbitraryValue('[full-start] 1fr')).toBeNull();
    expect(arbitraryValue('url("x.png")')).toBeNull();
    expect(arbitraryValue('')).toBeNull();
  });
});

describe('classesFor: layout family', () => {
  it('maps display keywords and hides display none', () => {
    expect(classes({ display: 'none' })).toEqual(['hidden']);
    expect(classes({ display: 'flex' })).toEqual(['flex']);
    expect(classes({ display: 'inline-block' })).toEqual(['inline-block']);
    expect(classes({ display: 'grid' })).toEqual(['grid']);
    expect(classes({ display: 'list-item' })).toEqual(['list-item']);
  });
  it('maps position and insets', () => {
    expect(classes({ position: 'absolute', top: '100%', left: '0px', right: '0px', 'z-index': '10' })).toEqual(['absolute', 'left-0', 'right-0', 'top-[100%]', 'z-[10]']);
    expect(classes({ position: 'static', top: 'auto' })).toEqual(['static', 'top-auto']);
  });
  it('maps sizing with named and arbitrary values', () => {
    expect(classes({ width: '520px', height: 'auto', 'max-width': '480px', 'min-width': '0px', 'min-height': '100%' })).toEqual(['h-auto', 'max-w-[480px]', 'min-h-full', 'min-w-0', 'w-[520px]']);
    expect(classes({ width: '100%', 'max-width': 'none' })).toEqual(['max-w-none', 'w-full']);
  });
  it('maps box-sizing, overflow, float, clear and vertical-align', () => {
    expect(classes({ 'box-sizing': 'content-box' })).toEqual(['box-content']);
    expect(classes({ 'overflow-x': 'hidden', 'overflow-y': 'hidden' })).toEqual(['overflow-hidden']);
    expect(classes({ 'overflow-x': 'auto', 'overflow-y': 'visible' })).toEqual(['overflow-x-auto', 'overflow-y-visible']);
    expect(classes({ float: 'left', clear: 'both', 'vertical-align': 'middle' })).toEqual(['align-middle', 'clear-both', 'float-left']);
  });
  it('maps aspect-ratio and object-fit', () => {
    expect(classes({ 'aspect-ratio': 'auto 520 / 400' })).toEqual(['aspect-[520/400]']);
    expect(classes({ 'aspect-ratio': '16 / 9', 'object-fit': 'cover' })).toEqual(['aspect-[16/9]', 'object-cover']);
  });
});

describe('classesFor: spacing family', () => {
  it('collapses equal sides into shorthands', () => {
    expect(classes({ 'padding-top': '16px', 'padding-right': '16px', 'padding-bottom': '16px', 'padding-left': '16px' })).toEqual(['p-[16px]']);
    expect(classes({ 'padding-top': '16px', 'padding-right': '24px', 'padding-bottom': '16px', 'padding-left': '24px' })).toEqual(['px-[24px]', 'py-[16px]']);
    expect(classes({ 'padding-top': '0px', 'padding-right': '24px', 'padding-bottom': '24px', 'padding-left': '24px' })).toEqual(['pb-[24px]', 'pt-0', 'px-[24px]']);
  });
  it('maps margins including auto, zero and negative values', () => {
    expect(classes({ 'margin-top': '16px' })).toEqual(['mt-[16px]']);
    expect(classes({ 'margin-left': 'auto', 'margin-right': 'auto' })).toEqual(['mx-auto']);
    expect(classes({ 'margin-top': '-8px', 'margin-bottom': '0px' })).toEqual(['mb-0', 'mt-[-8px]']);
  });
  it('respects the `only` filter while using the rest of the style as context', () => {
    const style = { 'padding-top': '16px', 'padding-right': '24px', 'padding-bottom': '16px', 'padding-left': '24px' };
    expect(classes(style, { only: new Set(['padding-left']) })).toEqual(['pl-[24px]']);
  });
});

describe('classesFor: flex and grid family', () => {
  it('maps flex container and item properties', () => {
    expect(classes({ 'flex-direction': 'column', 'flex-wrap': 'wrap', 'justify-content': 'space-between', 'align-items': 'center', gap: '24px' })).toEqual([
      'flex-col',
      'flex-wrap',
      'gap-[24px]',
      'items-center',
      'justify-between',
    ]);
    expect(classes({ 'flex-grow': '1', 'flex-shrink': '0', 'flex-basis': '0%', 'align-self': 'flex-end', order: '2' })).toEqual(['basis-[0%]', 'grow', 'order-[2]', 'self-end', 'shrink-0']);
    expect(classes({ gap: '8px 16px' })).toEqual(['gap-x-[16px]', 'gap-y-[8px]']);
    expect(classes({ 'row-gap': '8px', 'column-gap': '0px' })).toEqual(['gap-x-0', 'gap-y-[8px]']);
  });
  it('maps equal pixel tracks to grid-cols-N and other templates to arbitrary values', () => {
    expect(classes({ 'grid-template-columns': '341.33px 341.33px 341.33px' })).toEqual(['grid-cols-3']);
    expect(classes({ 'grid-template-columns': '1fr 1fr' })).toEqual(['grid-cols-[1fr_1fr]']);
    expect(classes({ 'grid-template-columns': '200px 872px' })).toEqual(['grid-cols-[200px_872px]']);
    expect(classes({ 'grid-template-columns': 'none' })).toEqual(['grid-cols-none']);
    expect(classes({ 'grid-auto-flow': 'column', 'grid-column-start': '2', 'grid-row-end': 'span 2' })).toEqual(['col-start-2', 'grid-flow-col', 'row-end-[span_2]']);
  });
});

describe('classesFor: border family', () => {
  it('collapses equal 1px borders to `border` and uses tokens for colors and radii', () => {
    const style = {
      'border-top-width': '1px',
      'border-right-width': '1px',
      'border-bottom-width': '1px',
      'border-left-width': '1px',
      'border-top-style': 'solid',
      'border-right-style': 'solid',
      'border-bottom-style': 'solid',
      'border-left-style': 'solid',
      'border-top-color': 'rgb(47, 91, 234)',
      'border-right-color': 'rgb(47, 91, 234)',
      'border-bottom-color': 'rgb(47, 91, 234)',
      'border-left-color': 'rgb(47, 91, 234)',
      'border-top-left-radius': '12px',
      'border-top-right-radius': '12px',
      'border-bottom-right-radius': '12px',
      'border-bottom-left-radius': '12px',
    };
    expect(classes(style, { tokens })).toEqual(['border', 'border-color-01', 'rounded-radius-01']);
    expect(classes(style)).toEqual(['border', 'border-[#2f5bea]', 'rounded-[12px]']);
  });
  it('emits per-side widths, non-solid styles and per-corner radii', () => {
    expect(classes({ 'border-bottom-width': '1px', 'border-bottom-style': 'dashed', 'border-bottom-color': 'rgb(223, 227, 236)' })).toEqual(['border-b', 'border-b-[#dfe3ec]', 'border-dashed']);
    expect(classes({ 'border-top-width': '2px', 'border-top-style': 'solid', 'border-top-color': 'rgba(0, 0, 0, 0)' })).toEqual(['border-t-[2px]', 'border-t-transparent']);
    expect(classes({ 'border-top-left-radius': '12px', 'border-top-right-radius': '0px' })).toEqual(['rounded-tl-[12px]', 'rounded-tr-none']);
  });
  it('maps outline and box-shadow', () => {
    expect(classes({ 'outline-style': 'solid', 'outline-width': '2px', 'outline-color': 'rgb(47, 91, 234)', 'outline-offset': '2px' })).toEqual(['outline-[#2f5bea]', 'outline-[2px]', 'outline-offset-[2px]', 'outline-solid']);
    expect(classes({ 'box-shadow': 'rgba(27, 31, 42, 0.08) 0px 8px 24px 0px' })).toEqual(['shadow-[rgba(27,31,42,0.08)_0px_8px_24px_0px]']);
    expect(classes({ 'box-shadow': 'none' })).toEqual(['shadow-none']);
  });
});

describe('classesFor: background family', () => {
  it('uses the color token when the hex matches and arbitrary values otherwise', () => {
    expect(classes({ 'background-color': 'rgb(47, 91, 234)' }, { tokens })).toEqual(['bg-color-01']);
    expect(classes({ 'background-color': 'rgb(229, 231, 235)' }, { tokens })).toEqual(['bg-[#e5e7eb]']);
    expect(classes({ 'background-color': 'rgba(0, 0, 0, 0)' })).toEqual(['bg-transparent']);
  });
  it('reproduces gradients but reports url() images as skipped', () => {
    expect(classes({ 'background-image': 'linear-gradient(90deg, rgb(0, 0, 0), rgb(255, 255, 255))' })).toEqual(['bg-[linear-gradient(90deg,rgb(0,0,0),rgb(255,255,255))]']);
    const mapping = classesFor({ 'background-image': 'url("hero.png")', 'background-size': 'cover', 'background-repeat': 'no-repeat' });
    expect(mapping.classes).toEqual(['bg-cover', 'bg-no-repeat']);
    expect(mapping.skipped.map((s) => s.property)).toEqual(['background-image']);
  });
});

describe('classesFor: text family', () => {
  it('maps color, font family, size, weight, style and line-height', () => {
    expect(classes({ color: 'rgb(27, 31, 42)' }, { tokens })).toEqual(['text-color-02']);
    expect(classes({ color: 'rgb(107, 114, 128)' })).toEqual(['text-[#6b7280]']);
    expect(classes({ 'font-family': '"Segoe UI", Roboto, sans-serif' }, { tokens })).toEqual(['font-font-01']);
    expect(classes({ 'font-family': '"Helvetica Neue", Arial, sans-serif' })).toEqual(['font-[family-name:Helvetica_Neue,Arial,sans-serif]']);
    expect(classes({ 'font-size': '18px' }, { tokens })).toEqual(['text-size-01']);
    expect(classes({ 'font-size': '13.333px' })).toEqual(['text-[13.333px]']);
    expect(classes({ 'font-weight': '600' })).toEqual(['font-semibold']);
    expect(classes({ 'font-weight': '450' })).toEqual(['font-[450]']);
    expect(classes({ 'font-style': 'italic', 'line-height': '24px' })).toEqual(['italic', 'leading-[24px]']);
    expect(classes({ 'line-height': '1.1' })).toEqual(['leading-[1.1]']);
    expect(classes({ 'line-height': 'normal' })).toEqual(['leading-[normal]']);
  });
  it('maps spacing, alignment, decoration, transform and wrapping', () => {
    expect(classes({ 'letter-spacing': '0.26px', 'text-align': 'center', 'text-transform': 'uppercase' })).toEqual(['text-center', 'tracking-[0.26px]', 'uppercase']);
    expect(classes({ 'text-decoration-line': 'underline', 'text-decoration-color': 'rgb(47, 91, 234)' })).toEqual(['decoration-[#2f5bea]', 'underline']);
    expect(classes({ 'text-decoration-line': 'none' })).toEqual(['no-underline']);
    expect(classes({ 'white-space': 'nowrap', 'text-overflow': 'ellipsis', 'word-break': 'break-all' })).toEqual(['break-all', 'text-ellipsis', 'whitespace-nowrap']);
    expect(classes({ 'list-style-type': 'none' })).toEqual(['list-none']);
    expect(classes({ 'list-style-type': 'disc' })).toEqual(['list-disc']);
  });
});

describe('classesFor: visual effects family', () => {
  it('maps opacity, visibility, transform, filter, blend, cursor, pointer-events and user-select', () => {
    expect(classes({ opacity: '0.5', visibility: 'hidden' })).toEqual(['invisible', 'opacity-[0.5]']);
    expect(classes({ transform: 'matrix(1, 0, 0, 1, 10, 0)', 'transform-origin': '50% 50%' })).toEqual(['[transform:matrix(1,0,0,1,10,0)]', 'origin-[50%_50%]']);
    expect(classes({ filter: 'blur(4px)', 'mix-blend-mode': 'multiply' })).toEqual(['[filter:blur(4px)]', 'mix-blend-multiply']);
    expect(classes({ cursor: 'pointer', 'pointer-events': 'none', 'user-select': 'none' })).toEqual(['cursor-pointer', 'pointer-events-none', 'select-none']);
    expect(classesFor({ cursor: 'url(x.cur), auto' }).skipped).toHaveLength(1);
  });
});

describe('classesFor: prefixes and pseudo content', () => {
  it('prefixes every class with the variant', () => {
    expect(classes({ display: 'flex', color: 'rgb(27, 31, 42)' }, { prefix: 'md:' })).toEqual(['md:flex', 'md:text-[#1b1f2a]']);
    expect(classes({ 'background-color': 'rgb(36, 72, 191)' }, { prefix: 'hover:' })).toEqual(['hover:bg-[#2448bf]']);
  });
  it('turns quoted content strings into content-[] classes', () => {
    expect(pseudoContentClass('"+"')).toBe("content-['+']");
    expect(pseudoContentClass('"read more"')).toBe("content-['read_more']");
    expect(pseudoContentClass('none')).toBeNull();
    expect(pseudoContentClass('counter(item)')).toBeNull();
    expect(classes({ content: '"+"', color: 'rgb(91, 100, 116)' }, { prefix: 'after:' })).toEqual(["after:content-['+']", 'after:text-[#5b6474]']);
  });
  it('sorts classes alphabetically', () => {
    const out = classes({ display: 'flex', 'align-items': 'center', 'background-color': 'rgb(255, 255, 255)', 'padding-top': '4px' });
    expect(out).toEqual([...out].sort());
  });
});

describe('helpers', () => {
  it('derives safe token class names', () => {
    expect(tokenClassName('color-01')).toBe('color-01');
    expect(tokenClassName('Brand Primary')).toBe('brand-primary');
    expect(tokenClassName('brandPrimary')).toBe('brand-primary');
    expect(tokenClassName('***')).toBe('token');
  });
  it('knows the preflight display defaults', () => {
    expect(uaDefaultDisplay('div')).toBe('block');
    expect(uaDefaultDisplay('span')).toBe('inline');
    expect(uaDefaultDisplay('button')).toBe('inline-block');
    expect(uaDefaultDisplay('li')).toBe('list-item');
    expect(uaDefaultDisplay('img')).toBe('block');
  });
});
