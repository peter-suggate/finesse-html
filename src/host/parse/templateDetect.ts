/**
 * Patterns that break HTML parsing or cross tag boundaries. When any of these
 * appear in the source, the entire file is treated as templated and editing is
 * locked across the board (preview still works).
 */
const STRUCTURAL_PATTERNS: readonly RegExp[] = [
  /\{\{[^}]*\}\}/, // Handlebars, Vue, Mustache
  /\{%[^%]*%\}/, // Jinja2, Liquid, Nunjucks
  /<%[^%]*%>/, // EJS, ASP, ERB
  /<\?[^?]*\?>/, // PHP, XML processing instructions
];

/**
 * Patterns that appear as ordinary text inside otherwise valid HTML — they
 * don't confuse the parser, so we don't need to lock the whole file. Per-text
 * node we still skip them so commits never overwrite the interpolation. Always
 * applied at the per-node level regardless of user config.
 */
const TEXT_ONLY_PATTERNS: readonly RegExp[] = [
  /\$\{[^}]*\}/, // JS template literal interpolations
];

export function defaultTemplatePatterns(): readonly RegExp[] {
  return STRUCTURAL_PATTERNS;
}

export function defaultTextOnlyTemplatePatterns(): readonly RegExp[] {
  return TEXT_ONLY_PATTERNS;
}

export function detectTemplate(
  html: string,
  patterns: readonly RegExp[] = STRUCTURAL_PATTERNS,
): boolean {
  for (const p of patterns) {
    if (p.test(html)) return true;
  }
  return false;
}

export function textHasTemplateToken(
  text: string,
  patterns: readonly RegExp[] = STRUCTURAL_PATTERNS,
): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  for (const p of TEXT_ONLY_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}
