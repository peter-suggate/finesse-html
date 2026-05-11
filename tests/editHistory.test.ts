import { describe, expect, it } from 'vitest';
import {
  createEditTransaction,
  EditHistory,
  hashText,
  type EditTransaction,
} from '../src/host/editHistory';
import type { SpliceOp } from '../src/host/undoStack';

function applySplices(source: string, splices: readonly SpliceOp[]): string {
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  let out = source;
  for (const s of ordered) {
    out = out.slice(0, s.startOffset) + s.replacement + out.slice(s.endOffset);
  }
  return out;
}

function transaction(
  id: string,
  sourceBefore: string,
  forward: readonly SpliceOp[],
): EditTransaction {
  const versionBefore = Number(id.slice(1));
  return createEditTransaction({
    id,
    label: `Edit ${id}`,
    sourceBefore,
    sourceAfter: applySplices(sourceBefore, forward),
    forward,
    versionBefore,
    versionAfter: versionBefore + 1,
  });
}

describe('EditHistory', () => {
  it('records transactions on the undo branch and ignores empty edits', () => {
    const history = new EditHistory();

    expect(history.record(transaction('t1', 'abc', []))).toBe(false);
    expect(history.state()).toEqual({
      undo: 0,
      redo: 0,
      conflicted: false,
      conflictReason: null,
    });

    expect(
      history.record(
        transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]),
      ),
    ).toBe(true);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(history.state()).toMatchObject({ undo: 1, redo: 0 });
  });

  it('committed undo and redo move transactions between stacks', () => {
    const history = new EditHistory();
    const t1 = transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]);
    const t2 = transaction('t2', 'aBc', [{ startOffset: 2, endOffset: 3, replacement: 'C' }]);
    history.record(t1);
    history.record(t2);

    const undo = history.beginUndo();
    expect(undo?.kind).toBe('undo');
    expect(undo?.transaction).toBe(t2);
    expect(undo?.splices).toBe(t2.inverse);
    expect(history.state()).toMatchObject({ undo: 2, redo: 0 });

    undo?.commit();
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(true);
    expect(history.state()).toMatchObject({ undo: 1, redo: 1 });

    const redo = history.beginRedo();
    expect(redo?.kind).toBe('redo');
    expect(redo?.transaction).toBe(t2);
    expect(redo?.splices).toBe(t2.forward);
    redo?.commit();

    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(history.state()).toMatchObject({ undo: 2, redo: 0 });
  });

  it('new transactions clear the redo branch', () => {
    const history = new EditHistory();
    history.record(transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]));
    history.beginUndo()?.commit();
    expect(history.state()).toMatchObject({ undo: 0, redo: 1 });

    history.record(transaction('t2', 'abc', [{ startOffset: 2, endOffset: 3, replacement: 'C' }]));
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(history.state()).toMatchObject({ undo: 1, redo: 0 });
  });

  it('conflict disables undo and redo without discarding history', () => {
    const history = new EditHistory();
    history.record(transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]));
    history.beginUndo()?.commit();

    history.markExternalConflict('external-disk-change');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.beginUndo()).toBeNull();
    expect(history.beginRedo()).toBeNull();
    expect(
      history.record(
        transaction('t2', 'abc', [{ startOffset: 2, endOffset: 3, replacement: 'C' }]),
      ),
    ).toBe(false);
    expect(history.state()).toEqual({
      undo: 0,
      redo: 1,
      conflicted: true,
      conflictReason: 'external-disk-change',
    });
  });

  it('aborted manual operations preserve stack state', () => {
    const history = new EditHistory();
    const tx = transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]);
    history.record(tx);

    const beforeUndoAbort = history.state();
    const undo = history.beginUndo();
    expect(undo?.transaction).toBe(tx);
    undo?.abort();
    expect(history.state()).toEqual(beforeUndoAbort);

    history.beginUndo()?.commit();
    const beforeRedoAbort = history.state();
    const redo = history.beginRedo();
    expect(redo?.transaction).toBe(tx);
    redo?.abort();
    expect(history.state()).toEqual(beforeRedoAbort);
  });

  it('safe undo and redo abort automatically when replay throws', () => {
    const history = new EditHistory();
    const tx = transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]);
    history.record(tx);

    expect(() =>
      history.undo(() => {
        throw new Error('apply failed');
      }),
    ).toThrow('apply failed');
    expect(history.state()).toEqual({
      undo: 1,
      redo: 0,
      conflicted: false,
      conflictReason: null,
    });

    history.undo(() => undefined);
    expect(() =>
      history.redo(() => {
        throw new Error('apply failed');
      }),
    ).toThrow('apply failed');
    expect(history.state()).toEqual({
      undo: 0,
      redo: 1,
      conflicted: false,
      conflictReason: null,
    });
  });

  it('clear removes history and conflict state', () => {
    const history = new EditHistory();
    history.record(transaction('t1', 'abc', [{ startOffset: 1, endOffset: 2, replacement: 'B' }]));
    history.markExternalConflict('external-document-change');

    history.clear();
    expect(history.state()).toEqual({
      undo: 0,
      redo: 0,
      conflicted: false,
      conflictReason: null,
    });
  });
});

describe('createEditTransaction', () => {
  it('stores versions, hashes, and inverse splices for exact round trips', () => {
    const before = 'Hello world';
    const forward: SpliceOp[] = [{ startOffset: 6, endOffset: 11, replacement: 'there' }];
    const after = applySplices(before, forward);

    const tx = createEditTransaction({
      id: 'edit-1',
      label: 'Text edit',
      sourceBefore: before,
      sourceAfter: after,
      forward,
      versionBefore: 4,
      versionAfter: 5,
    });

    expect(tx).toMatchObject({
      id: 'edit-1',
      label: 'Text edit',
      versionBefore: 4,
      versionAfter: 5,
      sourceHashBefore: hashText(before),
      sourceHashAfter: hashText(after),
    });
    expect(applySplices(before, tx.forward)).toBe(after);
    expect(applySplices(after, tx.inverse)).toBe(before);
  });
});
