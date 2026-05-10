/**
 * Pure positioning math for the floating format toolbar.
 *
 * No DOM access, no globals — every input is passed in. This makes it easy to
 * unit-test edge cases (collision with viewport edges, flip placement when
 * there is no room above the block).
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Placement = 'above' | 'below';

export interface ToolbarPosition {
  /** Fixed-positioning `left` (in viewport px). */
  left: number;
  /** Fixed-positioning `top` (in viewport px). */
  top: number;
  /** Whether the toolbar ended up above or below the anchor. */
  placement: Placement;
}

export interface ComputeOpts {
  /** Anchor rect — typically the selection rect, or the block's getBoundingClientRect. */
  anchor: Rect;
  /** Viewport size. */
  viewport: Viewport;
  /** Toolbar's own size (after layout). */
  toolbar: Size;
  /** Pixel gap between anchor and toolbar. Defaults to 8. */
  gap?: number;
  /** Inner padding inside the viewport. Defaults to 8. */
  padding?: number;
}

/**
 * Pick a placement (above when there's room, else below) and clamp horizontal
 * position so the toolbar stays inside the viewport (with `padding`).
 */
export function computeToolbarPosition(opts: ComputeOpts): ToolbarPosition {
  const gap = opts.gap ?? 8;
  const padding = opts.padding ?? 8;
  const { anchor, viewport, toolbar } = opts;

  const placeAboveTop = anchor.top - toolbar.height - gap;
  const placeBelowTop = anchor.top + anchor.height + gap;
  const fitsAbove = placeAboveTop >= padding;
  const fitsBelow = placeBelowTop + toolbar.height <= viewport.height - padding;

  let placement: Placement;
  let top: number;
  if (fitsAbove) {
    placement = 'above';
    top = placeAboveTop;
  } else if (fitsBelow) {
    placement = 'below';
    top = placeBelowTop;
  } else {
    // Neither fits — prefer above and clamp.
    placement = 'above';
    top = Math.max(padding, placeAboveTop);
  }

  // Center horizontally on the anchor, then clamp.
  const idealLeft = anchor.left + anchor.width / 2 - toolbar.width / 2;
  const minLeft = padding;
  const maxLeft = Math.max(padding, viewport.width - toolbar.width - padding);
  const left = clamp(idealLeft, minLeft, maxLeft);

  return { left, top, placement };
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Convert a window {@link Selection}'s bounding range to a {@link Rect}.
 * Returns null if there is no range or the range is collapsed and at the
 * very start of an empty block (in which case fall back to the block rect).
 */
export interface SelectionLike {
  rangeCount: number;
  isCollapsed: boolean;
  getRangeAt(index: number): {
    getBoundingClientRect: () => Rect;
    getClientRects: () => { length: number; item(i: number): Rect | null };
  };
}

export function selectionRect(sel: SelectionLike | null): Rect | null {
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const r = range.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    // Try first client rect — sometimes a collapsed caret has a zero bounding
    // rect but a non-zero first client rect we can use as the caret line.
    const list = range.getClientRects();
    if (list.length > 0) {
      const first = list.item(0);
      if (first && (first.width !== 0 || first.height !== 0)) return first;
    }
    return null;
  }
  return r;
}
