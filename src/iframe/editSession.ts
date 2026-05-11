import type {
  ElementSelectionSnapshot,
  ElementStyleSnapshot,
  FileMeta,
  IframeMessage,
  OffsetMap,
} from '../shared/protocol';
import { computeEdits } from './diff';

export type EditState =
  | { kind: 'idle' }
  | { kind: 'editing'; block: HTMLElement; blockId: number };

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
  'span',
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
const INLINE_TEXT_BLOCK_TAGS: ReadonlySet<string> = new Set(['span']);

export interface EditSession {
  applyOffsetMap(map: OffsetMap): void;
  applyFileMeta(meta: FileMeta): void;
  /** Return the editable block container ancestor, or null. */
  findEditableBlock(target: Element | null): HTMLElement | null;
  /** Return the innermost ancestor that is a selectable element, or null. */
  findSelectableElement(target: Element | null): HTMLElement | null;
  beginEdit(block: HTMLElement): boolean;
  commitEdit(): void;
  cancelEdit(): void;
  /** Remove any selectable element from source via host. */
  removeElement(el: HTMLElement): boolean;
  /** Make `el` programmatically focusable and focus it (for non-edit selection). */
  selectElement(el: HTMLElement): void;
  /** Ask the host to save the underlying document. */
  requestSave(): void;
  /** Ask the host to undo the most recent committed edit. */
  requestUndo(): void;
  /** Ask the host to redo the most recently undone edit. */
  requestRedo(): void;
  /** Ask the host to open Cursor/VS Code's command palette. */
  requestCommandPalette(): void;
  isLocked(): boolean;
  hasActiveBlock(): boolean;
  activeBlockElement(): HTMLElement | null;
  isInsideActive(target: Element | null): boolean;
  /** Block elements in document order, for keyboard nav. */
  orderedBlocks(): HTMLElement[];
  onStale(): void;
  /**
   * Subscribe to edit-state transitions. Useful for layers like the format
   * toolbar that need to mount/unmount in sync with edit mode. Returns an
   * unsubscribe function.
   */
  onEditStateChange(listener: (state: EditState) => void): () => void;
  /** Lookup the blockId for a known block element. */
  blockIdFor(el: HTMLElement): number | null;
  /** Build a source-backed snapshot for the currently selected element. */
  describeElement(el: HTMLElement): ElementSelectionSnapshot | null;
  /** Tell the host which element the user has selected for agent context. */
  announceElementSelection(el: HTMLElement | null): void;
  /**
   * Send a structural-edit commit (block innerHTML replace). Skips the
   * text-node-id pipe entirely. Caller is responsible for clearing
   * contenteditable on `block` first.
   */
  sendBlockHtmlCommit(blockId: number, newInnerHtml: string): void;
  /** Send a block-tag transform commit. */
  sendBlockTagCommit(blockId: number, newTagName: string): void;
  /**
   * Send an attribute-edit commit for `el`. `attrs` maps name → value (set)
   * or null (remove). Returns false if the element isn't tracked.
   */
  sendAttrEditCommit(el: HTMLElement, attrs: Record<string, string | null>): boolean;
  /** The currently selected element (mirrors the most recent `announceElementSelection`). */
  selectedElement(): HTMLElement | null;
  /** Subscribe to selection changes. Returns an unsubscribe. */
  onSelectionChange(listener: (el: HTMLElement | null) => void): () => void;
  /** Lookup the live DOM element for a given source elementId. */
  findElementById(elementId: number): HTMLElement | null;
  /**
   * High-level entry for the side-panel pipeline: apply attribute changes
   * optimistically to the DOM, sequence around any active text edit, and
   * dispatch the canonical {@link IframeMessage} commit. Returns true if a
   * dispatch (or queued dispatch) occurred.
   */
  applyStyleEdit(el: HTMLElement, attrs: Record<string, string | null>): boolean;
  /**
   * Stage a tag rename for the active block. Applied atomically with any
   * inner edit on the next commit. Pass null to clear.
   */
  setPendingTag(tag: string | null): void;
  /** Currently staged tag, or null. */
  pendingTag(): string | null;
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
  let elementToElementId = new Map<HTMLElement, number>();
  let elementIdToElement = new Map<number, HTMLElement>();

