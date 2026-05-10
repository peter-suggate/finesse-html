import { describe, expect, it } from 'vitest';
import {
  computeInverseSplices,
  UndoStack,
  type SpliceOp,
  type UndoEntry,
} from '../src/host/undoStack';

function entry(forward: SpliceOp[], sourceBefore: string, vBefore: number): UndoEntry {
  return {
    forward,
    inverse: computeInverseSplices(sourceBefore, forward),
    versionBefore: vBefore,
    versionAfter: vBefore + 1,
  };
}

function applySplices(source: string, splices: readonly SpliceOp[]): string {
  // Right-to-left so leading offsets stay valid.
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  let out = source;
  for (const s of ordered) {
    out = out.slice(0, s.startOffset) + s.replacement + out.slice(s.endOffset);
  }
  return out;
}

describe('UndoStack', () => {
  it('starts empty', () => {
    const s = new UndoStack();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.popUndo()).toBeNull();
    expect(s.popRedo()).toBeNull();
  });

  it('push records an entry on the undo branch and clears redo', () => {
    const s = new UndoStack();
    const e1 = entry([{ startOffset: 0, endOffset: 1, replacement: 'x' }], 'a', 0);
    s.push(e1);
    expect(s.size()).toEqual({ undo: 1, redo: 0 });

    const popped = s.popUndo()!;
    s.pushRedo(popped);
    expect(s.size()).toEqual({ undo: 0, redo: 1 });

    // A fresh push must wipe the redo branch.
    const e2 = entry([{ startOffset: 0, endOffset: 1, replacement: 'y' }], 'a', 0);
    s.push(e2);
    expect(s.size()).toEqual({ undo: 1, redo: 0 });
  });

  it('clear() empties both branches', () => {
    const s = new UndoStack();
    s.push(entry([{ startOffset: 0, endOffset: 0, replacement: 'a' }], '', 0));
    s.pushRedo(entry([{ startOffset: 0, endOffset: 0, replacement: 'b' }], '', 0));
    s.clear();
    expect(s.size()).toEqual({ undo: 0, redo: 0 });
  });
});

describe('computeInverseSplices + round-trip', () => {
  it('inverse of a single replace round-trips', () => {
    const before = 'Hello world';
    const forward: SpliceOp[] = [
      { startOffset: 6, endOffset: 11, replacement: 'there' },
    ];
    const after = applySplices(before, forward);
    expect(after).toBe('Hello there');

    const inverse = computeInverseSplices(before, forward);
    const reverted = applySplices(after, inverse);
    expect(reverted).toBe(before);
  });

  it('inverse of multiple non-overlapping replaces round-trips', () => {
    const before = 'one two three';
    const forward: SpliceOp[] = [
      { startOffset: 0, endOffset: 3, replacement: 'ONE' },
      { startOffset: 4, endOffset: 7, replacement: 'TWO' },
      { startOffset: 8, endOffset: 13, replacement: 'THREE' },
    ];
    const after = applySplices(before, forward);
    expect(after).toBe('ONE TWO THREE');

    const inverse = computeInverseSplices(before, forward);
    const reverted = applySplices(after, inverse);
    expect(reverted).toBe(before);
  });

  it('inverse handles different-length replacements (insert/delete)', () => {
    const before = 'abc def';
    const forward: SpliceOp[] = [
      { startOffset: 0, endOffset: 3, replacement: 'AB' }, // shrink
      { startOffset: 4, endOffset: 7, replacement: 'DEFGH' }, // grow
    ];
    const after = applySplices(before, forward);
    expect(after).toBe('AB DEFGH');

    const inverse = computeInverseSplices(before, forward);
    const reverted = applySplices(after, inverse);
    expect(reverted).toBe(before);
  });

  it('repeated undo/redo cycles preserve the document exactly', () => {
    const v0 = '<p>one</p><p>two</p>';
    const fwd: SpliceOp[] = [
      { startOffset: 3, endOffset: 6, replacement: 'ONE' },
    ];
    const inv = computeInverseSplices(v0, fwd);
    const v1 = applySplices(v0, fwd);

    // 5 round trips
    let cur = v0;
    for (let i = 0; i < 5; i++) {
      cur = applySplices(cur, fwd);
      expect(cur).toBe(v1);
      cur = applySplices(cur, inv);
      expect(cur).toBe(v0);
    }
  });
});
