import { describe, expect, it } from 'vitest';
import { computeEdits } from '../src/iframe/diff';

describe('computeEdits', () => {
  it('returns no edits when before === after', () => {
    expect(computeEdits([10, 11, 12], ['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('emits one edit per changed text node, keyed by id', () => {
    const edits = computeEdits([10, 11, 12], ['a', 'b', 'c'], ['a', 'B', 'c']);
    expect(edits).toEqual([{ nodeId: 11, newText: 'B' }]);
  });

  it('caps at the length of the shortest input array (defensive against snapshot drift)', () => {
    const edits = computeEdits([10, 11], ['a', 'b'], ['a', 'B', 'extra']);
    expect(edits).toEqual([{ nodeId: 11, newText: 'B' }]);
  });

  it('emits edits in input order', () => {
    const edits = computeEdits([10, 11, 12], ['a', 'b', 'c'], ['A', 'B', 'C']);
    expect(edits.map((e) => e.nodeId)).toEqual([10, 11, 12]);
  });
});
