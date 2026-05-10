import { describe, expect, it } from 'vitest';
import {
  composeTemplateLiterals,
  composedToSource,
  extractTemplateLiterals,
} from '../src/host/parse/extractTemplateLiterals';

describe('extractTemplateLiterals', () => {
  it('finds a simple html-tagged template literal', () => {
    const src = "const t = html`<p>hi</p>`;\n";
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].tag).toBe('html');
    expect(ranges[0].innerText).toBe('<p>hi</p>');
    expect(src.slice(ranges[0].innerStartOffset, ranges[0].innerEndOffset)).toBe(
      '<p>hi</p>',
    );
    expect(src.slice(ranges[0].openOffset, ranges[0].closeOffset)).toBe(
      '`<p>hi</p>`',
    );
  });

  it('matches the trailing identifier of a member expression tag', () => {
    const src = 'const t = lit.html`<p>hi</p>`;';
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].tag).toBe('html');
  });

  it('ignores untagged template literals', () => {
    const src = 'const t = `not html`;';
    expect(extractTemplateLiterals(src)).toEqual([]);
  });

  it('ignores tags not in the allowlist', () => {
    const src = "const sql = sql`SELECT 1`; const x = html`<p>y</p>`;";
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].tag).toBe('html');
  });

  it('keeps ${...} interpolations as literal text in innerText', () => {
    const src = 'html`<p>Hello ${name}!</p>`';
    const ranges = extractTemplateLiterals(src);
    expect(ranges[0].innerText).toBe('<p>Hello ${name}!</p>');
  });

  it('handles nested template literals inside ${} interpolations', () => {
    const src = 'html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`';
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(2);
    // Outer first or inner first? Inner closes first → emitted first.
    const tags = ranges.map((r) => r.innerText);
    expect(tags).toContain('<li>${i}</li>');
    expect(tags).toContain('<ul>${items.map(i => html`<li>${i}</li>`)}</ul>');
  });

  it('handles escaped backticks inside the template body', () => {
    const src = 'html`<p>back \\` tick</p>`';
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].innerText).toBe('<p>back \\` tick</p>');
  });

  it('skips backticks inside string literals', () => {
    const src = "const s = 'not a `template`'; html`<p>real</p>`";
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].innerText).toBe('<p>real</p>');
  });

  it('skips backticks inside line comments', () => {
    const src = '// comment with ` backtick\nhtml`<p>real</p>`';
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].innerText).toBe('<p>real</p>');
  });

  it('skips backticks inside block comments', () => {
    const src = '/* `nope` */ html`<p>real</p>`';
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].innerText).toBe('<p>real</p>');
  });

  it('handles object literals inside ${} (brace-depth tracking)', () => {
    const src = 'html`<p>${{a: 1, b: {c: 2}}}</p>` html`<p>after</p>`';
    const ranges = extractTemplateLiterals(src);
    expect(ranges).toHaveLength(2);
    expect(ranges[1].innerText).toBe('<p>after</p>');
  });
});

describe('composeTemplateLiterals + composedToSource', () => {
  it('returns identity mapping for a single literal', () => {
    const src = 'html`<p>hi</p>`';
    const ranges = extractTemplateLiterals(src);
    const composed = composeTemplateLiterals(ranges);
    expect(composed.composedHtml).toBe('<p>hi</p>');
    expect(composedToSource(0, composed.chunks)).toBe(ranges[0].innerStartOffset);
    expect(composedToSource(2, composed.chunks)).toBe(ranges[0].innerStartOffset + 2);
    expect(composedToSource(composed.composedHtml.length, composed.chunks)).toBe(
      ranges[0].innerEndOffset,
    );
  });

  it('inserts a synthetic divider between literals and maps offsets correctly', () => {
    const src = 'html`<p>one</p>` html`<p>two</p>`';
    const ranges = extractTemplateLiterals(src);
    const composed = composeTemplateLiterals(ranges);
    const firstLen = ranges[0].innerText.length;
    expect(composedToSource(0, composed.chunks)).toBe(ranges[0].innerStartOffset);
    // Position INSIDE divider returns null
    expect(composedToSource(firstLen + 2, composed.chunks)).toBeNull();
    // Position at start of second literal maps back to its inner start
    const secondStart = composed.chunks[2].composedStart;
    expect(composedToSource(secondStart, composed.chunks)).toBe(
      ranges[1].innerStartOffset,
    );
  });
});
