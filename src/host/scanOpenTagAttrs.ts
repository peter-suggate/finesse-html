/**
 * Pure attribute scanner over a single HTML opening tag.
 *
 * Given the source text and the offset of the opening `<`, locates every
 * `name="value"` (or `name='value'` or `name=value` or bare `name`) inside the
 * tag and returns precise byte ranges so callers can splice individual
 * attributes without disturbing surrounding bytes (whitespace, attribute
 * order, quoting).
 *
 * No DOM, no parse5. Self-contained for surgical edits.
 */

export interface ScannedAttr {
  /** Lowercase attribute name. */
  name: string;
  /** Original (case-preserving) name slice. */
  originalName: string;
  /** Inclusive offset of the first character of the name. */
  nameStart: number;
  /** Exclusive offset just past the last character of the name. */
  nameEnd: number;
  /** Inclusive offset of the leading whitespace before the name (joins to prior attr). */
  prefixStart: number;
  /** Quote character used (`"` | `'` | empty for unquoted/bare). */
  quote: '"' | "'" | '';
  /** Inclusive offset of the value's first character (after the opening quote). null if attribute has no `=`. */
  valueStart: number | null;
  /** Exclusive offset just past the value's last character (before the closing quote). null if attribute has no `=`. */
  valueEnd: number | null;
  /** Decoded value string (HTML entities NOT decoded — raw source slice). */
  rawValue: string | null;
  /** Inclusive offset of the entire attribute (including any leading whitespace). */
  fullStart: number;
  /** Exclusive offset just past the attribute's closing quote (or value/name). */
  fullEnd: number;
}

export interface ScannedOpenTag {
  /** Inclusive offset of the opening `<`. */
  openStart: number;
  /** Exclusive offset just past the tag name. */
  tagNameEnd: number;
  /** Lowercase tag name. */
  tagName: string;
  /** Inclusive offset of the closing `>` of the opening tag. */
  closeBracket: number;
  /** True if the opening tag is self-closed (`/>`). */
  selfClosing: boolean;
  /** Attributes in source order. */
  attrs: ScannedAttr[];
}

const WS = new Set([' ', '\t', '\n', '\r', '\f']);

/**
 * Scan the opening tag that starts at `openStart`. Returns null if the slice
 * doesn't look like an HTML element open tag.
 */
export function scanOpenTag(source: string, openStart: number): ScannedOpenTag | null {
  if (source[openStart] !== '<') return null;
  let i = openStart + 1;
  const nameStart = i;
  while (i < source.length && isTagNameChar(source[i])) i++;
  if (i === nameStart) return null;
  const tagName = source.slice(nameStart, i).toLowerCase();
  const tagNameEnd = i;

  const attrs: ScannedAttr[] = [];
  let selfClosing = false;
  let closeBracket = -1;

  while (i < source.length) {
    // Capture whitespace prefix start so we can splice including the leading
    // separator on attribute removal.
    const prefixStart = i;
    while (i < source.length && WS.has(source[i])) i++;
    if (i >= source.length) return null;

    const ch = source[i];
    if (ch === '>') {
      closeBracket = i;
      break;
    }
    if (ch === '/' && source[i + 1] === '>') {
      selfClosing = true;
      closeBracket = i + 1;
      break;
    }

    // Attribute name. Names can be almost anything that isn't whitespace, /, >, =, or quotes.
    const attrNameStart = i;
    while (i < source.length && isAttrNameChar(source[i])) i++;
    if (i === attrNameStart) {
      // Defensive: skip an unexpected char so we don't infinite-loop on malformed input.
      i++;
      continue;
    }
    const attrNameEnd = i;
    const originalName = source.slice(attrNameStart, attrNameEnd);
    const name = originalName.toLowerCase();

    // Optional = value.
    let j = i;
    while (j < source.length && WS.has(source[j])) j++;
    if (source[j] !== '=') {
      // Bare attribute (HTML allows e.g. `disabled`).
      attrs.push({
        name,
        originalName,
        nameStart: attrNameStart,
        nameEnd: attrNameEnd,
        prefixStart,
        quote: '',
        valueStart: null,
        valueEnd: null,
        rawValue: null,
        fullStart: prefixStart,
        fullEnd: attrNameEnd,
      });
      continue;
    }
    j++; // past =
    while (j < source.length && WS.has(source[j])) j++;

    let quote: '"' | "'" | '' = '';
    let valueStart: number;
    let valueEnd: number;
    if (source[j] === '"' || source[j] === "'") {
      quote = source[j] as '"' | "'";
      valueStart = j + 1;
      valueEnd = source.indexOf(quote, valueStart);
      if (valueEnd === -1) return null;
      i = valueEnd + 1;
    } else {
      valueStart = j;
      let k = j;
      while (k < source.length && !WS.has(source[k]) && source[k] !== '>' && source[k] !== '/') k++;
      valueEnd = k;
      i = k;
    }
    attrs.push({
      name,
      originalName,
      nameStart: attrNameStart,
      nameEnd: attrNameEnd,
      prefixStart,
      quote,
      valueStart,
      valueEnd,
      rawValue: source.slice(valueStart, valueEnd),
      fullStart: prefixStart,
      fullEnd: i,
    });
  }

  if (closeBracket === -1) return null;
  return {
    openStart,
    tagNameEnd,
    tagName,
    closeBracket,
    selfClosing,
    attrs,
  };
}

function isTagNameChar(ch: string): boolean {
  return /[a-zA-Z0-9_:-]/.test(ch);
}

function isAttrNameChar(ch: string): boolean {
  // Be permissive: anything that isn't whitespace, =, /, >, ", '.
  if (WS.has(ch)) return false;
  if (ch === '=' || ch === '/' || ch === '>' || ch === '"' || ch === "'") return false;
  return true;
}

/**
 * Encode `value` for use inside a double-quoted attribute. Escapes `&` and `"`.
 * Single quotes/braces left alone — the JS-template escaper runs separately if
 * the output is being spliced into a tagged-template literal.
 */
export function encodeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
