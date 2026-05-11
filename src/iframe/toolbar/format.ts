/**
 * DOM-using format helpers — apply formatting to the live Selection and
 * derive {@link FormatState} from it.
 *
 * Pure logic lives in {@link ./formatHelpers}; this file is the thin layer
 * that touches `document`, `window`, and `Selection`.
 */

import {
  EMPTY_FORMAT_STATE,
  isLinkUrlSafe,
  queryFormatStateForElement,
  type AncestorNode,
  type FormatState,
  type InlineFormat,
} from './formatHelpers';

export {
  EMPTY_FORMAT_STATE,
  queryFormatStateForElement,
  tagToFormatName,
} from './formatHelpers';
export type { AncestorNode, FormatState, InlineFormat } from './formatHelpers';

/**
 * Inspect the current Selection and report which inline formats are active.
 * If the selection has no range, returns {@link EMPTY_FORMAT_STATE}.
 */
export function queryFormatState(
  selection: Selection | null,
  boundary: HTMLElement,
): FormatState {
  if (!selection || selection.rangeCount === 0) return { ...EMPTY_FORMAT_STATE };
  const range = selection.getRangeAt(0);
  let anchor: Node | null = range.startContainer;
  if (selection.focusNode) anchor = selection.focusNode;
  if (!anchor) return { ...EMPTY_FORMAT_STATE };
  const startEl =
    anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
  return queryFormatStateForElement(
    startEl as unknown as AncestorNode,
    boundary as unknown as AncestorNode,
  );
}

/**
 * Apply an inline format toggle to the current selection. Returns true if a
 * format command ran. Uses {@link document.execCommand} for the heavy lifting.
 *
 * `code` is special — execCommand has no native code command. We fall back
 * to a manual wrap/unwrap.
 */
export function applyInlineFormat(format: InlineFormat, boundary: HTMLElement): boolean {
  if (format === 'code') return toggleCodeWrap(boundary);
  const cmd = EXEC_COMMAND[format];
  if (!cmd) return false;
  // styleWithCSS=false → semantic <b>/<i>/<u>/<strike> rather than spans.
  document.execCommand('styleWithCSS', false, 'false');
  return document.execCommand(cmd);
}

export function applyFontWeight(weight: string, boundary: HTMLElement): boolean {
  const normalized = normalizeFontWeight(weight);
  if (!normalized) return false;
  const sel = window.getSelection();
  const targetRange = document.createRange();
  if (!sel || sel.rangeCount === 0) {
    targetRange.selectNodeContents(boundary);
  } else {
    const sourceRange = sel.getRangeAt(0);
    targetRange.setStart(sourceRange.startContainer, sourceRange.startOffset);
    targetRange.setEnd(sourceRange.endContainer, sourceRange.endOffset);
    if (targetRange.collapsed) {
      targetRange.selectNodeContents(boundary);
    }
  }
  const fragment = targetRange.extractContents();
  stripFontWeight(fragment);
  const replacement =
    normalized === '400' ? fragment : wrapFragmentWithFontWeight(fragment, normalized);
  targetRange.insertNode(replacement);
  const nextRange = document.createRange();
  nextRange.selectNodeContents(boundary);
  nextRange.collapse(false);
  const nextSelection = window.getSelection();
  if (nextSelection) {
    nextSelection.removeAllRanges();
    nextSelection.addRange(nextRange);
  }
  return true;
}

export function queryFontWeight(selection: Selection | null, boundary: HTMLElement): string {
  if (!selection || selection.rangeCount === 0) return '400';
  const range = selection.getRangeAt(0);
  let anchor: Node | null = range.startContainer;
  if (selection.focusNode) anchor = selection.focusNode;
  const startEl =
    anchor?.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor?.parentElement ?? null;
  let cur: Element | null = startEl;
  while (cur && cur !== boundary) {
    const explicit = normalizeFontWeight((cur as HTMLElement).style?.fontWeight ?? '');
    if (explicit) return explicit;
    const tag = cur.tagName.toLowerCase();
    if (tag === 'strong' || tag === 'b') return '700';
    cur = cur.parentElement;
  }
  return '400';
}

const EXEC_COMMAND: Readonly<Record<InlineFormat, string | null>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strikeThrough',
  code: null,
};

function toggleCodeWrap(boundary: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return false;
  const anchor = sel.focusNode;
  const startEl =
    anchor && anchor.nodeType === Node.ELEMENT_NODE
      ? (anchor as Element)
      : anchor?.parentElement ?? null;
  const codeAncestor = findAncestorTag(startEl, 'code', boundary);
  if (codeAncestor) {
    unwrap(codeAncestor);
    return true;
  }
  const wrapper = document.createElement('code');
  try {
    range.surroundContents(wrapper);
  } catch {
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
  }
  const newRange = document.createRange();
  newRange.selectNodeContents(wrapper);
  sel.removeAllRanges();
  sel.addRange(newRange);
  return true;
}

function findAncestorTag(
  node: Element | null,
  tag: string,
  boundary: HTMLElement,
): HTMLElement | null {
  let cur: Element | null = node;
  while (cur && cur !== boundary) {
    if (cur.tagName.toLowerCase() === tag) return cur as HTMLElement;
    cur = cur.parentElement;
  }
  return null;
}

function unwrap(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function normalizeFontWeight(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'normal') return '400';
  if (trimmed === 'bold') return '700';
  return /^(100|200|300|400|500|600|700|800|900)$/.test(trimmed) ? trimmed : null;
}

function stripFontWeight(node: Node): void {
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    el.style.fontWeight = '';
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  }
  for (const child of Array.from(node.childNodes)) stripFontWeight(child);
}

function wrapFragmentWithFontWeight(fragment: DocumentFragment, weight: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.style.fontWeight = weight;
  span.appendChild(fragment);
  return span;
}

/** Apply a link to the current selection. Empty URL ⇒ unlink. */
export function applyLink(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === '') {
    document.execCommand('unlink');
    return true;
  }
  if (!isLinkUrlSafe(trimmed)) return false;
  document.execCommand('createLink', false, trimmed);
  return true;
}

export function clearFormatting(): void {
  document.execCommand('removeFormat');
  document.execCommand('unlink');
}
