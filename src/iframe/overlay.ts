import type { EditSession } from './editSession';
import { sanitizePaste } from './pasteSanitizer';

export interface OverlayOpts {
  session: EditSession;
}

const HOVER_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  pointerEvents: 'none',
  border: '1px solid #4a90e2',
  background: 'rgba(74, 144, 226, 0.06)',
  borderRadius: '2px',
  zIndex: '2147483640',
  display: 'none',
  transition: 'left 60ms ease-out, top 60ms ease-out, width 60ms ease-out, height 60ms ease-out',
};

const SELECTION_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  pointerEvents: 'none',
  border: '2px solid #1e6fd9',
  borderRadius: '2px',
  zIndex: '2147483641',
  display: 'none',
};

const DELETE_BUTTON_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  width: '16px',
  height: '16px',
  lineHeight: '14px',
  textAlign: 'center',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  fontSize: '13px',
  fontWeight: '300',
  color: '#1e6fd9',
  background: 'transparent',
  border: 'none',
  borderRadius: '0',
  cursor: 'pointer',
  padding: '0',
  zIndex: '2147483642',
  display: 'none',
  opacity: '0.55',
  userSelect: 'none',
  transition: 'opacity 100ms ease-out, color 100ms ease-out',
};

export function setupOverlay(opts: OverlayOpts): void {
  const { session } = opts;
  const hover = createOverlay(HOVER_STYLE, 'finesse-hover');
  const selection = createOverlay(SELECTION_STYLE, 'finesse-selection');
  const deleteBtn = createDeleteButton();
  document.body.appendChild(hover);
  document.body.appendChild(selection);
  document.body.appendChild(deleteBtn);

  let hoveredEl: HTMLElement | null = null;
  let focusedEl: HTMLElement | null = null;
  let selectedEl: HTMLElement | null = null;
  let nativeClickBypass = false;

  function rectOf(el: HTMLElement): DOMRect {
    return el.getBoundingClientRect();
  }

  function deleteTargetEl(): HTMLElement | null {
    return selectedEl ?? hoveredEl ?? focusedEl;
  }

  function refreshDeleteButton(): void {
    if (session.isLocked()) {
      deleteBtn.style.display = 'none';
      return;
    }
    const el = deleteTargetEl();
    if (!el) {
      deleteBtn.style.display = 'none';
      return;
    }
    if (el !== selectedEl && isInteractiveClickTarget(el)) {
      deleteBtn.style.display = 'none';
      return;
    }
    const r = rectOf(el);
    deleteBtn.style.display = 'block';
    deleteBtn.style.left = `${Math.max(0, r.right - 18)}px`;
    deleteBtn.style.top = `${Math.max(0, r.top + 2)}px`;
  }

  function setHoveredEl(el: HTMLElement | null): void {
    hoveredEl = el;
    refreshDeleteButton();
  }

  function setFocusedEl(el: HTMLElement | null): void {
    focusedEl = el;
    refreshDeleteButton();
  }

  function setSelectedEl(el: HTMLElement | null): void {
    selectedEl = el;
    refreshDeleteButton();
  }

  function pickHoverTarget(target: Element | null): HTMLElement | null {
    if (!target) return null;
    return session.findSelectableElement(target);
  }

  function clearNavigationUi(): void {
    hover.style.display = 'none';
    selection.style.display = 'none';
    deleteBtn.style.display = 'none';
    setHoveredEl(null);
    setFocusedEl(null);
    setSelectedEl(null);
  }

  function showHover(el: HTMLElement | null): void {
    if (!el || session.hasActiveBlock() || nativeClickBypass) {
      hover.style.display = 'none';
      setHoveredEl(null);
      return;
    }
    const r = rectOf(el);
    hover.style.display = 'block';
    hover.style.left = `${r.left}px`;
    hover.style.top = `${r.top}px`;
    hover.style.width = `${r.width}px`;
    hover.style.height = `${r.height}px`;
    setHoveredEl(el);
  }

  function showSelection(el: HTMLElement | null): void {
    if (!el || nativeClickBypass) {
      selection.style.display = 'none';
      return;
    }
    const r = rectOf(el);
    selection.style.display = 'block';
    selection.style.left = `${r.left}px`;
    selection.style.top = `${r.top}px`;
    selection.style.width = `${r.width}px`;
    selection.style.height = `${r.height}px`;
    refreshDeleteButton();
  }

  document.addEventListener('mousemove', (e) => {
    if (nativeClickBypass || session.isLocked() || session.hasActiveBlock()) {
      hover.style.display = 'none';
      setHoveredEl(null);
      if (nativeClickBypass) deleteBtn.style.display = 'none';
      return;
    }
    const target = elementFromEventTarget(e.target);
    if (target && (target === deleteBtn || deleteBtn.contains(target))) return;
    if (target && isInOverlayUi(target)) return;
    showHover(pickHoverTarget(target));
  });

  document.addEventListener('mouseleave', () => {
    hover.style.display = 'none';
    setHoveredEl(null);
  });

  deleteBtn.addEventListener('mouseenter', () => {
    deleteBtn.style.opacity = '1';
    deleteBtn.style.color = '#d14545';
  });
  deleteBtn.addEventListener('mouseleave', () => {
    deleteBtn.style.opacity = '0.55';
    deleteBtn.style.color = '#1e6fd9';
  });

  deleteBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  deleteBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (session.isLocked()) return;
    const target = deleteTargetEl();
    if (!target) return;
    setHoveredEl(null);
    setFocusedEl(null);
    setSelectedEl(null);
    session.announceElementSelection(null);
    hover.style.display = 'none';
    showSelection(null);
    session.removeElement(target);
  });

  function editFromEvent(e: MouseEvent | PointerEvent): boolean {
    if (e instanceof MouseEvent && e.button !== 0) return false;
    const target = elementFromEventTarget(e.target);
    if (target && (target === deleteBtn || deleteBtn.contains(target))) return false;
    if (target && isInOverlayUi(target)) return false;
    if (session.hasActiveBlock()) {
      if (session.isInsideActive(target)) return false;
      session.commitEdit();
      showSelection(null);
      setSelectedEl(null);
    }
    const block = session.findEditableBlock(target);
    if (block) {
      hover.style.display = 'none';
      setHoveredEl(null);
      setFocusedEl(null);
      if (!session.beginEdit(block)) return false;
      setSelectedEl(block);
      showSelection(block);
      session.announceElementSelection(block);
      return true;
    }
    // Non-text-editable element (layout div, image, etc.): still selectable
    // so the side-panel can mutate its attributes. Don't move focus — that
    // would let a follow-up focusout (e.g. user clicking into the panel)
    // wipe the selection.
    const selectable = session.findSelectableElement(target);
    if (!selectable) return false;
    hover.style.display = 'none';
    setHoveredEl(null);
    setFocusedEl(null);
    setSelectedEl(selectable);
    showSelection(selectable);
    session.announceElementSelection(selectable);
    return true;
  }

  function shouldAllowNativeMouseEvent(
    e: MouseEvent | PointerEvent,
    target: Element | null,
  ): boolean {
    if (nativeClickBypass) return true;
    if (e.altKey) return true;
    if (target && (target === deleteBtn || deleteBtn.contains(target))) return true;
    if (target && isInOverlayUi(target)) return true;
    return session.hasActiveBlock() && session.isInsideActive(target);
  }

  function suppressInspectorMouseEvent(e: MouseEvent | PointerEvent): void {
    if (session.isLocked()) return;
    const target = elementFromEventTarget(e.target);
    if (shouldAllowNativeMouseEvent(e, target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  document.addEventListener('pointerdown', suppressInspectorMouseEvent, true);
  document.addEventListener('mousedown', suppressInspectorMouseEvent, true);
  document.addEventListener('mouseup', suppressInspectorMouseEvent, true);
  document.addEventListener('dblclick', suppressInspectorMouseEvent, true);

  document.addEventListener(
    'click',
    (e) => {
      if (session.isLocked()) return;
      const target = elementFromEventTarget(e.target);
      if (shouldAllowNativeMouseEvent(e, target)) {
        if (nativeClickBypass || e.altKey) clearNavigationUi();
        return;
      }
      if (nativeClickBypass) {
        clearNavigationUi();
        return;
      }
      editFromEvent(e);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );

  document.addEventListener('click', (e) => {
    if (session.isLocked()) return;
    const target = elementFromEventTarget(e.target);
    if (target && (target === deleteBtn || deleteBtn.contains(target))) return;
    if (target && isInOverlayUi(target)) return;
    if (nativeClickBypass || e.altKey) {
      clearNavigationUi();
      return;
    }
    if (editFromEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (isCommandPaletteShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      session.requestCommandPalette();
      return;
    }
    if (e.altKey && !isTextEntryTarget(document.activeElement)) {
      if (!nativeClickBypass) {
        nativeClickBypass = true;
        clearNavigationUi();
      }
    }
    // Cmd/Ctrl+S: commit any active edit, then ask host to save.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (session.hasActiveBlock()) {
        session.commitEdit();
        showSelection(null);
        setSelectedEl(null);
      }
      session.requestSave();
      return;
    }
    // Cmd/Ctrl+Z: undo the most recent committed Finesse edit. While an edit
    // session is active, defer to the browser's native contenteditable undo
    // so within-edit typing can be undone normally.
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !session.hasActiveBlock() &&
      !session.isLocked() &&
      (e.key === 'z' || e.key === 'Z')
    ) {
      e.preventDefault();
      if (e.shiftKey) session.requestRedo();
      else session.requestUndo();
      return;
    }
    // Cmd/Ctrl+Y: redo (Windows-style alternative to Cmd+Shift+Z).
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      !e.shiftKey &&
      !session.hasActiveBlock() &&
      !session.isLocked() &&
      (e.key === 'y' || e.key === 'Y')
    ) {
      e.preventDefault();
      session.requestRedo();
      return;
    }
    if (session.hasActiveBlock()) {
      // In edit mode: never intercept Delete/Backspace — let contentEditable handle them.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        const active = document.activeElement;
        if (active instanceof HTMLElement && session.isInsideActive(active)) {
          e.preventDefault();
          selectActiveBlockContents(session.activeBlockElement());
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        session.cancelEdit();
        session.announceElementSelection(null);
        clearNavigationUi();
        const active = document.activeElement as HTMLElement | null;
        active?.blur();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const block = session.activeBlockElement();
        session.commitEdit();
        showSelection(null);
        setSelectedEl(null);
        block?.focus({ preventScroll: true });
      }
      return;
    }
    // Not editing: Escape clears the current selection.
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      session.announceElementSelection(null);
      clearNavigationUi();
      const active = document.activeElement as HTMLElement | null;
      active?.blur();
      return;
    }
    // Not editing: Enter on a focused editable block enters edit mode.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const focused = document.activeElement as HTMLElement | null;
      if (!focused) return;
      const block = session.findEditableBlock(focused);
      if (block === focused) {
        e.preventDefault();
        if (session.beginEdit(block)) {
          setSelectedEl(block);
          showSelection(block);
          hover.style.display = 'none';
          setHoveredEl(null);
          setFocusedEl(null);
          session.announceElementSelection(block);
        }
      }
      return;
    }
    // Not editing: Delete/Backspace on a focused selectable element removes it.
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const focused = document.activeElement as HTMLElement | null;
      if (!focused) return;
      // Only when the focused element itself is a selectable target — never when
      // focus is inside something else that happens to live under one.
      if (session.findSelectableElement(focused) !== focused) return;
      e.preventDefault();
      setHoveredEl(null);
      setFocusedEl(null);
      setSelectedEl(null);
      session.announceElementSelection(null);
      hover.style.display = 'none';
      showSelection(null);
      session.removeElement(focused);
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt') return;
    nativeClickBypass = false;
  });

  document.addEventListener('focusin', (e) => {
    if (session.hasActiveBlock() || nativeClickBypass) return;
    const target = elementFromEventTarget(e.target);
    if (!(target instanceof HTMLElement)) return;
    if (session.findSelectableElement(target) !== target) return;
    setSelectedEl(target);
    showSelection(target);
    hover.style.display = 'none';
    setFocusedEl(target);
    session.announceElementSelection(target);
  });

  document.addEventListener('focusout', () => {
    if (!session.hasActiveBlock()) {
      showSelection(null);
      setFocusedEl(null);
      setSelectedEl(null);
    }
  });

  document.addEventListener(
    'blur',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.getAttribute('contenteditable') !== 'true') return;
      if (!session.hasActiveBlock()) return;
      setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active && session.isInsideActive(active)) return;
        // Focus moved into our own UI (toolbar select, link popover input).
        // Treat the editable block as still active.
        if (active && isInOverlayUi(active)) return;
        session.commitEdit();
        showSelection(null);
        setSelectedEl(null);
      }, 0);
    },
    true,
  );

  document.addEventListener('paste', (e) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active.getAttribute('contenteditable') !== 'true') return;
    sanitizePaste(e);
  });

  const reposition = (): void => {
    hover.style.display = 'none';
    showSelection(null);
    setHoveredEl(null);
    setFocusedEl(null);
    setSelectedEl(null);
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  window.addEventListener('blur', () => {
    nativeClickBypass = false;
  });
}

