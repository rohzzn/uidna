import { describe, expect, it } from 'vitest';
import { positionedAxis } from './styles.js';

describe('positionedAxis', () => {
  it('reads a box stretched by both insets as stretched', () => {
    expect(positionedAxis({ left: '0px', right: '0px' }, 'left', 'right')).toBe('stretch');
    expect(positionedAxis({ top: '0.5px', bottom: '0px' }, 'top', 'bottom')).toBe('stretch');
  });

  it('anchors on the side nearer the edge, since computed insets resolve both sides', () => {
    // A sidebar at left: 0 whose right inset is the rest of the viewport.
    expect(positionedAxis({ left: '0px', right: '390px' }, 'left', 'right')).toBe('start');
    // A badge at right: 12px whose left inset is whatever remains.
    expect(positionedAxis({ left: '820px', right: '12px' }, 'left', 'right')).toBe('end');
    expect(positionedAxis({ top: '73px', bottom: '1200px' }, 'top', 'bottom')).toBe('start');
  });

  it('uses the only inset given', () => {
    expect(positionedAxis({ right: '16px' }, 'left', 'right')).toBe('end');
    expect(positionedAxis({ left: '16px' }, 'left', 'right')).toBe('start');
  });
});
