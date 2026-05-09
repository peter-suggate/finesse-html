import * as vscode from 'vscode';
import type { EditCommit, OffsetMap } from '../shared/protocol';

export interface ApplyEditOpts {
  document: vscode.TextDocument;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  commit: EditCommit;
  /** Called immediately before applyEdit with the version we expect post-apply. */
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
