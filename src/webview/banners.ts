let container: HTMLElement | null = null;
let templatedShown = false;

export function initBanners(el: HTMLElement): void {
  container = el;
}

interface BannerOpts {
  kind: 'warn' | 'error' | 'info';
  text: string;
  dataKind?: string;
  action?: { label: string; onClick: () => void };
  dismissAfterMs?: number;
  dismissible?: boolean;
}

function build(opts: BannerOpts): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `banner${opts.kind === 'warn' ? ' banner-warn' : opts.kind === 'error' ? ' banner-error' : ''}`;
  if (opts.dataKind) div.dataset.kind = opts.dataKind;
  const msg = document.createElement('span');
  msg.textContent = opts.text;
  div.appendChild(msg);
  if (opts.action) {
    const btn = document.createElement('button');
    btn.textContent = opts.action.label;
    btn.addEventListener('click', opts.action.onClick);
    div.appendChild(btn);
  }
  if (opts.dismissible !== false) {
    const dismiss = document.createElement('span');
    dismiss.className = 'dismiss';
    dismiss.textContent = '×';
    dismiss.setAttribute('role', 'button');
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.addEventListener('click', () => div.remove());
    div.appendChild(dismiss);
  }
  if (opts.dismissAfterMs) {
    setTimeout(() => div.remove(), opts.dismissAfterMs);
  }
  return div;
}

export function showTemplatedBanner(opts: { onEditAnyway: () => void }): void {
  if (!container || templatedShown) return;
  templatedShown = true;
  const banner = build({
    kind: 'warn',
    dataKind: 'templated',
    text: 'Finesse editing disabled: template syntax detected. Preview only.',
    action: { label: 'Edit anyway', onClick: opts.onEditAnyway },
  });
  banner.addEventListener('DOMNodeRemoved', () => {
    templatedShown = false;
  });
  container.appendChild(banner);
}

export function showStaleReloadBanner(): void {
  if (!container) return;
  container
    .querySelectorAll('[data-kind="stale-reload"]')
    .forEach((existing) => existing.remove());
  const banner = build({
    kind: 'info',
    dataKind: 'stale-reload',
    text: 'Source changed elsewhere; preview reloaded.',
    dismissAfterMs: 4000,
  });
  container.appendChild(banner);
}

export function showUnsavedChangesBanner(opts: { onSave: () => void }): void {
  if (!container) return;
  if (container.querySelector('[data-kind="unsaved-changes"]')) return;
  const banner = build({
    kind: 'warn',
    dataKind: 'unsaved-changes',
    text: 'Unsaved changes in this file. Save before closing Finesse or switching tasks.',
    action: { label: 'Save now', onClick: opts.onSave },
    dismissible: false,
  });
  container.appendChild(banner);
}

export function dismissUnsavedChangesBanner(): void {
  if (!container) return;
  container
    .querySelectorAll('[data-kind="unsaved-changes"]')
    .forEach((existing) => existing.remove());
}

export function showRuntimeErrorBanner(message: string): void {
  if (!container) return;
  const banner = build({
    kind: 'error',
    dataKind: 'runtime-error',
    text: `Runtime error: ${message}`,
  });
  container.appendChild(banner);
}

export function showPreviewLoadErrorBanner(opts: {
  status: number;
  detail: string;
  iframeUrl: string;
  onRetry?: () => void;
}): void {
  if (!container) return;
  container
    .querySelectorAll('[data-kind="preview-load-error"]')
    .forEach((existing) => existing.remove());
  const statusLabel = opts.status > 0 ? `HTTP ${opts.status}` : 'connection failed';
  const detail = opts.detail.trim().slice(0, 400) || '(no response body)';
  const banner = build({
    kind: 'error',
    dataKind: 'preview-load-error',
    text: `Preview didn't load (${statusLabel}): ${detail}`,
    action: opts.onRetry ? { label: 'Retry', onClick: opts.onRetry } : undefined,
  });
  container.appendChild(banner);
}

export function dismissPreviewLoadErrorBanner(): void {
  if (!container) return;
  container
    .querySelectorAll('[data-kind="preview-load-error"]')
    .forEach((existing) => existing.remove());
}

export function showEditFailedBanner(message: string): void {
  if (!container) return;
  container
    .querySelectorAll('[data-kind="edit-failed"]')
    .forEach((existing) => existing.remove());
  const banner = build({
    kind: 'warn',
    dataKind: 'edit-failed',
    text: message,
  });
  container.appendChild(banner);
}

export function dismissAll(): void {
  if (!container) return;
  container.innerHTML = '';
  templatedShown = false;
}
