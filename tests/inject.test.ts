import { describe, expect, it } from 'vitest';
import { walkEditable } from '../src/host/parse/walkEditable';
import { injectElementIds, injectInstrumentation } from '../src/host/server/inject';
import type { FileMeta, OffsetMap } from '../src/shared/protocol';

const FILE_META: FileMeta = { type: 'fileMeta', path: 'x.html', isTemplated: false };

describe('injectElementIds', () => {
  it('returns html unchanged when offsetMap is null', () => {
    const html = '<!doctype html><html><body><p>x</p></body></html>';
    expect(injectElementIds(html, null)).toBe(html);
  });

  it('returns html unchanged when there are no elements', () => {
    const html = 'no elements';
    const empty: OffsetMap = {
      type: 'offsetMap',
      documentVersion: 1,
      elements: [],
      blocks: [],
      textNodes: [],
    };
    expect(injectElementIds(html, empty)).toBe(html);
  });

  it('inserts data-html-wysiwyg-id immediately after each tag name', () => {
    const html = '<!doctype html><html><body><p>x</p></body></html>';
    const map = walkEditable(html, 1);
    const out = injectElementIds(html, map);
    expect(out).toContain('<p data-html-wysiwyg-id="0">x</p>');
  });

  it('preserves bytes outside the inserted attributes (only adds expected length)', () => {
    const html = '<!doctype html><html><body><h1>A</h1><p>B</p></body></html>';
    const map = walkEditable(html, 1);
    const out = injectElementIds(html, map);
    const expectedAdded = map.elements.reduce(
      (sum, e) => sum + ` data-html-wysiwyg-id="${e.elementId}"`.length,
      0,
    );
    expect(out.length).toBe(html.length + expectedAdded);
    // Strip injected attrs and assert original text is recovered.
    const stripped = out.replace(/ data-html-wysiwyg-id="\d+"/g, '');
    expect(stripped).toBe(html);
  });

  it('handles existing attributes on the tag without disturbing them', () => {
    const html =
      '<!doctype html><html><body><a href="x" class="y">link</a></body></html>';
    const map = walkEditable(html, 1);
    const out = injectElementIds(html, map);
    expect(out).toContain('<a data-html-wysiwyg-id="0" href="x" class="y">');
  });

  it('handles void / self-closing tags', () => {
    const html =
      '<!doctype html><html><body><hr><img src="a.png"/></body></html>';
    const map = walkEditable(html, 1);
    const out = injectElementIds(html, map);
    expect(out).toContain('<hr data-html-wysiwyg-id="');
    expect(out).toContain('<img data-html-wysiwyg-id="');
  });

  it('handles many adjacent elements correctly (no offset corruption)', () => {
    const html =
      '<!doctype html><html><body>' +
      '<p>1</p><p>2</p><p>3</p><p>4</p><p>5</p>' +
      '</body></html>';
    const map = walkEditable(html, 1);
    const out = injectElementIds(html, map);
    // Each <p>N</p> should be tagged with a sequential id and N preserved.
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`<p data-html-wysiwyg-id="${i}">${i + 1}</p>`);
    }
  });

  it('skips elements with invalid offsets', () => {
    const html = '<p>x</p>';
    const bogus: OffsetMap = {
      type: 'offsetMap',
      documentVersion: 1,
      elements: [{ elementId: 0, tagName: 'p', startOffset: 10, endOffset: 5 }],
      blocks: [],
      textNodes: [],
    };
    expect(injectElementIds(html, bogus)).toBe(html);
  });
});

describe('injectInstrumentation', () => {
  it('inserts before </body>', () => {
    const html = '<!doctype html><html><body><p>x</p></body></html>';
    const out = injectInstrumentation(html, { offsetMap: null, fileMeta: FILE_META });
    const bodyIdx = out.indexOf('</body>');
    const runtimeIdx = out.indexOf('/__edit/runtime.js');
    expect(runtimeIdx).toBeGreaterThan(0);
    expect(runtimeIdx).toBeLessThan(bodyIdx);
  });

  it('falls back to </html> when there is no body', () => {
    const html = '<!doctype html><html><div>x</div></html>';
    const out = injectInstrumentation(html, { offsetMap: null, fileMeta: FILE_META });
    expect(out.indexOf('/__edit/runtime.js')).toBeLessThan(out.indexOf('</html>'));
  });

  it('appends when neither </body> nor </html> is present', () => {
    const html = '<div>x</div>';
    const out = injectInstrumentation(html, { offsetMap: null, fileMeta: FILE_META });
    expect(out.startsWith(html)).toBe(true);
    expect(out).toContain('/__edit/runtime.js');
  });

  it('escapes </ inside the JSON payload so it cannot break out of the script tag', () => {
    const meta: FileMeta = { type: 'fileMeta', path: '</script><b>x</b>', isTemplated: false };
    const out = injectInstrumentation('<html><body></body></html>', {
      offsetMap: null,
      fileMeta: meta,
    });
    // The literal "</script>" must NOT appear inside the init script payload —
    // it should be escaped as <\/script>.
    const initScriptStart = out.indexOf('window.__HTML_WYSIWYG__');
    const initScriptEnd = out.indexOf('</script>', initScriptStart);
    const payload = out.slice(initScriptStart, initScriptEnd);
    expect(payload).not.toContain('</script>');
    expect(payload).toContain('<\\/script>');
  });
});
