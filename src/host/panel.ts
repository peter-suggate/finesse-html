import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  DocumentState,
  EditBlockHtml,
  EditBlockTag,
  EditCommit,
  EditCancel,
  EditRemove,
  FileMeta,
  HostMessage,
  IframeMessage,
  OffsetMap,
  Ready,
  RuntimeError,
} from '../shared/protocol';
import {
  applyBlockHtmlCommit,
  applyBlockTagCommit,
  applyEditCommit,
  applyRemoveCommit,
  type ReplacementEscaper,
} from './applyEdit';
import type { ResolvedConfig } from './config';
import { escapeForJsTemplate } from './jsTemplateEscape';
import {
  detectTemplate,
  hasEditAnywayOverride,
  walkEditable,
  walkEditableInJs,
} from './parse';
import { injectElementIds } from './server/inject';

const JS_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
]);

function isJsLikeDocument(doc: vscode.TextDocument): boolean {
  return JS_LANGUAGE_IDS.has(doc.languageId);
}

export interface PreviewPanel {
  readonly documentUri: vscode.Uri;
  readonly key: string;
  readonly relativePath: string;
  currentVersion: number;
  currentOffsetMap: OffsetMap | null;
  /** Composed HTML to serve from the preview server. For HTML docs this is just the
   * document text; for JS/TS docs it's the concatenated bodies of the tagged
   * template literals discovered by the extractor. `null` if nothing renderable. */
  currentPreviewHtml: string | null;
  /** For JS/TS docs only: composed HTML with `data-html-wysiwyg-id` attrs
   * already spliced in (since the JS-source-coords offset map can't be used
   * by the server to inject directly into composed bytes). `null` for HTML
   * docs — the server handles injection itself. */
  currentInjectedPreviewHtml: string | null;
  isTemplated: boolean;
  expectedSelfEditVersion: number | null;
  postToWebview(msg: HostMessage): void;
  dispose(): void;
  reveal(): void;
  onDocumentChanged(doc: vscode.TextDocument, kind: 'self' | 'external'): void;
  onDocumentSaved(doc: vscode.TextDocument): void;
}

export interface PanelDeps {
  context: vscode.ExtensionContext;
  port: number;
  workspaceRoot: string;
  getConfig: () => ResolvedConfig;
  onDispose: () => void;
}

interface WebviewActionMessage {
  type: '__webview_action';
  action: 'editAnyway' | 'save' | 'discard' | 'setAutoSave';
  value?: boolean;
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
  let currentPreviewHtml: string | null = null;
  let currentInjectedPreviewHtml: string | null = null;
  let isTemplated = false;
  let expectedSelfEditVersion: number | null = null;
  let autoSave = false;
  const jsMode = isJsLikeDocument(document);
  const escapeReplacement: ReplacementEscaper | undefined = jsMode
    ? escapeForJsTemplate
    : undefined;

  function reparse(text: string, version: number): void {
    const structuralPatterns = deps.getConfig().templatePatterns;
    if (jsMode) {
      const result = walkEditableInJs(text, version, {
        templatePatterns: structuralPatterns,
      });
      currentOffsetMap = result.offsetMap;
      currentPreviewHtml = result.composedHtml;
      currentInjectedPreviewHtml = injectElementIds(
        result.composedHtml,
        result.composedOffsetMap,
      );
      isTemplated = false;
      currentVersion = version;
      return;
    }
    const templated = detectTemplate(text, structuralPatterns);
    const overrideTemplate = templated && hasEditAnywayOverride(text);
    isTemplated = templated && !overrideTemplate;
    currentOffsetMap = isTemplated
      ? null
      : walkEditable(text, version, { templatePatterns: structuralPatterns });
    currentPreviewHtml = text;
    currentInjectedPreviewHtml = null;
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

  function postDocumentState(): void {
    const msg: DocumentState = {
      type: 'documentState',
      isDirty: document.isDirty,
      autoSave,
    };
    panel.webview.postMessage(msg);
  }

  async function saveDocument(): Promise<void> {
    if (!document.isDirty) return;
    try {
      await document.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`HTML WYSIWYG save failed: ${message}`);
    }
  }

