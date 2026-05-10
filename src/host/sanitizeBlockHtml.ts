import { parseFragment, serialize } from 'parse5';

/**
 * Inline tags allowed inside an editable block when committing structural
 * (formatting) edits. Anything else has its tag stripped but its text content
 * preserved.
 */
export const DEFAULT_ALLOWED_INLINE_TAGS: ReadonlySet<string> = new Set([
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'code',
  'a',
  'br',
  'span',
]);

/**
 * Per-tag attribute allowlist. Tags absent from this map keep no attributes.
 * Attribute *values* are not interpreted; the parse5 serializer escapes them.
 * URL attributes (`href`) are additionally checked against {@link isSafeUrl}.
 */
export const DEFAULT_ALLOWED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'title', 'target', 'rel']),
};

const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src']);

/** Reject `javascript:` / `data:` / `vbscript:` URLs. Allow same-document and http(s)/mailto. */
export function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    const scheme = trimmed.slice(0, trimmed.indexOf(':')).toLowerCase();
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
  }
  // Relative URLs (./foo, /foo, foo, #anchor, ?q=1)
  return true;
}

export interface SanitizeOptions {
  allowedTags?: ReadonlySet<string>;
  allowedAttrs?: Readonly<Record<string, ReadonlySet<string>>>;
  /** Strip this attribute name from every element regardless of allowlist. */
  stripDataAttrs?: boolean;
}

interface FragmentNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: FragmentNode[];
  parentNode?: FragmentNode;
}

/**
 * Sanitize an HTML fragment against an inline-tag allowlist. Disallowed tags
 * are unwrapped (children survive); disallowed attributes are dropped;
 * unsafe URLs become empty strings.
 *
 * Pure: no I/O, no globals. Safe to call on untrusted input.
 */
export function sanitizeBlockHtml(html: string, options: SanitizeOptions = {}): string {
  const allowedTags = options.allowedTags ?? DEFAULT_ALLOWED_INLINE_TAGS;
  const allowedAttrs = options.allowedAttrs ?? DEFAULT_ALLOWED_ATTRS;
  const stripDataAttrs = options.stripDataAttrs ?? true;

  const fragment = parseFragment(html) as unknown as FragmentNode;
  walk(fragment, allowedTags, allowedAttrs, stripDataAttrs);
  return serialize(fragment as never);
}

function walk(
  node: FragmentNode,
  allowedTags: ReadonlySet<string>,
  allowedAttrs: Readonly<Record<string, ReadonlySet<string>>>,
  stripDataAttrs: boolean,
): void {
  const children = node.childNodes ? [...node.childNodes] : [];
  for (const child of children) {
    walk(child, allowedTags, allowedAttrs, stripDataAttrs);
  }

  if (typeof node.tagName !== 'string') return; // text/comment/document — leave alone
  const tag = node.tagName.toLowerCase();

  if (!allowedTags.has(tag)) {
    unwrap(node);
    return;
  }

  const allowed = allowedAttrs[tag] ?? EMPTY_SET;
  if (node.attrs && node.attrs.length > 0) {
    node.attrs = node.attrs.filter((a) => {
      const name = a.name.toLowerCase();
      if (stripDataAttrs && name.startsWith('data-')) return false;
      if (name === 'style' || name === 'class' || name === 'id') return false;
      if (name.startsWith('on')) return false;
      if (!allowed.has(name)) return false;
      if (URL_ATTRS.has(name) && !isSafeUrl(a.value)) {
        a.value = '';
      }
      return true;
    });
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Replace `node` with its children in `node.parentNode`. */
function unwrap(node: FragmentNode): void {
  const parent = node.parentNode;
  if (!parent || !parent.childNodes) return;
  const idx = parent.childNodes.indexOf(node);
  if (idx === -1) return;
  const kids = node.childNodes ?? [];
  for (const k of kids) k.parentNode = parent;
  parent.childNodes.splice(idx, 1, ...kids);
}
