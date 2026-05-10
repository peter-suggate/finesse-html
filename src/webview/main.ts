import type { FileMeta, HostMessage, IframeMessage } from '../shared/protocol';
import {
  dismissAll,
  initBanners,
  showRuntimeErrorBanner,
  showStaleReloadBanner,
  showTemplatedBanner,
} from './banners';
import { initStatus, updateStatus } from './status';

interface InitData {
  iframeUrl: string;
  fileMeta: FileMeta;
  port: number;
}

declare global {
  interface Window {
    __HTML_WYSIWYG_INIT__?: InitData;
  }
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare const acquireVsCodeApi: () => VsCodeApi;

interface WebviewActionMessage {
  type: '__webview_action';
  action: 'editAnyway' | 'save' | 'discard' | 'setAutoSave';
  value?: boolean;
}

const vscode = acquireVsCodeApi();
const init = window.__HTML_WYSIWYG_INIT__;

const banners = document.getElementById('banners');
if (banners) initBanners(banners);

if (!init) {
  showRuntimeErrorBanner('init data missing (window.__HTML_WYSIWYG_INIT__)');
} else {
  initStatus(
    {
      file: init.fileMeta.path,
      version: 0,
      port: init.port,
      locked: init.fileMeta.isTemplated,
      isDirty: false,
      autoSave: false,
    },
    {
      onSave: requestSave,
      onDiscard: requestDiscard,
      onToggleAutoSave: (next) => requestSetAutoSave(next),
    },
  );
  if (init.fileMeta.isTemplated) {
    showTemplatedBanner({ onEditAnyway: requestEditAnyway });
  }
  bootIframe(init);
}

function requestEditAnyway(): void {
  const msg: WebviewActionMessage = { type: '__webview_action', action: 'editAnyway' };
  vscode.postMessage(msg);
}

function requestSave(): void {
  const msg: WebviewActionMessage = { type: '__webview_action', action: 'save' };
  vscode.postMessage(msg);
}

function requestDiscard(): void {
  const msg: WebviewActionMessage = { type: '__webview_action', action: 'discard' };
  vscode.postMessage(msg);
}

function requestSetAutoSave(value: boolean): void {
  const msg: WebviewActionMessage = { type: '__webview_action', action: 'setAutoSave', value };
  vscode.postMessage(msg);
}

function bootIframe(init: InitData): void {
  const found = document.getElementById('frame') as HTMLIFrameElement | null;
  if (!found) {
    showRuntimeErrorBanner('iframe element missing from webview HTML');
    return;
  }
  const frame: HTMLIFrameElement = found;
  const iframeOrigin = new URL(init.iframeUrl).origin;
  frame.src = init.iframeUrl;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source === frame.contentWindow) {
      handleIframeMessage(event.data);
      return;
    }
    handleHostMessage(event.data);
  });

  function relayToIframe(msg: HostMessage): void {
    const win = frame.contentWindow;
    if (!win) return;
    try {
      win.postMessage(msg, iframeOrigin);
    } catch {
      // best-effort
    }
  }

  function handleIframeMessage(data: unknown): void {
    if (!isIframeMessage(data)) return;
    if (data.type === 'runtimeError') {
      showRuntimeErrorBanner(data.message);
    }
    vscode.postMessage(data);
  }

  function handleHostMessage(data: unknown): void {
    if (!isHostMessage(data)) return;
    switch (data.type) {
      case 'offsetMap':
        updateStatus({ version: data.documentVersion });
        relayToIframe(data);
        break;
      case 'editAck':
        updateStatus({ version: data.documentVersion });
        relayToIframe(data);
        break;
      case 'reload':
        if (data.reason === 'external-edit') showStaleReloadBanner();
        relayToIframe(data);
        break;
      case 'staleCommit':
        relayToIframe(data);
        break;
      case 'fileMeta':
        updateStatus({ locked: data.isTemplated });
        if (data.isTemplated) {
          showTemplatedBanner({ onEditAnyway: requestEditAnyway });
        } else {
          dismissAll();
        }
        relayToIframe(data);
        break;
      case 'documentState':
        updateStatus({ isDirty: data.isDirty, autoSave: data.autoSave });
        break;
    }
  }
}

window.addEventListener(
  'keydown',
  (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      requestSave();
    }
  },
  true,
);

function isIframeMessage(data: unknown): data is IframeMessage {
  if (!data || typeof data !== 'object') return false;
  const t = (data as { type?: unknown }).type;
  return (
    t === 'editCommit' ||
    t === 'editRemove' ||
    t === 'editCancel' ||
    t === 'runtimeError' ||
    t === 'ready' ||
    t === 'saveRequest'
  );
}

function isHostMessage(data: unknown): data is HostMessage {
  if (!data || typeof data !== 'object') return false;
  const t = (data as { type?: unknown }).type;
  return (
    t === 'offsetMap' ||
    t === 'editAck' ||
    t === 'reload' ||
    t === 'staleCommit' ||
    t === 'fileMeta' ||
    t === 'documentState'
  );
}
