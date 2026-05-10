import * as vscode from 'vscode';
import type {
  EditBlockHtml,
  EditBlockTag,
  EditCommit,
  EditRemove,
  OffsetMap,
} from '../shared/protocol';
import {
  ALLOWED_BLOCK_TAGS,
  computeBlockTagSplices,
} from './blockTagTransform';
import { computeBlockHtmlSplices } from './computeBlockHtmlSplices';
import {
  computeInverseSplices,
  type SpliceOp,
  type UndoEntry,
} from './undoStack';

/**
 * Optional pre-splice transform applied to user-provided replacement text.
 * Used by JS/TS panels to escape backticks, backslashes, and `${` so the
 * splice can't break out of the template literal it's nested in.
 */
export type ReplacementEscaper = (text: string) => string;

const identity: ReplacementEscaper = (s) => s;

export interface ApplyEditOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditCommit;
  /** Called immediately before applyEdit with the version we expect post-apply. */
  beforeApply: (expectedVersion: number) => void;
  escapeReplacement?: ReplacementEscaper;
}

export interface ApplyRemoveOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditRemove;
  beforeApply: (expectedVersion: number) => void;
}

export interface ApplyBlockHtmlOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditBlockHtml;
  beforeApply: (expectedVersion: number) => void;
  escapeReplacement?: ReplacementEscaper;
}

export interface ApplyBlockTagOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditBlockTag;
  beforeApply: (expectedVersion: number) => void;
}

export type ApplyEditResult =
  | { ok: true; newVersion: number; undoEntry: UndoEntry }
  | {
      ok: false;
      reason: 'stale' | 'no-offsets' | 'apply-failed';
      expected: number;
      actual: number;
    };

/**
 * Apply a list of splices to `document` as one WorkspaceEdit, returning the
 * inverse splice set so callers can build undo entries. Right-to-left
 * ordering is applied internally; the input list may be in any order.
 *
 * Returns an empty undo entry if the splice list is empty (the doc isn't
 * touched and the version doesn't advance).
 */
async function applySplicesWithInverse(
  document: vscode.TextDocument,
  splices: readonly SpliceOp[],
  beforeApply: (expectedVersion: number) => void,
): Promise<
  | { ok: true; entry: UndoEntry }
  | { ok: false; reason: 'apply-failed'; expected: number; actual: number }
> {
  const versionBefore = document.version;
  if (splices.length === 0) {
    return {
      ok: true,
      entry: {
        forward: [],
        inverse: [],
        versionBefore,
        versionAfter: versionBefore,
      },
    };
  }
  const sourceBefore = document.getText();
  const inverse = computeInverseSplices(sourceBefore, splices);

  const edit = new vscode.WorkspaceEdit();
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  for (const s of ordered) {
    const startPos = document.positionAt(s.startOffset);
    const endPos = document.positionAt(s.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), s.replacement);
  }
  const expectedVersion = versionBefore + 1;
  beforeApply(expectedVersion);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) {
    return {
      ok: false,
      reason: 'apply-failed',
      expected: expectedVersion,
      actual: document.version,
    };
  }
  return {
    ok: true,
    entry: {
      forward: splices,
      inverse,
      versionBefore,
      versionAfter: document.version,
    },
  };
}

/**
 * Apply a pre-recorded splice list (forward or inverse) without re-deriving
 * it. Used by undo (apply inverse) and redo (apply forward) from an
 * {@link UndoEntry}.
 */
export async function applyRecordedSplices(
  document: vscode.TextDocument,
  splices: readonly SpliceOp[],
  expectedDocVersion: number,
  beforeApply: (expectedVersion: number) => void,
): Promise<
  | { ok: true; newVersion: number }
  | {
      ok: false;
      reason: 'stale' | 'apply-failed';
      expected: number;
      actual: number;
    }