/**
 * Click/move events that originate inside our own UI (toolbar, link popover,
 * delete button, etc.) should never be treated as canvas interactions.
 * Detected by id prefix `finesse-` so new UI pieces are auto-excluded.
 */
function isInOverlayUi(target: Element): boolean {
  let cur: Element | null = target;
  while (cur && cur !== document.body) {
    if (cur instanceof HTMLElement && cur.id && cur.id.startsWith('finesse-')) return true;
    cur = cur.parentElement;
  }
  return false;
}

function isInteractiveClickTarget(target: Element): boolean {
  let cur: Element | null = target;
  while (cur && cur !== document.body) {
    if (!(cur instanceof HTMLElement)) {
      cur = cur.parentElement;
      continue;
    }
    const tag = cur.tagName.toLowerCase();
    if (
      tag === 'a' ||
      tag === 'button' ||
      tag === 'summary' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      tag === 'label'
    ) {
      return true;
    }
    if (cur.hasAttribute('onclick')) return true;
    const role = cur.getAttribute('role');
    if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') return true;
    cur = cur.parentElement;
  }
  return false;
}

function elementFromEventTarget(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isCommandPaletteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p';
}

function selectActiveBlockContents(block: HTMLElement | null): void {
  if (!block) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(block);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isTextEntryTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
}

function createDeleteButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'finesse-delete';
  btn.type = 'button';
  btn.textContent = '×';
  btn.title = 'Remove element (Delete)';
  btn.setAttribute('aria-label', 'Remove element');
  Object.assign(btn.style, DELETE_BUTTON_STYLE);
  return btn;
}

function createOverlay(style: Partial<CSSStyleDeclaration>, id: string): HTMLDivElement {
  const el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, style);
  el.setAttribute('aria-hidden', 'true');
  return el;
}
