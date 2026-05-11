/**
 * Pure splice planner for surgical attribute edits on a single element.
 *
 * Given a target element's source range and a set of attribute mutations
 * (`{ [name]: value | null }`), returns the minimal SpliceOp[] that mutate
 * just those attributes. Other bytes — attribute order, quoting, whitespace,
 * inner content, sibling tags — are preserved verbatim.
 *
 * Rules:
 *   - Existing attribute, string value: replace the value range only,
 *     preserving the original quote style. If the original was unquoted or
 *     the new value contains characters that require quoting, normalise to
 *     double quotes and re-encode entities.
 *   - Existing attribute, null value: remove the attribute including its
 *     leading whitespace separator.
 *   - Missing attribute, string value: insert ` name="value"` immediately
 *     before the opening tag's `>` (or `/>`).
 *   - Missing attribute, null value: no-op.
 *
 * Idempotent: if a string value matches the existing rawValue exactly, no
 * splice is emitted.
 */

import { scanOpenTag, encodeAttrValue, type ScannedAttr } from './scanOpenTagAttrs';
import type { SpliceOp } from './undoStack';

export interface ComputeAttrEditInput {
  source: string;
  /** Inclusive offset of the element's opening `<`. */
  elementStart: number;
  /** Mutations: value → set; null → remove. Names are matched case-insensitively. */
  attrs: Readonly<Record<string, string | null>>;
}

export type ComputeAttrEditResult =
  | { ok: true; splices: SpliceOp[] }
  | { ok: false; reason: 'bad-tag' };

export function computeAttrEditSplices(input: ComputeAttrEditInput): ComputeAttrEditResult {
  const tag = scanOpenTag(input.source, input.elementStart);
  if (!tag) return { ok: false, reason: 'bad-tag' };

  const splices: SpliceOp[] = [];
  const insertions: string[] = [];
  const seen = new Set<string>();

  // Build a lowercase-indexed lookup of existing attrs (last one wins on duplicates).
  const existing = new Map<string, ScannedAttr>();
  for (const a of tag.attrs) existing.set(a.name, a);

  for (const [rawName, value] of Object.entries(input.attrs)) {
    const name = rawName.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);

    const current = existing.get(name);
    if (current === undefined) {
      if (value === null) continue;
      insertions.push(` ${name}="${encodeAttrValue(value)}"`);
      continue;
    }

    if (value === null) {
      // Remove attribute including leading whitespace separator.
      splices.push({
        startOffset: current.fullStart,
        endOffset: current.fullEnd,
        replacement: '',
      });
      continue;
    }

    if (current.rawValue !== null && current.valueStart !== null && current.valueEnd !== null) {
      const encoded = encodeAttrValue(value);
      const safeForExistingQuote =
        current.quote === '"'
          ? !value.includes('"')
          : current.quote === "'"
            ? !value.includes("'")
            : isUnquotedSafe(value);
      if (safeForExistingQuote && current.rawValue === maybeMatchingRaw(value, current.quote)) {
        continue;
      }
      if (safeForExistingQuote) {
        // Replace just the value range, keeping the existing quote style.
        const replacement = current.quote === '' ? value : encoded;
        splices.push({
          startOffset: current.valueStart,
          endOffset: current.valueEnd,
          replacement,
        });
      } else {
        // Need to upgrade quoting: rewrite the whole `name=value` span.
        splices.push({
          startOffset: current.nameStart,
          endOffset: current.fullEnd,
          replacement: `${current.originalName}="${encoded}"`,
        });
      }
    } else {
      // Bare attribute (no =) — rewrite as name="value".
      splices.push({
        startOffset: current.nameStart,
        endOffset: current.fullEnd,
        replacement: `${current.originalName}="${encodeAttrValue(value)}"`,
      });
    }
  }

  if (insertions.length > 0) {
    // For self-closing tags, insert before the `/` (which sits one byte before `>`),
    // so that `<br/>` becomes `<br class="y"/>` rather than `<br/ class="y">`.
    const insertAt = tag.selfClosing ? tag.closeBracket - 1 : tag.closeBracket;
    splices.push({
      startOffset: insertAt,
      endOffset: insertAt,
      replacement: insertions.join(''),
    });
  }

  splices.sort((a, b) => b.startOffset - a.startOffset);
  return { ok: true, splices };
}

/** Conservative check that a value is safe to leave unquoted. */
function isUnquotedSafe(value: string): boolean {
  if (value === '') return false;
  return /^[A-Za-z0-9._:#\/-]+$/.test(value);
}

/**
 * If `value` matches the raw source slice exactly (assuming the same quoting),
 * return that raw slice so the caller can short-circuit. We compare against
 * the encoded form for quoted attrs since the encoder is the inverse of HTML
 * decoding for the limited set of chars it touches.
 */
function maybeMatchingRaw(value: string, quote: '"' | "'" | ''): string {
  if (quote === '') return value;
  return encodeAttrValue(value);
}
