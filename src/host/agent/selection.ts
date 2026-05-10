import { createHash } from 'node:crypto';
import type * as vscode from 'vscode';
import type { ElementSelectionSnapshot, OffsetMap } from '../../shared/protocol';
import type { ElementSourceReference, SourcePosition } from './types';

export interface BuildElementReferenceOpts {
  document: vscode.TextDocument;
  relativePath: string;
  offsetMap: OffsetMap;
  selection: ElementSelectionSnapshot;
}

export function buildElementSourceReference(
  opts: BuildElementReferenceOpts,
): ElementSourceReference {
  const { document, relativePath, offsetMap, selection } = opts;
  if (selection.documentVersion !== offsetMap.documentVersion) {
    throw new Error('The selected element is stale. Select the element again.');
  }
  const element = offsetMap.elements.find((e) => e.elementId === selection.elementId);
  if (!element) {
    throw new Error('The selected element no longer exists. Select it again.');
  }
  const source = document.getText();
  const selectedSource = source.slice(element.startOffset, element.endOffset);
  const start = positionAt(document, element.startOffset);
  const end = positionAt(document, element.endOffset);
  const sourceHash = createHash('sha256').update(selectedSource).digest('hex');
  const token = [
    'finesse-selection',
    relativePath,
    offsetMap.documentVersion,
    element.startOffset,
    element.endOffset,
    sourceHash.slice(0, 12),
  ].join(':');

  return {
    token,
    workspaceRelativePath: relativePath,
    documentVersion: offsetMap.documentVersion,
    tagName: element.tagName,
    elementId: selection.elementId,
    blockId: selection.blockId,
    sourceHash,
    start,
    end,
    source: selectedSource,
    beforeContext: source.slice(Math.max(0, element.startOffset - 1200), element.startOffset),
    afterContext: source.slice(element.endOffset, Math.min(source.length, element.endOffset + 1200)),
    domPath: selection.domPath,
    selectorHints: selection.selectorHints,
    textPreview: selection.textPreview,
    outerHtmlPreview: selection.outerHtmlPreview,
  };
}

function positionAt(document: vscode.TextDocument, offset: number): SourcePosition {
  const pos = document.positionAt(offset);
  return {
    offset,
    line: pos.line + 1,
    character: pos.character + 1,
  };
}
