import type {
  ElementSelectionSnapshot,
  FileMeta,
  HostMessage,
  IframeMessage,
  PanelCssEdit,
  PanelStyleEdit,
  WebviewActionMessage,
} from '../shared/protocol';
import { setupSidePanel, type SidePanelController } from './stylePanel';
import { setupAgentPanel, type AgentPanelController } from './agentPanel';
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
    __FINESSE_INIT__?: InitData;
  }
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const init = window.__FINESSE_INIT__;

const banners = document.getElementById('banners');
if (banners) initBanners(banners);

if (!init) {
  showRuntimeErrorBanner('init data missing (window.__FINESSE_INIT__)');
} else {
  initStatus(
    {
      file: init.fileMeta.path,
      version: 0,
      port: init.port,
      locked: init.fileMeta.isTemplated,
      isDirty: false,
      autoSave: true,
      canUndo: false,
      canRedo: false,
      selectedLabel: undefined,
      agentRunning: false,
    },
    {
      onSave: requestSave,
      onDiscard: requestDiscard,
      onToggleAutoSave: (next) => requestSetAutoSave(next),
      onUndo: requestUndo,
      onRedo: requestRedo,
    },
  );
  if (init.fileMeta.isTemplated) {
    showTemplatedBanner({ onEditAnyway: requestEditAnyway });
  }
  bootIframe(init);
}

function post(msg: WebviewActionMessage): void {
  vscode.postMessage(msg);
}

function requestEditAnyway(): void {
  post({ type: '__webview_action', action: 'editAnyway' });
}

function requestSave(): void {
  post({ type: '__webview_action', action: 'save' });
}

function requestDiscard(): void {
  post({ type: '__webview_action', action: 'discard' });
}

function requestSetAutoSave(value: boolean): void {
  post({ type: '__webview_action', action: 'setAutoSave', value });
}

function requestUndo(): void {
  post({ type: '__webview_action', action: 'undo' });
}

function requestRedo(): void {
  post({ type: '__webview_action', action: 'redo' });
}

function requestCommandPalette(): void {
  post({ type: '__webview_action', action: 'commandPalette' });
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

  // Mount the right-hand side dock: style panel on top (fills available space),
  // agent panel pinned to the bottom. The style panel posts PanelStyleEdit
  // messages directly into the iframe; the iframe applies optimistically and
  // forwards the canonical commit to the host.
  const dock = document.getElementById('side-dock');
  let sidePanel: SidePanelController | null = null;
  let agentPanel: AgentPanelController | null = null;
  if (dock) {
    sidePanel = setupSidePanel({
      host: dock,
      sender: {
        toIframe(msg: PanelStyleEdit | PanelCssEdit) {
          postToIframe(msg);
        },
      },
    });
    sidePanel.setLocked(init.fileMeta.isTemplated);
    agentPanel = setupAgentPanel({
      host: dock,
      actions: {
        onOpenDashboard: () => post({ type: '__webview_action', action: 'openCursorDashboard' }),
        onSaveApiKey: (value) => post({ type: '__webview_action', action: 'saveApiKey', value }),
        onForgetApiKey: () => post({ type: '__webview_action', action: 'forgetApiKey' }),
        onRunAgent: (value) => {
          agentPanel?.clearLog();
          post({ type: '__webview_action', action: 'runAgent', value });
        },
      },
    });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source === frame.contentWindow) {
      handleIframeMessage(event.data);
      return;
    }
    handleHostMessage(event.data);
  });

  function postToIframe(msg: unknown): void {
    const win = frame.contentWindow;
    if (!win) return;
    try {
      win.postMessage(msg, iframeOrigin);
    } catch {
      // best-effort
    }
  }

  function relayToIframe(msg: HostMessage): void {
    postToIframe(msg);
  }

  function handleIframeMessage(data: unknown): void {
    if (!isIframeMessage(data)) return;
    if (data.type === 'runtimeError') {
      showRuntimeErrorBanner(data.message);
    }
    if (data.type === 'elementSelectionChanged') {
      sidePanel?.setSelection(data.selection as ElementSelectionSnapshot | null);
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
        sidePanel?.setLocked(data.isTemplated);
        if (data.isTemplated) {
          showTemplatedBanner({ onEditAnyway: requestEditAnyway });
        } else {
          dismissAll();
        }
        relayToIframe(data);
        break;
      case 'documentState':
        updateStatus({
          isDirty: data.isDirty,
          autoSave: data.autoSave,
          canUndo: data.canUndo,
          canRedo: data.canRedo,
        });
        break;
      case 'agentSelectionState':
        updateStatus({
          selectedLabel: data.selected ? data.label : undefined,
          agentRunning: data.agentRunning,
        });
        agentPanel?.setState({
          selectedLabel: data.selected ? data.label : undefined,
          agentRunning: data.agentRunning,
        });
        break;
      case 'agentConnectionState':
        agentPanel?.setState({
          connected: data.connected,
          connectionSource: data.source,
        });
        break;
      case 'agentRunStatus':
        switch (data.phase) {
          case 'starting':
            agentPanel?.clearLog();
            if (data.text) agentPanel?.appendLog(`${data.text}\n`);
            break;
          case 'status':
            if (data.text) agentPanel?.appendLog(`[${data.text}]\n`);
            break;
          case 'output':
            if (data.text) agentPanel?.appendLog(data.text);
            break;
          case 'done':
            agentPanel?.appendLog('\n— done —\n');
            break;
          case 'error':
            agentPanel?.setError(data.text ?? 'Agent run failed.');
            break;
        }
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
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) requestRedo();
      else requestUndo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      requestRedo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      requestCommandPalette();
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
    t === 'editBlockHtml' ||
    t === 'editBlockTag' ||
    t === 'editElementAttrs' ||
    t === 'editCancel' ||
    t === 'runtimeError' ||
    t === 'ready' ||
    t === 'saveRequest' ||
    t === 'undoRequest' ||
    t === 'redoRequest' ||
    t === 'commandPaletteRequest' ||
    t === 'elementSelectionChanged'
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
    t === 'documentState' ||
    t === 'agentSelectionState' ||
    t === 'agentConnectionState' ||
    t === 'agentRunStatus'
  );
}