  async function discardChanges(): Promise<void> {
    if (!document.isDirty) return;
    const choice = await vscode.window.showWarningMessage(
      `Discard changes to ${path.basename(document.uri.fsPath)}?`,
      { modal: true },
      'Discard',
    );
    if (choice !== 'Discard') return;
    try {
      // Some VS Code / Cursor builds accept a URI arg; try that first.
      await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
    } catch {
      try {
        // Fallback: focus the document briefly so the active-editor revert finds it.
        await vscode.window.showTextDocument(document, {
          preserveFocus: true,
          preview: false,
        });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`HTML WYSIWYG discard failed: ${message}`);
      }
    }
  }

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
        } else if (msg.action === 'save') {
          await saveDocument();
        } else if (msg.action === 'discard') {
          await discardChanges();
        } else if (msg.action === 'setAutoSave') {
          autoSave = !!msg.value;
          postDocumentState();
          if (autoSave) await saveDocument();
        }
        return;
      case 'ready':
        sendInitialState(msg);
        return;
      case 'editCommit':
        await handleEditCommit(msg);
        return;
      case 'editRemove':
        await handleEditRemove(msg);
        return;
      case 'editBlockHtml':
        await handleEditBlockHtml(msg);
        return;
      case 'editBlockTag':
        await handleEditBlockTag(msg);
        return;
      case 'editCancel':
        handleEditCancel(msg);
        return;
      case 'saveRequest':
        await saveDocument();
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
    postDocumentState();
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
        escapeReplacement,
      });
      if (!result.ok) {
        expectedSelfEditVersion = null;
        panel.webview.postMessage({
          type: 'staleCommit',
          expectedVersion: result.expected,
          actualVersion: result.actual,
        });
      } else if (autoSave) {
        await saveDocument();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`HTML WYSIWYG edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditRemove(msg: EditRemove): Promise<void> {
    try {
      const result = await applyRemoveCommit({
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
      } else if (autoSave) {
        await saveDocument();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`HTML WYSIWYG remove failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditBlockHtml(msg: EditBlockHtml): Promise<void> {
    try {
      const result = await applyBlockHtmlCommit({
        document,
        currentVersion,
        currentOffsetMap,
        commit: msg,
        beforeApply: (expected) => {
          expectedSelfEditVersion = expected;
        },
        escapeReplacement,
      });
      if (!result.ok) {
        expectedSelfEditVersion = null;
        panel.webview.postMessage({
          type: 'staleCommit',
          expectedVersion: result.expected,
          actualVersion: result.actual,
        });
      } else if (autoSave) {
        await saveDocument();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`HTML WYSIWYG block edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditBlockTag(msg: EditBlockTag): Promise<void> {
    try {
      const result = await applyBlockTagCommit({
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
      } else if (autoSave) {
        await saveDocument();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`HTML WYSIWYG tag transform failed: ${message}`);
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
    get currentPreviewHtml() {
      return currentPreviewHtml;
    },
    set currentPreviewHtml(v: string | null) {
      currentPreviewHtml = v;
    },
    get currentInjectedPreviewHtml() {
      return currentInjectedPreviewHtml;
    },
    set currentInjectedPreviewHtml(v: string | null) {
      currentInjectedPreviewHtml = v;
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
      postDocumentState();
    },
    onDocumentSaved(_doc) {
      postDocumentState();
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
      #status { display: flex; gap: 12px; align-items: center; padding: 4px 12px; font-size: 11px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); border-bottom: 1px solid var(--vscode-panel-border); }
      #status .muted { opacity: 0.7; }
      #status .grow { flex: 1; }
      #status .dirty-dot { color: #e2a04a; font-size: 13px; line-height: 1; opacity: 0; transition: opacity 100ms ease-out; }
      #status .dirty-dot.is-dirty { opacity: 1; }
      #status button.tool { font: inherit; font-size: 11px; background: transparent; color: inherit; border: 1px solid var(--vscode-panel-border); border-radius: 2px; padding: 1px 8px; cursor: pointer; opacity: 0.85; }
      #status button.tool:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
      #status button.tool:disabled { opacity: 0.4; cursor: default; }
      #status label.toggle { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; opacity: 0.85; }
      #status label.toggle input { margin: 0; }
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
    <div id="status" role="status">
      <span id="status-dirty" class="dirty-dot" aria-hidden="true">●</span>
      <span id="status-file" class="muted">no file</span>
      <span id="status-version" class="muted">v?</span>
      <span id="status-port" class="muted">-</span>
      <span id="status-locked" class="muted" hidden>editing locked</span>
      <span class="grow"></span>
      <label class="toggle" title="Save automatically after each edit">
        <input id="status-autosave" type="checkbox" />
        <span>Auto-save</span>
      </label>
      <button id="status-discard" class="tool" type="button" title="Discard unsaved changes" disabled>Discard</button>
      <button id="status-save" class="tool" type="button" title="Save (⌘S)" disabled>Save</button>
    </div>
    <div id="banners" role="region" aria-label="HTML WYSIWYG notifications" aria-live="polite"></div>
    <div id="frame-wrap">
      <iframe id="frame" title="HTML preview" aria-label="HTML preview" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
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
