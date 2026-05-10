import { describe, expect, it } from 'vitest';
import {
  EMPTY_FORMAT_STATE,
  isLinkUrlSafe,
  queryFormatStateForElement,
  tagToFormatName,
  type AncestorNode,
} from '../src/iframe/toolbar/formatHelpers';

describe('isLinkUrlSafe', () => {
  it('accepts http/https/mailto/tel and relative URLs', () => {
    expect(isLinkUrlSafe('https://example.com')).toBe(true);
    expect(isLinkUrlSafe('http://example.com')).toBe(true);
    expect(isLinkUrlSafe('mailto:a@b.c')).toBe(true);
    expect(isLinkUrlSafe('tel:+123')).toBe(true);
    expect(isLinkUrlSafe('/relative')).toBe(true);
    expect(isLinkUrlSafe('#anchor')).toBe(true);
    expect(isLinkUrlSafe('')).toBe(true);
  });
  it('rejects javascript:/data:/vbscript:', () => {
    expect(isLinkUrlSafe('javascript:alert(1)')).toBe(false);
    expect(isLinkUrlSafe('JAVASCRIPT:x')).toBe(false);
    expect(isLinkUrlSafe('data:text/html,x')).toBe(false);
    expect(isLinkUrlSafe('vbscript:x')).toBe(false);
  });
});

/**
 * Build a fake ancestor chain. The last entry is the boundary; the first is
 * the leaf "selection anchor". Each node's parentNode points to the next.
 */
function chain(...tags: string[]): { leaf: AncestorNode; boundary: AncestorNode } {
  const nodes: AncestorNode[] = tags.map((t) => ({ tagName: t, parentNode: null }));
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].parentNode = nodes[i + 1];
  }
  return { leaf: nodes[0], boundary: nodes[nodes.length - 1] };
}

describe('tagToFormatName', () => {
  it('maps semantic and presentational variants to canonical formats', () => {
    expect(tagToFormatName('strong')).toBe('bold');
    expect(tagToFormatName('B')).toBe('bold');
    expect(tagToFormatName('em')).toBe('italic');
    expect(tagToFormatName('I')).toBe('italic');
    expect(tagToFormatName('u')).toBe('underline');
    expect(tagToFormatName('s')).toBe('strike');
    expect(tagToFormatName('strike')).toBe('strike');
    expect(tagToFormatName('del')).toBe('strike');
    expect(tagToFormatName('code')).toBe('code');
  });

  it('returns null for unrelated tags', () => {
    expect(tagToFormatName('span')).toBeNull();
    expect(tagToFormatName('p')).toBeNull();
    expect(tagToFormatName('')).toBeNull();
  });
});

describe('queryFormatStateForElement', () => {
  it('returns all-false when there are no formatting ancestors', () => {
    const { leaf, boundary } = chain('span', 'p');
    expect(queryFormatStateForElement(leaf, boundary)).toEqual(EMPTY_FORMAT_STATE);
  });

  it('detects a single format wrapping ancestor', () => {
    const { leaf, boundary } = chain('strong', 'p');
    const state = queryFormatStateForElement(leaf, boundary);
    expect(state.bold).toBe(true);
    expect(state.italic).toBe(false);
  });

  it('detects nested formats', () => {
    const { leaf, boundary } = chain('em', 'strong', 'p');
    const state = queryFormatStateForElement(leaf, boundary);
    expect(state.bold).toBe(true);
    expect(state.italic).toBe(true);
  });

  it('does not look past the boundary', () => {
    // <strong> sits OUTSIDE the boundary <p>. Should not register.
    const { leaf, boundary } = chain('span', 'p');
    boundary.parentNode = { tagName: 'strong', parentNode: null };
    const state = queryFormatStateForElement(leaf, boundary);
    expect(state.bold).toBe(false);
  });

  it('handles every supported format', () => {
    const { leaf, boundary } = chain('code', 'u', 's', 'em', 'strong', 'p');
    const state = queryFormatStateForElement(leaf, boundary);
    expect(state).toEqual({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      code: true,
    });
  });

  it('treats null leaf as empty state', () => {
    const { boundary } = chain('p');
    expect(queryFormatStateForElement(null, boundary)).toEqual(EMPTY_FORMAT_STATE);
  });
});
