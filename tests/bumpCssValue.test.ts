import { describe, expect, it } from 'vitest';
import { bumpCssValue, bumpStep } from '../src/webview/stylePanel/bumpCssValue';

describe('bumpCssValue', () => {
  it('bumps px integers up and down', () => {
    expect(bumpCssValue('12px', 1)).toBe('13px');
    expect(bumpCssValue('12px', -1)).toBe('11px');
    expect(bumpCssValue('12px', 10)).toBe('22px');
  });

  it('bumps em with decimal precision', () => {
    expect(bumpCssValue('1.5em', 0.1)).toBe('1.6em');
    expect(bumpCssValue('1.5em', 1)).toBe('2.5em');
    expect(bumpCssValue('1.5em', -0.1)).toBe('1.4em');
  });

  it('preserves the unit for %, vh, vw, fr, rem, deg', () => {
    expect(bumpCssValue('50%', 1)).toBe('51%');
    expect(bumpCssValue('10vh', 1)).toBe('11vh');
    expect(bumpCssValue('80vw', -5)).toBe('75vw');
    expect(bumpCssValue('1fr', 1)).toBe('2fr');
    expect(bumpCssValue('1.25rem', 0.25)).toBe('1.5rem');
    expect(bumpCssValue('45deg', 15)).toBe('60deg');
  });

  it('handles unitless numbers (line-height, opacity, etc.)', () => {
    expect(bumpCssValue('1.2', 0.1)).toBe('1.3');
    expect(bumpCssValue('0', 1)).toBe('1');
    expect(bumpCssValue('1', -1)).toBe('0');
  });

  it('handles negative numbers', () => {
    expect(bumpCssValue('-4px', 1)).toBe('-3px');
    expect(bumpCssValue('-1px', -1)).toBe('-2px');
    expect(bumpCssValue('-0.5em', 0.1)).toBe('-0.4em');
  });

  it('returns null for keywords and color values', () => {
    expect(bumpCssValue('auto', 1)).toBeNull();
    expect(bumpCssValue('none', 1)).toBeNull();
    expect(bumpCssValue('inherit', 1)).toBeNull();
    expect(bumpCssValue('#4cb6ff', 1)).toBeNull();
    expect(bumpCssValue('rgb(255, 0, 0)', 1)).toBeNull();
  });

  it('returns null for shorthand multi-value declarations', () => {
    expect(bumpCssValue('8px 4px', 1)).toBeNull();
    expect(bumpCssValue('1px solid black', 1)).toBeNull();
    expect(bumpCssValue('flex-start', 1)).toBeNull();
  });

  it('returns null for calc() / var() / clamp() values', () => {
    expect(bumpCssValue('calc(100% - 4px)', 1)).toBeNull();
    expect(bumpCssValue('var(--bg)', 1)).toBeNull();
    expect(bumpCssValue('clamp(8px, 1vw, 16px)', 1)).toBeNull();
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(bumpCssValue('', 1)).toBeNull();
    expect(bumpCssValue('   ', 1)).toBeNull();
  });

  it('returns null for malformed numeric tokens', () => {
    // A bare decimal point isn't a number.
    expect(bumpCssValue('.', 1)).toBeNull();
    expect(bumpCssValue('px', 1)).toBeNull();
    expect(bumpCssValue('1.2.3em', 1)).toBeNull();
  });

  it('trims trailing zeros from floating-point results', () => {
    // 1.2 + 0.1 = 1.3000000000000003 in IEEE-754; we should still return "1.3".
    expect(bumpCssValue('1.2em', 0.1)).toBe('1.3em');
    expect(bumpCssValue('0.1em', 0.1)).toBe('0.2em');
  });

  it('caps decimal places to avoid noise', () => {
    // 0.1 + 0.2 = 0.30000000000000004 — must render as 0.3.
    expect(bumpCssValue('0.1', 0.2)).toBe('0.3');
  });

  it('tolerates leading/trailing whitespace in the input', () => {
    expect(bumpCssValue('  12px  ', 1)).toBe('13px');
  });
});

describe('bumpStep', () => {
  it('returns 1 by default', () => {
    expect(bumpStep({})).toBe(1);
  });
  it('returns 10 when shift is held', () => {
    expect(bumpStep({ shift: true })).toBe(10);
  });
  it('returns 0.1 when alt is held', () => {
    expect(bumpStep({ alt: true })).toBe(0.1);
  });
  it('prefers shift over alt when both are held', () => {
    expect(bumpStep({ shift: true, alt: true })).toBe(10);
  });
});