> {
  if (document.version !== expectedDocVersion) {
    return {
      ok: false,
      reason: 'stale',
      expected: expectedDocVersion,
      actual: document.version,
    };
  }
  if (splices.length === 0) {
    return { ok: true, newVersion: document.version };
  }
  const edit = new vscode.WorkspaceEdit();
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  for (const s of ordered) {
    const startPos = document.positionAt(s.startOffset);
    const endPos = document.positionAt(s.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), s.replacement);
  }
  const expectedVersion = document.version + 1;
  beforeApply(expectedVersion);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) {
    return {
      ok: false,
      reason: 'apply-failed',
      expected: expectedVersion,
      actual: document.version,
    };
  }
  return { ok: true, newVersion: document.version };
}

function emptyUndoEntry(version: number): UndoEntry {
  return { forward: [], inverse: [], versionBefore: version, versionAfter: version };
}

export async function applyEditCommit(opts: ApplyEditOpts): Promise<ApplyEditResult> {
  const { document, currentVersion, currentOffsetMap, commit } = opts;
  if (!currentOffsetMap) {
    return {
      ok: false,
      reason: 'no-offsets',
      expected: commit.documentVersion,
      actual: currentVersion,
    };
  }
  if (commit.documentVersion !== currentVersion || document.version !== currentVersion) {
    return {
      ok: false,
      reason: 'stale',
      expected: commit.documentVersion,
      actual: document.version,
    };
  }

  const lookup = new Map<
    number,
    { startOffset: number; endOffset: number; originalText: string }
  >();
  for (const tn of currentOffsetMap.textNodes) {
    lookup.set(tn.nodeId, tn);
  }

  const escape = opts.escapeReplacement ?? identity;
  const splices: SpliceOp[] = [];
  for (const e of commit.edits) {
    const tn = lookup.get(e.nodeId);
    if (!tn) continue;
    splices.push({
      startOffset: tn.startOffset,
      endOffset: tn.endOffset,
      replacement: escape(e.newText),
    });
  }
  if (splices.length === 0) {
    return { ok: true, newVersion: currentVersion, undoEntry: emptyUndoEntry(currentVersion) };
  }

  const result = await applySplicesWithInverse(document, splices, opts.beforeApply);
  if (!result.ok) return result;
  return { ok: true, newVersion: document.version, undoEntry: result.entry };
}

export async function applyRemoveCommit(opts: ApplyRemoveOpts): Promise<ApplyEditResult> {
  const { document, currentVersion, currentOffsetMap, commit } = opts;
  if (!currentOffsetMap) {
    return {
      ok: false,
      reason: 'no-offsets',
      expected: commit.documentVersion,
      actual: currentVersion,
    };
  }
  if (commit.documentVersion !== currentVersion || document.version !== currentVersion) {
    return {
      ok: false,
      reason: 'stale',
      expected: commit.documentVersion,
      actual: document.version,
    };
  }

  const elementLookup = new Map<number, { startOffset: number; endOffset: number }>();
  for (const el of currentOffsetMap.elements) {
    elementLookup.set(el.elementId, { startOffset: el.startOffset, endOffset: el.endOffset });
  }

  const source = document.getText();
  const splices: SpliceOp[] = [];
  for (const elementId of commit.elementIds) {
    const r = elementLookup.get(elementId);
    if (!r) continue;
    if (r.endOffset <= r.startOffset) continue;
    const expanded = expandRangeToTrimWhitespace(source, r.startOffset, r.endOffset);
    splices.push({
      startOffset: expanded.startOffset,
      endOffset: expanded.endOffset,
      replacement: '',
    });
  }
  if (splices.length === 0) {
    return { ok: true, newVersion: currentVersion, undoEntry: emptyUndoEntry(currentVersion) };
  }

  const result = await applySplicesWithInverse(document, splices, opts.beforeApply);
  if (!result.ok) return result;
  return { ok: true, newVersion: document.version, undoEntry: result.entry };
}

