import { computeInverseSplices, type SpliceOp } from './undoStack';

export type EditHistoryConflictReason =
  | 'external-document-change'
  | 'external-disk-change'
  | 'stale-replay'
  | (string & {});

export type EditHistoryReplayKind = 'undo' | 'redo';

export interface EditTransaction {
  id: string;
  label: string;
  forward: readonly SpliceOp[];
  inverse: readonly SpliceOp[];
  versionBefore: number;
  versionAfter: number;
  sourceHashBefore: string;
  sourceHashAfter: string;
}

export interface CreateEditTransactionOpts {
  id: string;
  label: string;
  sourceBefore: string;
  sourceAfter: string;
  forward: readonly SpliceOp[];
  versionBefore: number;
  versionAfter: number;
}

export interface PendingHistoryOperation {
  readonly kind: EditHistoryReplayKind;
  readonly transaction: EditTransaction;
  readonly splices: readonly SpliceOp[];
  commit(): void;
  abort(): void;
}

export interface EditHistoryState {
  undo: number;
  redo: number;
  conflicted: boolean;
  conflictReason: EditHistoryConflictReason | null;
}

export function createEditTransaction(opts: CreateEditTransactionOpts): EditTransaction {
  return {
    id: opts.id,
    label: opts.label,
    forward: [...opts.forward],
    inverse: computeInverseSplices(opts.sourceBefore, opts.forward),
    versionBefore: opts.versionBefore,
    versionAfter: opts.versionAfter,
    sourceHashBefore: hashText(opts.sourceBefore),
    sourceHashAfter: hashText(opts.sourceAfter),
  };
}

export function hashText(text: string): string {
  // 32-bit FNV-1a. This is a cheap guardrail for stale replay checks; it is
  // not intended to be cryptographic.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class EditHistory {
  private undoStack: EditTransaction[] = [];
  private redoStack: EditTransaction[] = [];
  private conflictReason: EditHistoryConflictReason | null = null;
  private pendingToken: symbol | null = null;

  record(transaction: EditTransaction): boolean {
    this.assertNoPendingOperation();
    if (this.conflictReason || transaction.forward.length === 0) return false;
    this.undoStack.push(transaction);
    this.redoStack = [];
    return true;
  }

  beginUndo(): PendingHistoryOperation | null {
    return this.beginOperation('undo');
  }

  beginRedo(): PendingHistoryOperation | null {
    return this.beginOperation('redo');
  }

  undo<T>(apply: (operation: PendingHistoryOperation) => T): T | null {
    const operation = this.beginUndo();
    if (!operation) return null;
    try {
      const result = apply(operation);
      operation.commit();
      return result;
    } catch (error) {
      operation.abort();
      throw error;
    }
  }

  redo<T>(apply: (operation: PendingHistoryOperation) => T): T | null {
    const operation = this.beginRedo();
    if (!operation) return null;
    try {
      const result = apply(operation);
      operation.commit();
      return result;
    } catch (error) {
      operation.abort();
      throw error;
    }
  }

  markExternalConflict(reason: EditHistoryConflictReason): void {
    this.assertNoPendingOperation();
    this.conflictReason = reason;
  }

  clear(): void {
    this.assertNoPendingOperation();
    this.undoStack = [];
    this.redoStack = [];
    this.conflictReason = null;
  }

  canUndo(): boolean {
    return !this.conflictReason && !this.pendingToken && this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return !this.conflictReason && !this.pendingToken && this.redoStack.length > 0;
  }

  get conflicted(): boolean {
    return this.conflictReason !== null;
  }

  state(): EditHistoryState {
    return {
      undo: this.undoStack.length,
      redo: this.redoStack.length,
      conflicted: this.conflicted,
      conflictReason: this.conflictReason,
    };
  }

  private beginOperation(kind: EditHistoryReplayKind): PendingHistoryOperation | null {
    if (this.conflictReason || this.pendingToken) return null;

    const stack = kind === 'undo' ? this.undoStack : this.redoStack;
    const transaction = stack.at(-1);
    if (!transaction) return null;

    const token = Symbol(kind);
    this.pendingToken = token;
    let settled = false;

    return {
      kind,
      transaction,
      splices: kind === 'undo' ? transaction.inverse : transaction.forward,
      commit: () => {
        if (settled) return;
        settled = true;
        this.commitOperation(kind, transaction, token);
      },
      abort: () => {
        if (settled) return;
        settled = true;
        this.clearPendingOperation(token);
      },
    };
  }

  private commitOperation(
    kind: EditHistoryReplayKind,
    transaction: EditTransaction,
    token: symbol,
  ): void {
    this.assertCurrentPendingOperation(token);
    const from = kind === 'undo' ? this.undoStack : this.redoStack;
    const to = kind === 'undo' ? this.redoStack : this.undoStack;
    const current = from.at(-1);
    if (current !== transaction) {
      this.pendingToken = null;
      throw new Error('Cannot commit edit history operation after stack mutation');
    }
    from.pop();
    to.push(transaction);
    this.pendingToken = null;
  }

  private clearPendingOperation(token: symbol): void {
    this.assertCurrentPendingOperation(token);
    this.pendingToken = null;
  }

  private assertNoPendingOperation(): void {
    if (this.pendingToken) {
      throw new Error('Cannot mutate edit history while an undo/redo operation is pending');
    }
  }

  private assertCurrentPendingOperation(token: symbol): void {
    if (this.pendingToken !== token) {
      throw new Error('Edit history operation is no longer pending');
    }
  }
}