  let activeBlock: HTMLElement | null = null;
  let activeBlockId: number | null = null;
  let snapshotTexts: string[] = [];
  let snapshotTextNodes: Text[] = [];
  let snapshotHTML = '';
  let snapshotStructureHTML = '';
  let pendingNewTag: string | null = null;
  let selectedEl: HTMLElement | null = null;
  const stateListeners: Array<(state: EditState) => void> = [];
  const selectionListeners: Array<(el: HTMLElement | null) => void> = [];

  function notifyState(state: EditState): void {
    for (const l of stateListeners) {
      try {
        l(state);
      } catch (err) {
        opts.onError(`edit-state listener: ${(err as Error).message}`, (err as Error).stack);
      }
    }
  }

  function rebuild(): void {
    // Restore prior tabindex/role attrs we may have set on editable blocks.
    for (const el of elementToBlockId.keys()) {
      if (el.dataset.finesseApplied === 'true') {
        el.removeAttribute('tabindex');
        el.removeAttribute('role');
        el.removeAttribute('aria-label');
        delete el.dataset.finesseApplied;
      }
    }
    elementToBlockId = new Map();
    blockIdToElement = new Map();
    blockIdToTextNodeIds = new Map();
    elementToElementId = new Map();
    elementIdToElement = new Map();
    if (!offsetMap) return;

    // Element id mapping comes from data-finesse-id attributes the host
    // splices in at serve time. Robust against implicit DOM insertions like
    // browser-added <tbody>.
    const tagged = document.body?.querySelectorAll('[data-finesse-id]') ?? [];
    for (const el of Array.from(tagged)) {
      if (!(el instanceof HTMLElement)) continue;
      const idStr = el.getAttribute('data-finesse-id');
      if (!idStr) continue;
      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) continue;
      elementIdToElement.set(id, el);
      elementToElementId.set(el, id);
    }

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
    if (INLINE_TEXT_BLOCK_TAGS.has(el.tagName.toLowerCase())) return;
    if (el.dataset.finesseApplied === 'true') return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'region');
    if (!el.hasAttribute('aria-label')) {
      el.setAttribute('aria-label', `Editable ${el.tagName.toLowerCase()}`);
    }
    el.dataset.finesseApplied = 'true';
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
      if (el.id && el.id.startsWith('finesse-')) {
        return;
      }
      const elLocked =
        locked || el.hasAttribute('data-no-edit') || el.getAttribute('contenteditable') === 'false';
      if (NON_EDITABLE_PARENT_TAGS.has(tag)) return;
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

  function findSelectableElement(target: Element | null): HTMLElement | null {
    if (!target || isLocked()) return null;
    let cur: Element | null = target;
    while (cur && cur !== document.body) {
      if (cur instanceof HTMLElement) {
        if (cur.hasAttribute('data-no-edit')) return null;
        if (elementToElementId.has(cur)) return cur;
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
    pendingNewTag = null;
    snapshotTextNodes = collectBlockTexts(block);
    snapshotTexts = snapshotTextNodes.map((t) => t.data);
    snapshotHTML = block.innerHTML;
    snapshotStructureHTML = htmlWithTextPlaceholders(block);
    block.setAttribute('contenteditable', 'true');
    block.setAttribute('spellcheck', 'true');
    block.focus({ preventScroll: true });
    placeCaretAtEnd(block);
    if (activeBlockId !== null) {
      notifyState({ kind: 'editing', block, blockId: activeBlockId });
    }
    return true;
  }

  function commitEdit(): void {
    if (!activeBlock || !offsetMap) return;
    const block = activeBlock;
    const blockId = activeBlockId;
    const snapshotNodes = snapshotTextNodes;
    const newTag = pendingNewTag;
    activeBlock = null;
    activeBlockId = null;
    pendingNewTag = null;
    block.removeAttribute('contenteditable');
    block.removeAttribute('spellcheck');
    if (blockId === null) {
      notifyState({ kind: 'idle' });
      return;
    }
    const currentTexts = collectBlockTexts(block);
    const ids = blockIdToTextNodeIds.get(blockId) ?? [];
    const sameNodes =
      currentTexts.length === snapshotNodes.length &&
      currentTexts.every((n, i) => n === snapshotNodes[i]);
    const innerHtmlChanged = block.innerHTML !== snapshotHTML;
    const structureChanged = htmlWithTextPlaceholders(block) !== snapshotStructureHTML;

    if (!structureChanged && sameNodes && ids.length === snapshotNodes.length) {
      // Text-only edit — use the byte-perfect text-node pipe.
      const after = currentTexts.map((t) => t.data);
      const edits = computeEdits(ids, snapshotTexts, after);
      if (edits.length > 0) {
        opts.postToParent({
          type: 'editCommit',
          documentVersion: offsetMap.documentVersion,
          edits,
        });
        // If the user also requested a tag change, send it as a follow-up.
        // The host applies the editCommit first; documentWatcher then ships a
        // fresh editAck with the new offset map, which the iframe replays
        // before sending the editBlockTag below.
        if (newTag) queueTagAfterAck(blockId, newTag);
      } else if (newTag) {
        // Tag-only change, byte-perfect inner content.
        opts.postToParent({
          type: 'editBlockTag',
          documentVersion: offsetMap.documentVersion,
          blockId,
          newTagName: newTag,
        });
      }
      notifyState({ kind: 'idle' });
      return;
    }

    // Structural change — combine inner-html replace with optional tag rename.
    if (!innerHtmlChanged && !newTag) {
      notifyState({ kind: 'idle' });
      return;
    }
    opts.postToParent({
      type: 'editBlockHtml',
      documentVersion: offsetMap.documentVersion,
      blockId,
      newInnerHtml: block.innerHTML,
      newTagName: newTag ?? undefined,
    });
    notifyState({ kind: 'idle' });
  }

  /** Queue a tag rename to fire after the next editAck arrives. */
  let queuedTag: { blockId: number; newTagName: string } | null = null;
  function queueTagAfterAck(blockId: number, newTagName: string): void {
    queuedTag = { blockId, newTagName };
  }
  function flushQueuedTag(): void {
    if (!queuedTag || !offsetMap) return;
    const q = queuedTag;
    queuedTag = null;
    opts.postToParent({
      type: 'editBlockTag',
      documentVersion: offsetMap.documentVersion,
      blockId: q.blockId,
      newTagName: q.newTagName,
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
    notifyState({ kind: 'idle' });
  }

  function requestSave(): void {
    opts.postToParent({ type: 'saveRequest' });
  }

  function requestUndo(): void {
    opts.postToParent({ type: 'undoRequest' });
  }

  function requestRedo(): void {
    opts.postToParent({ type: 'redoRequest' });
  }

  function requestCommandPalette(): void {
    opts.postToParent({ type: 'commandPaletteRequest' });
  }

  function selectElement(el: HTMLElement): void {
    if (isLocked()) return;
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1');
      el.dataset.finesseSelTab = 'true';
    }
    el.focus({ preventScroll: true });
  }

  function removeElement(el: HTMLElement): boolean {
    if (isLocked() || !offsetMap) return false;
    const elementId = elementToElementId.get(el);
    if (elementId === undefined) return false;
    if (activeBlock) cancelEdit();
    // Optimistically remove from DOM; host responds with editAck + fresh offset map.
    el.remove();
    opts.postToParent({
      type: 'editRemove',
      documentVersion: offsetMap.documentVersion,
      elementIds: [elementId],
    });
    return true;
  }

  function applyOffsetMap(map: OffsetMap): void {
    offsetMap = map;
    rebuild();
    // If we deferred a tag rename behind a text commit, fire it now that the
    // host's response has aligned us to the post-commit version.
    if (queuedTag) flushQueuedTag();
    // Same trick for a panel-driven attr edit that landed mid-text-edit.
    if (queuedPanelEdit) {
      const q = queuedPanelEdit;
      queuedPanelEdit = null;
      // The element identity may have been replaced by the host's reparse —
      // resolve fresh by id if possible.
      const elementId = elementToElementId.get(q.el);
      const fresh = elementId !== undefined ? q.el : null;
      if (fresh) sendAttrEditCommit(fresh, q.attrs);
    }
    // Re-poke selection listeners so panels re-sync against the refreshed
    // element ↔ id map. Pass the current selection (still a live DOM node)
    // through so the panel can read the latest inline style. We also re-emit
    // the rich snapshot to the host so the chrome side panel sees the new
    // inline style after a self-edit ack.
    if (selectedEl && selectedEl.isConnected) {
      opts.postToParent({
        type: 'elementSelectionChanged',
        selection: describeElement(selectedEl),
      });
      for (const l of selectionListeners) {
        try {
          l(selectedEl);
        } catch (err) {
          opts.onError(`selection listener: ${(err as Error).message}`, (err as Error).stack);
        }
      }
    }
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
      notifyState({ kind: 'idle' });
    }
  }

  function onEditStateChange(listener: (state: EditState) => void): () => void {
    stateListeners.push(listener);
    return () => {
      const i = stateListeners.indexOf(listener);
      if (i >= 0) stateListeners.splice(i, 1);
    };
  }

  function blockIdFor(el: HTMLElement): number | null {
    return elementToBlockId.get(el) ?? null;
  }

  function describeElement(el: HTMLElement): ElementSelectionSnapshot | null {
    if (!offsetMap) return null;
    const elementId = elementToElementId.get(el);
    if (elementId === undefined) return null;
    const element = offsetMap.elements.find((e) => e.elementId === elementId);
    if (!element) return null;
    const blockId = elementToBlockId.get(el);
    const rect = el.getBoundingClientRect();
    return {
      documentVersion: offsetMap.documentVersion,
      elementId,
      blockId,
      tagName: element.tagName || el.tagName.toLowerCase(),
      domPath: domPathFor(el),
      selectorHints: selectorHintsFor(el),
      textPreview: limit(el.innerText || el.textContent || '', 500),
      outerHtmlPreview: limit(el.outerHTML, 4000),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      styles: snapshotStyles(el),
    };
  }

  function announceElementSelection(el: HTMLElement | null): void {
    selectedEl = el;
    opts.postToParent({
      type: 'elementSelectionChanged',
      selection: el ? describeElement(el) : null,
    });
    for (const l of selectionListeners) {
      try {
        l(el);
      } catch (err) {
        opts.onError(`selection listener: ${(err as Error).message}`, (err as Error).stack);
      }
    }
  }

  function sendBlockHtmlCommit(blockId: number, newInnerHtml: string): void {
    if (!offsetMap) return;
    opts.postToParent({
      type: 'editBlockHtml',
      documentVersion: offsetMap.documentVersion,
      blockId,
      newInnerHtml,
    });
  }

  function sendBlockTagCommit(blockId: number, newTagName: string): void {
    if (!offsetMap) return;
    opts.postToParent({
      type: 'editBlockTag',
      documentVersion: offsetMap.documentVersion,
      blockId,
      newTagName,
    });
  }

  function setPendingTag(tag: string | null): void {
    pendingNewTag = tag;
  }

  function pendingTag(): string | null {
    return pendingNewTag;
  }

  function sendAttrEditCommit(el: HTMLElement, attrs: Record<string, string | null>): boolean {
    if (!offsetMap) return false;
    const elementId = elementToElementId.get(el);
    if (elementId === undefined) return false;
    opts.postToParent({
      type: 'editElementAttrs',
      documentVersion: offsetMap.documentVersion,
      elementId,
      attrs,
    });
    return true;
  }

  /** Optimistically apply attribute changes to a live DOM element. */
  function applyAttrsToDom(el: HTMLElement, attrs: Record<string, string | null>): void {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  }

  /** Queue used when a panel-driven attr edit must wait for a text-commit ack. */
  let queuedPanelEdit: { el: HTMLElement; attrs: Record<string, string | null> } | null = null;

  function applyStyleEdit(el: HTMLElement, attrs: Record<string, string | null>): boolean {
    if (isLocked()) return false;
    if (!offsetMap) return false;
    if (!elementToElementId.has(el)) return false;
    applyAttrsToDom(el, attrs);
    if (activeBlock && (el === activeBlock || activeBlock.contains(el) || el.contains(activeBlock))) {
      // The panel touched the actively-edited block (or one of its ancestors / descendants).
      // Commit the text edit first, then dispatch the attr edit on the next ack so
      // both edits target a fresh document version.
      queuedPanelEdit = { el, attrs };
      commitEdit();
      return true;
    }
    return sendAttrEditCommit(el, attrs);
  }

  function findElementById(elementId: number): HTMLElement | null {
    return elementIdToElement.get(elementId) ?? null;
  }

  function selectedElement(): HTMLElement | null {
    return selectedEl;
  }

  function onSelectionChange(listener: (el: HTMLElement | null) => void): () => void {
    selectionListeners.push(listener);
    return () => {
      const i = selectionListeners.indexOf(listener);
      if (i >= 0) selectionListeners.splice(i, 1);
    };
  }

  if (offsetMap) rebuild();

  return {
    applyOffsetMap,
    applyFileMeta,
    findEditableBlock,
    findSelectableElement,
    beginEdit,
    commitEdit,
    cancelEdit,
    removeElement,
    selectElement,
    requestSave,
    requestUndo,
    requestRedo,
    requestCommandPalette,
    isLocked,
    hasActiveBlock,
    activeBlockElement,
    isInsideActive,
    orderedBlocks,
    onStale,
    onEditStateChange,
    blockIdFor,
    describeElement,
    announceElementSelection,
    sendBlockHtmlCommit,
    sendBlockTagCommit,
    setPendingTag,
    pendingTag,
    sendAttrEditCommit,
    selectedElement,
    onSelectionChange,
    findElementById,
    applyStyleEdit,
  };
}

function snapshotStyles(el: HTMLElement): ElementStyleSnapshot {
  const computed = window.getComputedStyle(el);
  return {
    inlineStyle: el.getAttribute('style'),
    computed: {
      display: computed.display,
      paddingTop: computed.paddingTop,
      paddingRight: computed.paddingRight,
      paddingBottom: computed.paddingBottom,
      paddingLeft: computed.paddingLeft,
      marginTop: computed.marginTop,
      marginRight: computed.marginRight,
      marginBottom: computed.marginBottom,
      marginLeft: computed.marginLeft,
      borderTopWidth: computed.borderTopWidth,
      borderTopStyle: computed.borderTopStyle,
      borderTopColor: computed.borderTopColor,
      borderTopLeftRadius: computed.borderTopLeftRadius,
      backgroundColor: computed.backgroundColor,
      flexDirection: computed.flexDirection,
      justifyContent: computed.justifyContent,
      alignItems: computed.alignItems,
      flexWrap: computed.flexWrap,
      rowGap: computed.rowGap,
      gridTemplateColumns: computed.gridTemplateColumns,
      gridTemplateRows: computed.gridTemplateRows,
    },
  };
}

function limit(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function selectorHintsFor(el: HTMLElement): string[] {
  const hints: string[] = [];
  if (el.id) hints.push(`#${cssEscape(el.id)}`);
  for (const cls of Array.from(el.classList).slice(0, 4)) {
    hints.push(`.${cssEscape(cls)}`);
  }
  for (const attr of ['aria-label', 'role', 'name', 'href', 'src']) {
    const value = el.getAttribute(attr);
    if (value) hints.push(`[${attr}="${value.replace(/"/g, '\\"')}"]`);
  }
  return hints;
}

function domPathFor(el: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const tag = cur.tagName.toLowerCase();
    const parent: HTMLElement | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTagSiblings: Element[] = Array.from(parent.children).filter(
      (child) => child.tagName.toLowerCase() === tag,
    );
    if (sameTagSiblings.length <= 1) {
      parts.unshift(tag);
    } else {
      const index = sameTagSiblings.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    }
    cur = parent;
  }
  return parts.length > 0 ? `body > ${parts.join(' > ')}` : 'body';
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
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

function htmlWithTextPlaceholders(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    node.textContent = '\u0000';
    node = walker.nextNode();
  }
  return clone.innerHTML;
}
