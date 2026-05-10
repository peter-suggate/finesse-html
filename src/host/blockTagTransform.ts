/**
 * Block-tag transform: rewrite just the tag name on a block's opening and
 * closing tags, leaving attributes and inner content byte-perfect.
 *
 * Pure helper — no I/O, no parse5, no DOM. Operates on raw source offsets.
 */

export const ALLOWED_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
]);

export interface BlockTagSpliceInput {
  source: string;
  /** Offset of the opening `<`. */
  elementStart: number;
  /** Offset just past the closing `>`. */
  elementEnd: number;
  /** Offset just past the opening tag's `>`. */
  innerStart?: number;
  /** Offset of the closing tag's `<`. */
  innerEnd?: number;
  /** Source tag name (lowercase). */
  oldTag: string;
  /** Target tag name (lowercase). */
  newTag: string;
}

export interface Splice {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

/**
 * Compute the minimal splices required to retag a block element.
 *
 * Returns null if the source at the expected positions doesn't look like the
 * old tag (e.g. case mismatch beyond ASCII, or stale offset map).
 */
export function computeBlockTagSplices(input: BlockTagSpliceInput): Splice[] | null {
  const { source, elementStart, oldTag, newTag } = input;
  if (oldTag === newTag) return [];
  if (!isTagNameLike(newTag)) return null;
  if (!isTagNameLike(oldTag)) return null;

  // Opening tag: `<oldTag` at elementStart.
  const openExpect = `<${oldTag}`;
  const openSlice = source.slice(elementStart, elementStart + openExpect.length).toLowerCase();
  if (openSlice !== openExpect.toLowerCase()) return null;
  const openTagNameStart = elementStart + 1;
  const openTagNameEnd = openTagNameStart + oldTag.length;

  // Closing tag: search backwards from elementEnd for `</oldTag`. Tolerates
  // whitespace before `>` (e.g. `</p >`).
  const closeStart = findClosingTagStart(source, elementStart, input.elementEnd, oldTag, input.innerEnd);
  if (closeStart === null) {
    // Self-closing or void — only rewrite the opening tag.
    return [
      {
        startOffset: openTagNameStart,
        endOffset: openTagNameEnd,
        replacement: newTag,
      },
    ];
  }
  const closeTagNameStart = closeStart + 2; // past `</`
  const closeTagNameEnd = closeTagNameStart + oldTag.length;

  return [
    {
      startOffset: openTagNameStart,
      endOffset: openTagNameEnd,
      replacement: newTag,
    },
    {
      startOffset: closeTagNameStart,
      endOffset: closeTagNameEnd,
      replacement: newTag,
    },
  ];
}

function isTagNameLike(s: string): boolean {
  return /^[a-z][a-z0-9]*$/i.test(s);
}

/**
 * Locate `</tag` within `[elementStart, elementEnd)`. Prefers the position
 * indicated by `innerEnd` if present; falls back to a last-occurrence search.
 */
function findClosingTagStart(
  source: string,
  elementStart: number,
  elementEnd: number,
  oldTag: string,
  innerEnd: number | undefined,
): number | null {
  const expected = `</${oldTag.toLowerCase()}`;
  if (innerEnd !== undefined && innerEnd >= elementStart && innerEnd <= elementEnd) {
    const slice = source.slice(innerEnd, innerEnd + expected.length).toLowerCase();
    if (slice === expected) return innerEnd;
  }
  // Last-occurrence search within element bounds (tolerant fallback).
  const segment = source.slice(elementStart, elementEnd).toLowerCase();
  const idx = segment.lastIndexOf(expected);
  if (idx === -1) return null;
  return elementStart + idx;
}
