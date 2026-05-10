import { describe, expect, it } from 'vitest';
import { computeBlockTagSplices } from '../src/host/blockTagTransform';

function applySplices(source: string, splices: ReturnType<typeof computeBlockTagSplices>): string {
  if (!splices) throw new Error('null splices');
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  let out = source;
  for (const s of ordered) {
    out = out.slice(0, s.startOffset) + s.replacement + out.slice(s.endOffset);
  }
  return out;
}

describe('computeBlockTagSplices', () => {
  it('rewrites <p>…</p> to <h2>…</h2>', () => {
    const src = '<p>hello</p>';
    const splices = computeBlockTagSplices({
      source: src,
      elementStart: 0,
      elementEnd: src.length,
      innerStart: 3,
      innerEnd: 8,
      oldTag: 'p',
      newTag: 'h2',
    });
    expect(applySplices(src, splices)).toBe('<h2>hello</h2>');
  });

  it('preserves attributes byte-for-byte', () => {
    const src = '<p class="a"  data-x="1" >hi</p   >';
    const innerStart = src.indexOf('>') + 1;
    const innerEnd = src.lastIndexOf('</p');
    const splices = computeBlockTagSplices({
      source: src,
      elementStart: 0,
      elementEnd: src.length,
      innerStart,
      innerEnd,
      oldTag: 'p',
      newTag: 'h3',
    });
    const after = applySplices(src, splices);
    expect(after).toBe('<h3 class="a"  data-x="1" >hi</h3   >');
  });

  it('returns empty array when oldTag === newTag', () => {
    const splices = computeBlockTagSplices({
      source: '<p>x</p>',
      elementStart: 0,
      elementEnd: 8,
      innerStart: 3,
      innerEnd: 4,
      oldTag: 'p',
      newTag: 'p',
    });
    expect(splices).toEqual([]);
  });

  it('returns null on stale offsets (source no longer matches oldTag)', () => {
    const splices = computeBlockTagSplices({
      source: '<h1>x</h1>',
      elementStart: 0,
      elementEnd: 10,
      innerStart: 4,
      innerEnd: 5,
      oldTag: 'p',
      newTag: 'h2',
    });
    expect(splices).toBeNull();
  });

  it('returns null on bogus newTag', () => {
    const splices = computeBlockTagSplices({
      source: '<p>x</p>',
      elementStart: 0,
      elementEnd: 8,
      innerStart: 3,
      innerEnd: 4,
      oldTag: 'p',
      newTag: 'h2 onclick=x',
    });
    expect(splices).toBeNull();
  });

  it('handles uppercase source tags via case-insensitive match', () => {
    const src = '<P>hi</P>';
    const splices = computeBlockTagSplices({
      source: src,
      elementStart: 0,
      elementEnd: src.length,
      innerStart: 3,
      innerEnd: 5,
      oldTag: 'p',
      newTag: 'h2',
    });
    // Replacement uses the requested newTag verbatim; source-side closing is
    // identified by lowercased compare.
    const after = applySplices(src, splices);
    expect(after).toBe('<h2>hi</h2>');
  });
});
