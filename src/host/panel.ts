import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  EditCommit,
  EditCancel,
  FileMeta,
  HostMessage,
  IframeMessage,
  OffsetMap,
  Ready,
  RuntimeError,
} from '../shared/protocol';
import { applyEditCommit } from './applyEdit';
import { detectTemplate, hasEditAnywayOverride, walkEditable } from './parse';

export interface PreviewPanel {
  readonly documentUri: vscode.Uri;
  readonly key: string;
  readonly relativePath: string;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  isTemplated: boolean;
  expectedSelfEditVersion: number | null;
  postToWebview(msg: HostMessage): void;
  dispose(): void;
  reveal(): void;
  onDocumentChanged(doc: vscode.TextDocument, kind: 'self' | 'external'): void;
}

export interface PanelDeps {
  context: vscode.ExtensionContext;
  port: number;
  workspaceRoot: string;
  onDispose: () => void;
}

interface WebviewActionMessage {
  type: '__webview_action';
  action: 'editAnyway';
}

type IncomingMessage = IframeMessage | WebviewActionMessage;

export function createPreviewPanel(
  document: vscode.TextDocument,
  deps: PanelDeps,
): PreviewPanel {
  const relativePath = relativeWebPath(deps.workspaceRoot, document.uri.fsPath);
  const key = document.uri.toString();
  const panel = vscode.window.createWebviewPanel(
    'htmlWysiwyg.preview',
    `WYSIWYG: ${path.basename(document.uri.fsPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(deps.context.extensionPath, 'dist'))],
    },
  );

  let currentVersion = document.version;
  let currentOffsetMap: OffsetMap | null = null;
  let isTemplated = false;
  let expectedSelfEditVersion: number | null = null;

  function reparse(text: string, version: number): void {
    const templated = detectTemplate(text);
    const overrideTemplate = templated && hasEditAnywayOverride(text);
    isTemplated = templated && !overrideTemplate;
    currentOffsetMap = isTemplated ? null : walkEditable(text, version);
    currentVersion = version;
  }

  reparse(document.getText(), document.version);

  const iframeUrl = `http://127.0.0.1:${deps.port}/${encodePath(relativePath)}`;
  const fileMeta: FileMeta = {
    type: 'fileMeta',
    path: relativePath,
    isTemplated,
  };
  panel.webview.html = buildWebviewHtml(panel.webview, deps.context.extensionPath, {
    iframeUrl,
    fileMeta,
    port: deps.port,
  });

  panel.webview.onDidReceiveMessage((raw: unknown) => {
    void handleMessage(raw);
  });

  panel.onDidDispose(() => {
    deps.onDispose();
  });

  async function handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as IncomingMessage;
    switch (msg.type) {
      case '__webview_action':
        if (msg.action === 'editAnyway') {
          await vscode.commands.executeCommand('htmlWysiwyg.editAnyway');
        }
        return;
      case 'ready':
        sendInitialState(msg);
        return;
      case 'editCommit':
        await handleEditCommit(msg);
        return;
      case 'editCancel':
        handleEditCancel(msg);
        return;
      case 'runtimeError':
        handleRuntimeError(msg);
        return;
    }
  }

  function sendInitialState(_msg: Ready): void {
    if (currentOffsetMap) panel.webview.postMessage(currentOffsetMap);
    panel.webview.postMessage({
      type: 'fileMeta',
      path: relativePath,
      isTemplated,
    } satisfies FileMeta);
  }

  async function handleEditCommit(msg: EditCommit): Promise<void> {
    try {
      const result = await applyEditCommit({
        document,
        currentVersion,
        currentOffsetMap,
        commit: msg,
        beforeApply: (expected) => {
          expectedSelfEditVersion = expected;
        },
      });
      if (!result.ok) {
        expectedSelfEditVersion = null;
        panel.webview.postMessage({
          type: 'staleCommit',
          expectedVersion: result.expected,
          actualVersion: result.actual,
        });
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`HTML WYSIWYG edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  function handleEditCancel(msg: EditCancel): void {
    void msg;
  }

  function handleRuntimeError(msg: RuntimeError): void {
    console.warn('[htmlWysiwyg] iframe runtime error:', msg.message, msg.stack);
  }

  return {
    documentUri: document.uri,
    key,
    relativePath,
    get currentVersion() {
      return currentVersion;
    },
    set currentVersion(v: number) {
      currentVersion = v;
    },
    get currentOffsetMap() {
      return currentOffsetMap;
    },
    set currentOffsetMap(v: OffsetMap | null) {
      currentOffsetMap = v;
    },
    get isTemplated() {
      return isTemplated;
    },
    set isTemplated(v: boolean) {
      isTemplated = v;
    },
    get expectedSelfEditVersion() {
      return expectedSelfEditVersion;
    },
    set expectedSelfEditVersion(v: number | null) {
      expectedSelfEditVersion = v;
    },
    postToWebview(msg) {
      panel.webview.postMessage(msg);
    },
    dispose() {
      panel.dispose();
    },
    reveal() {
      panel.reveal(vscode.ViewColumn.Beside, true);
    },
    onDocumentChanged(doc, kind) {
      reparse(doc.getText(), doc.version);
      const fm: FileMeta = { type: 'fileMeta', path: relativePath, isTemplated };
      if (kind === 'self') {
        if (currentOffsetMap) {
          panel.webview.postMessage({
            type: 'editAck',
            documentVersion: doc.version,
            offsetMap: currentOffsetMap,
          });
        }
        panel.webview.postMessage(fm);
      } else {
        if (currentOffsetMap) panel.webview.postMessage(currentOffsetMap);
        panel.webview.postMessage(fm);
        panel.webview.postMessage({ type: 'reload', reason: 'external-edit' });
      }
    },
  };
}

interface PanelInit {
  iframeUrl: string;
  fileMeta: FileMeta;
  port: number;
}

function buildWebviewHtml(
  webview: vscode.Webview,
  extensionPath: string,
  init: PanelInit,
): string {
  const mainJs = webview
    .asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'dist', 'webview', 'main.js')))
    .toString();
  const initJson = JSON.stringify(init).replace(/<\//g, '<\\/');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `script-src ${webview.cspSource} 'unsafe-inline'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} https: data:`,
    'frame-src http://127.0.0.1:* http://localhost:*',
    'connect-src http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*',
  ].join('; ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>HTML WYSIWYG</title>
    <style>
      :root { color-scheme: dark light; }
      body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
      #status { display: flex; gap: 12px; padding: 4px 12px; font-size: 11px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); border-bottom: 1px solid var(--vscode-panel-border); }
      #status .muted { opacity: 0.7; }
      #banners { display: flex; flex-direction: column; }
      .banner { padding: 8px 12px; font-size: 13px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
      .banner-warn { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); }
      .banner-error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
      .banner button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 10px; cursor: pointer; font: inherit; }
      .banner button:hover { background: var(--vscode-button-hoverBackground); }
      .banner .dismiss { margin-left: auto; opacity: 0.6; cursor: pointer; padding: 0 4px; }
      .banner .dismiss:hover { opacity: 1; }
      #frame-wrap { flex: 1; position: relative; }
      #frame { width: 100%; height: 100%; border: none; background: white; }
    </style>
    <script>window.__HTML_WYSIWYG_INIT__ = ${initJson};</script>
  </head>
  <body>
    <div id="status">
      <span id="status-file" class="muted">no file</span>
      <span id="status-version" class="muted">v?</span>
      <span id="status-port" class="muted">-</span>
      <span id="status-locked" class="muted" hidden>editing locked</span>
    </div>
    <div id="banners"></div>
    <div id="frame-wrap">
      <iframe id="frame" title="HTML preview" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    </div>
    <script src="${mainJs}"></script>
  </body>
</html>`;
}

function relativeWebPath(workspaceRoot: string, fsPath: string): string {
  const rel = path.relative(workspaceRoot, fsPath);
  return rel.split(path.sep).join('/');
}

function encodePath(relPath: string): string {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
