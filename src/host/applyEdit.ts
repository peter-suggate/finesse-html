import * as vscode from 'vscode';
import type { EditCommit, EditRemove, OffsetMap } from '../shared/protocol';

export interface ApplyEditOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditCommit;
  /** Called immediately before applyEdit with the version we expect post-apply. */
  beforeApply: (expectedVersion: number) => void;
}

export interface ApplyRemoveOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditRemove;
  beforeApply: (expectedVersion: number) => void;
}

export type ApplyEditResult =
  | { ok: true; newVersion: number }
  | { ok: false; reason: 'stale' | 'no-offsets' | 'apply-failed'; expected: number; actual: number };

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

  type Resolved = {
    nodeId: number;
    newText: string;
    startOffset: number;
    endOffset: number;
  };
  const sortable: Resolved[] = [];
  for (const e of commit.edits) {
    const tn = lookup.get(e.nodeId);
    if (!tn) continue;
    sortable.push({
      nodeId: e.nodeId,
      newText: e.newText,
      startOffset: tn.startOffset,
      endOffset: tn.endOffset,
    });
  }
  if (sortable.length === 0) {
    return { ok: true, newVersion: currentVersion };
  }
  sortable.sort((a, b) => b.startOffset - a.startOffset);

  const edit = new vscode.WorkspaceEdit();
  for (const e of sortable) {
    const startPos = document.positionAt(e.startOffset);
    const endPos = document.positionAt(e.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), e.newText);
  }
  const expectedVersion = document.version + 1;
  opts.beforeApply(expectedVersion);
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

  type Range = { startOffset: number; endOffset: number };
  const ranges: Range[] = [];
  for (const elementId of commit.elementIds) {
    const r = elementLookup.get(elementId);
    if (!r) continue;
    if (r.endOffset <= r.startOffset) continue;
    ranges.push({ ...r });
  }
  if (ranges.length === 0) {
    return { ok: true, newVersion: currentVersion };
  }
  ranges.sort((a, b) => b.startOffset - a.startOffset);

  const source = document.getText();
  const edit = new vscode.WorkspaceEdit();
  for (const r of ranges) {
    const expanded = expandRangeToTrimWhitespace(source, r.startOffset, r.endOffset);
    const startPos = document.positionAt(expanded.startOffset);
    const endPos = document.positionAt(expanded.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), '');
  }
  const expectedVersion = document.version + 1;
  opts.beforeApply(expectedVersion);
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
