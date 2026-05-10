import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_INLINE_TAGS,
  isSafeUrl,
  sanitizeBlockHtml,
} from '../src/host/sanitizeBlockHtml';

describe('sanitizeBlockHtml', () => {
  it('preserves plain text untouched', () => {
    expect(sanitizeBlockHtml('hello world')).toBe('hello world');
  });

  it('keeps allowlisted inline tags', () => {
    expect(sanitizeBlockHtml('<strong>bold</strong>')).toBe('<strong>bold</strong>');
    expect(sanitizeBlockHtml('<em>e</em>')).toBe('<em>e</em>');
    expect(sanitizeBlockHtml('<u>u</u><s>s</s><code>c</code>')).toBe(
      '<u>u</u><s>s</s><code>c</code>',
    );
  });

  it('unwraps disallowed tags but keeps their text', () => {
    expect(sanitizeBlockHtml('<font color="red">hi</font>')).toBe('hi');
    expect(sanitizeBlockHtml('<div>x</div>')).toBe('x');
  });

  it('strips script tags entirely (children unwrapped, no execution risk)', () => {
    // <script> contents are parsed as raw text by parse5; unwrapping leaves the
    // string. The sanitizer's job is to remove the tag — the host then escapes
    // when writing, so even leftover text can't execute.
    const out = sanitizeBlockHtml('<script>alert(1)</script>safe');
    expect(out).not.toContain('<script');
    expect(out).toContain('safe');
  });

  it('drops data attrs by default (e.g. host-injected element ids)', () => {
    expect(
      sanitizeBlockHtml('<strong data-html-wysiwyg-id="42">x</strong>'),
    ).toBe('<strong>x</strong>');
  });

  it('drops style/class/id/event-handler attributes', () => {
    const input = '<a href="/x" style="color:red" class="c" id="i" onclick="x()">link</a>';
    const out = sanitizeBlockHtml(input);
    expect(out).toContain('href="/x"');
    expect(out).not.toContain('style');
    expect(out).not.toContain('class');
    expect(out).not.toContain(' id=');
    expect(out).not.toContain('onclick');
  });

  it('keeps href on <a> but blanks unsafe schemes', () => {
    expect(sanitizeBlockHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a href="">x</a>',
    );
    expect(sanitizeBlockHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com">x</a>',
    );
    expect(sanitizeBlockHtml('<a href="/foo">x</a>')).toBe('<a href="/foo">x</a>');
    expect(sanitizeBlockHtml('<a href="mailto:a@b.c">x</a>')).toBe(
      '<a href="mailto:a@b.c">x</a>',
    );
  });

  it('handles nested allowed tags (bold inside italic)', () => {
    expect(sanitizeBlockHtml('<em>a<strong>b</strong>c</em>')).toBe(
      '<em>a<strong>b</strong>c</em>',
    );
  });

  it('unwraps disallowed wrapper but keeps allowed children', () => {
    expect(sanitizeBlockHtml('<font><strong>hi</strong></font>')).toBe(
      '<strong>hi</strong>',
    );
  });

  it('respects custom allowedTags', () => {
    const out = sanitizeBlockHtml('<strong>x</strong><em>y</em>', {
      allowedTags: new Set(['strong']),
    });
    expect(out).toBe('<strong>x</strong>y');
  });

  it('handles <br> as a void element', () => {
    expect(sanitizeBlockHtml('a<br>b')).toBe('a<br>b');
  });

  it('default allowlist includes the canonical inline set', () => {
    for (const tag of ['strong', 'em', 'b', 'i', 'u', 's', 'code', 'a', 'br', 'span']) {
      expect(DEFAULT_ALLOWED_INLINE_TAGS.has(tag)).toBe(true);
    }
  });
});

describe('isSafeUrl', () => {
  it('allows http/https/mailto/tel', () => {
    expect(isSafeUrl('http://x')).toBe(true);
    expect(isSafeUrl('https://x')).toBe(true);
    expect(isSafeUrl('mailto:a@b')).toBe(true);
    expect(isSafeUrl('tel:+1')).toBe(true);
  });
  it('allows relative urls and anchors', () => {
    expect(isSafeUrl('/foo')).toBe(true);
    expect(isSafeUrl('./foo')).toBe(true);
    expect(isSafeUrl('#anchor')).toBe(true);
    expect(isSafeUrl('?q=1')).toBe(true);
    expect(isSafeUrl('foo/bar')).toBe(true);
    expect(isSafeUrl('')).toBe(true);
  });
  it('rejects javascript: and similar', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeUrl(' javascript:x')).toBe(false);
    expect(isSafeUrl('vbscript:x')).toBe(false);
    expect(isSafeUrl('data:text/html,<x>')).toBe(false);
  });
});
