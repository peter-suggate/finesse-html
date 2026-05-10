/**
 * A tagged template literal located in JS/TS source whose tag identifier is in
 * the configured allowlist (e.g. `html`...`).
 */
export interface TemplateLiteralRange {
  /** Lowercased trailing identifier of the tag expression (e.g. `lit.html` → "html"). */
  tag: string;
  /** Source offset of the opening backtick (inclusive). */
  openOffset: number;
  /** Source offset just past the closing backtick (exclusive). */
  closeOffset: number;
  /** Source offset just after the opening backtick (inclusive). */
  innerStartOffset: number;
  /** Source offset of the closing backtick (exclusive). */
  innerEndOffset: number;
  /** Verbatim slice of source between the backticks. `${...}` segments are kept as text. */
  innerText: string;
}

export interface ExtractOptions {
  /**
   * Lowercased identifiers accepted as a template-literal tag. Matched against
   * the trailing identifier of the tag expression so `lit.html` matches via
   * "html" if "html" is in the set.
   */
  tags?: ReadonlySet<string>;
}

export const DEFAULT_TEMPLATE_TAGS: ReadonlySet<string> = new Set([
  'html',
  'htm',
  'lit',
  'svg',
  'markup',
]);

const TRAILING_IDENT = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/;

function readPrecedingTag(source: string, backtickIndex: number): string | null {
  const slice = source.slice(0, backtickIndex);
  const match = TRAILING_IDENT.exec(slice);
  if (!match) return null;
  return match[1].toLowerCase();
}

type CodeFrame = { kind: 'code' };
type InterpFrame = { kind: 'interp'; depth: number };
type TemplFrame = {
  kind: 'templ';
  open: number;
  innerStart: number;
  tag: string | null;
};
type Frame = CodeFrame | InterpFrame | TemplFrame;

/**
 * Scan a JS/TS source string for tagged template literals whose tag matches
 * the allowlist. Returns one `TemplateLiteralRange` per match in document
 * order. Inner content is returned verbatim — escape sequences and `${...}`
 * interpolations are preserved as text.
 *
 * Limitations:
 * - Regex literals (`/.../flags`) are not specially recognised. A backtick
 *   inside a regex is rare and would be misclassified.
 * - String/template-literal escape decoding is not performed; the raw source
 *   slice is returned. For HTML in template literals this is almost always
 *   what you want.
 */
export function extractTemplateLiterals(
  source: string,
  options: ExtractOptions = {},
): TemplateLiteralRange[] {
  const tags = options.tags ?? DEFAULT_TEMPLATE_TAGS;
  const out: TemplateLiteralRange[] = [];
  const stack: Frame[] = [{ kind: 'code' }];

  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];

    if (top.kind === 'templ') {
      const c = source[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        if (top.tag !== null) {
          out.push({
            tag: top.tag,
            openOffset: top.open,
            closeOffset: i + 1,
            innerStartOffset: top.innerStart,
            innerEndOffset: i,
            innerText: source.slice(top.innerStart, i),
          });
        }
        stack.pop();
        i++;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        stack.push({ kind: 'interp', depth: 1 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '\n') break;
        i++;
      }
      if (source[i] === quote) i++;
      continue;
    }
    if (c === '`') {
      const tag = readPrecedingTag(source, i);
      const accepted = tag !== null && tags.has(tag);
      stack.push({
        kind: 'templ',
        open: i,
        innerStart: i + 1,
        tag: accepted ? tag : null,
      });
      i++;
      continue;
    }
    if (top.kind === 'interp') {
      if (c === '{') {
        top.depth++;
      } else if (c === '}') {
        top.depth--;
        if (top.depth === 0) {
          stack.pop();
          i++;
          continue;
        }
      }
    }
    i++;
  }

  return out;
}

// ── Composition: many template literals → one preview HTML string ────────────

export interface ComposedChunk {
  /** Inclusive offset into the composed string. */
  composedStart: number;
  /** Exclusive offset into the composed string. */
  composedEnd: number;
  /**
   * JS-source offset corresponding to `composedStart`. Identity within a
   * chunk: `sourceStart + (composedOffset - composedStart)`. `null` for
   * synthetic chunks (dividers between literals) that have no source mapping.
   */
  sourceStart: number | null;
}

export interface ComposeResult {
  composedHtml: string;
  chunks: ComposedChunk[];
}

const DIVIDER = '\n<!-- -->\n';

export function composeTemplateLiterals(
  ranges: readonly TemplateLiteralRange[],
): ComposeResult {
  const parts: string[] = [];
  const chunks: ComposedChunk[] = [];
  let cursor = 0;
  ranges.forEach((r, idx) => {
    if (idx > 0) {
      parts.push(DIVIDER);
      chunks.push({
        composedStart: cursor,
        composedEnd: cursor + DIVIDER.length,
        sourceStart: null,
      });
      cursor += DIVIDER.length;
    }
    parts.push(r.innerText);
    chunks.push({
      composedStart: cursor,
      composedEnd: cursor + r.innerText.length,
      sourceStart: r.innerStartOffset,
    });
    cursor += r.innerText.length;
  });
  return { composedHtml: parts.join(''), chunks };
}

/**
 * Translate a composed-string offset to the matching JS-source offset.
 * Returns `null` if the offset falls inside a synthetic divider or outside
 * any chunk.
 *
 * At chunk boundaries (where one chunk's `composedEnd` equals the next
 * chunk's `composedStart`), a real chunk is preferred over a synthetic
 * (divider) chunk, so endOffsets that abut a divider still map to the
 * preceding literal's source range.
 */
export function composedToSource(
  offset: number,
  chunks: readonly ComposedChunk[],
): number | null {
  for (const ch of chunks) {
    if (offset > ch.composedStart && offset < ch.composedEnd) {
      if (ch.sourceStart === null) return null;
      return ch.sourceStart + (offset - ch.composedStart);
    }
  }
  for (const ch of chunks) {
    if (ch.sourceStart === null) continue;
    if (offset === ch.composedStart) return ch.sourceStart;
    if (offset === ch.composedEnd) {
      return ch.sourceStart + (ch.composedEnd - ch.composedStart);
    }
  }
  return null;
}
