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

export function setupOverlay(opts: OverlayOpts): void {
  const { session } = opts;
  const hover = createOverlay(HOVER_STYLE, 'html-wysiwyg-hover');
  const selection = createOverlay(SELECTION_STYLE, 'html-wysiwyg-selection');
  document.body.appendChild(hover);
  document.body.appendChild(selection);

  function rectOf(el: HTMLElement): DOMRect {
    return el.getBoundingClientRect();
  }

  function showHover(el: HTMLElement | null): void {
    if (!el || session.hasActiveBlock()) {
      hover.style.display = 'none';
      return;
    }
    const r = rectOf(el);
    hover.style.display = 'block';
    hover.style.left = `${r.left}px`;
    hover.style.top = `${r.top}px`;
    hover.style.width = `${r.width}px`;
    hover.style.height = `${r.height}px`;
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
      return;
    }
    const block = session.findEditableBlock(e.target as Element | null);
    showHover(block);
  });

  document.addEventListener('mouseleave', () => {
    hover.style.display = 'none';
  });

  document.addEventListener('click', (e) => {
    if (session.isLocked()) return;
    const target = e.target as Element | null;
    if (session.hasActiveBlock()) {
      if (!session.isInsideActive(target)) {
        session.commitEdit();
        showSelection(null);
      }
      return;
    }
    const block = session.findEditableBlock(target);
    if (!block) return;
    e.preventDefault();
    e.stopPropagation();
    if (session.beginEdit(block)) {
      showSelection(block);
      hover.style.display = 'none';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (session.hasActiveBlock()) {
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
        }
      }
    }
  });

  document.addEventListener('focusin', (e) => {
    if (session.hasActiveBlock()) return;
    const target = e.target as Element | null;
    if (!target) return;
    const block = session.findEditableBlock(target);
    if (block && block === target) {
      showSelection(block);
      hover.style.display = 'none';
    }
  });

  document.addEventListener('focusout', () => {
    if (!session.hasActiveBlock()) showSelection(null);
  });

  document.addEventListener(
    'blur',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.getAttribute('contenteditable') !== 'true') return;
      if (!session.hasActiveBlock()) return;
      // The user may be tabbing within the block; defer commit slightly to allow
      // refocus checks to land first.
      setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active && session.isInsideActive(active)) return;
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
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
}

function createOverlay(style: Partial<CSSStyleDeclaration>, id: string): HTMLDivElement {
  const el = document.createElement('div');
  el.id = id;
  Object.assign(el.style, style);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

