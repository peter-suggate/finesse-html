import { describe, expect, it } from 'vitest';
import { computeToolbarPosition } from '../src/iframe/toolbar/positioning';

const TOOLBAR = { width: 280, height: 36 };
const VIEWPORT = { width: 1000, height: 800 };

describe('computeToolbarPosition', () => {
  it('places above the anchor when there is room', () => {
    const out = computeToolbarPosition({
      anchor: { left: 100, top: 200, width: 400, height: 30 },
      viewport: VIEWPORT,
      toolbar: TOOLBAR,
    });
    expect(out.placement).toBe('above');
    // 200 - 36 - 8 = 156
    expect(out.top).toBe(156);
  });

  it('flips below when the anchor is near the top of the viewport', () => {
    const out = computeToolbarPosition({
      anchor: { left: 100, top: 4, width: 400, height: 30 },
      viewport: VIEWPORT,
      toolbar: TOOLBAR,
    });
    expect(out.placement).toBe('below');
    // 4 + 30 + 8 = 42
    expect(out.top).toBe(42);
  });

  it('centers horizontally on the anchor', () => {
    const out = computeToolbarPosition({
      anchor: { left: 200, top: 300, width: 400, height: 30 },
      viewport: VIEWPORT,
      toolbar: TOOLBAR,
    });
    // anchor center = 400; toolbar half = 140; left = 260
    expect(out.left).toBe(260);
  });

  it('clamps to the left padding when the anchor would push it offscreen', () => {
    const out = computeToolbarPosition({
      anchor: { left: 0, top: 300, width: 50, height: 20 },
      viewport: VIEWPORT,
      toolbar: TOOLBAR,
    });
    expect(out.left).toBe(8);
  });

  it('clamps to the right padding when the anchor is near the right edge', () => {
    const out = computeToolbarPosition({
      anchor: { left: 950, top: 300, width: 50, height: 20 },
      viewport: VIEWPORT,
      toolbar: TOOLBAR,
    });
    // max left = 1000 - 280 - 8 = 712
    expect(out.left).toBe(712);
  });

  it('respects custom gap and padding', () => {
    const out = computeToolbarPosition({
      anchor: { left: 100, top: 200, width: 100, height: 30 },
      viewport: VIEWPORT,
      toolbar: TOOLBAR,
      gap: 16,
      padding: 20,
    });
    expect(out.top).toBe(200 - 36 - 16);
    // anchor center = 150; ideal left = 10; clamped to padding 20
    expect(out.left).toBe(20);
  });

  it('falls back to clamped above when neither above nor below fits', () => {
    const out = computeToolbarPosition({
      anchor: { left: 100, top: 0, width: 50, height: 750 },
      viewport: { width: 1000, height: 800 },
      toolbar: TOOLBAR,
      gap: 8,
      padding: 8,
    });
    expect(out.placement).toBe('above');
    // placeAboveTop = -44 → clamped to padding 8
    expect(out.top).toBe(8);
  });
});
