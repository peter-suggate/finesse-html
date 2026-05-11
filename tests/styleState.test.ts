import { describe, expect, it } from 'vitest';
import {
  attrsForStyleMap,
  parseStyleAttr,
  serialiseStyleAttr,
  withProperties,
  withProperty,
} from '../src/webview/stylePanel/styleState';

describe('parseStyleAttr', () => {
  it('parses an empty / null value to an empty map', () => {
    expect(parseStyleAttr(null).size).toBe(0);
    expect(parseStyleAttr('').size).toBe(0);
  });

  it('parses simple declarations', () => {
    const m = parseStyleAttr('color: red; padding: 8px');
    expect(m.get('color')).toBe('red');
    expect(m.get('padding')).toBe('8px');
  });

  it('lowercases property names but preserves value casing', () => {
    const m = parseStyleAttr('COLOR: Red; Background-Color: #FFF');
    expect(m.get('color')).toBe('Red');
    expect(m.get('background-color')).toBe('#FFF');
  });

  it('survives extra whitespace and trailing semicolons', () => {
    const m = parseStyleAttr('  color :  red ;  padding: 8px ;  ');
    expect(m.get('color')).toBe('red');
    expect(m.get('padding')).toBe('8px');
    expect(m.size).toBe(2);
  });

  it('preserves declaration order on round-trip', () => {
    const src = 'color: red; padding: 8px; margin: 4px';
    const round = serialiseStyleAttr(parseStyleAttr(src));
    expect(round).toBe('color: red; padding: 8px; margin: 4px');
  });
});

describe('withProperty / withProperties', () => {
  it('sets a new property at the end', () => {
    const m = parseStyleAttr('color: red');
    const next = withProperty(m, 'padding', '8px');
    expect(serialiseStyleAttr(next)).toBe('color: red; padding: 8px');
  });

  it('updates in-place without changing order', () => {
    const m = parseStyleAttr('color: red; padding: 8px');
    const next = withProperty(m, 'color', 'blue');
    expect(serialiseStyleAttr(next)).toBe('color: blue; padding: 8px');
  });

  it('removes when value is null or empty', () => {
    const m = parseStyleAttr('color: red; padding: 8px');
    expect(serialiseStyleAttr(withProperty(m, 'color', null))).toBe('padding: 8px');
    expect(serialiseStyleAttr(withProperty(m, 'color', ''))).toBe('padding: 8px');
  });

  it('does not mutate the original map', () => {
    const m = parseStyleAttr('color: red');
    withProperty(m, 'color', 'blue');
    expect(serialiseStyleAttr(m)).toBe('color: red');
  });

  it('applies many properties in one call', () => {
    const m = parseStyleAttr('color: red');
    const next = withProperties(m, { color: 'blue', padding: '8px', display: null });
    expect(serialiseStyleAttr(next)).toBe('color: blue; padding: 8px');
  });
});

describe('attrsForStyleMap', () => {
  it('emits a string when there are declarations', () => {
    const m = parseStyleAttr('color: red');
    expect(attrsForStyleMap(m)).toEqual({ style: 'color: red' });
  });

  it('emits null when the map is empty (so the host removes the attribute)', () => {
    const m = parseStyleAttr('');
    expect(attrsForStyleMap(m)).toEqual({ style: null });
  });
});
