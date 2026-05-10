/**
 * DOM builder for the floating format toolbar.
 *
 * Pure-ish: takes a button spec, returns the DOM nodes plus a small handle for
 * driving them. No knowledge of the edit session or formatting semantics —
 * the controller layer wires those.
 */

export const TOOLBAR_ID = 'finesse-toolbar';

export type ButtonKind = 'toggle' | 'action' | 'separator' | 'select';

export interface ButtonSpec {
  /** Stable id (e.g. "bold", "italic"). */
  name: string;
  kind: ButtonKind;
  label: string;
  /** Inline SVG (preferred) or text glyph. */
  icon?: string;
  /** Keyboard shortcut hint, displayed in title. */
  shortcut?: string;
  /** Only used when kind === 'select'; e.g. paragraph/heading. */
  options?: Array<{ value: string; label: string }>;
}

export interface ToolbarHandle {
  root: HTMLDivElement;
  buttons: Map<string, HTMLElement>;
  setActive(name: string, on: boolean): void;
  setSelectValue(name: string, value: string): void;
  show(): void;
  hide(): void;
  isVisible(): boolean;
  /** Attach a click handler that fires with (name, value?) and prevents focus theft. */
  onAction(handler: (name: string, value?: string) => void): void;
  destroy(): void;
}

const CSS = `
.finesse-toolbar-root {
  position: fixed;
  z-index: 2147483645;
  display: none;
  align-items: center;
  gap: 1px;
  padding: 4px;
  background: rgba(28, 28, 30, 0.96);
  color: #f5f5f7;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  box-shadow:
    0 6px 24px rgba(0, 0, 0, 0.28),
    0 1px 2px rgba(0, 0, 0, 0.18);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1;
  user-select: none;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 120ms ease-out, transform 120ms ease-out;
  -webkit-font-smoothing: antialiased;
}
.finesse-toolbar-root[data-visible="true"] {
  opacity: 1;
  transform: translateY(0);
}
.finesse-toolbar-root[data-placement="below"] {
  transform: translateY(-4px);
}
.finesse-toolbar-root[data-placement="below"][data-visible="true"] {
  transform: translateY(0);
}
.finesse-toolbar-btn {
  appearance: none;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: #d8d8dc;
  cursor: pointer;
  transition: background 80ms ease-out, color 80ms ease-out;
}
.finesse-toolbar-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}
.finesse-toolbar-btn[aria-pressed="true"] {
  background: rgba(74, 144, 226, 0.22);
  color: #6cb0ff;
}
.finesse-toolbar-btn[aria-pressed="true"]:hover {
  background: rgba(74, 144, 226, 0.32);
  color: #8fc4ff;
}
.finesse-toolbar-btn:focus-visible {
  outline: 2px solid #6cb0ff;
  outline-offset: 1px;
}
.finesse-toolbar-btn svg {
  width: 16px;
  height: 16px;
  display: block;
  pointer-events: none;
}
.finesse-toolbar-sep {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.12);
  margin: 0 3px;
}
.finesse-toolbar-select {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: none;
  color: #d8d8dc;
  font: inherit;
  font-size: 12.5px;
  height: 28px;
  padding: 0 22px 0 8px;
  border-radius: 5px;
  cursor: pointer;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='%23d8d8dc' d='M2 4l3 3 3-3z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 6px center;
}
.finesse-toolbar-select:hover {
  background-color: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}
.finesse-toolbar-select:focus-visible {
  outline: 2px solid #6cb0ff;
  outline-offset: 1px;
}
.finesse-toolbar-select option {
  background: #1c1c1e;
  color: #f5f5f7;
}
@media (prefers-color-scheme: light) {
  .finesse-toolbar-root {
    background: rgba(255, 255, 255, 0.98);
    color: #1c1c1e;
    border-color: rgba(0, 0, 0, 0.08);
    box-shadow:
      0 6px 24px rgba(0, 0, 0, 0.12),
      0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .finesse-toolbar-btn { color: #4a4a4f; }
  .finesse-toolbar-btn:hover { background: rgba(0, 0, 0, 0.06); color: #1c1c1e; }
  .finesse-toolbar-btn[aria-pressed="true"] {
    background: rgba(30, 111, 217, 0.14);
    color: #1e6fd9;
  }
  .finesse-toolbar-btn[aria-pressed="true"]:hover {
    background: rgba(30, 111, 217, 0.22);
  }
  .finesse-toolbar-sep { background: rgba(0, 0, 0, 0.10); }
  .finesse-toolbar-select { color: #4a4a4f; }
  .finesse-toolbar-select:hover { background-color: rgba(0, 0, 0, 0.06); color: #1c1c1e; }
  .finesse-toolbar-select option { background: #ffffff; color: #1c1c1e; }
  .finesse-toolbar-select {
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='%234a4a4f' d='M2 4l3 3 3-3z'/></svg>");
  }
}
`;

