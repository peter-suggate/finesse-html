import type { FileMeta, IframeMessage, OffsetMap } from '../shared/protocol';
import { computeEdits } from './diff';

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'li',
  'dt',
  'dd',
  'figcaption',
  'blockquote',
  'address',
  'td',
  'th',
  'caption',
]);
const NON_EDITABLE_PARENT_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'code',
  'pre',
  'title',
]);
const SKIP_SUBTREE_TAGS: ReadonlySet<string> = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
]);

export interface EditSession {
  applyOffsetMap(map: OffsetMap): void;
  applyFileMeta(meta: FileMeta): void;
  /** Return the editable block container ancestor, or null. */
  findEditableBlock(target: Element | null): HTMLElement | null;
  beginEdit(block: HTMLElement): boolean;
  commitEdit(): void;
  cancelEdit(): void;
  isLocked(): boolean;
  hasActiveBlock(): boolean;
  activeBlockElement(): HTMLElement | null;
  isInsideActive(target: Element | null): boolean;
  /** Block elements in document order, for keyboard nav. */
  orderedBlocks(): HTMLElement[];
  onStale(): void;
}

export interface SetupOpts {
  initialOffsetMap: OffsetMap | null;
  initialFileMeta: FileMeta;
  postToParent: (msg: IframeMessage) => void;
  onError: (message: string, stack?: string) => void;
}

