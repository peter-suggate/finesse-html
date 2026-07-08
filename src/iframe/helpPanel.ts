/**
 * Fixed help panel pinned to the bottom-left of the preview.
 *
 * Lists the canonical interactions (click to edit, Shift+click to use natively,
 * Delete to remove, ⌘S/⌘Z, etc.) at a glance. Fades out of the way when the
 * user's pointer approaches it, and hides entirely while an edit session is
 * active so it doesn't compete with the format toolbar.
 */

import { SHIFT, modKey, shiftModKey } from '../shared/keys';
import type { EditSession, EditState } from './editSession';

const PANEL_ID = 'finesse-help-panel';
const STORAGE_KEY = 'finesse:helpPanel:collapsed';

/** Distance in px at which the panel begins to fade. */
const FADE_START = 220;
/** Distance at which the panel reaches its minimum opacity. */
const FADE_END = 80;
const MIN_OPACITY = 0.08;
const MAX_OPACITY = 0.92;

interface Row {
  keys: string[];
  label: string;
}

const ROWS: readonly Row[] = [
  { keys: ['Click'], label: 'Edit text' },
  { keys: ['✦'], label: 'Ask AI (select first)' },
  { keys: [SHIFT, 'Click'], label: 'Use link / button' },
  { keys: [SHIFT, SHIFT], label: 'Toggle interactive' },
  { keys: ['Tab'], label: 'Next element' },
  { keys: ['Enter'], label: 'Edit focused' },
  { keys: ['Del'], label: 'Remove selected' },
  { keys: [modKey('S')], label: 'Save' },
  { keys: [modKey('Z')], label: 'Undo' },
  { keys: [shiftModKey('Z')], label: 'Redo' },
  { keys: [modKey('.')], label: 'Toggle side panel' },
  { keys: ['Esc'], label: 'Deselect / exit' },
];

export interface HelpPanelController {
  destroy(): void;
}

export function setupHelpPanel(session: EditSession): HelpPanelController {
  const panel = buildPanel();
  document.body.appendChild(panel.root);

  let collapsed = readCollapsed();
  let editing = false;
  let panelRect: DOMRect | null = null;

  function applyCollapsed(): void {
    panel.root.dataset.collapsed = collapsed ? 'true' : 'false';
    panel.body.style.display = collapsed ? 'none' : 'grid';
    panel.toggle.textContent = collapsed ? '?' : '–';
    panel.toggle.title = collapsed ? 'Show shortcuts' : 'Collapse';
    panel.toggle.setAttribute('aria-label', panel.toggle.title);
    panelRect = null;
  }

  function setVisible(visible: boolean): void {
    panel.root.style.display = visible ? 'block' : 'none';
    if (visible) panelRect = null;
  }

  function refreshFade(clientX: number, clientY: number): void {
    if (panel.root.style.display === 'none') return;
    if (!panelRect) panelRect = panel.root.getBoundingClientRect();
    const r = panelRect;
    const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    const dist = Math.hypot(dx, dy);
    let opacity: number;
    if (dist >= FADE_START) opacity = MAX_OPACITY;
    else if (dist <= FADE_END) opacity = MIN_OPACITY;
    else {
      const t = (dist - FADE_END) / (FADE_START - FADE_END);
      opacity = MIN_OPACITY + (MAX_OPACITY - MIN_OPACITY) * t;
    }
    panel.root.style.opacity = String(opacity);
  }

  function onMouseMove(e: MouseEvent): void {
    refreshFade(e.clientX, e.clientY);
  }

  function onMouseLeave(): void {
    panel.root.style.opacity = String(MAX_OPACITY);
  }

  function onResizeOrScroll(): void {
    panelRect = null;
  }

  panel.toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    collapsed = !collapsed;
    writeCollapsed(collapsed);
    applyCollapsed();
  });

  // Keep our own mouse events from triggering canvas hover; the iframe's
  // overlay layer already excludes anything with id starting `finesse-`.
  panel.root.addEventListener('mouseenter', () => {
    panel.root.style.opacity = String(MIN_OPACITY);
  });
  panel.root.addEventListener('mouseleave', () => {
    panel.root.style.opacity = String(MAX_OPACITY);
  });

  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('mouseleave', onMouseLeave);
  window.addEventListener('resize', onResizeOrScroll);
  window.addEventListener('scroll', onResizeOrScroll, true);

  const unsubscribe = session.onEditStateChange((state: EditState) => {
    editing = state.kind === 'editing';
    setVisible(!editing);
  });

  applyCollapsed();
  setVisible(!editing);

  return {
    destroy() {
      unsubscribe();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('resize', onResizeOrScroll);
      window.removeEventListener('scroll', onResizeOrScroll, true);
      panel.root.remove();
    },
  };
}

