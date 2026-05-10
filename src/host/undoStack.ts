/**
 * Per-panel undo/redo stack of source-level edits.
 *
 * Each {@link UndoEntry} bundles the forward splices that were applied to
 * advance the document from `versionBefore` → `versionAfter` together with
 * the inverse splices that revert it. Both lists are pre-computed at apply
 * time so undo/redo can replay them without re-deriving offsets.
 */

export interface SpliceOp {
  /** Inclusive start offset in the document this splice applies to. */
  startOffset: number;
  /** Exclusive end offset. */
  endOffset: number;
  /** Replacement text (already escaped for the target document if needed). */
  replacement: string;
}

export interface UndoEntry {
  /** Splices that take the doc from versionBefore → versionAfter. */
  forward: readonly SpliceOp[];
  /** Splices that take the doc from versionAfter → versionBefore. */
  inverse: readonly SpliceOp[];
  /** Document version observed immediately before forward splices were applied. */
  versionBefore: number;
  /** Document version observed immediately after forward splices were applied. */
  versionAfter: number;
}

export class UndoStack {
  private undo: UndoEntry[] = [];
  private redo: UndoEntry[] = [];

  /** Record a freshly applied edit. Always clears the redo branch. */
  push(entry: UndoEntry): void {
    this.undo.push(entry);
    this.redo = [];
  }

  /** Pop the most recent applied edit so it can be reverted. */
  popUndo(): UndoEntry | null {
    return this.undo.pop() ?? null;
  }

  /** Pop the most recent reverted edit so it can be reapplied. */
  popRedo(): UndoEntry | null {
    return this.redo.pop() ?? null;
  }

  /** Move an entry from undo→redo (after an undo successfully applies). */
  pushRedo(entry: UndoEntry): void {
    this.redo.push(entry);
  }

  /** Move an entry from redo→undo (after a redo successfully applies). */
  pushUndo(entry: UndoEntry): void {
    this.undo.push(entry);
  }

  /** Drop everything — used when an external edit invalidates stored offsets. */
  clear(): void {
    this.undo = [];
    this.redo = [];
  }

  canUndo(): boolean {
    return this.undo.length > 0;
  }

  canRedo(): boolean {
    return this.redo.length > 0;
  }

  /** Inspector for tests. */
  size(): { undo: number; redo: number } {
    return { undo: this.undo.length, redo: this.redo.length };
  }
}

/**
 * Compute the inverse splice list for a forward splice list, given the
 * document text BEFORE the forward splices were applied. The resulting
 * inverse splices are in post-apply coordinates and revert the document
 * exactly when applied right-to-left.
 *
 * Forward splices may be in any order — they don't have to be sorted.
 */
export function computeInverseSplices(
  sourceBefore: string,
  forward: readonly SpliceOp[],
): SpliceOp[] {
  // Each splice's post-apply position is its pre-apply startOffset plus the
  // cumulative size delta of every earlier (lower startOffset) splice. We
  // sort by startOffset so we can accumulate that delta in one pass.
  const sorted = [...forward].sort((a, b) => a.startOffset - b.startOffset);
  let cumulativeDelta = 0;
  const inverses: SpliceOp[] = [];
  for (const f of sorted) {
    const postStart = f.startOffset + cumulativeDelta;
    const postEnd = postStart + f.replacement.length;
    const original = sourceBefore.slice(f.startOffset, f.endOffset);
    inverses.push({
      startOffset: postStart,
      endOffset: postEnd,
      replacement: original,
    });
    cumulativeDelta += f.replacement.length - (f.endOffset - f.startOffset);
  }
  return inverses;
}