export function setupEditSession(opts: SetupOpts): EditSession {
  let offsetMap: OffsetMap | null = opts.initialOffsetMap;
  let fileMeta: FileMeta = opts.initialFileMeta;

  let elementToBlockId = new Map<HTMLElement, number>();
  let blockIdToElement = new Map<number, HTMLElement>();
  let blockIdToTextNodeIds = new Map<number, number[]>();

  let activeBlock: HTMLElement | null = null;
  let activeBlockId: number | null = null;
  let snapshotTexts: string[] = [];
  let snapshotHTML = '';

  function rebuild(): void {
    // Restore prior tabindex/role attrs we may have set; we apply fresh below.
    for (const el of elementToBlockId.keys()) {
      if (el.dataset.htmlWysiwygApplied === 'true') {
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
        delete el.dataset.htmlWysiwygApplied;
      }
    }
    elementToBlockId = new Map();
    blockIdToElement = new Map();
    blockIdToTextNodeIds = new Map();
    if (!offsetMap) return;
    const blockEls: HTMLElement[] = [];
    const textNodes: Text[] = [];
    walk(document.body, [], false, blockEls, textNodes);
    const blocks = offsetMap.blocks;
    const orderedTexts = offsetMap.textNodes;
    for (let i = 0; i < blocks.length && i < blockEls.length; i++) {
      const el = blockEls[i];
      blockIdToElement.set(blocks[i].blockId, el);
      elementToBlockId.set(el, blocks[i].blockId);
      applyA11yAttrs(el);
    }
    for (const tn of orderedTexts) {
      const list = blockIdToTextNodeIds.get(tn.blockId) ?? [];
      list.push(tn.nodeId);
      blockIdToTextNodeIds.set(tn.blockId, list);
    }
    void textNodes;
  }

  function applyA11yAttrs(el: HTMLElement): void {
    if (el.dataset.htmlWysiwygApplied === 'true') return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'region');
    if (!el.hasAttribute('aria-label')) {
      el.setAttribute('aria-label', `Editable ${el.tagName.toLowerCase()}`);
    }
    el.dataset.htmlWysiwygApplied = 'true';
  }

  function walk(
    node: Node,
    blockAncestors: HTMLElement[],
    locked: boolean,
    blockEls: HTMLElement[],
    textNodes: Text[],
  ): void {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (SKIP_SUBTREE_TAGS.has(tag)) return;
      if (NON_EDITABLE_PARENT_TAGS.has(tag)) return;
      const elLocked =
        locked || el.hasAttribute('data-no-edit') || el.getAttribute('contenteditable') === 'false';
      const nextBlocks = BLOCK_TAGS.has(tag) ? [...blockAncestors, el] : blockAncestors;
      for (const child of Array.from(el.childNodes)) {
        walk(child, nextBlocks, elLocked, blockEls, textNodes);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      if (locked) return;
      const text = (node as Text).data;
      if (!text || !text.trim()) return;
      const block = blockAncestors.length > 0 ? blockAncestors[blockAncestors.length - 1] : null;
      if (!block) return;
      if (blockEls.length === 0 || blockEls[blockEls.length - 1] !== block) {
        if (!blockEls.includes(block)) blockEls.push(block);
      }
      textNodes.push(node as Text);
    }
  }

  function isLocked(): boolean {
    return fileMeta.isTemplated;
  }

  function findEditableBlock(target: Element | null): HTMLElement | null {
    if (!target || isLocked()) return null;
    let cur: Element | null = target;
    while (cur && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      if (NON_EDITABLE_PARENT_TAGS.has(tag) || SKIP_SUBTREE_TAGS.has(tag)) return null;
      if (cur instanceof HTMLElement) {
        if (cur.hasAttribute('data-no-edit')) return null;
        if (elementToBlockId.has(cur)) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function collectBlockTexts(block: HTMLElement): Text[] {
    const result: Text[] = [];
    const stack: Node[] = [block];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (SKIP_SUBTREE_TAGS.has(tag)) continue;
        if (NON_EDITABLE_PARENT_TAGS.has(tag)) continue;
        if (el !== block && el.getAttribute('contenteditable') === 'false') continue;
        if (el !== block && el.hasAttribute('data-no-edit')) continue;
        const children = Array.from(el.childNodes);
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      } else if (node.nodeType === Node.TEXT_NODE) {
        const t = node as Text;
        if (t.data && t.data.trim()) result.push(t);
      }
    }
    return result;
  }

  function beginEdit(block: HTMLElement): boolean {
    if (isLocked()) return false;
    if (!elementToBlockId.has(block)) return false;
    if (activeBlock === block) return true;
    if (activeBlock) commitEdit();
    activeBlock = block;
    activeBlockId = elementToBlockId.get(block) ?? null;
    snapshotTexts = collectBlockTexts(block).map((t) => t.data);
    snapshotHTML = block.innerHTML;
    block.setAttribute('contenteditable', 'true');
    block.setAttribute('spellcheck', 'true');
    block.focus({ preventScroll: true });
    placeCaretAtEnd(block);
    return true;
  }

  function commitEdit(): void {
    if (!activeBlock || !offsetMap) return;
    const block = activeBlock;
    const blockId = activeBlockId;
    activeBlock = null;
    activeBlockId = null;
    block.removeAttribute('contenteditable');
    block.removeAttribute('spellcheck');
    if (blockId === null) return;
    const currentTexts = collectBlockTexts(block);
    const ids = blockIdToTextNodeIds.get(blockId) ?? [];
    if (currentTexts.length !== snapshotTexts.length || ids.length !== snapshotTexts.length) {
      block.innerHTML = snapshotHTML;
      opts.postToParent({ type: 'editCancel', blockId });
      return;
    }
    const after = currentTexts.map((t) => t.data);
    const edits = computeEdits(ids, snapshotTexts, after);
    if (edits.length === 0) return;
    opts.postToParent({
      type: 'editCommit',
      documentVersion: offsetMap.documentVersion,
      edits,
    });
  }

  function cancelEdit(): void {
    if (!activeBlock) return;
    const block = activeBlock;
    const blockId = activeBlockId;
    activeBlock = null;
    activeBlockId = null;
    block.removeAttribute('contenteditable');
    block.removeAttribute('spellcheck');
    block.innerHTML = snapshotHTML;
    if (blockId !== null) {
      opts.postToParent({ type: 'editCancel', blockId });
    }
  }

  function applyOffsetMap(map: OffsetMap): void {
    offsetMap = map;
    rebuild();
  }

  function applyFileMeta(meta: FileMeta): void {
    fileMeta = meta;
  }

  function hasActiveBlock(): boolean {
    return activeBlock !== null;
  }

  function activeBlockElement(): HTMLElement | null {
    return activeBlock;
  }

  function isInsideActive(target: Element | null): boolean {
    if (!activeBlock || !target) return false;
    return activeBlock === target || activeBlock.contains(target);
  }

  function orderedBlocks(): HTMLElement[] {
    if (!offsetMap) return [];
    const result: HTMLElement[] = [];
    for (const b of offsetMap.blocks) {
      const el = blockIdToElement.get(b.blockId);
      if (el) result.push(el);
    }
    return result;
  }

  function onStale(): void {
    if (activeBlock) {
      const block = activeBlock;
      const blockId = activeBlockId;
      activeBlock = null;
      activeBlockId = null;
      block.removeAttribute('contenteditable');
      block.removeAttribute('spellcheck');
      block.innerHTML = snapshotHTML;
      if (blockId !== null) {
        opts.postToParent({ type: 'editCancel', blockId });
      }
    }
  }

  if (offsetMap) rebuild();

  return {
    applyOffsetMap,
    applyFileMeta,
    findEditableBlock,
    beginEdit,
    commitEdit,
    cancelEdit,
    isLocked,
    hasActiveBlock,
    activeBlockElement,
    isInsideActive,
    orderedBlocks,
    onStale,
  };
}

function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
