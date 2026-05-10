import { describe, expect, it } from 'vitest';
import { walkEditableInJs } from '../src/host/parse/walkEditableInJs';

describe('walkEditableInJs', () => {
  it('extracts editable text nodes from a single html`` literal', () => {
    const src = "export const view = html`<p>Hello</p>`;\n";
    const { offsetMap } = walkEditableInJs(src, 1);
    expect(offsetMap.textNodes).toHaveLength(1);
    expect(offsetMap.textNodes[0].originalText).toBe('Hello');
    const tn = offsetMap.textNodes[0];
    expect(src.slice(tn.startOffset, tn.endOffset)).toBe('Hello');
  });

  it('produces JS-source offsets that round-trip via splice', () => {
    const src = "const v = html`<p>Hello</p>`;";
    const { offsetMap } = walkEditableInJs(src, 1);
    const tn = offsetMap.textNodes[0];
    const replaced =
      src.slice(0, tn.startOffset) + 'World' + src.slice(tn.endOffset);
    expect(replaced).toBe('const v = html`<p>World</p>`;');
  });

  it('preserves block inner-offset round-trip in JS source', () => {
    const src = 'const v = html`<p class="a">hi</p>`;';
    const { offsetMap } = walkEditableInJs(src, 1);
    const block = offsetMap.blocks.find((b) => b.tagName === 'p');
    expect(block).toBeDefined();
    const replaced =
      src.slice(0, block!.innerStartOffset!) +
      '<strong>HI</strong>' +
      src.slice(block!.innerEndOffset!);
    expect(replaced).toContain('<p class="a"><strong>HI</strong></p>');
  });

  it('locks text nodes containing ${...} interpolations but leaves siblings editable', () => {
    const src = "html`<p>Hello ${name}</p><p>plain</p>`";
    const { offsetMap } = walkEditableInJs(src, 1);
    const texts = offsetMap.textNodes.map((t) => t.originalText);
    expect(texts).toEqual(['plain']);
  });

  it('handles multiple html`` literals in one file', () => {
    const src = "html`<h1>One</h1>` + html`<h2>Two</h2>`";
    const { offsetMap } = walkEditableInJs(src, 1);
    const texts = offsetMap.textNodes.map((t) => t.originalText);
    expect(texts).toEqual(['One', 'Two']);
    // Each text node's slice in the JS source must equal originalText.
    for (const tn of offsetMap.textNodes) {
      expect(src.slice(tn.startOffset, tn.endOffset)).toBe(tn.originalText);
    }
  });

  it('returns an empty map for a file with no html`` literals', () => {
    const src = "const x = 42; const y = `not html`;";
    const { offsetMap } = walkEditableInJs(src, 1);
    expect(offsetMap.elements).toHaveLength(0);
    expect(offsetMap.textNodes).toHaveLength(0);
  });

  it('preserves documentVersion on the emitted map', () => {
    const { offsetMap } = walkEditableInJs("html`<p>x</p>`", 99);
    expect(offsetMap.documentVersion).toBe(99);
  });
});
