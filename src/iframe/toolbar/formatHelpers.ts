/**
 * Pure format-detection helpers. No DOM globals — operates on a tiny
 * Node-like interface so it can be unit-tested with handcrafted fakes.
 *
 * The DOM-using wrappers live in {@link ./format}.
 */

export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'code';

export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
}

export const EMPTY_FORMAT_STATE: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
};

const TAG_TO_FORMAT: Readonly<Record<string, InlineFormat>> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
};

export function tagToFormatName(tag: string): InlineFormat | null {
  return TAG_TO_FORMAT[tag.toLowerCase()] ?? null;
}

export interface AncestorNode {
  tagName?: string;
  parentNode?: AncestorNode | null;
}

/**
 * Walk the ancestor chain from `node` up to (but not crossing) `boundary`,
 * recording any inline formats encountered.
 */
export function queryFormatStateForElement(
  node: AncestorNode | null,
  boundary: AncestorNode | null,
): FormatState {
  const out: FormatState = { ...EMPTY_FORMAT_STATE };
  let cur: AncestorNode | null | undefined = node;
  while (cur && cur !== boundary) {
    const tagName: string | undefined = cur.tagName;
    if (tagName) {
      const fmt = TAG_TO_FORMAT[tagName.toLowerCase()];
      if (fmt) out[fmt] = true;
    }
    cur = cur.parentNode ?? null;
  }
  return out;
}

/**
 * Validate a URL for use in `<a href>`. Allows http/https/mailto/tel and
 * any non-scheme (relative) URL. Rejects javascript:/data:/vbscript:.
 */
export function isLinkUrlSafe(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase();
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
  }
  return true;
}
