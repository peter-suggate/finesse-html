/**
 * Format toolbar controller — wires the toolbar DOM to the EditSession.
 *
 * Responsibilities:
 *   - Show on edit-begin, hide on edit-end.
 *   - Reposition on selectionchange / scroll / resize.
 *   - Reflect the current selection's formatting state on toggle buttons.
 *   - Hand off button clicks to the action layer (Phase 3+).
 */

import type { EditSession, EditState } from '../editSession';
import { buildToolbar, type ButtonSpec, type ToolbarHandle } from './element';
import { ICONS } from './icons';
import { computeToolbarPosition, selectionRect, type Rect } from './positioning';

export type ToolbarActionName =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'clear'
  | 'block'
  | 'fontWeight'
  | 'delete';

export interface ToolbarActionContext {
  /** The editable block the action targets. */
  block: HTMLElement;
  /** Live blockId for the active block. */
  blockId: number;
  /** Toolbar handle (e.g. so an action can refresh active states). */
  toolbar: ToolbarHandle;
}

export interface ToolbarActionHandler {
  (
    name: ToolbarActionName,
    value: string | undefined,
    ctx: ToolbarActionContext,
  ): void;
}

export interface ToolbarRefreshHandler {
  (ctx: ToolbarActionContext, selection: Selection | null): void;
}

export interface SetupToolbarOpts {
  session: EditSession;
  /** Custom button spec; falls back to the canonical Notion-like set. */
  specs?: readonly ButtonSpec[];
  /** Called on each user button click while editing. */
  onAction?: ToolbarActionHandler;
  /** Called on selectionchange while editing — to refresh active states. */
  onRefresh?: ToolbarRefreshHandler;
}

export const DEFAULT_SPECS: readonly ButtonSpec[] = [
  {
    name: 'block',
    kind: 'select',
    label: 'Block style',
    options: [
      { value: 'p', label: 'Paragraph' },
      { value: 'h1', label: 'Heading 1' },
      { value: 'h2', label: 'Heading 2' },
      { value: 'h3', label: 'Heading 3' },
      { value: 'blockquote', label: 'Quote' },
    ],
  },
  { name: 'sep1', kind: 'separator', label: '' },
  {
    name: 'fontWeight',
    kind: 'select',
    label: 'Font weight',
    options: [
      { value: '400', label: 'Regular' },
      { value: '100', label: 'Thin' },
      { value: '200', label: 'Extra Light' },
      { value: '300', label: 'Light' },
      { value: '500', label: 'Medium' },
      { value: '600', label: 'Semibold' },
      { value: '700', label: 'Bold' },
      { value: '800', label: 'Extra Bold' },
      { value: '900', label: 'Black' },
    ],
  },
  { name: 'sepWeight', kind: 'separator', label: '' },
  { name: 'bold', kind: 'toggle', label: 'Bold', icon: ICONS.bold, shortcut: '⌘B' },
  { name: 'italic', kind: 'toggle', label: 'Italic', icon: ICONS.italic, shortcut: '⌘I' },
  { name: 'underline', kind: 'toggle', label: 'Underline', icon: ICONS.underline, shortcut: '⌘U' },
  { name: 'strike', kind: 'toggle', label: 'Strikethrough', icon: ICONS.strike },
  { name: 'code', kind: 'toggle', label: 'Inline code', icon: ICONS.code, shortcut: '⌘E' },
  { name: 'sep2', kind: 'separator', label: '' },
  { name: 'link', kind: 'action', label: 'Link', icon: ICONS.link, shortcut: '⌘K' },
  { name: 'clear', kind: 'action', label: 'Clear formatting', icon: ICONS.clear },
  { name: 'sep3', kind: 'separator', label: '' },
  { name: 'delete', kind: 'action', label: 'Delete element', icon: ICONS.trash },
];

export interface ToolbarController {
  toolbar: ToolbarHandle;
  /** Force a reposition (e.g. after the host has restored layout). */
  reposition(): void;
  destroy(): void;
}

export function setupFormatToolbar(opts: SetupToolbarOpts): ToolbarController {
  const specs = opts.specs ?? DEFAULT_SPECS;
  const toolbar = buildToolbar(specs);
  let activeBlock: HTMLElement | null = null;
  let activeBlockId: number | null = null;
  let rafScheduled = false;

  function ctx(): ToolbarActionContext | null {
    if (!activeBlock || activeBlockId === null) return null;
    return { block: activeBlock, blockId: activeBlockId, toolbar };
  }

  function reposition(): void {
    if (!activeBlock) return;
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      if (!activeBlock) return;
      const sel = window.getSelection();
      const selRect = selectionRect(sel);
      const blockRect = activeBlock.getBoundingClientRect();
      const anchor: Rect = selRect ?? {
        left: blockRect.left,
        top: blockRect.top,
        width: blockRect.width,
        height: blockRect.height,
      };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const tbRect = toolbar.root.getBoundingClientRect();
      const size = {
        width: tbRect.width || 320,
        height: tbRect.height || 36,
      };
      const pos = computeToolbarPosition({ anchor, viewport, toolbar: size });
      toolbar.root.style.left = `${pos.left}px`;
      toolbar.root.style.top = `${pos.top}px`;
      toolbar.root.dataset.placement = pos.placement;
    });
  }

  function refreshActive(): void {
    const c = ctx();
    if (!c) return;
    const sel = window.getSelection();
    if (opts.onRefresh) opts.onRefresh(c, sel);
  }

  function fireToolbarAction(name: ToolbarActionName, value?: string): void {
    const c = ctx();
    if (!c) return;
    if (opts.onAction) opts.onAction(name, value, c);
    if (name === 'delete') return;
    if (document.activeElement !== c.block) {
      c.block.focus({ preventScroll: true });
    }
    refreshActive();
    reposition();
  }

  toolbar.onAction((name, value) => {
    fireToolbarAction(name as ToolbarActionName, value);
  });

  // Keyboard shortcuts. Mac uses ⌘; other platforms use Ctrl.
  function onKeyDown(e: KeyboardEvent): void {
    if (!activeBlock) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.altKey) return;
    const key = e.key.toLowerCase();
    let action: ToolbarActionName | null = null;
    if (key === 'b') action = 'bold';
    else if (key === 'i') action = 'italic';
    else if (key === 'u') action = 'underline';
    else if (key === 'k') action = 'link';
    else if (key === 'e') action = 'code';
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    fireToolbarAction(action);
  }
  document.addEventListener('keydown', onKeyDown);

  function onSelectionChange(): void {
    if (!activeBlock) return;
    refreshActive();
    reposition();
  }

  function onScrollOrResize(): void {
    if (!activeBlock) return;
    reposition();
  }

  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);

  const unsubscribe = opts.session.onEditStateChange((state: EditState) => {
    if (state.kind === 'editing') {
      activeBlock = state.block;
      activeBlockId = state.blockId;
      toolbar.show();
      // Wait one frame so getBoundingClientRect reflects any layout change.
      requestAnimationFrame(() => {
        reposition();
        refreshActive();
      });
    } else {
      activeBlock = null;
      activeBlockId = null;
      toolbar.hide();
    }
  });

  return {
    toolbar,
    reposition,
    destroy() {
      unsubscribe();
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      toolbar.destroy();
    },
  };
}
