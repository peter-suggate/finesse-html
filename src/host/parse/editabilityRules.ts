export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'li',
  'dt',
  'dd',
  'figcaption',
  'blockquote',
  'address',
  'td',
  'th',
  'caption',
]);

export const NON_EDITABLE_PARENT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'code',
  'pre',
  'title',
]);

export const SKIP_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
]);

export interface AnyAttr {
  name: string;
  value: string;
}

export function hasNoEditAttr(attrs: AnyAttr[] | undefined): boolean {
  if (!attrs) return false;
  for (const a of attrs) {
    if (a.name === 'data-no-edit') return true;
    if (a.name === 'contenteditable' && a.value === 'false') return true;
  }
  return false;
}

export function isEditAnywayOverride(attrs: AnyAttr[] | undefined): boolean {
  if (!attrs) return false;
  for (const a of attrs) {
    if (a.name === 'data-html-wysiwyg-allow' && a.value === 'true') return true;
  }
  return false;
}
