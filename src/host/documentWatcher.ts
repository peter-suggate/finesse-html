import type * as vscode from 'vscode';
import type { PreviewPanel } from './panel';

export function handleDocumentChange(
  event: vscode.TextDocumentChangeEvent,
  panel: PreviewPanel,
): void {
  const doc = event.document;
  if (doc.version === panel.currentVersion) return;
  const isSelf =
    panel.expectedSelfEditVersion !== null && doc.version === panel.expectedSelfEditVersion;
  if (isSelf) {
    panel.expectedSelfEditVersion = null;
  }
  panel.onDocumentChanged(doc, isSelf ? 'self' : 'external');
}
