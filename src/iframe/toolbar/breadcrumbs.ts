/**
 * Breadcrumb strip for the floating format toolbar. Renders the active block's
 * ancestor chain (shallow → deep) plus the block itself as a compact trail.
 * Clicking an ancestor crumb commits the in-progress edit and jumps selection.
 *
 * When the trail is too wide to fit the toolbar's width, leftmost ancestors
 * are collapsed behind a `…` overflow button that opens a small popover
 * listing the hidden crumbs.
 */

import type { AncestorRef } from '../../shared/protocol';
import type { EditSession } from '../editSession';

export interface CrumbsHandle {
  /** Render crumbs for the given active block, or clear when null. */
  sync(activeBlock: HTMLElement | null): void;
  /** Recompute overflow layout (call after width changes / reposition). */
  refit(): void;
  destroy(): void;
}

export interface SetupCrumbsOpts {
  /** Mount point inside the toolbar root. */
  container: HTMLElement;
  session: EditSession;
  /** Called when the user picks an ancestor crumb. */
  onPick: (elementId: number) => void;
}

interface CrumbEntry {
  ref: AncestorRef;
  node: HTMLButtonElement;
  sep: HTMLSpanElement;
}

export function setupCrumbs(opts: SetupCrumbsOpts): CrumbsHandle {
  const { container, session, onPick } = opts;

  const overflowBtn = document.createElement('button');
  overflowBtn.type = 'button';
  overflowBtn.className = 'finesse-crumb-overflow';
  overflowBtn.textContent = '…';
  overflowBtn.title = 'Show hidden ancestors';
  overflowBtn.setAttribute('aria-haspopup', 'menu');
  overflowBtn.setAttribute('aria-expanded', 'false');
  overflowBtn.style.display = 'none';
  overflowBtn.addEventListener('mousedown', (e) => e.preventDefault());
  overflowBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
  });

  const overflowSep = document.createElement('span');
  overflowSep.className = 'finesse-crumb-sep';
  overflowSep.textContent = '›';
  overflowSep.setAttribute('aria-hidden', 'true');
  overflowSep.style.display = 'none';

  const menu = document.createElement('div');
  menu.className = 'finesse-crumb-menu';
  menu.setAttribute('role', 'menu');
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  document.body.appendChild(menu);

  let entries: CrumbEntry[] = [];
  let leaf: HTMLSpanElement | null = null;
  let hiddenRefs: AncestorRef[] = [];

  function clearChildren(): void {
    container.replaceChildren();
    entries = [];
    leaf = null;
    hiddenRefs = [];
    closeMenu();
  }

  function sync(activeBlock: HTMLElement | null): void {
    clearChildren();
    if (!activeBlock) return;

    const ancestors = session.collectAncestors(activeBlock);
    container.appendChild(overflowBtn);
    container.appendChild(overflowSep);

    for (const ref of ancestors) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'finesse-crumb';
      node.textContent = labelFor(ref.tagName, ref.id, ref.classList);
      node.title = titleFor(ref.tagName, ref.id, ref.classList);
      node.addEventListener('mousedown', (e) => e.preventDefault());
      node.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        onPick(ref.elementId);
      });
      const sep = document.createElement('span');
      sep.className = 'finesse-crumb-sep';
      sep.textContent = '›';
      sep.setAttribute('aria-hidden', 'true');
      container.appendChild(node);
      container.appendChild(sep);
      entries.push({ ref, node, sep });
    }

    leaf = document.createElement('span');
    leaf.className = 'finesse-crumb finesse-crumb-leaf';
    const tag = activeBlock.tagName.toLowerCase();
    const id = activeBlock.id || undefined;
    const classes = classListFor(activeBlock);
    leaf.textContent = labelFor(tag, id, classes);
    leaf.title = titleFor(tag, id, classes);
    leaf.setAttribute('aria-current', 'true');
    container.appendChild(leaf);

    refit();
  }

  function refit(): void {
    if (entries.length === 0) {
      overflowBtn.style.display = 'none';
      overflowSep.style.display = 'none';
      return;
    }
    // Reveal everything first so we can measure with the most generous layout.
    for (const e of entries) {
      e.node.style.display = '';
      e.sep.style.display = '';
    }
    overflowBtn.style.display = 'none';
    overflowSep.style.display = 'none';
    hiddenRefs = [];

    if (container.scrollWidth <= container.clientWidth) return;

    // Overflowing — show the `…` button and hide leftmost crumbs one by one
    // until it fits. Keep at least the deepest ancestor + leaf visible.
    overflowBtn.style.display = '';
    overflowSep.style.display = '';
    for (let i = 0; i < entries.length - 1; i++) {
      if (container.scrollWidth <= container.clientWidth) break;
      entries[i].node.style.display = 'none';
      entries[i].sep.style.display = 'none';
      hiddenRefs.push(entries[i].ref);
    }
    if (hiddenRefs.length === 0) {
      // No room saved — hide the overflow chrome since nothing's collapsed.
      overflowBtn.style.display = 'none';
      overflowSep.style.display = 'none';
    }
  }

  function toggleMenu(): void {
    if (menu.dataset.open === 'true') {
      closeMenu();
      return;
    }
    if (hiddenRefs.length === 0) return;
    menu.replaceChildren();
    for (const ref of hiddenRefs) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'finesse-crumb-menu-item';
      item.textContent = titleFor(ref.tagName, ref.id, ref.classList);
      item.setAttribute('role', 'menuitem');
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        onPick(ref.elementId);
      });
      menu.appendChild(item);
    }
    const r = overflowBtn.getBoundingClientRect();
    menu.style.left = `${Math.round(r.left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.dataset.open = 'true';
    overflowBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
  }

  function closeMenu(): void {
    if (menu.dataset.open !== 'true') return;
    menu.dataset.open = 'false';
    overflowBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  }

  function onDocMouseDown(e: MouseEvent): void {
    const target = e.target as Node | null;
    if (target && (menu.contains(target) || overflowBtn.contains(target))) return;
    closeMenu();
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') closeMenu();
  }

  function destroy(): void {
    closeMenu();
    menu.remove();
    clearChildren();
  }

  return { sync, refit, destroy };
}

function classListFor(el: HTMLElement): string[] | undefined {
  const raw = el.getAttribute('class');
  if (!raw) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : undefined;
}

function labelFor(tag: string, id: string | undefined, classes: string[] | undefined): string {
  if (id) return `${tag}#${id}`;
  if (classes && classes.length > 0) return `${tag}.${classes[0]}`;
  return tag;
}

function titleFor(tag: string, id: string | undefined, classes: string[] | undefined): string {
  const parts = [tag];
  if (id) parts.push(`#${id}`);
  if (classes) for (const c of classes) parts.push(`.${c}`);
  return parts.join('');
}