export async function applyBlockHtmlCommit(opts: ApplyBlockHtmlOpts): Promise<ApplyEditResult> {
  const { document, currentVersion, currentOffsetMap, commit } = opts;
  if (!currentOffsetMap) {
    return {
      ok: false,
      reason: 'no-offsets',
      expected: commit.documentVersion,
      actual: currentVersion,
    };
  }
  if (commit.documentVersion !== currentVersion || document.version !== currentVersion) {
    return {
      ok: false,
      reason: 'stale',
      expected: commit.documentVersion,
      actual: document.version,
    };
  }
  const result = computeBlockHtmlSplices({
    source: document.getText(),
    offsetMap: currentOffsetMap,
    blockId: commit.blockId,
    newInnerHtml: commit.newInnerHtml,
    newTagName: commit.newTagName,
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === 'bad-tag' ? 'apply-failed' : 'no-offsets',
      expected: commit.documentVersion,
      actual: currentVersion,
    };
  }

  const escape = opts.escapeReplacement ?? identity;
  const splices: SpliceOp[] = result.splices.map((op) => ({
    startOffset: op.startOffset,
    endOffset: op.endOffset,
    replacement: escape(op.replacement),
  }));

  const applied = await applySplicesWithInverse(document, splices, opts.beforeApply);
  if (!applied.ok) return applied;
  return { ok: true, newVersion: document.version, undoEntry: applied.entry };
}

export async function applyBlockTagCommit(opts: ApplyBlockTagOpts): Promise<ApplyEditResult> {
  const { document, currentVersion, currentOffsetMap, commit } = opts;
  if (!currentOffsetMap) {
    return {
      ok: false,
      reason: 'no-offsets',
      expected: commit.documentVersion,
      actual: currentVersion,
    };
  }
  if (commit.documentVersion !== currentVersion || document.version !== currentVersion) {
    return {
      ok: false,
      reason: 'stale',
      expected: commit.documentVersion,
      actual: document.version,
    };
  }
  const newTag = commit.newTagName.toLowerCase();
  if (!ALLOWED_BLOCK_TAGS.has(newTag)) {
    return {
      ok: false,
      reason: 'apply-failed',
      expected: commit.documentVersion,
      actual: document.version,
    };
  }
  const block = currentOffsetMap.blocks.find((b) => b.blockId === commit.blockId);
  const element = block ? currentOffsetMap.elements.find((e) => e.elementId === block.elementId) : undefined;
  if (!block || !element) {
    return {
      ok: false,
      reason: 'no-offsets',
      expected: commit.documentVersion,
      actual: currentVersion,
    };
  }
  const source = document.getText();
  const splices = computeBlockTagSplices({
    source,
    elementStart: element.startOffset,
    elementEnd: element.endOffset,
    innerStart: block.innerStartOffset,
    innerEnd: block.innerEndOffset,
    oldTag: block.tagName,
    newTag,
  });
  if (!splices) {
    return {
      ok: false,
      reason: 'apply-failed',
      expected: commit.documentVersion,
      actual: document.version,
    };
  }

  const applied = await applySplicesWithInverse(document, splices, opts.beforeApply);
  if (!applied.ok) return applied;
  return { ok: true, newVersion: document.version, undoEntry: applied.entry };
}

/**
 * If the element sits on its own line, swallow the leading newline + indent so
 * removing it doesn't leave a blank line behind. Only consumes whitespace that
 * is, together with a single newline, the entire line prefix.
 */
function expandRangeToTrimWhitespace(
  source: string,
  startOffset: number,
  endOffset: number,
): { startOffset: number; endOffset: number } {
  let i = startOffset - 1;
  while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
  if (i >= 0 && source[i] === '\n') {
    return { startOffset: i, endOffset };
  }
  if (i >= 1 && source[i] === '\n' && source[i - 1] === '\r') {
    return { startOffset: i - 1, endOffset };
  }
  return { startOffset, endOffset };
}
