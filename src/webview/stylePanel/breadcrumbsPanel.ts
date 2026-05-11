/**
 * "Breadcrumbs" widget for the side panel — renders the ancestor chain of the
 * currently selected element as a compact horizontal trail. Clicking a crumb
 * asks the iframe to re-select that ancestor via {@link onPick}, letting users
 * drill UP from a deeply selected element.
 *
 * Lives outside the `<details>` body so it stays visible regardless of which
 * sections are collapsed.
 */

import type { AncestorRef, ElementSelectionSnapshot } from '../../shared/protocol';

export interface BreadcrumbsHandle {
  root: HTMLElement;
  sync(selection: ElementSelectionSnapshot | null): void;
}

export function breadcrumbsBar(onPick: (elementId: number) => void): BreadcrumbsHandle {
  const root = document.createElement('nav');
  root.className = 'sp-breadcrumbs';
  root.setAttribute('aria-label', 'Selection ancestors');

  const list = document.createElement('div');
  list.className = 'sp-breadcrumbs-list';
  root.appendChild(list);

  function sync(selection: ElementSelectionSnapshot | null): void {
    list.replaceChildren();
    if (!selection) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const ancestors = selection.ancestors ?? [];
    // Render shallow → deep, then the selected leaf as a non-clickable chip.
    for (let i = 0; i < ancestors.length; i++) {
      list.appendChild(crumb(ancestors[i], onPick));
      list.appendChild(separator());
    }
    list.appendChild(leaf(selection));
  }

  return { root, sync };
}

function crumb(ref: AncestorRef, onPick: (elementId: number) => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sp-crumb';
  btn.textContent = labelFor(ref.tagName, ref.id, ref.classList);
  btn.title = titleFor(ref.tagName, ref.id, ref.classList);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    onPick(ref.elementId);
  });
  return btn;
}

function leaf(selection: ElementSelectionSnapshot): HTMLElement {
  const node = document.createElement('span');
  node.className = 'sp-crumb sp-crumb-leaf';
  const id = pickId(selection);
  node.textContent = labelFor(selection.tagName, id, selection.classList);
  node.title = titleFor(selection.tagName, id, selection.classList);
  node.setAttribute('aria-current', 'true');
  return node;
}

function separator(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'sp-crumb-sep';
  sep.setAttribute('aria-hidden', 'true');
  sep.textContent = '›';
  return sep;
}

function pickId(selection: ElementSelectionSnapshot): string | undefined {
  for (const hint of selection.selectorHints) {
    if (hint.startsWith('#')) return hint.slice(1);
  }
  return undefined;
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
