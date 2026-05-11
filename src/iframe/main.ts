import type {
  FileMeta,
  IframeInboundMessage,
  IframeMessage,
  OffsetMap,
} from '../shared/protocol';
import { setupEditSession, type EditSession } from './editSession';
import { setupHelpPanel } from './helpPanel';
import { setupOverlay } from './overlay';
import { setupFormatToolbar } from './toolbar';
import { makeDefaultActionHandler, makeDefaultRefreshHandler } from './toolbar/wiring';

interface InitData {
  offsetMap: OffsetMap | null;
  fileMeta: FileMeta;
}

declare global {
  interface Window {
    __FINESSE__?: InitData;
  }
}

function postToParent(msg: IframeMessage): void {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // best-effort
  }
}

function reportError(message: string, stack?: string): void {
  postToParent({ type: 'runtimeError', message, stack });
}

function start(): void {
  const init = window.__FINESSE__;
  if (!init) {
    reportError('init data missing (window.__FINESSE__)');
    return;
  }
  const session = setupEditSession({
    initialOffsetMap: init.offsetMap,
    initialFileMeta: init.fileMeta,
    postToParent,
    onError: reportError,
  });
  setupOverlay({ session });
  setupHelpPanel(session);
  setupFormatToolbar({
    session,
    onAction: makeDefaultActionHandler({ session }),
    onRefresh: makeDefaultRefreshHandler({ session }),
  });
  setupReloadSocket(init.fileMeta.path);
  setupHostMessageListener(session);
  setupGlobalErrorHandlers();
  postToParent({ type: 'ready' });
}

function setupReloadSocket(path: string): void {
  let attempts = 0;
  const open = (): void => {
    let socket: WebSocket;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/__edit/socket`);
    } catch (err) {
      reportError(`reload socket failed: ${(err as Error).message}`);
      return;
    }
    socket.addEventListener('open', () => {
      attempts = 0;
      socket.send(JSON.stringify({ type: 'subscribe', path }));
    });
    socket.addEventListener('message', (e: MessageEvent) => {
      try {
        const data = typeof e.data === 'string' ? e.data : '';
        const msg = JSON.parse(data) as { type?: string };
        if (msg && msg.type === 'reload') location.reload();
      } catch {
        // ignore malformed
      }
    });
    socket.addEventListener('close', () => {
      attempts++;
      if (attempts > 10) return;
      setTimeout(open, Math.min(500 * attempts, 3000));
    });
  };
  open();
}

function setupHostMessageListener(session: EditSession): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as IframeInboundMessage | undefined;
    if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
    switch (data.type) {
      case 'offsetMap':
        session.applyOffsetMap(data);
        break;
      case 'editAck':
        session.applyOffsetMap(data.offsetMap);
        break;
      case 'staleCommit':
        session.onStale();
        location.reload();
        break;
      case 'reload':
        location.reload();
        break;
      case 'fileMeta':
        session.applyFileMeta(data);
        break;
      case 'panelStyleEdit': {
        const el = session.findElementById(data.elementId);
        if (el) session.applyStyleEdit(el, data.attrs);
        break;
      }
      case 'panelCssEdit': {
        session.applyCssDeclarationEdit({
          documentVersion: data.documentVersion,
          selector: data.selector,
          property: data.property,
          value: data.value,
        });
        break;
      }
    }
  });
}

function setupGlobalErrorHandlers(): void {
  window.addEventListener('error', (e: ErrorEvent) => {
    reportError(e.message, e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
    const stack = e.reason instanceof Error ? e.reason.stack : undefined;
    reportError(reason, stack);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
