import { describe, expect, it } from 'vitest';
import {
  applySplicesToSource,
  computeBlockHtmlSplices,
} from '../src/host/computeBlockHtmlSplices';
import { walkEditable } from '../src/host/parse/walkEditable';

function commit(source: string, blockId: number, newInnerHtml: string, newTagName?: string): string {
  const map = walkEditable(source, 1);
  const result = computeBlockHtmlSplices({
    source,
    offsetMap: map,
    blockId,
    newInnerHtml,
    newTagName,
  });
  if (!result.ok) throw new Error(`splice failed: ${result.reason}`);
  return applySplicesToSource(source, result.splices);
}

describe('computeBlockHtmlSplices — round trip via walkEditable', () => {
  it('replaces inner content of a single block byte-perfectly outside the block', () => {
    const src = '<!doctype html>\n<html><body>\n  <p>hello</p>\n  <p>world</p>\n</body></html>';
    // Block 0 is the first <p>. Replace its inner with formatted text.
    const after = commit(src, 0, 'hello <strong>world</strong>');
    expect(after).toBe(
      '<!doctype html>\n<html><body>\n  <p>hello <strong>world</strong></p>\n  <p>world</p>\n</body></html>',
    );
  });

  it('leaves indentation and surrounding whitespace untouched', () => {
    const src = '<html><body>\n\n    <h1>old</h1>\n\n</body></html>';
    const after = commit(src, 0, 'new');
    expect(after).toBe('<html><body>\n\n    <h1>new</h1>\n\n</body></html>');
  });

  it('preserves block attributes when changing inner content', () => {
    const src = '<html><body><p class="lead" id="x">old</p></body></html>';
    const after = commit(src, 0, 'new');
    expect(after).toBe('<html><body><p class="lead" id="x">new</p></body></html>');
  });

  it('combined tag rename + inner edit applies atomically', () => {
    const src = '<html><body><p>old</p></body></html>';
    const after = commit(src, 0, 'new', 'h2');
    expect(after).toBe('<html><body><h2>new</h2></body></html>');
  });

  it('combined tag rename preserves attributes byte-for-byte', () => {
    const src = '<html><body><p class="lead">old</p></body></html>';
    const after = commit(src, 0, 'new', 'h3');
    expect(after).toBe('<html><body><h3 class="lead">new</h3></body></html>');
  });

  it('sanitizes disallowed tags out of newInnerHtml', () => {
    const src = '<html><body><p>x</p></body></html>';
    const after = commit(src, 0, '<font>hi</font><script>alert(1)</script>');
    expect(after).toContain('<p>hi');
    expect(after).not.toContain('<font');
    expect(after).not.toContain('<script');
  });

  it('strips data-finesse-id attrs that the iframe might re-emit', () => {
    const src = '<html><body><p>x</p></body></html>';
    const after = commit(
      src,
      0,
      '<strong data-finesse-id="42">bold</strong>',
    );
    expect(after).toBe('<html><body><p><strong>bold</strong></p></body></html>');
  });

  it('sanitizes javascript: URLs to empty href', () => {
    const src = '<html><body><p>x</p></body></html>';
    const after = commit(src, 0, '<a href="javascript:alert(1)">click</a>');
    expect(after).toBe('<html><body><p><a href="">click</a></p></body></html>');
  });

  it('preserves sanitized font weight spans', () => {
    const src = '<html><body><p>x</p></body></html>';
    const after = commit(src, 0, '<span style="color: red; font-weight: 600">x</span>');
    expect(after).toBe(
      '<html><body><p><span style="font-weight: 600">x</span></p></body></html>',
    );
  });

  it('rejects unknown blockId', () => {
    const map = walkEditable('<html><body><p>x</p></body></html>', 1);
    const result = computeBlockHtmlSplices({
      source: '<html><body><p>x</p></body></html>',
      offsetMap: map,
      blockId: 999,
      newInnerHtml: 'y',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown-block');
  });

  it('rejects out-of-list newTagName', () => {
    const map = walkEditable('<html><body><p>x</p></body></html>', 1);
    const result = computeBlockHtmlSplices({
      source: '<html><body><p>x</p></body></html>',
      offsetMap: map,
      blockId: 0,
      newInnerHtml: 'y',
      newTagName: 'script',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-tag');
  });

  it('preserves bytes around multi-block documents (only the targeted block changes)', () => {
    const src =
      '<html><body>\n  <h1>title</h1>\n  <p>first</p>\n  <p>second</p>\n  <footer>x</footer>\n</body></html>';
    const map = walkEditable(src, 1);
    // Find the second <p> by looking up its blockId.
    const blocks = map.blocks.filter((b) => b.tagName === 'p');
    const targetId = blocks[1].blockId;
    const result = computeBlockHtmlSplices({
      source: src,
      offsetMap: map,
      blockId: targetId,
      newInnerHtml: 'SECOND',
    });
    if (!result.ok) throw new Error('failed');
    const after = applySplicesToSource(src, result.splices);
    expect(after).toBe(
      '<html><body>\n  <h1>title</h1>\n  <p>first</p>\n  <p>SECOND</p>\n  <footer>x</footer>\n</body></html>',
    );
  });
});
