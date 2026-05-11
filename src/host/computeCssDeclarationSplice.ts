/**
 * Pure splice planner for editing a single CSS declaration inside a `<style>`
 * block in the HTML source.
 *
 * Scope (v1):
 *   - Only top-level rules whose selector text trims to exactly `.className`
 *     are considered. `.foo:hover`, `.foo .bar`, and at-rule-nested rules are
 *     deliberately ignored — the side panel hides controls for those.
 *   - All `<style>` blocks in the document are searched; first matching rule
 *     wins. If multiple rules with the same selector exist we edit the first.
 *   - Strings (`"…"`, `'…'`) and `/* … *​/` comments are skipped during
 *     tokenisation so a `:` or `;` inside them doesn't confuse parsing.
 *
 * Edit semantics:
 *   - Existing declaration → splice the value (between `:` and the terminator
 *     `;` or `}`); preserves `!important` only if the caller's new value
 *     contains it. Pass `value: null` to remove the entire declaration line.
 *   - Missing declaration → insert `  <property>: <value>;\n` immediately
 *     before the rule's closing `}`, matching the indentation of the rule
 *     body's first non-whitespace character.
 */

import type { SpliceOp } from './undoStack';

export interface ComputeCssDeclarationInput {
  source: string;
  selector: string;
  property: string;
  /** `null` removes the declaration entirely. */
  value: string | null;
}

export type ComputeCssDeclarationResult =
  | { ok: true; splices: SpliceOp[] }
  | { ok: false; reason: 'no-style-block' | 'no-rule' | 'no-op' };

export function computeCssDeclarationSplice(
  input: ComputeCssDeclarationInput,
): ComputeCssDeclarationResult {
  const { source, selector, property, value } = input;
  const blocks = findStyleBlocks(source);
  if (blocks.length === 0) return { ok: false, reason: 'no-style-block' };

  for (const block of blocks) {
    const rule = locateTopLevelRule(source, block.contentStart, block.contentEnd, selector);
    if (!rule) continue;
    const decl = locateDeclaration(source, rule.bodyStart, rule.bodyEnd, property);
    if (decl) {
      if (value === null) {
        // Remove the whole declaration (including its terminator and trailing newline if any).
        let end = decl.terminatorEnd;
        // Swallow a trailing newline + indent so we don't leave a blank line.
        if (source[end] === '\n') end += 1;
        else if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
        return {
          ok: true,
          splices: [
            {
              startOffset: decl.lineStart,
              endOffset: end,
              replacement: '',
            },
          ],
        };
      }
      const trimmed = value.trim();
      const current = source.slice(decl.valueStart, decl.valueEnd).trim();
      if (current === trimmed) return { ok: false, reason: 'no-op' };
      // Preserve leading whitespace after `:` so " 8px" stays " 12px".
      const leading = source.slice(decl.valueStart, decl.valueStart + leadingSpaceCount(source, decl.valueStart));
      return {
        ok: true,
        splices: [
          {
            startOffset: decl.valueStart + leading.length,
            endOffset: decl.valueEnd,
            replacement: trimmed,
          },
        ],
      };
    }
    if (value === null) return { ok: false, reason: 'no-op' };
    // Insert before the closing `}` of this rule.
    const indent = detectBodyIndent(source, rule.bodyStart, rule.bodyEnd);
    const insertion = `${indent}${property}: ${value.trim()};\n${trailingIndent(source, rule.bodyEnd)}`;
    return {
      ok: true,
      splices: [
        {
          startOffset: rule.bodyEnd,
          endOffset: rule.bodyEnd,
          replacement: insertion,
        },
      ],
    };
  }
  return { ok: false, reason: 'no-rule' };
}

// ── Style block discovery ────────────────────────────────────────────────

interface StyleBlock {
  contentStart: number;
  contentEnd: number;
}

function findStyleBlocks(source: string): StyleBlock[] {
  const out: StyleBlock[] = [];
  const openRe = /<style\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(source))) {
    const contentStart = m.index + m[0].length;
    const close = source.indexOf('</style', contentStart);
    if (close < 0) break;
    out.push({ contentStart, contentEnd: close });
    openRe.lastIndex = close;
  }
  return out;
}

// ── Tokenisation helpers ─────────────────────────────────────────────────

/**
 * Advance `i` past any whitespace, `/* … *​/` comments, or string literals
 * starting at `i`. Returns the new index. If `i` doesn't sit on one of those
 * tokens, returns `i` unchanged.
 */
function skipTrivia(source: string, i: number, end: number): number {
  while (i < end) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    return i;
  }
  return i;
}

/** Advance past a `"…"` or `'…'` string starting at quote. Returns index after close. */
function skipString(source: string, i: number, end: number): number {
  const quote = source[i];
  i++;
  while (i < end) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return end;
}

/**
 * Starting at `i` inside a CSS body, scan forward and return the index of the
 * next character that is structurally significant (`{`, `}`, `;`, `:`) at the
 * current nesting depth, skipping strings + comments. Returns `end` if none.
 */
function findNextStructural(source: string, i: number, end: number, targets: string): number {
  while (i < end) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? end : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(source, i, end);
      continue;
    }
    if (targets.includes(c)) return i;
    i++;
  }
  return end;
}

// ── Top-level rule lookup ────────────────────────────────────────────────

