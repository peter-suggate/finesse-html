/**
 * Pure helper for nudging a CSS declaration value by a numeric delta while
 * preserving its unit. Used by the per-class declaration row to give users
 * ArrowUp / ArrowDown / Shift-Arrow / Alt-Arrow bumping in the side panel.
 *
 * Returns the bumped value as a string, or `null` if the input isn't a
 * single numeric token we can bump (multi-value shorthand like
 * `padding: 8px 4px`, keywords like `auto`, `calc(...)`, etc.).
 */

/** Maximum decimal places we ever keep in a bumped value. */
const MAX_DECIMALS = 4;

export function bumpCssValue(value: string, delta: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  // Match a single token of:   sign? digits ('.' digits)? unit?
  // Unit is letters and/or `%`. Refuses multi-token values like `8px 4px` and
  // function calls like `calc(...)` / `var(...)`.
  const m = /^(-?(?:\d+\.\d*|\.\d+|\d+))([A-Za-z%]*)$/.exec(trimmed);
  if (!m) return null;
  const numStr = m[1];
  const unit = m[2];
  const num = Number.parseFloat(numStr);
  if (!Number.isFinite(num)) return null;
  const next = num + delta;
  // Preserve precision: keep as many decimals as max(input, delta), capped.
  const inputDecimals = decimalsOf(numStr);
  const deltaDecimals = decimalsOf(String(delta));
  const places = Math.min(MAX_DECIMALS, Math.max(inputDecimals, deltaDecimals));
  const formatted = formatNumber(next, places);
  return formatted + unit;
}

function decimalsOf(s: string): number {
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  return s.length - dot - 1;
}

/** Format to `places` decimals, but trim trailing zeros (so `1.50` → `1.5`). */
function formatNumber(n: number, places: number): string {
  if (places === 0) return String(Math.round(n));
  // toFixed rounds; that's what we want for floating-point noise.
  const fixed = n.toFixed(places);
  // Trim trailing zeros and a dangling decimal point: 1.500 → 1.5, 2.000 → 2.
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export interface BumpModifiers {
  shift?: boolean;
  alt?: boolean;
}

/**
 * Resolve the effective step given keyboard modifiers. Convention matches
 * the existing `numericInput` in `inputs.ts` plus a finer Alt-step:
 *   - plain:    ±1
 *   - Shift:    ±10
 *   - Alt:      ±0.1
 *   - Shift+Alt is treated as Shift (10), to keep the rule predictable.
 */
export function bumpStep(modifiers: BumpModifiers): number {
  if (modifiers.shift) return 10;
  if (modifiers.alt) return 0.1;
  return 1;
}
