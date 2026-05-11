import { describe, expect, it } from 'vitest';
import { computeAttrEditSplices } from '../src/host/computeAttrEditSplices';
import { applySplicesToSource } from '../src/host/computeBlockHtmlSplices';
import { scanOpenTag } from '../src/host/scanOpenTagAttrs';

function applyAt(source: string, elementStart: number, attrs: Record<string, string | null>): string {
  const result = computeAttrEditSplices({ source, elementStart, attrs });
  if (!result.ok) throw new Error(`splice failed: ${result.reason}`);
  return applySplicesToSource(source, result.splices);
}

describe('scanOpenTag', () => {
  it('parses a simple tag with no attrs', () => {
    const t = scanOpenTag('<p>hello</p>', 0)!;
    expect(t.tagName).toBe('p');
    expect(t.closeBracket).toBe(2);
    expect(t.attrs).toEqual([]);
    expect(t.selfClosing).toBe(false);
  });

  it('parses double-quoted attrs', () => {
    const src = '<div class="lead" id="hero">';
    const t = scanOpenTag(src, 0)!;
    expect(t.attrs.map((a) => [a.name, a.rawValue])).toEqual([
      ['class', 'lead'],
      ['id', 'hero'],
    ]);
    expect(t.attrs[0].quote).toBe('"');
  });

  it('parses single-quoted, unquoted, and bare attrs', () => {
    const src = "<input type='text' name=foo disabled>";
    const t = scanOpenTag(src, 0)!;
    expect(t.attrs.map((a) => [a.name, a.rawValue, a.quote])).toEqual([
      ['type', 'text', "'"],
      ['name', 'foo', ''],
      ['disabled', null, ''],
    ]);
  });

  it('handles self-closing', () => {
    const src = '<br/>';
    const t = scanOpenTag(src, 0)!;
    expect(t.selfClosing).toBe(true);
  });

  it('returns null on malformed open', () => {
    expect(scanOpenTag('<', 0)).toBeNull();
    expect(scanOpenTag('<>', 0)).toBeNull();
    expect(scanOpenTag('<unclosed attr="v', 0)).toBeNull();
  });
});

describe('computeAttrEditSplices', () => {
  it('replaces an existing quoted attribute value preserving quote style', () => {
    const src = '<div style="color: red" id="x">hi</div>';
    const after = applyAt(src, 0, { style: 'color: blue' });
    expect(after).toBe('<div style="color: blue" id="x">hi</div>');
  });

  it('preserves single-quote style when the value is safe', () => {
    const src = "<div style='color: red'>hi</div>";
    const after = applyAt(src, 0, { style: 'color: blue' });
    expect(after).toBe("<div style='color: blue'>hi</div>");
  });

  it('upgrades to double quotes when the new value contains the existing quote char', () => {
    const src = "<div style='color: red'>hi</div>";
    const after = applyAt(src, 0, { style: "background: url('a.png')" });
    expect(after).toBe(`<div style="background: url('a.png')">hi</div>`);
  });

  it('encodes special characters in attribute values', () => {
    const src = '<a title="x">go</a>';
    const after = applyAt(src, 0, { title: 'a & b "c"' });
    expect(after).toBe('<a title="a &amp; b &quot;c&quot;">go</a>');
  });

  it('inserts a missing attribute before the closing >', () => {
    const src = '<div id="x">hi</div>';
    const after = applyAt(src, 0, { style: 'padding: 8px' });
    expect(after).toBe('<div id="x" style="padding: 8px">hi</div>');
  });

  it('removes an attribute including the leading whitespace separator', () => {
    const src = '<div class="foo" style="padding: 8px" id="x">hi</div>';
    const after = applyAt(src, 0, { style: null });
    expect(after).toBe('<div class="foo" id="x">hi</div>');
  });

  it('removes the first attribute cleanly', () => {
    const src = '<div class="foo" id="x">hi</div>';
    const after = applyAt(src, 0, { class: null });
    expect(after).toBe('<div id="x">hi</div>');
  });

  it('mixes set / insert / remove in one commit', () => {
    const src = '<div class="foo" id="x" data-keep="yes">hi</div>';
    const after = applyAt(src, 0, {
      class: null,
      style: 'color: red',
      id: 'y',
    });
    expect(after).toBe('<div id="y" data-keep="yes" style="color: red">hi</div>');
  });

  it('is idempotent for unchanged values', () => {
    const src = '<div style="color: red">hi</div>';
    const result = computeAttrEditSplices({
      source: src,
      elementStart: 0,
      attrs: { style: 'color: red' },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.splices).toEqual([]);
  });

  it('preserves bytes outside the opening tag verbatim', () => {
    const src = '<!doctype html>\n<html><body>\n  <div style="a: 1">hi</div>\n  <p>x</p>\n</body></html>';
    const start = src.indexOf('<div');
    const after = applyAt(src, start, { style: 'a: 2' });
    expect(after).toBe(
      '<!doctype html>\n<html><body>\n  <div style="a: 2">hi</div>\n  <p>x</p>\n</body></html>',
    );
  });

  it('handles tags with extra whitespace around attributes', () => {
    const src = '<div   style = "a: 1"   id="x"  >hi</div>';
    const after = applyAt(src, 0, { style: 'a: 2' });
    expect(after).toBe('<div   style = "a: 2"   id="x"  >hi</div>');
  });

  it('handles a self-closing tag', () => {
    const src = '<br class="x"/>';
    const after = applyAt(src, 0, { class: 'y' });
    expect(after).toBe('<br class="y"/>');
  });

  it('inserts before the / in a self-closing tag', () => {
    const src = '<br/>';
    const after = applyAt(src, 0, { class: 'y' });
    expect(after).toBe('<br class="y"/>');
  });

  it('returns bad-tag when the element offset does not point at <', () => {
    const r = computeAttrEditSplices({ source: 'abc', elementStart: 0, attrs: { x: 'y' } });
    expect(r.ok).toBe(false);
  });

  it('matches attribute names case-insensitively', () => {
    const src = '<div STYLE="a: 1">hi</div>';
    const after = applyAt(src, 0, { style: 'a: 2' });
    expect(after).toBe('<div STYLE="a: 2">hi</div>');
  });
});