interface RuleSpan {
  selectorStart: number;
  selectorEnd: number;
  /** Index immediately after the opening `{`. */
  bodyStart: number;
  /** Index of the closing `}`. */
  bodyEnd: number;
}

function locateTopLevelRule(
  source: string,
  start: number,
  end: number,
  selector: string,
): RuleSpan | null {
  let i = start;
  while (i < end) {
    i = skipTrivia(source, i, end);
    if (i >= end) return null;

    if (source[i] === '@') {
      // At-rule. Skip to its `;` or matching `{…}` block; don't descend.
      i = skipAtRule(source, i, end);
      continue;
    }

    const selectorStart = i;
    const brace = findNextStructural(source, i, end, '{;}');
    if (brace >= end || source[brace] !== '{') {
      // No body — likely a stray declaration or invalid input. Bail.
      return null;
    }
    const selectorText = source.slice(selectorStart, brace).trim();
    const bodyStart = brace + 1;
    const bodyEnd = findMatchingClose(source, bodyStart, end);
    if (bodyEnd < 0) return null;
    if (selectorText === selector) {
      return { selectorStart, selectorEnd: brace, bodyStart, bodyEnd };
    }
    i = bodyEnd + 1;
  }
  return null;
}

/** From an `@` at `start`, skip the at-rule (either a `;` or a balanced `{…}`). */
function skipAtRule(source: string, start: number, end: number): number {
  const term = findNextStructural(source, start, end, '{;');
  if (term >= end) return end;
  if (source[term] === ';') return term + 1;
  // Block at-rule (e.g. @media). Skip the balanced braces.
  const close = findMatchingClose(source, term + 1, end);
  return close < 0 ? end : close + 1;
}

/** From inside a block (just after a `{`), find the matching `}` accounting for nested blocks. */
function findMatchingClose(source: string, i: number, end: number): number {
  let depth = 1;
  while (i < end) {
    const next = findNextStructural(source, i, end, '{}');
    if (next >= end) return -1;
    if (source[next] === '{') depth++;
    else {
      depth--;
      if (depth === 0) return next;
    }
    i = next + 1;
  }
  return -1;
}

// ── Declaration lookup ───────────────────────────────────────────────────

interface DeclarationSpan {
  /** Start of the declaration's line (the property identifier's first char). */
  lineStart: number;
  /** Position of the `:` separating property and value. */
  colon: number;
  /** First char of the value (immediately after the `:`). */
  valueStart: number;
  /** End of the value (the terminator `;` or `}`). */
  valueEnd: number;
  /** Index just past the terminator (the `;` itself; or `bodyEnd` if no `;`). */
  terminatorEnd: number;
}

function locateDeclaration(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  property: string,
): DeclarationSpan | null {
  let i = bodyStart;
  while (i < bodyEnd) {
    i = skipTrivia(source, i, bodyEnd);
    if (i >= bodyEnd) return null;
    if (source[i] === '@') {
      i = skipAtRule(source, i, bodyEnd);
      continue;
    }
    if (source[i] === '}') return null;
    const lineStart = i;
    const colon = findNextStructural(source, i, bodyEnd, ':;{}');
    if (colon >= bodyEnd || source[colon] !== ':') {
      // Not a declaration (could be a nested selector — not supported). Skip past it.
      if (colon >= bodyEnd) return null;
      if (source[colon] === ';') {
        i = colon + 1;
        continue;
      }
      if (source[colon] === '{') {
        const close = findMatchingClose(source, colon + 1, bodyEnd);
        i = close < 0 ? bodyEnd : close + 1;
        continue;
      }
      return null; // hit `}`
    }
    const name = source.slice(lineStart, colon).trim();
    const valueStart = colon + 1;
    const terminator = findNextStructural(source, valueStart, bodyEnd, ';}');
    const valueEnd = terminator;
    const terminatorEnd = terminator < bodyEnd && source[terminator] === ';' ? terminator + 1 : terminator;
    if (normaliseProperty(name) === normaliseProperty(property)) {
      return { lineStart, colon, valueStart, valueEnd, terminatorEnd };
    }
    i = terminatorEnd;
  }
  return null;
}

function normaliseProperty(name: string): string {
  return name.trim().toLowerCase();
}

// ── Indentation helpers (insertion) ──────────────────────────────────────

function leadingSpaceCount(source: string, from: number): number {
  let n = 0;
  while (source[from + n] === ' ' || source[from + n] === '\t') n++;
  return n;
}

/**
 * Heuristic: walk the rule body for the indentation prefix of the first
 * declaration. Falls back to two spaces if none is detected (empty body).
 */
function detectBodyIndent(source: string, bodyStart: number, bodyEnd: number): string {
  let i = bodyStart;
  while (i < bodyEnd) {
    if (source[i] === '\n') {
      i++;
      let j = i;
      while (j < bodyEnd && (source[j] === ' ' || source[j] === '\t')) j++;
      if (j > i && j < bodyEnd && source[j] !== '\n' && source[j] !== '\r') {
        return source.slice(i, j);
      }
      continue;
    }
    i++;
  }
  return '  ';
}

/** Indentation prefix of the line containing `bodyEnd` (the closing `}`'s line). */
function trailingIndent(source: string, bodyEnd: number): string {
  let i = bodyEnd - 1;
  while (i >= 0 && source[i] !== '\n') i--;
  let j = i + 1;
  while (j < bodyEnd && (source[j] === ' ' || source[j] === '\t')) j++;
  return source.slice(i + 1, j);
}
