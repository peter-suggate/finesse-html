import { describe, expect, it } from 'vitest';
import { walkEditable } from '../src/host/parse/walkEditable';

describe('walkEditable', () => {
  it('emits one element per non-structural source element, in document order', () => {
    const html = '<!doctype html><html><body><h1>A</h1><p>B</p></body></html>';
    const map = walkEditable(html, 1);
    const tags = map.elements.map((e) => e.tagName);
    expect(tags).toEqual(['h1', 'p']);
  });

  it('does not emit html, body, or head children', () => {
    const html =
      '<!doctype html><html><head><title>x</title><meta charset="utf-8"></head><body><div>hi</div></body></html>';
    const map = walkEditable(html, 1);
    const tags = map.elements.map((e) => e.tagName);
    expect(tags).toEqual(['div']);
  });

  it('records source offsets that splice cleanly', () => {
    const html = '<!doctype html><html><body><h1>Hello</h1><p>world</p></body></html>';
    const map = walkEditable(html, 1);
    const h1 = map.elements.find((e) => e.tagName === 'h1');
    expect(h1).toBeDefined();
    const removed = html.slice(0, h1!.startOffset) + html.slice(h1!.endOffset);
    expect(removed).toBe('<!doctype html><html><body><p>world</p></body></html>');
  });

  it('emits pre/code as elements but does not emit their text nodes', () => {
    const html =
      '<!doctype html><html><body><pre>hello\nworld</pre><code>x</code></body></html>';
    const map = walkEditable(html, 1);
    const tags = map.elements.map((e) => e.tagName);
    expect(tags).toContain('pre');
    expect(tags).toContain('code');
    expect(map.textNodes).toHaveLength(0);
  });

  it('blocks reference matching elementIds via the elements table', () => {
    const html = '<!doctype html><html><body><p>foo</p></body></html>';
    const map = walkEditable(html, 1);
    expect(map.blocks).toHaveLength(1);
    const block = map.blocks[0];
    const linkedElement = map.elements.find((e) => e.elementId === block.elementId);
    expect(linkedElement?.tagName).toBe('p');
  });

  it('does not synthesise an elementId for browser-implicit tbody (no source location)', () => {
    // Source has <table><tr> directly; parse5 inserts an implicit <tbody> with no location.
    const html =
      '<!doctype html><html><body><table><tr><td>cell</td></tr></table></body></html>';
    const map = walkEditable(html, 1);
    const tags = map.elements.map((e) => e.tagName);
    expect(tags).toEqual(['table', 'tr', 'td']);
  });

  it('preserves the document version on the emitted map', () => {
    const map = walkEditable('<!doctype html><html><body><p>x</p></body></html>', 42);
    expect(map.documentVersion).toBe(42);
    expect(map.type).toBe('offsetMap');
  });

  it('skips text nodes containing template tokens but still emits the surrounding element', () => {
    const html = '<!doctype html><html><body><p>Hello {{ name }}</p></body></html>';
    const map = walkEditable(html, 1);
    expect(map.elements.map((e) => e.tagName)).toContain('p');
    expect(map.textNodes).toHaveLength(0);
  });

  it('honours custom template patterns by locking matching text nodes', () => {
    const html = '<!doctype html><html><body><p>~~lock~~</p><p>ok</p></body></html>';
    const map = walkEditable(html, 1, { templatePatterns: [/~~[^~]*~~/] });
    const texts = map.textNodes.map((tn) => tn.originalText);
    expect(texts).toEqual(['ok']);
  });
});
