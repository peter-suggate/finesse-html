export function sanitizePaste(e: ClipboardEvent): void {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (!text) return;
  const exec = (document as Document & { execCommand?: (cmd: string, ui: boolean, value: string) => boolean }).execCommand;
  if (typeof exec === 'function') {
    exec.call(document, 'insertText', false, text);
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
}