let cssInjected = false;
function ensureStyle(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'finesse-toolbar-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function buildToolbar(specs: readonly ButtonSpec[]): ToolbarHandle {
  ensureStyle();
  const root = document.createElement('div');
  root.id = TOOLBAR_ID;
  root.className = 'finesse-toolbar-root';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Text formatting');
  root.dataset.visible = 'false';
  root.dataset.placement = 'above';

  const buttons = new Map<string, HTMLElement>();
  const handlers: Array<(name: string, value?: string) => void> = [];

  function fireAction(name: string, value?: string): void {
    for (const h of handlers) h(name, value);
  }

  for (const spec of specs) {
    if (spec.kind === 'separator') {
      const sep = document.createElement('span');
      sep.className = 'finesse-toolbar-sep';
      sep.setAttribute('aria-hidden', 'true');
      root.appendChild(sep);
      continue;
    }
    if (spec.kind === 'select') {
      const select = document.createElement('select');
      select.className = 'finesse-toolbar-select';
      select.dataset.name = spec.name;
      select.title = spec.label;
      select.setAttribute('aria-label', spec.label);
      for (const opt of spec.options ?? []) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      // Don't let the select steal focus on mousedown — keep selection intact.
      select.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      select.addEventListener('change', () => {
        fireAction(spec.name, select.value);
      });
      buttons.set(spec.name, select);
      root.appendChild(select);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'finesse-toolbar-btn';
    btn.dataset.name = spec.name;
    btn.title = spec.shortcut ? `${spec.label} (${spec.shortcut})` : spec.label;
    btn.setAttribute('aria-label', spec.label);
    if (spec.kind === 'toggle') btn.setAttribute('aria-pressed', 'false');
    if (spec.icon) btn.innerHTML = spec.icon;
    btn.addEventListener('mousedown', (e) => {
      // Crucial: prevent focus theft so the editable block keeps its caret.
      e.preventDefault();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fireAction(spec.name);
    });
    buttons.set(spec.name, btn);
    root.appendChild(btn);
  }

  document.body.appendChild(root);

  return {
    root,
    buttons,
    setActive(name, on) {
      const el = buttons.get(name);
      if (!el) return;
      if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', on ? 'true' : 'false');
    },
    setSelectValue(name, value) {
      const el = buttons.get(name);
      if (!(el instanceof HTMLSelectElement)) return;
      if (el.value !== value) el.value = value;
    },
    show() {
      root.style.display = 'inline-flex';
      // Force a reflow so the transition runs from the initial state.
      void root.offsetWidth;
      root.dataset.visible = 'true';
    },
    hide() {
      root.dataset.visible = 'false';
      root.style.display = 'none';
    },
    isVisible() {
      return root.dataset.visible === 'true';
    },
    onAction(handler) {
      handlers.push(handler);
    },
    destroy() {
      root.remove();
    },
  };
}
