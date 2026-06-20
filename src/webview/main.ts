import type {
  ElementSelectionSnapshot,
  FileMeta,
  HostMessage,
  IframeMessage,
  PanelCssEdit,
  PanelSelectElement,
  PanelStyleEdit,
  WebviewActionMessage,
  AgentProviderId,
} from '../shared/protocol';
import { setupSidePanel, type SidePanelController } from './stylePanel';
import { setupAgentPanel, type AgentPanelController } from './agentPanel';
import {
  dismissPreviewLoadErrorBanner,
  dismissAll,
  initBanners,
  showEditFailedBanner,
  showPreviewDiagnosticBanner,
  showPreviewLoadErrorBanner,
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
      canUndo: false,
      canRedo: false,
      selectedLabel: undefined,
      agentRunning: false,
    },
    {
      onSave: requestSave,
      onDiscard: requestDiscard,
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
  let readyReceived = false;
  let probeScheduled = false;

  function loadFrame(): void {
    dismissPreviewLoadErrorBanner();
    readyReceived = false;
    probeScheduled = false;
    frame.src = init.iframeUrl;
    window.setTimeout(() => {
      if (!readyReceived) void probePreviewUrl();
    }, 3000);
  }

  async function probePreviewUrl(): Promise<void> {
    if (readyReceived || probeScheduled) return;
    probeScheduled = true;
    try {
      const res = await fetch(init.iframeUrl, { cache: 'no-store' });
      if (readyReceived) return;
      const body = await res.text().catch(() => '');
      if (res.ok) {
        showPreviewLoadErrorBanner({
          status: res.status,
          detail:
            previewProbeDetail(body) ||
            "The preview HTML loaded, but Finesse's runtime did not report ready. Check for page CSP, an early script error, or a React dev server response that is not app HTML.",
          iframeUrl: init.iframeUrl,
          onRetry: loadFrame,
        });
        return;
      }
      showPreviewLoadErrorBanner({
        status: res.status,
        detail: body || res.statusText,
        iframeUrl: init.iframeUrl,
        onRetry: loadFrame,
      });
    } catch (err) {
      if (readyReceived) return;
      const message = err instanceof Error ? err.message : String(err);
      showPreviewLoadErrorBanner({
        status: 0,
        detail: `couldn't reach preview server at ${init.iframeUrl} (${message})`,
        iframeUrl: init.iframeUrl,
        onRetry: loadFrame,
      });
    }
  }

  frame.addEventListener('error', () => {
    void probePreviewUrl();
  });

  loadFrame();

  // Mount the right-hand side dock: style panel on top (fills available space),
  // agent panel pinned to the bottom. The style panel posts PanelStyleEdit
  // messages directly into the iframe; the iframe applies optimistically and
  // forwards the canonical commit to the host.
  const dock = document.getElementById('side-dock');
  let sidePanel: SidePanelController | null = null;
  let agentPanel: AgentPanelController | null = null;
  let currentAgentProvider: AgentProviderId = 'cursor';
  if (dock) {
    sidePanel = setupSidePanel({
      host: dock,
      sender: {
        toIframe(msg: PanelStyleEdit | PanelCssEdit | PanelSelectElement) {
          postToIframe(msg);
        },
      },
    });
    sidePanel.setLocked(init.fileMeta.isTemplated);
    agentPanel = setupAgentPanel({
      host: dock,
      actions: {
        onOpenDashboard: () => post({ type: '__webview_action', action: 'openCursorDashboard' }),
        onOpenClaudeDocs: () => post({ type: '__webview_action', action: 'openClaudeDocs' }),
        onSaveApiKey: (value) => post({ type: '__webview_action', action: 'saveApiKey', value }),
        onForgetApiKey: () => post({ type: '__webview_action', action: 'forgetApiKey' }),
        onChangeModel: () => post({ type: '__webview_action', action: 'changeAgentModel' }),
        onSelectProvider: (providerId) => {
          currentAgentProvider = providerId;
          agentPanel?.setState({
            providerId,
            connected: providerId === 'claude-code',
            connectionSource: undefined,
            runLog: '',
            runError: undefined,
          });
          post({ type: '__webview_action', action: 'selectAgentProvider', providerId });
        },
        onRunAgent: (value) => {
          agentPanel?.clearLog();
          post({
            type: '__webview_action',
            action: 'runAgent',
            value,
            providerId: currentAgentProvider,
          });
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

  function forwardBypassModifier(e: KeyboardEvent, state: 'down' | 'up'): void {
    if (e.key !== 'Shift') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextEntryTarget(document.activeElement)) return;
    postToIframe({ type: 'chromeModifierKey', key: 'Shift', state, repeat: e.repeat });
  }

  window.addEventListener('keydown', (e) => forwardBypassModifier(e, 'down'), true);
  window.addEventListener('keyup', (e) => forwardBypassModifier(e, 'up'), true);

  function relayToIframe(msg: HostMessage): void {
    postToIframe(msg);
  }

  function handleIframeMessage(data: unknown): void {
    if (!isIframeMessage(data)) return;
    if (data.type === 'ready') {
      readyReceived = true;
      dismissPreviewLoadErrorBanner();
    }
    if (data.type === 'runtimeError') {
      showRuntimeErrorBanner({
        source: data.source,
        message: data.message,
        stack: data.stack,
        filename: data.filename,
        lineno: data.lineno,
        colno: data.colno,
      });
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
      case 'editFailed':
        showEditFailedBanner(data.message);
        break;
      case 'previewDiagnostic':
        showPreviewDiagnosticBanner({
          severity: data.severity,
          message: data.message,
        });
        break;
      case 'fileMeta':
        updateStatus({ file: data.path, locked: data.isTemplated });
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
          file: data.path,
          isDirty: data.isDirty,
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
        if (data.providerId !== currentAgentProvider) break;
        agentPanel?.setState({
          connected: data.connected,
          connectionSource: data.source,
        });
        break;
      case 'agentProviderState':
        currentAgentProvider = data.providerId;
        agentPanel?.setState({
          providerId: data.providerId,
          model: data.model,
        });
        break;
      case 'agentRunStatus':
        if (data.providerId !== currentAgentProvider) break;
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

function previewProbeDetail(html: string): string {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 400);
}

function isTextEntryTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select';
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
    t === 'reactDomDiscovery' ||
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
    t === 'editFailed' ||
    t === 'previewDiagnostic' ||
    t === 'fileMeta' ||
    t === 'documentState' ||
    t === 'agentSelectionState' ||
    t === 'agentProviderState' ||
    t === 'agentConnectionState' ||
    t === 'agentRunStatus'
  );
}