interface PanelDom {
  root: HTMLDivElement;
  body: HTMLDivElement;
  toggle: HTMLButtonElement;
}

function buildPanel(): PanelDom {
  const root = document.createElement('div');
  root.id = PANEL_ID;
  root.setAttribute('aria-label', 'Finesse shortcuts');
  Object.assign(root.style, {
    position: 'fixed',
    left: '12px',
    bottom: '12px',
    zIndex: '2147483643',
    padding: '8px 10px 9px',
    minWidth: '170px',
    maxWidth: '240px',
    borderRadius: '8px',
    border: '1px solid var(--finesse-surface-border)',
    background: 'var(--finesse-surface)',
    color: 'var(--finesse-surface-fg)',
    boxShadow: 'var(--finesse-shadow-small)',
    fontFamily: 'var(--finesse-font)',
    fontSize: '11px',
    lineHeight: '14px',
    backdropFilter: 'blur(10px)',
    opacity: String(MAX_OPACITY),
    transition: 'opacity 140ms ease-out',
    userSelect: 'none',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  root.style.setProperty('-webkit-backdrop-filter', 'blur(10px)');

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginBottom: '6px',
  } satisfies Partial<CSSStyleDeclaration>);

  const title = document.createElement('div');
  title.textContent = 'Finesse';
  Object.assign(title.style, {
    fontSize: '10px',
    fontWeight: '600',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--finesse-muted)',
  } satisfies Partial<CSSStyleDeclaration>);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = 'finesse-help-toggle';
  Object.assign(toggle.style, {
    width: '18px',
    height: '18px',
    padding: '0',
    border: '1px solid var(--finesse-surface-border)',
    borderRadius: '4px',
    background: 'color-mix(in srgb, var(--finesse-surface-fg) 5%, transparent)',
    color: 'inherit',
    fontSize: '11px',
    lineHeight: '14px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    pointerEvents: 'auto',
  } satisfies Partial<CSSStyleDeclaration>);

  header.appendChild(title);
  header.appendChild(toggle);

  const body = document.createElement('div');
  Object.assign(body.style, {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: '10px',
    rowGap: '4px',
    alignItems: 'center',
  } satisfies Partial<CSSStyleDeclaration>);

  for (const row of ROWS) {
    const keys = document.createElement('div');
    Object.assign(keys.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      whiteSpace: 'nowrap',
    } satisfies Partial<CSSStyleDeclaration>);
    row.keys.forEach((k, i) => {
      if (i > 0) {
        const plus = document.createElement('span');
        plus.textContent = '+';
        plus.style.opacity = '0.45';
        plus.style.fontSize = '9px';
        keys.appendChild(plus);
      }
      keys.appendChild(kbd(k));
    });
    const label = document.createElement('div');
    label.textContent = row.label;
    Object.assign(label.style, {
      opacity: '0.85',
    } satisfies Partial<CSSStyleDeclaration>);
    body.appendChild(keys);
    body.appendChild(label);
  }

  root.appendChild(header);
  root.appendChild(body);

  return { root, body, toggle };
}

function kbd(value: string): HTMLElement {
  const el = document.createElement('kbd');
  el.textContent = value;
  Object.assign(el.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '14px',
    height: '15px',
    padding: '0 4px',
    border: '1px solid var(--finesse-surface-border)',
    borderRadius: '3px',
    background: 'color-mix(in srgb, var(--finesse-surface-fg) 8%, transparent)',
    color: 'inherit',
    font: '10px/1 var(--finesse-mono)',
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // ignore
  }
}
