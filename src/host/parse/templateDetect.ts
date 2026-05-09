const DEFAULT_PATTERNS: readonly RegExp[] = [
  /\{\{[^}]*\}\}/,
  /\{%[^%]*%\}/,
  /<%[^%]*%>/,
  /\$\{[^}]*\}/,
  /<\?[^?]*\?>/,
];

export function defaultTemplatePatterns(): readonly RegExp[] {
  return DEFAULT_PATTERNS;
}

export function detectTemplate(html: string, patterns: readonly RegExp[] = DEFAULT_PATTERNS): boolean {
  for (const p of patterns) {
    if (p.test(html)) return true;
  }
  return false;
}

export function textHasTemplateToken(
  text: string,
  patterns: readonly RegExp[] = DEFAULT_PATTERNS,
): boolean {
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}
