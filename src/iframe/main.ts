import type {
  FileMeta,
  IframeInboundMessage,
  IframeMessage,
  OffsetMap,
} from '../shared/protocol';
import { setupEditSession, type EditSession } from './editSession';
import { setupHelpPanel } from './helpPanel';
import { setupOverlay } from './overlay';
import { setupThreadPins, type ThreadPinsController } from './threadPins';
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

function reportError(input: {
  message: string;
  stack?: string;
  source?: 'finesse' | 'page';
  filename?: string;
  lineno?: number;
  colno?: number;
}): void {
  postToParent({ type: 'runtimeError', ...input });
}

function start(): void {
  setupGlobalErrorHandlers();
  const init = window.__FINESSE__;
  if (!init) {
    reportError({ source: 'finesse', message: 'init data missing (window.__FINESSE__)' });
    return;
  }
  const session = setupEditSession({
    initialOffsetMap: init.offsetMap,
    initialFileMeta: init.fileMeta,
    postToParent,
    onError: (message, stack) => reportError({ source: 'finesse', message, stack }),
  });
  const pins = setupThreadPins({
    session,
    postToParent,
    currentPath: () => init.fileMeta.path,
  });
  setupReloadSocket(init.fileMeta.path);
  setupHostMessageListener(session, pins);
  postReady(init);
  if (init.fileMeta.renderMode === 'react') {
    waitForReactDom(() => {
      setupEditingUi(session, pins);
      discoverReactDom(init.fileMeta.path, init.offsetMap?.documentVersion);
    });
    return;
  }
  setupEditingUi(session, pins);
}

function setupEditingUi(session: EditSession, pins: ThreadPinsController): void {
  setupOverlay({ session, onStartEdit: (el) => pins.startNewEdit(el) });
  setupHelpPanel(session);
  setupFormatToolbar({
    session,
    onAction: makeDefaultActionHandler({ session }),
    onRefresh: makeDefaultRefreshHandler({ session }),
  });
}

function postReady(init: InitData): void {
  postToParent({
    type: 'ready',
    path: init.fileMeta.path,
    documentVersion: init.offsetMap?.documentVersion,
  });
}

function waitForReactDom(callback: () => void): void {
  if (hasReactLocDescendants()) {
    callback();
    return;
  }
  const started = Date.now();
  const timeoutMs = 5000;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    observer.disconnect();
    callback();
  };
  const observer = new MutationObserver(() => {
    if (!hasReactLocDescendants()) return;
    finish();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const fallback = (): void => {
    if (hasReactLocDescendants() || Date.now() - started >= timeoutMs) {
      finish();
      return;
    }
    window.setTimeout(fallback, 100);
  };
  window.setTimeout(fallback, 100);
}

function hasReactLocDescendants(): boolean {
  return Boolean(document.body?.querySelector('[data-loc]'));
}

function discoverReactDom(path: string, documentVersion?: number): void {
  const tagged = Array.from(document.body?.querySelectorAll('[data-loc]') ?? []);
  const counts = new Map<string, number>();
  const elements = [];
  let elementId = 0;
  for (const node of tagged) {
    if (!(node instanceof HTMLElement)) continue;
    const loc = node.getAttribute('data-loc');
    if (!loc) continue;
    const occurrence = counts.get(loc) ?? 0;
    counts.set(loc, occurrence + 1);
    node.setAttribute('data-finesse-id', String(elementId));
    elements.push({
      elementId,
      loc,
      tagName: node.tagName.toLowerCase(),
      occurrence,
    });
    elementId++;
  }
  postToParent({
    type: 'reactDomDiscovery',
    path,
    documentVersion,
    elements,
  });
}

function setupReloadSocket(path: string): void {
  let attempts = 0;
  const open = (): void => {
    let socket: WebSocket;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/__edit/socket`);
    } catch (err) {
      reportError({ source: 'finesse', message: `reload socket failed: ${(err as Error).message}` });
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

function setupHostMessageListener(session: EditSession, pins: ThreadPinsController): void {
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
      case 'agentThreadsState':
        pins.applyThreadsState(data);
        break;
      case 'agentThreadRunStatus':
        pins.applyRunStatus(data);
        break;
      case 'resolveAnchor':
        pins.resolveAnchor(data);
        break;
      case 'focusThreadPin':
        pins.focusThread(data.threadId);
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
      case 'panelSelectElement': {
        const el = session.findElementById(data.elementId);
        if (!el) break;
        // If a block is being text-edited, commit it before shifting selection
        // so we don't lose in-flight typing.
        if (session.hasActiveBlock()) session.commitEdit();
        session.selectElement(el);
        session.announceElementSelection(el);
        break;
      }
    }
  });
}

function setupGlobalErrorHandlers(): void {
  let last = '';
  window.addEventListener('error', (e: ErrorEvent) => {
    const message = e.message || 'Script error';
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    const key = `${message}|${e.filename}|${e.lineno}|${e.colno}`;
    if (key === last) return;
    last = key;
    reportError({
      source: 'page',
      message,
      stack,
      filename: e.filename || undefined,
      lineno: e.lineno || undefined,
      colno: e.colno || undefined,
    });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
    const stack = e.reason instanceof Error ? e.reason.stack : undefined;
    const key = `promise|${reason}|${stack ?? ''}`;
    if (key === last) return;
    last = key;
    reportError({ source: 'page', message: `Unhandled promise rejection: ${reason}`, stack });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
