import { describe, expect, it } from 'vitest';
import { computeCssDeclarationSplice } from '../src/host/computeCssDeclarationSplice';

function apply(source: string, splices: { startOffset: number; endOffset: number; replacement: string }[]): string {
  const sorted = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  let out = source;
  for (const s of sorted) {
    out = out.slice(0, s.startOffset) + s.replacement + out.slice(s.endOffset);
  }
  return out;
}

describe('computeCssDeclarationSplice', () => {
  it('replaces an existing declaration value, preserving whitespace', () => {
    const source = [
      '<html><head><style>',
      '  .primary {',
      '    padding: 8px;',
      '    color: red;',
      '  }',
      '</style></head></html>',
    ].join('\n');
    const r = computeCssDeclarationSplice({
      source,
      selector: '.primary',
      property: 'padding',
      value: '12px',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(source, r.splices);
    expect(next).toContain('padding: 12px;');
    expect(next).toContain('color: red;');
  });

  it('is idempotent when value is unchanged', () => {
    const source = '<style>.x{padding:4px;}</style>';
    const r = computeCssDeclarationSplice({
      source,
      selector: '.x',
      property: 'padding',
      value: '4px',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-op');
  });

  it('inserts a new declaration before the rule close, indented to match', () => {
    const source = [
      '<style>',
      '.card {',
      '  padding: 8px;',
      '}',
      '</style>',
    ].join('\n');
    const r = computeCssDeclarationSplice({
      source,
      selector: '.card',
      property: 'margin',
      value: '4px',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(source, r.splices);
    expect(next).toMatch(/padding: 8px;\n {2}margin: 4px;\n}/);
  });

  it('removes a declaration when value is null', () => {
    const source = [
      '<style>',
      '.x {',
      '  padding: 8px;',
      '  color: red;',
      '}',
      '</style>',
    ].join('\n');
    const r = computeCssDeclarationSplice({
      source,
      selector: '.x',
      property: 'padding',
      value: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(source, r.splices);
    expect(next).not.toContain('padding');
    expect(next).toContain('color: red;');
  });

  it('skips rules nested inside @media (v1: not editable)', () => {
    const source = [
      '<style>',
      '@media (max-width: 800px) {',
      '  .primary { padding: 4px; }',
      '}',
      '.primary { padding: 8px; }',
      '</style>',
    ].join('\n');
    const r = computeCssDeclarationSplice({
      source,
      selector: '.primary',
      property: 'padding',
      value: '12px',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(source, r.splices);
    // The @media inner rule must stay as-is; only the outer rule edits.
    expect(next).toContain('@media (max-width: 800px) {\n  .primary { padding: 4px; }');
    expect(next).toContain('.primary { padding: 12px; }');
  });

  it('returns no-rule when selector is absent', () => {
    const source = '<style>.a{padding:1px;}</style>';
    const r = computeCssDeclarationSplice({
      source,
      selector: '.missing',
      property: 'padding',
      value: '4px',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-rule');
  });

  it('returns no-style-block when no <style> tag is present', () => {
    const source = '<div></div>';
    const r = computeCssDeclarationSplice({
      source,
      selector: '.x',
      property: 'padding',
      value: '4px',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-style-block');
  });

  it('handles strings and comments inside declaration values without confusion', () => {
    const source = [
      '<style>',
      '.x {',
      "  content: \"a; b: c\"; /* tricky */",
      '  padding: 8px;',
      '}',
      '</style>',
    ].join('\n');
    const r = computeCssDeclarationSplice({
      source,
      selector: '.x',
      property: 'padding',
      value: '12px',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(source, r.splices);
    expect(next).toContain('content: "a; b: c"');
    expect(next).toContain('padding: 12px;');
  });

  it('edits the rule in the first <style> block that contains it', () => {
    const source = [
      '<style>.x { padding: 1px; }</style>',
      '<style>.x { padding: 2px; }</style>',
    ].join('\n');
    const r = computeCssDeclarationSplice({
      source,
      selector: '.x',
      property: 'padding',
      value: '9px',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next = apply(source, r.splices);
    expect(next).toContain('.x { padding: 9px; }</style>\n<style>.x { padding: 2px; }');
  });
});
