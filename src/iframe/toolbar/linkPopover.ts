/**
 * Inline link-URL popover. Replaces window.prompt() for a more polished feel.
 *
 * Returns a Promise<string|null> — null on cancel, '' on "remove link",
 * non-empty string on confirm.
 */

const POPOVER_ID = 'html-wysiwyg-link-popover';

const CSS = `
.html-wysiwyg-link-popover {
  position: fixed;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(28, 28, 30, 0.96);
  color: #f5f5f7;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  opacity: 0;
  transform: translateY(2px);
  transition: opacity 100ms ease-out, transform 100ms ease-out;
}
.html-wysiwyg-link-popover[data-visible="true"] {
  opacity: 1;
  transform: translateY(0);
}
.html-wysiwyg-link-popover input {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: inherit;
  font: inherit;
  padding: 4px 8px;
  width: 280px;
  outline: none;
}
.html-wysiwyg-link-popover input:focus {
  border-color: rgba(108, 176, 255, 0.6);
  background: rgba(255, 255, 255, 0.12);
}
.html-wysiwyg-link-popover button {
  appearance: none;
  background: transparent;
  border: none;
  color: #d8d8dc;
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.html-wysiwyg-link-popover button:hover { background: rgba(255, 255, 255, 0.10); color: #fff; }
.html-wysiwyg-link-popover button.primary { color: #6cb0ff; }
.html-wysiwyg-link-popover button.primary:hover { background: rgba(108, 176, 255, 0.16); }
@media (prefers-color-scheme: light) {
  .html-wysiwyg-link-popover {
    background: rgba(255, 255, 255, 0.98);
    color: #1c1c1e;
    border-color: rgba(0, 0, 0, 0.08);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  }
  .html-wysiwyg-link-popover input {
    background: rgba(0, 0, 0, 0.04);
    border-color: rgba(0, 0, 0, 0.10);
  }
  .html-wysiwyg-link-popover input:focus {
    background: rgba(0, 0, 0, 0.06);
    border-color: rgba(30, 111, 217, 0.6);
  }
  .html-wysiwyg-link-popover button { color: #4a4a4f; }
  .html-wysiwyg-link-popover button:hover { background: rgba(0, 0, 0, 0.06); color: #1c1c1e; }
  .html-wysiwyg-link-popover button.primary { color: #1e6fd9; }
  .html-wysiwyg-link-popover button.primary:hover { background: rgba(30, 111, 217, 0.10); }
}
`;

let cssInjected = false;
function ensureStyle(): void {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'html-wysiwyg-link-popover-style';
  style.textContent = CSS;
  document.head.appendChild(style);
}

export interface PromptLinkOpts {
  /** Existing href, or empty string. */
  initialUrl: string;
  /** Anchor rect to position the popover near. */
  anchor: DOMRect;
}

export function promptLink(opts: PromptLinkOpts): Promise<string | null> {
  ensureStyle();
  return new Promise<string | null>((resolve) => {
    const root = document.createElement('div');
    root.id = POPOVER_ID;
    root.className = 'html-wysiwyg-link-popover';
    root.dataset.visible = 'false';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Edit link');

    const input = document.createElement('input');
    input.type = 'url';
    input.value = opts.initialUrl;
    input.placeholder = 'https://...';
    input.setAttribute('aria-label', 'Link URL');
    input.spellcheck = false;
    input.autocomplete = 'off';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.title = 'Remove link';
    if (opts.initialUrl === '') remove.style.display = 'none';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary';
    confirm.textContent = opts.initialUrl ? 'Update' : 'Add';

    root.appendChild(input);
    root.appendChild(remove);
    root.appendChild(confirm);

    const place = (): void => {
      const a = opts.anchor;
      const padding = 8;
      const w = root.offsetWidth || 420;
      const idealLeft = a.left + a.width / 2 - w / 2;
      const left = Math.max(padding, Math.min(idealLeft, window.innerWidth - w - padding));
      const top = Math.max(padding, a.bottom + 8);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };

    document.body.appendChild(root);
    place();
    requestAnimationFrame(() => {
      root.dataset.visible = 'true';
      input.focus();
      input.select();
    });

    function close(value: string | null): void {
      root.dataset.visible = 'false';
      document.removeEventListener('mousedown', onOutside, true);
      setTimeout(() => root.remove(), 120);
      resolve(value);
    }
    function onOutside(e: MouseEvent): void {
      if (!root.contains(e.target as Node)) close(null);
    }
    confirm.addEventListener('mousedown', (e) => e.preventDefault());
    confirm.addEventListener('click', () => close(input.value.trim()));
    remove.addEventListener('mousedown', (e) => e.preventDefault());
    remove.addEventListener('click', () => close(''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        close(input.value.trim());
      }
    });
    document.addEventListener('mousedown', onOutside, true);
  });
}
