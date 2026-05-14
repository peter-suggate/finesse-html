import type {
  AncestorRef,
  ClassRuleBlock,
  ClassRuleDeclaration,
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
  /**
   * Walk parentElement and return tracked ancestors (those with a
   * `data-finesse-id` mapping) ordered shallowest → deepest. Excludes `el`
   * itself.
   */
  collectAncestors(el: HTMLElement): AncestorRef[];
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
   * Apply a CSS declaration edit to a class rule. Updates the live CSSOM
   * optimistically (so the preview reflects immediately) and forwards an
   * {@link IframeMessage} to the host to splice the source file.
   */
  applyCssDeclarationEdit(input: {
    documentVersion: number;
    selector: string;
    property: string;
    value: string | null;
  }): boolean;
  /**
   * Stage a tag rename for the active block. Applied atomically with any
   * inner edit on the next commit. Pass null to clear.
   */
  setPendingTag(tag: string | null): void;
  /** Currently staged tag, or null. */
  pendingTag(): string | null;
  /** Retag the active block in the live DOM and stage the source rename. */
  applyActiveBlockTag(tag: string): boolean;
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

  function post(msg: IframeMessage): void {
    opts.postToParent({ ...msg, path: fileMeta.path } as IframeMessage);
  }

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
        post({
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
        post({
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
    post({
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
    post({
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
      post({ type: 'editCancel', blockId });
    }
    notifyState({ kind: 'idle' });
  }

  function requestSave(): void {
    post({ type: 'saveRequest' });
  }

  function requestUndo(): void {
    post({ type: 'undoRequest' });
  }

  function requestRedo(): void {
    post({ type: 'redoRequest' });
  }

  function requestCommandPalette(): void {
    post({ type: 'commandPaletteRequest' });
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
    post({
      type: 'editRemove',
      documentVersion: offsetMap.documentVersion,
      elementIds: [elementId],
    });
    return true;
  }

  function applyOffsetMap(map: OffsetMap): void {
    if (map.path && map.path !== fileMeta.path) return;
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
      post({
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
        post({ type: 'editCancel', blockId });
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
      path: fileMeta.path,
      documentVersion: offsetMap.documentVersion,
      elementId,
      blockId,
      tagName: element.tagName || el.tagName.toLowerCase(),
      domPath: domPathFor(el),
      selectorHints: selectorHintsFor(el),
      ancestors: collectAncestors(el),
      classList: classTokens(el),
      classCatalog: collectDocumentClassCatalog(el.ownerDocument ?? document),
      classRules: collectClassRules(
        el.ownerDocument ?? document,
        el,
        classTokens(el),
      ),
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

  function collectAncestors(el: HTMLElement): AncestorRef[] {
    const out: AncestorRef[] = [];
    let cur: HTMLElement | null = el.parentElement;
    while (cur) {
      const id = elementToElementId.get(cur);
      if (id !== undefined) {
        const ref: AncestorRef = {
          elementId: id,
          tagName: cur.tagName.toLowerCase(),
        };
        if (cur.id) ref.id = cur.id;
        const classes = classTokens(cur);
        if (classes.length > 0) ref.classList = classes.slice(0, 4);
        out.push(ref);
      }
      cur = cur.parentElement;
    }
    // Walked deepest → shallowest; flip so consumers can read root-first.
    out.reverse();
    return out;
  }

  function announceElementSelection(el: HTMLElement | null): void {
    selectedEl = el;
    post({
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
    post({
      type: 'editBlockHtml',
      documentVersion: offsetMap.documentVersion,
      blockId,
      newInnerHtml,
    });
  }

  function sendBlockTagCommit(blockId: number, newTagName: string): void {
    if (!offsetMap) return;
    post({
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

  function applyActiveBlockTag(tag: string): boolean {
    if (!activeBlock || activeBlockId === null || !offsetMap) return false;
    const nextTag = tag.toLowerCase();
    if (!BLOCK_TAGS.has(nextTag)) return false;
    const sourceBlock = offsetMap.blocks.find((b) => b.blockId === activeBlockId);
    if (!sourceBlock) return false;

    pendingNewTag = nextTag === sourceBlock.tagName.toLowerCase() ? null : nextTag;
    if (activeBlock.tagName.toLowerCase() === nextTag) return true;

    const replacement = document.createElement(nextTag);
    for (const attr of Array.from(activeBlock.attributes)) {
      replacement.setAttribute(attr.name, attr.value);
    }
    while (activeBlock.firstChild) {
      replacement.appendChild(activeBlock.firstChild);
    }
    activeBlock.replaceWith(replacement);

    const oldBlock = activeBlock;
    activeBlock = replacement;
    blockIdToElement.set(activeBlockId, replacement);
    elementToBlockId.delete(oldBlock);
    elementToBlockId.set(replacement, activeBlockId);
    const elementId = elementToElementId.get(oldBlock);
    if (elementId !== undefined) {
      elementToElementId.delete(oldBlock);
      elementToElementId.set(replacement, elementId);
      elementIdToElement.set(elementId, replacement);
    }
    replacement.focus({ preventScroll: true });
    notifyState({ kind: 'editing', block: replacement, blockId: activeBlockId });
    announceElementSelection(replacement);
    return true;
  }

  function sendAttrEditCommit(el: HTMLElement, attrs: Record<string, string | null>): boolean {
    if (!offsetMap) return false;
    const elementId = elementToElementId.get(el);
    if (elementId === undefined) return false;
    post({
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

  function applyCssDeclarationEdit(input: {
    documentVersion: number;
    selector: string;
    property: string;
    value: string | null;
  }): boolean {
    if (isLocked()) return false;
    if (!offsetMap) return false;
    // Optimistic CSSOM update: find the first top-level rule matching the
    // selector and apply the property change so the preview reflects it
    // before the host responds.
    applyCssOptimistic(document, input.selector, input.property, input.value);
    post({
      type: 'editCssDeclaration',
      documentVersion: offsetMap.documentVersion,
      selector: input.selector,
      property: input.property,
      value: input.value,
    });
    return true;
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
    collectAncestors,
    announceElementSelection,
    sendBlockHtmlCommit,
    sendBlockTagCommit,
    setPendingTag,
    pendingTag,
    applyActiveBlockTag,
    sendAttrEditCommit,
    selectedElement,
    onSelectionChange,
    findElementById,
    applyStyleEdit,
    applyCssDeclarationEdit,
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

function classTokens(el: HTMLElement): string[] {
  const raw = el.getAttribute('class');
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Gather every class token referenced by an element in the document. Used as
 * the autocomplete pool for the side panel — limiting suggestions to classes
 * the file already uses keeps them aligned with the project's CSS.
 */
function collectDocumentClassCatalog(doc: Document): string[] {
  const seen = new Set<string>();
  const all = doc.querySelectorAll('[class]');
  for (let i = 0; i < all.length; i++) {
    const cls = all[i].getAttribute('class');
    if (!cls) continue;
    for (const tok of cls.split(/\s+/)) {
      if (tok) seen.add(tok);
    }
  }
  return Array.from(seen).sort();
}

/**
 * Walk `document.styleSheets` and collect declarations for top-level rules
 * whose selectors match the selected element and mention one of its applied
 * class tokens. That surfaces contextual rules like `.hero .lede` under the
 * `.lede` class without showing unrelated rules for the same token.
 */
function collectClassRules(
  doc: Document,
  el: HTMLElement,
  classes: string[],
): Record<string, ClassRuleBlock[]> {
  if (classes.length === 0) return {};
  const wanted = new Set(classes);
  const out: Record<string, ClassRuleBlock[]> = {};
  for (const sheet of Array.from(doc.styleSheets)) {
    if (!isSameDocumentStyleSheet(sheet)) continue;
    let rules: CSSRuleList;
    try {
      rules = (sheet as CSSStyleSheet).cssRules;
    } catch {
      continue; // cross-origin
    }
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      const styleRule = rule as CSSStyleRule;
      const matchedClasses = classesMatchedByRule(el, styleRule.selectorText, wanted);
      if (matchedClasses.length === 0) continue;
      const decls = declarationsFromRule(styleRule);
      if (decls.length === 0) continue;
      for (const cls of matchedClasses) {
        const bucket = out[cls] ?? (out[cls] = []);
        bucket.push({
          selector: styleRule.selectorText.trim(),
          declarations: decls,
        });
      }
    }
  }
  return out;
}

function classesMatchedByRule(
  el: HTMLElement,
  selectorText: string,
  wanted: ReadonlySet<string>,
): string[] {
  const matched = new Set<string>();
  for (const selector of splitSelectorList(selectorText)) {
    if (!selectorMatches(el, selector)) continue;
    for (const cls of wanted) {
      if (selectorMentionsClass(selector, cls)) matched.add(cls);
    }
  }
  return Array.from(matched);
}

function selectorMatches(el: HTMLElement, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function selectorMentionsClass(selector: string, className: string): boolean {
  const escaped = cssEscape(className);
  const re = new RegExp(`\\.${escapeRegExp(escaped)}(?![-_a-zA-Z0-9])`);
  return re.test(selector);
}

function splitSelectorList(selectorText: string): string[] {
  const out: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: string | null = null;
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === ',' && bracketDepth === 0 && parenDepth === 0) {
      const item = selectorText.slice(start, i).trim();
      if (item) out.push(item);
      start = i + 1;
    }
  }
  const tail = selectorText.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Apply a property change to the first top-level rule in the document's
 * stylesheets whose selector is exactly `selector`. Used for optimistic
 * preview updates ahead of the host commit. Silently no-ops if no rule
 * matches or the stylesheet is cross-origin.
 */
function applyCssOptimistic(
  doc: Document,
  selector: string,
  property: string,
  value: string | null,
): void {
  for (const sheet of Array.from(doc.styleSheets)) {
    if (!isSameDocumentStyleSheet(sheet)) continue;
    let rules: CSSRuleList;
    try {
      rules = (sheet as CSSStyleSheet).cssRules;
    } catch {
      continue;
    }
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.type !== CSSRule.STYLE_RULE) continue;
      const styleRule = rule as CSSStyleRule;
      if (styleRule.selectorText.trim() !== selector) continue;
      if (value === null) styleRule.style.removeProperty(property);
      else styleRule.style.setProperty(property, value);
      return;
    }
  }
}

function isSameDocumentStyleSheet(sheet: StyleSheet): boolean {
  return sheet.ownerNode instanceof HTMLStyleElement;
}

function declarationsFromRule(rule: CSSStyleRule): ClassRuleDeclaration[] {
  const out: ClassRuleDeclaration[] = [];
  const style = rule.style;
  for (let i = 0; i < style.length; i++) {
    const property = style.item(i);
    if (!property) continue;
    const value = style.getPropertyValue(property).trim();
    if (!value) continue;
    out.push({
      property,
      value,
      important: style.getPropertyPriority(property) === 'important',
    });
  }
  return out;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
