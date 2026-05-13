import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  AgentConnectionState,
  AgentProviderId,
  AgentProviderState,
  AgentRunStatus,
  AgentSelectionState,
  DocumentState,
  EditBlockHtml,
  EditBlockTag,
  EditCommit,
  EditCancel,
  EditCssDeclaration,
  EditElementAttrs,
  EditRemove,
  ElementSelectionChanged,
  ElementSelectionSnapshot,
  FileMeta,
  HostMessage,
  IframeMessage,
  OffsetMap,
  Ready,
  RuntimeError,
  WebviewActionMessage,
} from '../shared/protocol';
import { runSelectedElementAgent } from './agent';
import { AgentCredentialStore } from './agent/credentials';
import { isAgentProviderId } from './agent/types';
import {
  applyAttrEditCommit,
  applyBlockHtmlCommit,
  applyBlockTagCommit,
  applyCssDeclarationCommit,
  applyEditCommit,
  applyRecordedSplices,
  applyRemoveCommit,
  type ReplacementEscaper,
} from './applyEdit';
import type { ResolvedConfig } from './config';
import { createEditTransaction, EditHistory, hashText } from './editHistory';
import { escapeForJsTemplate } from './jsTemplateEscape';
import { detectTemplate, hasEditAnywayOverride, walkEditable, walkEditableInJs } from './parse';
import { injectElementIds } from './server/inject';
import type { UndoEntry } from './undoStack';

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
  /** For JS/TS docs only: composed HTML with `data-finesse-id` attrs
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

type IncomingMessage = IframeMessage | WebviewActionMessage;

export function createPreviewPanel(document: vscode.TextDocument, deps: PanelDeps): PreviewPanel {
  const relativePath = relativeWebPath(deps.workspaceRoot, document.uri.fsPath);
  const key = document.uri.toString();
  const panel = vscode.window.createWebviewPanel(
    'finesse.preview',
    `Finesse: ${path.basename(document.uri.fsPath)}`,
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
  let currentAgentSelection: ElementSelectionSnapshot | null = null;
  let agentRunning = false;
  const credentials = new AgentCredentialStore(deps.context);
  const PROVIDER_STATE_KEY = 'finesse.agent.selectedProvider';
  const persistedProvider = deps.context.globalState.get<string>(PROVIDER_STATE_KEY);
  let selectedProvider: AgentProviderId = isAgentProviderId(persistedProvider)
    ? persistedProvider
    : deps.getConfig().agentDefaultProvider;
  const jsMode = isJsLikeDocument(document);
  const escapeReplacement: ReplacementEscaper | undefined = jsMode
    ? escapeForJsTemplate
    : undefined;
  const editHistory = new EditHistory();
  let nextEditTransactionId = 1;

  function reparse(text: string, version: number): void {
    const structuralPatterns = deps.getConfig().templatePatterns;
    if (jsMode) {
      const result = walkEditableInJs(text, version, {
        templatePatterns: structuralPatterns,
      });
      currentOffsetMap = result.offsetMap;
      currentPreviewHtml = result.composedHtml;
      currentInjectedPreviewHtml = injectElementIds(result.composedHtml, result.composedOffsetMap);
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
      canUndo: editHistory.canUndo(),
      canRedo: editHistory.canRedo(),
    };
    panel.webview.postMessage(msg);
  }

  function postAgentSelectionState(): void {
    const msg: AgentSelectionState = {
      type: 'agentSelectionState',
      selected: currentAgentSelection !== null,
      label: currentAgentSelection ? selectionLabel(currentAgentSelection) : undefined,
      agentRunning,
    };
    panel.webview.postMessage(msg);
  }

  async function postAgentConnectionState(
    providerId: AgentProviderId = selectedProvider,
  ): Promise<void> {
    const key = await credentials.getApiKey(providerId);
    let connected: boolean;
    if (providerId === 'cursor') {
      connected = !!key;
    } else {
      // Claude Code is "connected" either if we have an API key OR if we
      // expect the bundled CLI to fall back to subscription auth. We can't
      // probe the subscription synchronously, so optimistically report
      // connected; the run will report a clearer error if it fails.
      connected = true;
    }
    const msg: AgentConnectionState = {
      type: 'agentConnectionState',
      providerId,
      connected,
      source: key?.source === 'prompt' ? 'secret' : key?.source,
    };
    panel.webview.postMessage(msg);
  }

  function postAgentProviderState(): void {
    const msg: AgentProviderState = {
      type: 'agentProviderState',
      providerId: selectedProvider,
    };
    panel.webview.postMessage(msg);
  }

  function postAgentRunStatus(
    phase: AgentRunStatus['phase'],
    text?: string,
    providerId: AgentProviderId = selectedProvider,
  ): void {
    const msg: AgentRunStatus = {
      type: 'agentRunStatus',
      providerId,
      phase,
      text,
    };
    panel.webview.postMessage(msg);
  }

  async function saveDocument(): Promise<void> {
    if (!document.isDirty) return;
    try {
      await document.save();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse save failed: ${message}`);
    } finally {
      postDocumentState();
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
      await revertActiveDocument(document);
      await waitForDocumentClean(document);
      if (document.isDirty) {
        throw new Error('VS Code did not revert the file');
      }
      editHistory.clear();
      currentAgentSelection = null;
      reparse(document.getText(), document.version);
      const fm: FileMeta = { type: 'fileMeta', path: relativePath, isTemplated };
      if (currentOffsetMap) panel.webview.postMessage(currentOffsetMap);
      panel.webview.postMessage(fm);
      panel.webview.postMessage({ type: 'reload', reason: 'discard' });
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, false);
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse discard failed: ${message}`);
    } finally {
      postDocumentState();
      postAgentSelectionState();
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
          await vscode.commands.executeCommand('finesse.editAnyway');
        } else if (msg.action === 'save') {
          await saveDocument();
        } else if (msg.action === 'discard') {
          await discardChanges();
        } else if (msg.action === 'undo') {
          await handleUndoRequest();
        } else if (msg.action === 'redo') {
          await handleRedoRequest();
        } else if (msg.action === 'commandPalette') {
          await vscode.commands.executeCommand('workbench.action.showCommands');
        } else if (msg.action === 'openCursorDashboard') {
          await vscode.env.openExternal(
            vscode.Uri.parse(AgentCredentialStore.cursorDashboardUrl),
          );
        } else if (msg.action === 'openClaudeDocs') {
          await vscode.env.openExternal(
            vscode.Uri.parse(AgentCredentialStore.claudeDocsUrl),
          );
        } else if (msg.action === 'saveApiKey') {
          await credentials.setApiKey(selectedProvider, msg.value);
          await postAgentConnectionState();
        } else if (msg.action === 'forgetApiKey') {
          await credentials.clearApiKey(selectedProvider);
          await postAgentConnectionState();
        } else if (msg.action === 'selectAgentProvider') {
          if (isAgentProviderId(msg.providerId) && msg.providerId !== selectedProvider) {
            selectedProvider = msg.providerId;
            postAgentProviderState();
            void deps.context.globalState.update(PROVIDER_STATE_KEY, selectedProvider).then(
              undefined,
              (err: unknown) => {
                console.warn('[finesse] failed to persist agent provider:', err);
              },
            );
            await postAgentConnectionState(selectedProvider);
          }
        } else if (msg.action === 'runAgent') {
          await handleRunAgentRequest(msg.value, msg.providerId);
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
      case 'editElementAttrs':
        await handleEditElementAttrs(msg);
        return;
      case 'editCssDeclaration':
        await handleEditCssDeclaration(msg);
        return;
      case 'editCancel':
        handleEditCancel(msg);
        return;
      case 'saveRequest':
        await saveDocument();
        return;
      case 'undoRequest':
        await handleUndoRequest();
        return;
      case 'redoRequest':
        await handleRedoRequest();
        return;
      case 'commandPaletteRequest':
        await vscode.commands.executeCommand('workbench.action.showCommands');
        return;
      case 'elementSelectionChanged':
        handleElementSelectionChanged(msg);
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
    postAgentSelectionState();
    postAgentProviderState();
    void postAgentConnectionState();
  }

  function recordIfNonEmpty(
    entry: UndoEntry,
    label: string,
    sourceBefore: string,
  ): void {
    if (entry.forward.length === 0) return;
    editHistory.record(
      createEditTransaction({
        id: String(nextEditTransactionId++),
        label,
        sourceBefore,
        sourceAfter: document.getText(),
        forward: entry.forward,
        versionBefore: entry.versionBefore,
        versionAfter: entry.versionAfter,
      }),
    );
  }

  async function handleEditCommit(msg: EditCommit): Promise<void> {
    try {
      const sourceBefore = document.getText();
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
      } else {
        recordIfNonEmpty(result.undoEntry, 'Text edit', sourceBefore);
        postDocumentState();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditRemove(msg: EditRemove): Promise<void> {
    try {
      const sourceBefore = document.getText();
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
      } else {
        recordIfNonEmpty(result.undoEntry, 'Remove element', sourceBefore);
        postDocumentState();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse remove failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditBlockHtml(msg: EditBlockHtml): Promise<void> {
    try {
      const sourceBefore = document.getText();
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
      } else {
        recordIfNonEmpty(result.undoEntry, 'Block HTML edit', sourceBefore);
        postDocumentState();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse block edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditBlockTag(msg: EditBlockTag): Promise<void> {
    try {
      const sourceBefore = document.getText();
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
      } else {
        recordIfNonEmpty(result.undoEntry, 'Tag edit', sourceBefore);
        postDocumentState();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse tag transform failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditElementAttrs(msg: EditElementAttrs): Promise<void> {
    try {
      const sourceBefore = document.getText();
      const result = await applyAttrEditCommit({
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
        if (result.reason === 'stale') {
          panel.webview.postMessage({
            type: 'staleCommit',
            expectedVersion: result.expected,
            actualVersion: result.actual,
          });
        }
      } else {
        recordIfNonEmpty(result.undoEntry, 'Attribute edit', sourceBefore);
        postDocumentState();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse attribute edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleEditCssDeclaration(msg: EditCssDeclaration): Promise<void> {
    try {
      const sourceBefore = document.getText();
      const result = await applyCssDeclarationCommit({
        document,
        currentVersion,
        commit: msg,
        beforeApply: (expected) => {
          expectedSelfEditVersion = expected;
        },
        escapeReplacement,
      });
      if (!result.ok) {
        expectedSelfEditVersion = null;
        if (result.reason === 'stale') {
          panel.webview.postMessage({
            type: 'staleCommit',
            expectedVersion: result.expected,
            actualVersion: result.actual,
          });
        } else {
          panel.webview.postMessage({
            type: 'editFailed',
            message:
              'That CSS rule could not be saved. Finesse can currently save class-rule edits only when the rule lives in a <style> block in this file.',
          });
          postDocumentState();
        }
      } else {
        recordIfNonEmpty(result.undoEntry, 'CSS edit', sourceBefore);
        postDocumentState();
      }
    } catch (err) {
      expectedSelfEditVersion = null;
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse CSS edit failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
    }
  }

  async function handleUndoRequest(): Promise<void> {
    const op = editHistory.beginUndo();
    if (!op) return;
    const entry = op.transaction;
    try {
      if (hashText(document.getText()) !== entry.sourceHashAfter) {
        op.abort();
        editHistory.markExternalConflict('stale-replay');
        panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
        postDocumentState();
        return;
      }
      const result = await applyRecordedSplices(
        document,
        entry.inverse,
        currentVersion,
        (expected) => {
          expectedSelfEditVersion = expected;
        },
      );
      if (!result.ok) {
        expectedSelfEditVersion = null;
        op.abort();
        editHistory.markExternalConflict('stale-replay');
        panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
        postDocumentState();
        return;
      }
      op.commit();
      postDocumentState();
    } catch (err) {
      expectedSelfEditVersion = null;
      op.abort();
      editHistory.markExternalConflict('stale-replay');
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse undo failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
      postDocumentState();
    }
  }

  async function handleRedoRequest(): Promise<void> {
    const op = editHistory.beginRedo();
    if (!op) return;
    const entry = op.transaction;
    try {
      if (hashText(document.getText()) !== entry.sourceHashBefore) {
        op.abort();
        editHistory.markExternalConflict('stale-replay');
        panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
        postDocumentState();
        return;
      }
      const result = await applyRecordedSplices(
        document,
        entry.forward,
        currentVersion,
        (expected) => {
          expectedSelfEditVersion = expected;
        },
      );
      if (!result.ok) {
        expectedSelfEditVersion = null;
        op.abort();
        editHistory.markExternalConflict('stale-replay');
        panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
        postDocumentState();
        return;
      }
      op.commit();
      postDocumentState();
    } catch (err) {
      expectedSelfEditVersion = null;
      op.abort();
      editHistory.markExternalConflict('stale-replay');
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Finesse redo failed: ${message}`);
      panel.webview.postMessage({ type: 'reload', reason: 'stale-commit' });
      postDocumentState();
    }
  }

  function handleElementSelectionChanged(msg: ElementSelectionChanged): void {
    currentAgentSelection = msg.selection;
    postAgentSelectionState();
  }

  async function handleRunAgentRequest(
    userPrompt: string,
    providerId: AgentProviderId,
  ): Promise<void> {
    if (agentRunning) return;
    const runProvider = isAgentProviderId(providerId) ? providerId : selectedProvider;
    if (runProvider !== selectedProvider) {
      selectedProvider = runProvider;
      postAgentProviderState();
      void deps.context.globalState.update(PROVIDER_STATE_KEY, selectedProvider).then(
        undefined,
        (err: unknown) => {
          console.warn('[finesse] failed to persist agent provider:', err);
        },
      );
    }
    const trimmed = (userPrompt ?? '').trim();
    if (!trimmed) {
      postAgentRunStatus('error', 'Prompt was empty.', runProvider);
      return;
    }
    if (
      currentAgentSelection &&
      (currentAgentSelection.documentVersion !== currentVersion ||
        currentAgentSelection.documentVersion !== document.version)
    ) {
      currentAgentSelection = null;
      postAgentSelectionState();
      postAgentRunStatus('error', 'That selection is stale. Select the element again.', runProvider);
      return;
    }

    agentRunning = true;
    postAgentSelectionState();
    const cfg = deps.getConfig();
    const providerLabel = runProvider === 'cursor' ? 'Cursor Agent' : 'Claude Code';
    const model =
      runProvider === 'cursor' ? cfg.agentCursorModel : cfg.agentClaudeModel;
    const targetLabel = currentAgentSelection
      ? selectionLabel(currentAgentSelection)
      : relativePath;
    postAgentRunStatus(
      'starting',
      `Running ${providerLabel} on ${targetLabel}`,
      runProvider,
    );
    try {
      await runSelectedElementAgent({
        providerId: runProvider,
        context: deps.context,
        workspaceRoot: deps.workspaceRoot,
        model,
        document,
        relativePath,
        offsetMap: currentOffsetMap ?? undefined,
        selection: currentAgentSelection ?? undefined,
        userPrompt: trimmed,
        onStatus: (text) => postAgentRunStatus('status', text, runProvider),
        onOutput: (text) => postAgentRunStatus('output', text, runProvider),
      });
      postAgentRunStatus('done', undefined, runProvider);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      postAgentRunStatus('error', humanizeAgentError(message, runProvider), runProvider);
      // Re-check connection — if the key is missing/invalid, the popover flips
      // back to the Connect state automatically.
      await postAgentConnectionState(runProvider);
    } finally {
      agentRunning = false;
      postAgentSelectionState();
    }
  }

  function handleEditCancel(msg: EditCancel): void {
    void msg;
  }

  function handleRuntimeError(msg: RuntimeError): void {
    console.warn('[finesse] iframe runtime error:', msg.message, msg.stack);
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
        // External edits invalidate recorded splice offsets. Keep the history
        // present but disabled so stale undo/redo cannot replay into new text.
        editHistory.markExternalConflict('external-document-change');
        currentAgentSelection = null;
        if (currentOffsetMap) panel.webview.postMessage(currentOffsetMap);
        panel.webview.postMessage(fm);
        panel.webview.postMessage({ type: 'reload', reason: 'external-edit' });
      }
      postDocumentState();
      postAgentSelectionState();
    },
    onDocumentSaved(_doc) {
      postDocumentState();
    },
  };
}

function selectionLabel(selection: ElementSelectionSnapshot): string {
  const text = selection.textPreview ? ` "${selection.textPreview.slice(0, 40)}"` : '';
  return `<${selection.tagName}>${text}`;
}

async function revertActiveDocument(document: vscode.TextDocument): Promise<void> {
  // VS Code's revert command targets the active editor; URI args are ignored by
  // current VS Code/Cursor builds, so the source editor must be focused first.
  await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false,
  });
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

async function waitForDocumentClean(
  document: vscode.TextDocument,
  timeoutMs = 500,
): Promise<void> {
  if (!document.isDirty) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      changeSub.dispose();
      saveSub.dispose();
      resolve();
    };
    const matches = (doc: vscode.TextDocument): boolean =>
      doc.uri.toString() === document.uri.toString();
    const timer = setTimeout(done, timeoutMs);
    const changeSub = vscode.workspace.onDidChangeTextDocument((event) => {
      if (matches(event.document) && !event.document.isDirty) done();
    });
    const saveSub = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (matches(doc) && !doc.isDirty) done();
    });
  });
}

function humanizeAgentError(message: string, providerId: AgentProviderId): string {
  const lower = message.toLowerCase();
  if (providerId === 'cursor') {
    if (
      message.includes('CURSOR_API_KEY') ||
      lower.includes('api key') ||
      lower.includes('not configured')
    ) {
      return 'Cursor Agent is not connected. Choose "Connect Cursor Agent", open the Cursor Dashboard, create a key in Integrations > User API Keys, then paste it into Finesse.';
    }
    return message;
  }
  if (
    lower.includes('not authenticated') ||
    lower.includes('authentication_failed') ||
    lower.includes('login') ||
    lower.includes('api key')
  ) {
    return 'Claude Code is not authenticated. In a terminal run `claude` then `/login` to use your subscription — or paste an ANTHROPIC_API_KEY into the Ask Agent panel.';
  }
  return message;
}

interface PanelInit {
  iframeUrl: string;
  fileMeta: FileMeta;
  port: number;
}

function buildWebviewHtml(webview: vscode.Webview, extensionPath: string, init: PanelInit): string {
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
    <title>Finesse</title>
    <style>
      :root { color-scheme: dark light; }
      body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
      #status { display: flex; gap: 12px; align-items: center; padding: 4px 12px; font-size: 11px; background: var(--vscode-statusBar-background); color: var(--vscode-statusBar-foreground); border-bottom: 1px solid var(--vscode-panel-border); }
      #status .muted { opacity: 0.7; }
      #status .grow { flex: 1; }
      #status .selection { max-width: 220px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      #status .dirty-dot { color: #e2a04a; font-size: 13px; line-height: 1; opacity: 0; transition: opacity 100ms ease-out; }
      #status .dirty-dot.is-dirty { opacity: 1; }
      #status .save-state { font-weight: 600; opacity: 0.72; }
      #status .save-state.is-dirty { color: var(--vscode-inputValidation-warningForeground, #f0c674); opacity: 1; }
      #status button.tool { font: inherit; font-size: 11px; background: transparent; color: inherit; border: 1px solid var(--vscode-panel-border); border-radius: 2px; padding: 1px 8px; cursor: pointer; opacity: 0.85; }
		      #status button.tool:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
      #status button.tool.primary:not(:disabled) { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); opacity: 1; font-weight: 600; }
      #status button.tool.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); border-color: var(--vscode-button-hoverBackground); }
		      #status button.tool:disabled { opacity: 0.4; cursor: default; }
	      #banners { display: flex; flex-direction: column; }
      .banner { padding: 8px 12px; font-size: 13px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
      .banner-warn { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); }
      .banner-error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
      .banner button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 10px; cursor: pointer; font: inherit; }
      .banner button:hover { background: var(--vscode-button-hoverBackground); }
      .banner .dismiss { margin-left: auto; opacity: 0.6; cursor: pointer; padding: 0 4px; }
      .banner .dismiss:hover { opacity: 1; }
      #main-row { flex: 1; display: flex; flex-direction: row; min-height: 0; }
      #frame-wrap { flex: 1; position: relative; min-width: 0; }
      #frame { width: 100%; height: 100%; border: none; background: white; }
      #side-dock {
        display: flex;
        flex-direction: column;
        flex: 0 0 264px;
        width: 264px;
        min-height: 0;
        border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
        font-family: var(--vscode-font-family);
        font-size: 12px;
      }
    </style>
    <script>window.__FINESSE_INIT__ = ${initJson};</script>
  </head>
  <body>
    <div id="status" role="status">
      <span id="status-dirty" class="dirty-dot" aria-hidden="true">●</span>
      <span id="status-file" class="muted">no file</span>
      <span id="status-version" class="muted">v?</span>
      <span id="status-port" class="muted">-</span>
		      <span id="status-locked" class="muted" hidden>editing locked</span>
		      <span id="status-selection" class="muted selection" hidden>no selection</span>
		      <span id="status-save-state" class="save-state">Saved</span>
		      <span class="grow"></span>
      <button id="status-discard" class="tool" type="button" title="Discard unsaved changes" disabled>Discard</button>
      <button id="status-undo" class="tool" type="button" title="Undo Finesse edit (⌘Z)" disabled>Undo</button>
      <button id="status-redo" class="tool" type="button" title="Redo Finesse edit (⇧⌘Z)" disabled>Redo</button>
      <button id="status-save" class="tool" type="button" title="Save (⌘S)" disabled>Save</button>
    </div>
    <div id="banners" role="region" aria-label="Finesse notifications" aria-live="polite"></div>
    <div id="main-row">
      <div id="frame-wrap">
        <iframe id="frame" title="HTML preview" aria-label="HTML preview" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
      </div>
      <div id="side-dock" aria-label="Style panel"></div>
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
