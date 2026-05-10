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

  function rectOf(el: HTMLElement): DOMRect {
    return el.getBoundingClientRect();
  }

  function deleteTargetEl(): HTMLElement | null {
    return hoveredEl ?? focusedEl;
  }

  function refreshDeleteButton(): void {
    if (session.hasActiveBlock() || session.isLocked()) {
      deleteBtn.style.display = 'none';
      return;
    }
    const el = deleteTargetEl();
    if (!el) {
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

  /** Pick the visual hover target — prefers an editable block (so click-to-edit
   *  is the obvious affordance), falls back to any selectable ancestor. */
  function pickHoverTarget(target: Element | null): HTMLElement | null {
    if (!target) return null;
    return session.findEditableBlock(target) ?? session.findSelectableElement(target);
  }

  function showHover(el: HTMLElement | null): void {
    if (!el || session.hasActiveBlock()) {
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
    if (!el) {
      selection.style.display = 'none';
      return;
    }
    const r = rectOf(el);
    selection.style.display = 'block';
    selection.style.left = `${r.left}px`;
    selection.style.top = `${r.top}px`;
    selection.style.width = `${r.width}px`;
    selection.style.height = `${r.height}px`;
  }

  document.addEventListener('mousemove', (e) => {
    if (session.isLocked() || session.hasActiveBlock()) {
      hover.style.display = 'none';
      setHoveredEl(null);
      return;
    }
    const target = e.target as Element | null;
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
    if (session.isLocked() || session.hasActiveBlock()) return;
    const target = deleteTargetEl();
    if (!target) return;
    setHoveredEl(null);
    setFocusedEl(null);
    session.announceElementSelection(null);
    hover.style.display = 'none';
    showSelection(null);
    session.removeElement(target);
  });

  document.addEventListener('click', (e) => {
    if (session.isLocked()) return;
    const target = e.target as Element | null;
    if (target && (target === deleteBtn || deleteBtn.contains(target))) return;
    if (target && isInOverlayUi(target)) return;
    if (session.hasActiveBlock()) {
      if (!session.isInsideActive(target)) {
        session.commitEdit();
        showSelection(null);
      }
      return;
    }
    // Alt-click: bypass edit-mode logic, select the innermost element directly.
    if (e.altKey) {
      const exact = session.findSelectableElement(target);
      if (!exact) return;
      e.preventDefault();
      e.stopPropagation();
      hover.style.display = 'none';
      setHoveredEl(null);
      session.selectElement(exact);
      session.announceElementSelection(exact);
      return;
    }
    // Default click: prefer text-edit on an editable block, else select for delete.
    const block = session.findEditableBlock(target);
    if (block) {
      e.preventDefault();
      e.stopPropagation();
      if (session.beginEdit(block)) {
        showSelection(block);
        hover.style.display = 'none';
        setHoveredEl(null);
        setFocusedEl(null);
        session.announceElementSelection(block);
      }
      return;
    }
    const selectable = session.findSelectableElement(target);
    if (selectable) {
      e.preventDefault();
      e.stopPropagation();
      hover.style.display = 'none';
      setHoveredEl(null);
      session.selectElement(selectable);
      session.announceElementSelection(selectable);
    }
  });

  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+S: commit any active edit, then ask host to save.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (session.hasActiveBlock()) {
        session.commitEdit();
        showSelection(null);
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
      if (e.key === 'Escape') {
        e.preventDefault();
        const block = session.activeBlockElement();
        session.cancelEdit();
        showSelection(null);
        block?.focus({ preventScroll: true });
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const block = session.activeBlockElement();
        session.commitEdit();
        showSelection(null);
        block?.focus({ preventScroll: true });
      }
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
      session.announceElementSelection(null);
      hover.style.display = 'none';
      showSelection(null);
      session.removeElement(focused);
    }
  });

  document.addEventListener('focusin', (e) => {
    if (session.hasActiveBlock()) return;
    const target = e.target as Element | null;
    if (!(target instanceof HTMLElement)) return;
    if (session.findSelectableElement(target) !== target) return;
    showSelection(target);
    hover.style.display = 'none';
    setFocusedEl(target);
    session.announceElementSelection(target);
  });

  document.addEventListener('focusout', () => {
    if (!session.hasActiveBlock()) {
      showSelection(null);
      setFocusedEl(null);
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
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
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
