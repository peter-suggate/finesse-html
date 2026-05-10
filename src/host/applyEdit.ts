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

  const escape = opts.escapeReplacement ?? identity;
  const edit = new vscode.WorkspaceEdit();
  for (const e of sortable) {
    const startPos = document.positionAt(e.startOffset);
    const endPos = document.positionAt(e.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), escape(e.newText));
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
  const edit = new vscode.WorkspaceEdit();
  for (const op of result.splices) {
    const startPos = document.positionAt(op.startOffset);
    const endPos = document.positionAt(op.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), escape(op.replacement));
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

  const edit = new vscode.WorkspaceEdit();
  // Right-to-left so leading offsets stay valid.
  const ordered = [...splices].sort((a, b) => b.startOffset - a.startOffset);
  for (const s of ordered) {
    const startPos = document.positionAt(s.startOffset);
    const endPos = document.positionAt(s.endOffset);
    edit.replace(document.uri, new vscode.Range(startPos, endPos), s.replacement);
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
